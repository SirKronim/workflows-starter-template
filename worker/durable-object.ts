import { DurableObject } from "cloudflare:workers";
import { timingSafeEqual } from "./security";

/** Máximo de ligações WebSocket em simultâneo por instância. */
const MAX_SOCKETS_PER_INSTANCE = 5;

/**
 * WorkflowStatusDO - Durable Object for managing workflow state and WebSocket connections
 *
 * Responsibilities:
 * - Accept and manage WebSocket connections using hibernation API
 * - Track step statuses for a workflow instance
 * - Broadcast updates to all connected clients
 * - Provide RPC method for workflow to update step status
 */
export class WorkflowStatusDO extends DurableObject {
	private stepStatuses: Map<string, string>;
	private currentStep: string | null;
	private workflowStatus: "running" | "completed" | "error";

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		this.stepStatuses = new Map();
		this.currentStep = null;
		this.workflowStatus = "running";

		// Responde a "ping" com "pong" sem acordar o DO (não conta como duração faturada)
		ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair("ping", "pong"),
		);

		// Load state from durable storage to survive hibernation/eviction
		ctx.blockConcurrencyWhile(async () => {
			const storedStatuses =
				await ctx.storage.get<Record<string, string>>("stepStatuses");
			const storedCurrent = await ctx.storage.get<string | null>("currentStep");
			const storedWorkflowStatus = await ctx.storage.get<
				"running" | "completed" | "error"
			>("workflowStatus");

			if (storedStatuses) {
				this.stepStatuses = new Map(Object.entries(storedStatuses));
			} else {
				const steps = [
					"process data",
					"wait 2 seconds",
					"wait for approval",
					"final",
				];
				steps.forEach((s) => this.stepStatuses.set(s, "pending"));
			}

			this.currentStep = storedCurrent ?? null;
			this.workflowStatus = storedWorkflowStatus ?? "running";
		});
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") === "websocket") {
			if (this.ctx.getWebSockets().length >= MAX_SOCKETS_PER_INSTANCE) {
				return new Response("Too many connections", { status: 429 });
			}

			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);

			// Use hibernation API - acceptWebSocket allows the DO to hibernate
			this.ctx.acceptWebSocket(server);

			// Send current state immediately upon connection
			server.send(JSON.stringify(this.getStateMessage()));

			return new Response(null, { status: 101, webSocket: client });
		}

		return new Response("Expected WebSocket", { status: 400 });
	}

	/**
	 * RPC method called by the workflow to update step status
	 * This is called via stub.updateStep() from the workflow
	 */
	async updateStep(stepName: string, status: string): Promise<void> {
		this.stepStatuses.set(stepName, status);

		if (status === "running" || status === "waiting") {
			this.currentStep = stepName;
		}

		const allCompleted = Array.from(this.stepStatuses.values()).every(
			(s) => s === "completed",
		);
		if (allCompleted) {
			this.workflowStatus = "completed";
			this.currentStep = null;
		}

		await this.ctx.storage.put(
			"stepStatuses",
			Object.fromEntries(this.stepStatuses),
		);
		await this.ctx.storage.put("currentStep", this.currentStep);
		await this.ctx.storage.put("workflowStatus", this.workflowStatus);

		this.broadcast(this.getStateMessage());

		// Workflow terminado: já não há nada a transmitir; fechar as ligações
		if (this.workflowStatus === "completed") {
			for (const socket of this.ctx.getWebSockets()) {
				try {
					socket.close(1000, "Workflow completed");
				} catch {
					// Ignorar sockets já fechados
				}
			}
		}
	}

	/**
	 * Regista o dono da instância (hash da chave). Só pode ser definido uma vez.
	 * Chamado pelo Worker logo a seguir a criar a instância.
	 */
	async setOwner(tokenHash: string): Promise<void> {
		const existing = await this.ctx.storage.get<string>("ownerTokenHash");
		if (!existing) {
			await this.ctx.storage.put("ownerTokenHash", tokenHash);
		}
	}

	/** Verifica se o hash apresentado corresponde ao dono da instância. */
	async isOwner(tokenHash: string): Promise<boolean> {
		const stored = await this.ctx.storage.get<string>("ownerTokenHash");
		return !!stored && timingSafeEqual(stored, tokenHash);
	}

	/**
	 * WebSocket message handler (hibernation API).
	 * Os clientes não precisam de enviar nada (os "ping" são respondidos
	 * automaticamente, sem acordar o DO). Qualquer outra mensagem é inesperada:
	 * fecha-se a ligação (1008 = violação de política) para travar abusos.
	 */
	async webSocketMessage(ws: WebSocket, _message: string): Promise<void> {
		try {
			ws.close(1008, "Unexpected message");
		} catch {
			// A ligação já pode estar fechada
		}
	}

	/**
	 * WebSocket close handler (hibernation API)
	 * Called when a client closes the connection
	 */
	async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		_wasClean: boolean,
	): Promise<void> {
		// 1005 ("sem código") e 1006 ("fecho anormal") são reservados e não podem
		// ser enviados; nesses casos responde com 1000 (fecho normal).
		const sendable = code === 1000 || (code >= 3000 && code <= 4999);
		try {
			ws.close(sendable ? code : 1000, sendable ? reason : "");
		} catch {
			// A ligação já pode estar fechada
		}
	}

	/**
	 * Broadcast a message to all connected WebSocket clients
	 */
	private broadcast(message: object): void {
		const sockets = this.ctx.getWebSockets();
		const json = JSON.stringify(message);

		for (const socket of sockets) {
			try {
				socket.send(json);
			} catch {
				// Ignore errors for disconnected sockets
			}
		}
	}

	/**
	 * Get the current state as a message object
	 */
	private getStateMessage(): object {
		return {
			type: "workflow_update",
			currentStep: this.currentStep,
			stepStatuses: Object.fromEntries(this.stepStatuses),
			workflowStatus: this.workflowStatus,
			timestamp: Date.now(),
		};
	}
}
