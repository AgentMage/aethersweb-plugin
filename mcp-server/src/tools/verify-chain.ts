import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { verifyChain } from "../../../src/core/hash";
import { buildSpaceRefFs, isSpaceFs } from "../space-fs";
import { readLogFs } from "../vault-io";

export function registerVerifyChainTool(server: McpServer, vaultRoot: string): void {
	server.registerTool(
		"verify_chain",
		{
			title: "Verify a space's hash chain",
			description:
				"Walks a space's log top to bottom, recomputing each entry's hash and confirming the " +
				"chain is unbroken. On ok: false, reason/brokenAtSeq identify the break — tell the user " +
				"to open the space in the Obsidian plugin and use its chain-repair UI; repair is " +
				"intentionally not exposed through this server.",
			inputSchema: {
				space_path: z.string().describe('Vault-relative path of the space, e.g. "UserSpace/Location".'),
			},
		},
		async ({ space_path }) => {
			if (!(await isSpaceFs(vaultRoot, space_path))) {
				return {
					content: [{ type: "text" as const, text: `"${space_path}" is not a claimed space (no .aether/log.jsonl found).` }],
					isError: true,
				};
			}
			const ref = buildSpaceRefFs(vaultRoot, space_path);
			const log = await readLogFs(ref);
			const result = verifyChain(log);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
		},
	);
}
