import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";

/**
 * The network-reachable counterpart to stdio mode, for the headless case: a phone (or any other
 * remote MCP client) talking to this server over Tailscale rather than a local process launching
 * it over stdin/stdout.
 *
 * Unlike stdio — one process, one client, one `McpServer` for the process's whole lifetime — an
 * HTTP server serves many concurrent sessions. The SDK's own reference implementation builds a
 * fresh `McpServer` + `StreamableHTTPServerTransport` pair per `initialize` request rather than
 * sharing one server across every caller, and keeps a session-id-keyed map to route subsequent
 * requests to the transport already connected for that session. `buildServer` is the factory
 * (server.ts's `buildServer(vaultRoot)`, called once per session here instead of once per
 * process) that keeps this from duplicating the 17 tool registrations.
 *
 * Auth is a single shared-secret bearer token, checked before anything else touches the request.
 * That's a deliberate simplification versus full MCP OAuth 2.1: this port is reachable only
 * inside a private Tailscale tailnet (see mcp-server/README.md), never the public internet, so
 * the token is a second, scoped factor on top of Tailscale's own network-layer authentication —
 * not the sole line of defense. It would not be adequate if this were ever exposed beyond the
 * tailnet.
 */
export function startHttpServer(buildServer: () => McpServer, port: number, token: string): () => Promise<void> {
	// Defaults to host "127.0.0.1", which is also what makes createMcpExpressApp attach its own
	// DNS-rebinding-protection middleware (Host-header validation) — free defense in depth on top
	// of the explicit 127.0.0.1 bind below.
	const app = createMcpExpressApp();

	const transports = new Map<string, StreamableHTTPServerTransport>();

	function requireBearerToken(req: Request, res: Response): boolean {
		const header = req.headers.authorization ?? "";
		const expected = `Bearer ${token}`;
		const headerBuf = Buffer.from(header);
		const expectedBuf = Buffer.from(expected);
		// timingSafeEqual throws on mismatched lengths, so check that first — a length mismatch is
		// itself the "wrong token" case, not a bug to work around.
		const ok = headerBuf.length === expectedBuf.length && timingSafeEqual(headerBuf, expectedBuf);
		if (!ok) res.status(401).json({ error: "unauthorized" });
		return ok;
	}

	app.post("/mcp", async (req, res) => {
		if (!requireBearerToken(req, res)) return;
		const sessionId = req.headers["mcp-session-id"] as string | undefined;

		try {
			const existing = sessionId ? transports.get(sessionId) : undefined;
			if (existing) {
				await existing.handleRequest(req, res, req.body);
				return;
			}

			if (!sessionId && isInitializeRequest(req.body)) {
				const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
					sessionIdGenerator: () => randomUUID(),
					onsessioninitialized: (sid) => {
						transports.set(sid, transport);
					},
				});
				transport.onclose = () => {
					if (transport.sessionId) transports.delete(transport.sessionId);
				};
				await buildServer().connect(transport);
				await transport.handleRequest(req, res, req.body);
				return;
			}

			res.status(400).json({
				jsonrpc: "2.0",
				error: { code: -32000, message: "Bad Request: no valid session ID and not an initialize request" },
				id: null,
			});
		} catch (err) {
			console.error("[aethersweb-mcp-server] error handling MCP request:", err);
			if (!res.headersSent) {
				res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
			}
		}
	});

	// GET (the standalone SSE stream for server-initiated notifications) and DELETE (explicit
	// session termination) aren't wired up — POST alone is enough for request/response tool calls,
	// which is all of today's tools need. Add them if a client that actually relies on
	// server-initiated notifications or explicit teardown shows up.
	app.get("/mcp", (_req, res) => {
		res.status(405).json({ error: "GET /mcp (SSE) not implemented — this server only handles POST" });
	});
	app.delete("/mcp", (_req, res) => {
		res.status(405).json({ error: "DELETE /mcp (session close) not implemented — this server only handles POST" });
	});

	const server: Server = app.listen(port, "127.0.0.1", () => {
		console.error(`[aethersweb-mcp-server] HTTP mode listening on 127.0.0.1:${port}/mcp`);
	});

	return () =>
		new Promise((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
}
