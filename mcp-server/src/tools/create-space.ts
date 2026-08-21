import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdir, stat } from "node:fs/promises";
import { z } from "zod";
import { isIgnoredPath } from "../../../src/core/ignore";
import { regenerateContextFs } from "../context-fs";
import { buildSpaceRefFs, isSpaceFs } from "../space-fs";
import { appendSubspaceEventFs, ensureSpaceInitializedFs } from "../vault-io";
import { fail, ok } from "./helpers";

/**
 * Scaffolds a new space: the folder, its `.aether/` log with a seq-0 `space_created` spin, and its
 * context note — then tells the parent it has a new child.
 *
 * Space creation used to be plugin-only, on the reasoning that structure is a decision about
 * someone's world and should be made through their own GUI. That reasoning holds for who *decides*
 * and not for who *executes*: with an agent working the vault headlessly there is no GUI to make
 * the decision through, and refusing here doesn't keep the structure considered — it just means
 * the agent creates a bare folder some other way, which no log ever records.
 *
 * The one line still not crossed is the vault root. A top-level folder is a user-space, the
 * grounded centre of a person's world, and `require_user_space` makes creating one an explicit act
 * rather than something that can happen by passing a path with no slash in it.
 */
export function registerCreateSpaceTool(server: McpServer, vaultRoot: string): void {
	server.registerTool(
		"create_space",
		{
			title: "Create a space",
			description:
				"Creates a claimed space at a vault-relative path: folder, hash-chained log seeded with " +
				"space_created, and context note. The parent must already be a claimed space, so the " +
				"tree only ever grows from something that exists.\n\n" +
				"Creating a top-level user-space (a path with no parent) additionally requires " +
				"require_user_space: true — a user-space is the centre of someone's world, not a " +
				"folder. Idempotent: a path that is already a claimed space is returned unchanged.",
			inputSchema: {
				space_path: z.string().describe('Vault-relative path for the new space, e.g. "UserSpace/Location/Camp".'),
				require_user_space: z
					.boolean()
					.default(false)
					.describe("Required to be true when creating a top-level user-space (a path with no parent space)."),
			},
		},
		async ({ space_path, require_user_space }) => {
			const segments = space_path.split("/").filter((s) => s.length > 0);
			if (segments.length === 0) return fail("space_path is empty.");
			if (segments.some((s) => s === "." || s === "..")) return fail(`space_path must not contain traversal segments: "${space_path}"`);
			if (isIgnoredPath(space_path)) return fail(`"${space_path}" is an ignored path — it would be invisible to every pass.`);

			const normalized = segments.join("/");
			if (await isSpaceFs(vaultRoot, normalized)) {
				return ok({ space_path: normalized, created: false, note: "already a claimed space" });
			}

			const parentPath = segments.slice(0, -1).join("/");
			if (parentPath === "") {
				if (!require_user_space) {
					return fail(
						`"${normalized}" would be a new top-level user-space. Pass require_user_space: true to confirm, ` +
							`or nest it under an existing space.`,
					);
				}
			} else if (!(await isSpaceFs(vaultRoot, parentPath))) {
				return fail(`parent "${parentPath}" is not a claimed space — create it first.`);
			}

			const ref = buildSpaceRefFs(vaultRoot, normalized);
			try {
				await stat(ref.absPath);
			} catch {
				await mkdir(ref.absPath, { recursive: true });
			}

			await ensureSpaceInitializedFs(ref);
			const frontmatter = await regenerateContextFs(vaultRoot, ref);

			let parent_spin = null;
			if (parentPath) {
				const parentRef = buildSpaceRefFs(vaultRoot, parentPath);
				parent_spin = await appendSubspaceEventFs(parentRef, "subspace_created", segments[segments.length - 1]);
				await regenerateContextFs(vaultRoot, parentRef);
			}

			return ok({ space_path: normalized, created: true, head: frontmatter.source_tip, parent_spin });
		},
	);
}
