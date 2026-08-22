import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { regenerateContextFs } from "../context-fs";
import { buildSpaceRefFs, immediateSubspacesFs, isSpaceFs } from "../space-fs";
import { appendSubspaceEventFs } from "../vault-io";
import { deleteSpaceFs, WriteError } from "../write-fs";
import { fail, notASpace, ok, SPACE_PATH_DESC } from "./helpers";

/**
 * Permanently deletes a space's whole folder, `.aether/` log included — the destructive
 * counterpart to create_space, with none of its safety net. Deleting a file leaves its content
 * recoverable from the log (see delete_file); deleting a space destroys the log itself, so
 * nothing anywhere preserves what it held afterward — only that something by this name once
 * existed, via the parent's subspace_removed (name only, never a hash — see SpinPayload's doc
 * comment).
 *
 * Two gates, both refusals rather than confirmations, mirroring create_space's
 * require_user_space in reverse:
 * - A space with live subspaces of its own refuses unless `recursive: true` — a call that looks
 *   like it targets one leaf must not silently take an entire subtree with it.
 * - A top-level user-space (no parent) refuses unless `require_user_space: true` — the centre of
 *   someone's world doesn't disappear because a path happened to have no slash in it.
 */
export function registerDeleteSpaceTool(server: McpServer, vaultRoot: string): void {
	server.registerTool(
		"delete_space",
		{
			title: "Delete a space",
			description:
				"Permanently deletes a space's folder, including its .aether/ log — its entire " +
				"hash-chained history goes with it. There is no undo through this server, and unlike " +
				"delete_file, nothing anywhere preserves what it held afterward: the parent's log " +
				"records only that a child by this name once existed and is now gone, never its " +
				"content or its hash.\n\n" +
				"Refuses a space that still has live subspaces unless recursive: true — those are " +
				"destroyed too, with no separate confirmation per subspace. Refuses a top-level " +
				"user-space unless require_user_space: true — that is the centre of someone's world, " +
				"not a folder.\n\n" +
				"On success the parent's log records the departure and its context note is " +
				"regenerated. Use this only when a person has actually decided a piece of their " +
				"history should stop existing — not as a routine cleanup step.",
			inputSchema: {
				space_path: z.string().describe(SPACE_PATH_DESC),
				recursive: z
					.boolean()
					.default(false)
					.describe("Required to be true to delete a space that still has live subspaces of its own."),
				require_user_space: z
					.boolean()
					.default(false)
					.describe("Required to be true to delete a top-level user-space (a path with no parent space)."),
			},
		},
		async ({ space_path, recursive, require_user_space }) => {
			if (!(await isSpaceFs(vaultRoot, space_path))) return notASpace(space_path);

			const segments = space_path.split("/").filter((s) => s.length > 0);
			const parentPath = segments.slice(0, -1).join("/");
			if (parentPath === "" && !require_user_space) {
				return fail(
					`"${space_path}" is a top-level user-space — the centre of someone's world. ` +
						`Pass require_user_space: true to confirm.`,
				);
			}

			const ref = buildSpaceRefFs(vaultRoot, space_path);
			const children = await immediateSubspacesFs(vaultRoot, ref);
			if (children.length > 0 && !recursive) {
				const names = children.map((c) => c.path.split("/").pop()).join(", ");
				return fail(
					`"${space_path}" still has ${children.length} live subspace(s) (${names}) — ` +
						`pass recursive: true to delete them too.`,
				);
			}

			try {
				await deleteSpaceFs(vaultRoot, space_path);
			} catch (err) {
				if (err instanceof WriteError) return fail(err.message);
				throw err;
			}

			let parent_spin = null;
			if (parentPath && (await isSpaceFs(vaultRoot, parentPath))) {
				const parentRef = buildSpaceRefFs(vaultRoot, parentPath);
				parent_spin = await appendSubspaceEventFs(parentRef, "subspace_removed", segments[segments.length - 1]);
				await regenerateContextFs(vaultRoot, parentRef);
			}

			return ok({
				space_path,
				deleted: true,
				subspaces_removed: children.map((c) => c.path),
				parent_spin,
			});
		},
	);
}
