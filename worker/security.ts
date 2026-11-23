/**
 * Funções de segurança partilhadas pelo Worker.
 *
 * Modelo: cada instância de workflow tem uma chave secreta ("capability token")
 * entregue a quem a criou num cookie HttpOnly + SameSite=Strict. O servidor só
 * guarda o hash SHA-256 da chave (no Durable Object da instância).
 */

// 65 min: o prazo de aprovação (60 min) só começa uns segundos depois do /start,
// por isso o cookie tem uma pequena margem para não expirar antes do prazo
const TOKEN_MAX_AGE_SECONDS = 65 * 60;

export const MAX_EVENT_BODY_BYTES = 2048;
export const MAX_COMMENT_LENGTH = 500;

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidInstanceId(id: string | null | undefined): id is string {
	return typeof id === "string" && UUID_RE.test(id);
}

// ---------------------------------------------------------------------------
// Chaves (tokens)
// ---------------------------------------------------------------------------

/** Gera uma chave aleatória de 256 bits, em hexadecimal. */
export function generateToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

/** Comparação em tempo constante (evita ataques de temporização). */
export function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

/**
 * Um cookie por instância: iniciar um segundo workflow (ex.: noutro separador)
 * não apaga a chave do primeiro. O prefixo __Host- impede que subdomínios o sobrescrevam.
 */
export function tokenCookieName(instanceId: string): string {
	return `__Host-wf_${instanceId}`;
}

export function tokenCookie(instanceId: string, token: string): string {
	return `${tokenCookieName(instanceId)}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${TOKEN_MAX_AGE_SECONDS}`;
}

export function getCookie(request: Request, name: string): string | null {
	const header = request.headers.get("Cookie");
	if (!header) return null;
	for (const part of header.split(";")) {
		const [k, ...v] = part.trim().split("=");
		if (k === name) return v.join("=") || null;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Origem dos pedidos (CSRF / WebSocket hijacking)
// ---------------------------------------------------------------------------

/** O pedido vem de uma página da própria app? (o browser envia sempre Origin em POST e WebSocket) */
export function isSameOrigin(request: Request, url: URL): boolean {
	return request.headers.get("Origin") === url.origin;
}

/**
 * Chave do rate limiting. IPv4: o endereço. IPv6: o prefixo /64, porque um
 * único cliente costuma controlar um /64 inteiro (2^64 endereços) e, com o
 * endereço completo, bastaria mudar de endereço para contornar o limite.
 */
export function clientKey(request: Request): string {
	const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
	if (!ip.includes(":")) return ip;
	const prefix = expandIPv6(ip)?.slice(0, 4).join(":");
	return prefix ? `${prefix}::/64` : ip;
}

function expandIPv6(ip: string): string[] | null {
	const [head, tail, ...rest] = ip.toLowerCase().split("::");
	if (rest.length > 0) return null;
	const left = head ? head.split(":") : [];
	const right = tail !== undefined && tail !== "" ? tail.split(":") : [];
	const missing = 8 - left.length - right.length;
	if (tail === undefined ? missing !== 0 : missing < 1) return null;
	const groups = [...left, ...Array(tail === undefined ? 0 : missing).fill("0"), ...right];
	if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
	return groups.map((g) => g.padStart(4, "0"));
}

// ---------------------------------------------------------------------------
// Leitura do corpo com limite de tamanho
// ---------------------------------------------------------------------------

/**
 * Lê o corpo sem nunca guardar mais de `maxBytes` em memória.
 * Devolve null se o corpo for maior que o limite (com ou sem Content-Length).
 */
export async function readBodyLimited(
	request: Request,
	maxBytes: number,
): Promise<string | null> {
	const declared = Number(request.headers.get("Content-Length") ?? "0");
	if (declared > maxBytes) return null;
	if (!request.body) return "";

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const all = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		all.set(c, offset);
		offset += c.byteLength;
	}
	return new TextDecoder().decode(all);
}

// ---------------------------------------------------------------------------
// Validação do corpo do evento de aprovação
// ---------------------------------------------------------------------------

export interface ApprovalPayload {
	approved: boolean;
	comment?: string;
}

/** Devolve um payload novo só com campos validados, ou null se o corpo for inválido. */
export function parseApprovalBody(value: unknown): ApprovalPayload | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const obj = value as Record<string, unknown>;
	const allowed = new Set(["approved", "comment"]);
	if (Object.keys(obj).some((k) => !allowed.has(k))) return null;
	if (typeof obj.approved !== "boolean") return null;
	if (obj.comment !== undefined) {
		if (
			typeof obj.comment !== "string" ||
			obj.comment.length > MAX_COMMENT_LENGTH
		) {
			return null;
		}
		return { approved: obj.approved, comment: obj.comment };
	}
	return { approved: obj.approved };
}

// ---------------------------------------------------------------------------
// Respostas e cabeçalhos de segurança
// ---------------------------------------------------------------------------

export const SECURITY_HEADERS: Record<string, string> = {
	"Content-Security-Policy":
		"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "strict-origin-when-cross-origin",
	"Cache-Control": "no-store",
};

export function withSecurityHeaders(response: Response): Response {
	const res = new Response(response.body, response);
	for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
		res.headers.set(k, v);
	}
	return res;
}

export function jsonError(
	message: string,
	status: number,
	headers?: HeadersInit,
): Response {
	return Response.json({ error: message }, { status, headers });
}
