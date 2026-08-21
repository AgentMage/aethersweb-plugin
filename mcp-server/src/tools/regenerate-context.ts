import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { stringifyFrontmatter } from "../../../src/core/context-format";
import { regenerateContextFs } from "../context-fs";
import { buildSpaceRefFs, isSpaceFs } from "../space-fs";
import { notASpace, ok, SPACE_PATH_DESC } from "./helpers";

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
				space_path: z.string().describe(SPACE_PATH_DESC),
			},
		},
		async ({ space_path }) => {
			if (!(await isSpaceFs(vaultRoot, space_path))) return notASpace(space_path);
			const ref = buildSpaceRefFs(vaultRoot, space_path);
			const frontmatter = await regenerateContextFs(vaultRoot, ref);
			return ok({ frontmatter_text: stringifyFrontmatter(frontmatter) });
		},
	);
}
