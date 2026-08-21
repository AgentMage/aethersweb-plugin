import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { verifyChain } from "../../../src/core/hash";
import { buildSpaceRefFs, isSpaceFs } from "../space-fs";
import { readLogFs } from "../vault-io";
import { notASpace, ok, SPACE_PATH_DESC } from "./helpers";

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
				space_path: z.string().describe(SPACE_PATH_DESC),
			},
		},
		async ({ space_path }) => {
			if (!(await isSpaceFs(vaultRoot, space_path))) return notASpace(space_path);
			const ref = buildSpaceRefFs(vaultRoot, space_path);
			const log = await readLogFs(ref);
			const result = verifyChain(log);
			return ok(result);
		},
	);
}
