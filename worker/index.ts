// Export the Workflow and Durable Object classes
export { MyWorkflow } from "./workflow";
export { WorkflowStatusDO } from "./durable-object";

import {
	MAX_EVENT_BODY_BYTES,
	clientKey,
	generateToken,
	getCookie,
	isSameOrigin,
	isValidInstanceId,
	jsonError,
	parseApprovalBody,
	readBodyLimited,
	sha256Hex,
	tokenCookie,
	tokenCookieName,
	withSecurityHeaders,
} from "./security";

/**
 * Main Worker fetch handler
 *
 * Rotas (todas com rate limiting por IP e cabeçalhos de segurança):
 * - POST /api/workflow/start       Cria uma instância e entrega ao browser a chave do dono (cookie)
 * - GET  /api/workflow/status/:id  Estado da instância (só o dono)
 * - POST /api/workflow/event/:id   Envia a aprovação (só o dono, corpo validado)
 * - GET  /ws?instanceId=:id        WebSocket de atualizações em tempo real (só o dono)
 *
 * Ordem das verificações: método -> origem -> rate limit -> formato do ID
 * -> instância existe -> dono. As mais baratas primeiro, para recusar abusos
 * antes de gastar recursos pagos.
 */

const STATUS_ROUTE = /^\/api\/workflow\/status\/([^/]+)$/;
const EVENT_ROUTE = /^\/api\/workflow\/event\/([^/]+)$/;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const response = await handleRequest(request, env);
		// 101 (WebSocket) não pode ser reconstruído; tudo o resto leva os cabeçalhos
		return response.status === 101 ? response : withSecurityHeaders(response);
	},
} satisfies ExportedHandler<Env>;

async function handleRequest(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);

	if (url.pathname === "/api/workflow/start") {
		return handleStart(request, env, url);
	}

	const statusMatch = url.pathname.match(STATUS_ROUTE);
	if (statusMatch) {
		return handleStatus(request, env, statusMatch[1]);
	}

	const eventMatch = url.pathname.match(EVENT_ROUTE);
	if (eventMatch) {
		return handleEvent(request, env, url, eventMatch[1]);
	}

	if (url.pathname === "/ws") {
		return handleWebSocket(request, env, url);
	}

	return jsonError("Not Found", 404);
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

async function handleStart(
	request: Request,
	env: Env,
	url: URL,
): Promise<Response> {
	if (request.method !== "POST") {
		return jsonError("Method Not Allowed", 405, { Allow: "POST" });
	}
	if (!isSameOrigin(request, url)) {
		return jsonError("Forbidden", 403);
	}
	// Limite por cliente (IP ou /64) e teto global, porque um atacante com
	// muitos endereços contornaria o limite por cliente
	const perClient = await env.START_LIMITER.limit({ key: clientKey(request) });
	const global = perClient.success
		? await env.GLOBAL_START_LIMITER.limit({ key: "global" })
		: perClient;
	if (!perClient.success || !global.success) {
		return jsonError("Too Many Requests", 429, { "Retry-After": "60" });
	}

	try {
		// O dono é registado ANTES de a instância existir: se o registo falhar,
		// não fica nenhuma instância órfã a correr (e a gastar) sem dono
		const instanceId = crypto.randomUUID();
		const token = generateToken();
		await statusStub(env, instanceId).setOwner(await sha256Hex(token));
		await env.MY_WORKFLOW.create({
			id: instanceId,
			params: { timestamp: Date.now() },
		});

		return Response.json(
			{ instanceId, message: "Workflow started successfully" },
			{ headers: { "Set-Cookie": tokenCookie(instanceId, token) } },
		);
	} catch {
		return jsonError("Failed to start workflow", 500);
	}
}

async function handleStatus(
	request: Request,
	env: Env,
	rawId: string,
): Promise<Response> {
	if (request.method !== "GET") {
		return jsonError("Method Not Allowed", 405, { Allow: "GET" });
	}
	const denied = await checkAccess(request, env, rawId);
	if (denied) return denied;

	try {
		const instance = await env.MY_WORKFLOW.get(rawId);
		const { status } = await instance.status();
		// Só o estado: não devolver output/error internos
		return Response.json({ status });
	} catch {
		return jsonError("Failed to get workflow status", 500);
	}
}

async function handleEvent(
	request: Request,
	env: Env,
	url: URL,
	rawId: string,
): Promise<Response> {
	if (request.method !== "POST") {
		return jsonError("Method Not Allowed", 405, { Allow: "POST" });
	}
	if (!isSameOrigin(request, url)) {
		return jsonError("Forbidden", 403);
	}
	const contentType = request.headers.get("Content-Type") ?? "";
	if (!contentType.toLowerCase().startsWith("application/json")) {
		return jsonError("Content-Type must be application/json", 415);
	}

	const denied = await checkAccess(request, env, rawId);
	if (denied) return denied;

	// Ler o corpo sem nunca guardar mais de 2 KB em memória e validar antes de o usar
	const text = await readBodyLimited(request, MAX_EVENT_BODY_BYTES);
	if (text === null) {
		return jsonError("Payload Too Large", 413);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return jsonError("Invalid JSON", 400);
	}
	const payload = parseApprovalBody(parsed);
	if (!payload) {
		return jsonError(
			"Body must be { approved: boolean, comment?: string (max 500) }",
			400,
		);
	}

	try {
		const instance = await env.MY_WORKFLOW.get(rawId);
		await instance.sendEvent({ type: "user-approval", payload });
		return Response.json({
			success: true,
			message: "Event sent successfully",
		});
	} catch {
		return jsonError("Failed to send event", 500);
	}
}

async function handleWebSocket(
	request: Request,
	env: Env,
	url: URL,
): Promise<Response> {
	if (request.method !== "GET" || request.headers.get("Upgrade") !== "websocket") {
		return new Response("Expected Upgrade: websocket", { status: 426 });
	}
	if (!isSameOrigin(request, url)) {
		return new Response("Forbidden", { status: 403 });
	}

	const rawId = url.searchParams.get("instanceId");
	const denied = await checkAccess(request, env, rawId);
	if (denied) return denied;

	try {
		return await statusStub(env, rawId as string).fetch(request);
	} catch {
		return new Response("Failed to establish WebSocket connection", {
			status: 500,
		});
	}
}

// ---------------------------------------------------------------------------
// Verificações comuns
// ---------------------------------------------------------------------------

function statusStub(env: Env, instanceId: string) {
	return env.WORKFLOW_STATUS.get(env.WORKFLOW_STATUS.idFromName(instanceId));
}

/**
 * Rate limit -> formato do ID -> tem a chave desta instância? -> instância
 * existe -> a chave é a do dono.
 * Devolve uma resposta de erro, ou null se o acesso for permitido.
 */
async function checkAccess(
	request: Request,
	env: Env,
	rawId: string | null,
): Promise<Response | null> {
	const { success } = await env.API_LIMITER.limit({ key: clientKey(request) });
	if (!success) {
		return jsonError("Too Many Requests", 429, { "Retry-After": "60" });
	}
	if (!isValidInstanceId(rawId)) {
		return jsonError("Invalid instance ID", 400);
	}

	// Sem a chave desta instância: 403 imediato, sem gastar chamadas à API de
	// Workflows e sem revelar se o ID existe
	const token = getCookie(request, tokenCookieName(rawId));
	if (!token) {
		return jsonError("Forbidden", 403);
	}

	// Confirmar que a instância existe ANTES de tocar no Durable Object,
	// para não criar DOs para IDs inventados. Responde 403 (e não 404) para
	// não revelar, nem a quem forje um cookie, se o ID existe.
	try {
		await env.MY_WORKFLOW.get(rawId);
	} catch {
		return jsonError("Forbidden", 403);
	}

	const isOwner = await statusStub(env, rawId).isOwner(await sha256Hex(token));
	if (!isOwner) {
		return jsonError("Forbidden", 403);
	}
	return null;
}
