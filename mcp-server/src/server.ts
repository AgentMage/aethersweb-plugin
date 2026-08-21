#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveVaultRoot } from "./config";
import { registerAppendSpinTool } from "./tools/append-spin";
import { registerCheckStalenessTool } from "./tools/check-staleness";
import { registerCreateSpaceTool } from "./tools/create-space";
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

async function main(): Promise<void> {
	const vaultRoot = resolveVaultRoot();

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
	registerWriteFileTool(server, vaultRoot);
	registerDeleteFileTool(server, vaultRoot);
	registerMoveFileTool(server, vaultRoot);

	// Derived artifacts and catch-up.
	registerRegenerateContextTool(server, vaultRoot);
	registerWriteStatementTool(server, vaultRoot);
	registerReconcileSpaceTool(server, vaultRoot);
	registerAppendSpinTool(server, vaultRoot);

	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error(`[aethersweb-mcp-server] ready, vault: ${vaultRoot}`);
}

main().catch((err) => {
	console.error("[aethersweb-mcp-server] fatal error:", err);
	process.exit(1);
});
