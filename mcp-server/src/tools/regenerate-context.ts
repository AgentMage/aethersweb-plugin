import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { stringifyFrontmatter } from "../../../src/core/context-format";
import { regenerateContextFs } from "../context-fs";
import { buildSpaceRefFs, isSpaceFs } from "../space-fs";

export function registerRegenerateContextTool(server: McpServer, vaultRoot: string): void {
	server.registerTool(
		"regenerate_context",
		{
			title: "Regenerate a space's context note",
			description:
				"Fully rebuilds a space's context note's objective frontmatter (files, hashes, " +
				"subspace tips, counts) from current filesystem truth. The AI statement body is read " +
				"back and carried forward untouched — this tool never writes statement text.",
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
			const frontmatter = await regenerateContextFs(vaultRoot, ref);
			return { content: [{ type: "text", text: JSON.stringify({ frontmatter_text: stringifyFrontmatter(frontmatter) }, null, 2) }] };
		},
	);
}
