#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	resolveHttpAllowedHosts,
	resolveHttpPort,
	resolveHttpToken,
	resolveReconcileIntervalMinutes,
	resolveVaultRoot,
} from "./config";
import { startHttpServer } from "./http-server";
import { startReconcileSweep } from "./reconcile-sweep";
import { registerAppendSpinTool } from "./tools/append-spin";
import { registerCheckStalenessTool } from "./tools/check-staleness";
import { registerCreateSpaceTool } from "./tools/create-space";
import { registerDeleteSpaceTool } from "./tools/delete-space";
import { registerDescribeSpaceTool } from "./tools/describe-space";
import { registerListSpacesTool } from "./tools/list-spaces";
import { registerMoveFileTool } from "./tools/move-file";
import { registerMoveSpaceTool } from "./tools/move-space";
import { registerPlanRegenerationTool } from "./tools/plan-regeneration";
import { registerReadContextTool } from "./tools/read-context";
import { registerReadFileTool } from "./tools/read-file";
import { registerReadLogTool } from "./tools/read-log";
import { registerReconcileSpaceTool } from "./tools/reconcile-space";
import { registerRegenerateContextTool } from "./tools/regenerate-context";
import { registerVerifyChainTool } from "./tools/verify-chain";
import { registerDeleteFileTool, registerWriteFileTool } from "./tools/write-file";
import { registerWriteStatementTool } from "./tools/write-statement";

/**
 * Builds one McpServer with the full tool surface registered. Called exactly once for the whole
 * process in stdio mode (one process, one client, one server instance for its entire lifetime),
 * and once per session in HTTP mode, where many concurrent clients each need their own
 * server/transport pair — see http-server.ts's own doc comment for why that's not shared.
 */
export function buildServer(vaultRoot: string): McpServer {
	const server = new McpServer({ name: "aethersweb", version: "0.1.0" });

	// Grouped by what they do to the vault — nothing, then structure, then content. Registration
	// order has no functional effect; it is the clearest way to read the surface's risk profile.

	// Read: what the vault is and where things sit.
	registerListSpacesTool(server, vaultRoot);
	registerDescribeSpaceTool(server, vaultRoot);
	registerReadFileTool(server, vaultRoot);
	registerReadLogTool(server, vaultRoot);
	registerReadContextTool(server, vaultRoot);

	// Integrity: verify and report, never fix. Chain repair stays plugin-only.
	registerVerifyChainTool(server, vaultRoot);
	registerCheckStalenessTool(server, vaultRoot);
	registerPlanRegenerationTool(server, vaultRoot);

	// Authoring: perform a change and record it from what was actually written.
	registerCreateSpaceTool(server, vaultRoot);
	registerMoveSpaceTool(server, vaultRoot);
	registerDeleteSpaceTool(server, vaultRoot);
	registerWriteFileTool(server, vaultRoot);
	registerDeleteFileTool(server, vaultRoot);
	registerMoveFileTool(server, vaultRoot);

	// Derived artifacts and catch-up.
	registerRegenerateContextTool(server, vaultRoot);
	registerWriteStatementTool(server, vaultRoot);
	registerReconcileSpaceTool(server, vaultRoot);
	registerAppendSpinTool(server, vaultRoot);

	return server;
}

async function main(): Promise<void> {
	const vaultRoot = resolveVaultRoot();
	const httpPort = resolveHttpPort();

	if (httpPort === undefined) {
		// stdio mode — unchanged: one process, one client, one server instance, connected over
		// stdin/stdout by whatever local process launched us (e.g. Claude Code on this machine).
		const server = buildServer(vaultRoot);
		await server.connect(new StdioServerTransport());
		console.error(`[aethersweb-mcp-server] ready (stdio), vault: ${vaultRoot}`);
		return;
	}

	// HTTP mode: a long-running, potentially remote-reachable process (see mcp-server/README.md
	// for the Tailscale + systemd setup this is meant to run under). resolveHttpToken throws
	// rather than falling back to unauthenticated if the token env var is missing.
	const token = resolveHttpToken();
	startHttpServer(() => buildServer(vaultRoot), httpPort, token, resolveHttpAllowedHosts());
	startReconcileSweep(vaultRoot, resolveReconcileIntervalMinutes());
	console.error(`[aethersweb-mcp-server] ready (http :${httpPort}), vault: ${vaultRoot}`);
}

main().catch((err) => {
	console.error("[aethersweb-mcp-server] fatal error:", err);
	process.exit(1);
});
