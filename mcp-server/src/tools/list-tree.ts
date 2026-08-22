import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { listTreeFs } from "../space-fs";
import { fail, ok } from "./helpers";

/**
 * Raw filesystem shape, not space semantics. `list_spaces` only ever walks claimed spaces, and
 * `describe_space` only ever lists one space's own immediate files — neither shows a folder that
 * hasn't been scaffolded yet, an ignored path, or the tree more than one level deep in a single
 * call. An agent orienting itself in an unfamiliar vault, or checking what a bulk external drop-in
 * actually contains before deciding what to `create_space` over, needs to just see what's there.
 */
export function registerListTreeTool(server: McpServer, vaultRoot: string): void {
	server.registerTool(
		"list_tree",
		{
			title: "List the raw file tree",
			description:
				"Lists folders and files under a vault-relative path as a nested tree, straight off the " +
				"filesystem — no space semantics, no hashing. Each folder is marked is_space so you can " +
				"tell a claimed space from a plain folder (e.g. one waiting on create_space) at a glance. " +
				"Dotted paths (.aether, .obsidian, and similar) are omitted by default, matching what " +
				"Obsidian itself would show; pass include_ignored: true to see them.\n\n" +
				"Use describe_space for one space's files with hashes, and read_file for what a file " +
				"actually says — this tool only answers \"what's here\".",
			inputSchema: {
				under: z
					.string()
					.optional()
					.describe('Vault-relative folder path to root the tree at, e.g. "UserSpace". Omit for the whole vault.'),
				max_depth: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Levels to descend (1 = immediate children only). Omit for unlimited depth."),
				include_ignored: z
					.boolean()
					.default(false)
					.describe("Include dotted paths (.aether, .obsidian, sync sidecars, etc.) that are normally omitted."),
			},
		},
		async ({ under, max_depth, include_ignored }) => {
			const rootRel = under ?? "";
			if (rootRel) {
				const segments = rootRel.split("/").filter((s) => s.length > 0);
				if (segments.some((s) => s === "." || s === "..")) {
					return fail(`under must not contain traversal segments: "${rootRel}"`);
				}
			}

			let rootStat;
			try {
				rootStat = await stat(join(vaultRoot, rootRel));
			} catch {
				return fail(`no folder at "${rootRel || "(vault root)"}".`);
			}
			if (!rootStat.isDirectory()) return fail(`"${rootRel}" is a file, not a folder.`);

			const { tree, truncated } = await listTreeFs(vaultRoot, rootRel, {
				maxDepth: max_depth,
				includeIgnored: include_ignored,
			});
			return ok({ under: rootRel, tree, truncated });
		},
	);
}
