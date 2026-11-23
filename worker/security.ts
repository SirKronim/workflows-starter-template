/**
 * Funções de segurança partilhadas pelo Worker.
 *
 * Modelo: cada instância de workflow tem uma chave secreta ("capability token")
 * entregue a quem a criou num cookie HttpOnly + SameSite=Strict. O servidor só
 * guarda o hash SHA-256 da chave (no Durable Object da instância).
 */

export const TOKEN_COOKIE = "__Host-wf_token";
const TOKEN_MAX_AGE_SECONDS = 60 * 60; // igual ao timeout do waitForEvent

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

export function tokenCookie(token: string): string {
	return `${TOKEN_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${TOKEN_MAX_AGE_SECONDS}`;
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

export function clientKey(request: Request): string {
	return request.headers.get("CF-Connecting-IP") ?? "unknown";
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
