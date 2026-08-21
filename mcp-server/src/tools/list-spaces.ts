import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { immediateFilesFs, immediateSubspacesFs, walkSpacesFs } from "../space-fs";
import { readHeadFs } from "../vault-io";
import { isUnderOrEqual } from "./helpers";

export function registerListSpacesTool(server: McpServer, vaultRoot: string): void {
	server.registerTool(
		"list_spaces",
		{
			title: "List spaces",
			description:
				"Lists every claimed space (a folder with .aether/log.jsonl) in the vault, or under a " +
				"given vault-relative subtree. Addressing is by vault-relative path — there is no ID " +
				"system.\n\n" +
				"Each entry carries its parent, depth, and log head alongside its counts, so the tree " +
				"can be read straight from the response rather than reconstructed by splitting paths. " +
				"For one space in detail — its files, neighbours, statement and staleness — use " +
				"describe_space instead.",
			inputSchema: {
				under: z
					.string()
					.optional()
					.describe('Vault-relative folder path to scope the listing to, e.g. "UserSpace". Omit for the whole vault.'),
			},
		},
		async ({ under }) => {
			const spaces = [];
			for await (const ref of walkSpacesFs(vaultRoot)) {
				if (under && !isUnderOrEqual(ref, under)) continue;
				const [files, subspaces] = await Promise.all([immediateFilesFs(ref), immediateSubspacesFs(vaultRoot, ref)]);
				const segments = ref.path.split("/");
				spaces.push({
					path: ref.path,
					name: segments[segments.length - 1],
					parent: segments.length > 1 ? segments.slice(0, -1).join("/") : null,
					depth: segments.length,
					head: await readHeadFs(ref),
					file_count: files.length,
					subspace_count: subspaces.length,
				});
			}
			return { content: [{ type: "text", text: JSON.stringify({ spaces }, null, 2) }] };
		},
	);
}
