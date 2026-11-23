import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

/**
 * Testes de segurança da API: cada teste corresponde a um problema
 * da auditoria (.claude/last-security-audit.md).
 */

const ORIGIN = "https://example.com";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

// Cada teste usa um IP diferente para não partilhar o contador do rate limiting
let ipCounter = 0;
function nextIp(): string {
	ipCounter += 1;
	return `198.51.100.${ipCounter}`;
}

async function start(ip = nextIp()) {
	const res = await SELF.fetch(`${ORIGIN}/api/workflow/start`, {
		method: "POST",
		headers: { Origin: ORIGIN, "CF-Connecting-IP": ip },
	});
	const body = (await res.json()) as { instanceId?: string };
	const setCookie = res.headers.get("Set-Cookie") ?? "";
	const cookie = setCookie.split(";")[0];
	return { res, instanceId: body.instanceId as string, cookie, setCookie, ip };
}

function sendEvent(
	id: string,
	init: { cookie?: string; body?: string; origin?: string; contentType?: string; ip?: string },
) {
	const headers: Record<string, string> = {
		"CF-Connecting-IP": init.ip ?? nextIp(),
		"Content-Type": init.contentType ?? "application/json",
	};
	if (init.origin !== "") headers.Origin = init.origin ?? ORIGIN;
	if (init.cookie) headers.Cookie = init.cookie;
	return SELF.fetch(`${ORIGIN}/api/workflow/event/${id}`, {
		method: "POST",
		headers,
		body: init.body ?? JSON.stringify({ approved: true }),
	});
}

describe("POST /api/workflow/start", () => {
	it("cria a instância e entrega a chave num cookie seguro", async () => {
		const { res, instanceId, setCookie } = await start();
		expect(res.status).toBe(200);
		expect(instanceId).toMatch(/^[0-9a-f-]{36}$/);
		expect(setCookie).toContain(`__Host-wf_${instanceId}=`);
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("Secure");
		expect(setCookie).toContain("SameSite=Strict");
	});

	// O limitador da Cloudflare conta em janelas fixas de 60 s. Se o teste
	// atravessar a mudança de janela, o contador reinicia a meio; com 11 pedidos
	// (> 2 × 5) o limite tem de disparar mesmo nesse caso.
	function expectRateLimited(statuses: number[]) {
		expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
		expect(statuses).toContain(429);
		expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(10);
	}

	it("[#1] limita a criação a 5 por minuto por IP", async () => {
		const ip = nextIp();
		const statuses: number[] = [];
		for (let i = 0; i < 11; i++) {
			statuses.push((await start(ip)).res.status);
		}
		expectRateLimited(statuses);
	});

	it("[2.ª #1] em IPv6 conta o bloco /64 inteiro (mudar de endereço não contorna o limite)", async () => {
		const statuses: number[] = [];
		for (let i = 1; i <= 11; i++) {
			// 11 endereços diferentes, todos no mesmo /64
			statuses.push((await start(`2001:db8:aaaa:1::${i}`)).res.status);
		}
		expectRateLimited(statuses);
		// Outro /64 tem o seu próprio contador
		expect((await start("2001:db8:aaaa:2::1")).res.status).toBe(200);
	});

	it("[2.ª #5] dois workflows no mesmo browser mantêm ambas as chaves", async () => {
		const a = await start();
		const b = await start();
		const both = `${a.cookie}; ${b.cookie}`;
		expect((await sendEvent(a.instanceId, { cookie: both })).status).toBe(200);
		expect((await sendEvent(b.instanceId, { cookie: both })).status).toBe(200);
	});

	it("[#5] recusa pedidos de outra origem (CSRF)", async () => {
		const res = await SELF.fetch(`${ORIGIN}/api/workflow/start`, {
			method: "POST",
			headers: { Origin: "https://evil.example", "CF-Connecting-IP": nextIp() },
		});
		expect(res.status).toBe(403);
	});

	it("recusa métodos que não sejam POST", async () => {
		const res = await SELF.fetch(`${ORIGIN}/api/workflow/start`);
		expect(res.status).toBe(405);
	});
});

describe("POST /api/workflow/event/:id", () => {
	it("aceita a aprovação do dono", async () => {
		const { instanceId, cookie } = await start();
		const res = await sendEvent(instanceId, { cookie });
		expect(res.status).toBe(200);
	});

	it("[#2] recusa quem não tem a chave do dono", async () => {
		const { instanceId } = await start();
		expect((await sendEvent(instanceId, {})).status).toBe(403);
	});

	it("[#2] recusa a chave de OUTRA instância", async () => {
		const a = await start();
		const b = await start();
		expect((await sendEvent(a.instanceId, { cookie: b.cookie })).status).toBe(403);
	});

	it("[#3] recusa corpos inválidos", async () => {
		const { instanceId, cookie } = await start();
		const bad = [
			"not json",
			JSON.stringify({ approved: "sim" }),
			JSON.stringify({ approved: true, extra: 1 }),
			JSON.stringify({ approved: true, comment: "x".repeat(501) }),
			JSON.stringify([true]),
		];
		for (const body of bad) {
			expect((await sendEvent(instanceId, { cookie, body })).status).toBe(400);
		}
		const huge = JSON.stringify({ approved: true, comment: "x".repeat(5000) });
		expect((await sendEvent(instanceId, { cookie, body: huge })).status).toBe(413);
	});

	it("[2.ª #2] recusa corpos grandes enviados em stream (sem Content-Length)", async () => {
		const { instanceId, cookie } = await start();
		const chunk = new TextEncoder().encode("x".repeat(1024));
		let sent = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent >= 10) return controller.close();
				sent += 1;
				controller.enqueue(chunk);
			},
		});
		const res = await SELF.fetch(`${ORIGIN}/api/workflow/event/${instanceId}`, {
			method: "POST",
			headers: {
				Origin: ORIGIN,
				"Content-Type": "application/json",
				Cookie: cookie,
				"CF-Connecting-IP": nextIp(),
			},
			body: stream,
		});
		expect(res.status).toBe(413);
		// Parou de ler pouco depois do limite de 2 KB (não leu os 10 KB)
		expect(sent).toBeLessThan(10);
	});

	it("[#5] exige Origin da própria app e Content-Type JSON", async () => {
		const { instanceId, cookie } = await start();
		expect((await sendEvent(instanceId, { cookie, origin: "https://evil.example" })).status).toBe(403);
		expect((await sendEvent(instanceId, { cookie, origin: "" })).status).toBe(403);
		expect((await sendEvent(instanceId, { cookie, contentType: "text/plain" })).status).toBe(415);
	});

	it("[#12] rota exata, ID validado e 404 para instâncias inexistentes", async () => {
		const unknownCookie = `__Host-wf_${UNKNOWN_ID}=abc`;
		const nested = await SELF.fetch(`${ORIGIN}/api/workflow/event/a/${UNKNOWN_ID}`, {
			method: "POST",
			headers: { Origin: ORIGIN, "Content-Type": "application/json", Cookie: unknownCookie },
			body: "{}",
		});
		expect(nested.status).toBe(404);
		expect((await sendEvent("not-a-uuid", { cookie: unknownCookie })).status).toBe(400);
		expect((await sendEvent(UNKNOWN_ID, { cookie: unknownCookie })).status).toBe(404);
	});

	it("[2.ª #4] sem chave, recebe sempre 403 (não revela se o ID existe)", async () => {
		const { instanceId } = await start();
		expect((await sendEvent(instanceId, {})).status).toBe(403);
		expect((await sendEvent(UNKNOWN_ID, {})).status).toBe(403);
	});
});

describe("GET /api/workflow/status/:id", () => {
	it("[#6] devolve só o estado, e só ao dono, e só com GET", async () => {
		const { instanceId, cookie } = await start();
		const url = `${ORIGIN}/api/workflow/status/${instanceId}`;
		const ip = nextIp();

		const ok = await SELF.fetch(url, { headers: { Cookie: cookie, "CF-Connecting-IP": ip } });
		expect(ok.status).toBe(200);
		const body = (await ok.json()) as Record<string, unknown>;
		expect(Object.keys(body)).toEqual(["status"]);

		expect((await SELF.fetch(url, { headers: { "CF-Connecting-IP": ip } })).status).toBe(403);
		expect((await SELF.fetch(url, { method: "DELETE", headers: { Cookie: cookie } })).status).toBe(405);
	});
});

describe("GET /ws", () => {
	function ws(id: string, headers: Record<string, string>) {
		return SELF.fetch(`${ORIGIN}/ws?instanceId=${id}`, {
			headers: { Upgrade: "websocket", "CF-Connecting-IP": nextIp(), ...headers },
		});
	}

	it("liga o dono por WebSocket", async () => {
		const { instanceId, cookie } = await start();
		const res = await ws(instanceId, { Origin: ORIGIN, Cookie: cookie });
		expect(res.status).toBe(101);
		res.webSocket?.accept();
		res.webSocket?.close();
	});

	it("[#7] recusa outra origem e [#2] quem não é dono", async () => {
		const { instanceId, cookie } = await start();
		expect((await ws(instanceId, { Origin: "https://evil.example", Cookie: cookie })).status).toBe(403);
		expect((await ws(instanceId, { Origin: ORIGIN })).status).toBe(403);
	});

	it("[#4] recusa IDs inventados sem criar Durable Objects", async () => {
		const cookie = `__Host-wf_${UNKNOWN_ID}=abc`;
		expect((await ws(UNKNOWN_ID, { Origin: ORIGIN, Cookie: cookie })).status).toBe(404);
		expect((await ws("../start", { Origin: ORIGIN, Cookie: cookie })).status).toBe(400);
	});

	it("[2.ª #6] fecha a ligação quando o cliente envia mensagens inesperadas", async () => {
		const { instanceId, cookie } = await start();
		const res = await ws(instanceId, { Origin: ORIGIN, Cookie: cookie });
		const socket = res.webSocket as WebSocket;
		socket.accept();
		const closed = new Promise<number>((resolve) =>
			socket.addEventListener("close", (e) => resolve(e.code)),
		);
		socket.send("spam");
		expect(await closed).toBe(1008);
	});

	it("[#4] limita o número de ligações por instância", async () => {
		const { instanceId, cookie } = await start();
		const sockets: WebSocket[] = [];
		const statuses: number[] = [];
		for (let i = 0; i < 6; i++) {
			const res = await ws(instanceId, { Origin: ORIGIN, Cookie: cookie });
			statuses.push(res.status);
			if (res.webSocket) {
				res.webSocket.accept();
				sockets.push(res.webSocket);
			}
		}
		expect(statuses.slice(0, 5)).toEqual([101, 101, 101, 101, 101]);
		expect(statuses[5]).toBe(429);
		sockets.forEach((s) => s.close());
	});
});

describe("[#11] cabeçalhos de segurança", () => {
	it("estão presentes nas respostas da API", async () => {
		const res = await SELF.fetch(`${ORIGIN}/api/nao-existe`);
		expect(res.status).toBe(404);
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("X-Frame-Options")).toBe("DENY");
		expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
		expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
	});
});
