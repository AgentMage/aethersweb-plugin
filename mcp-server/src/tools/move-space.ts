import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { regenerateContextFs } from "../context-fs";
import { buildSpaceRefFs, isSpaceFs } from "../space-fs";
import { appendSubspaceEventFs } from "../vault-io";
import { moveSpaceFs, WriteError } from "../write-fs";
import { fail, notASpace, ok } from "./helpers";

/**
 * Moves or renames a space — the operation a personal ontology spends most of its life doing, and
 * the one the surface previously could not perform at all.
 *
 * Restructuring is not an edge case here. Deciding that Trinidad belongs under Colorado rather
 * than beside it *is* the modelling work; a tool surface for an ontology that can create and
 * describe but never reorganize is a surface for a filing cabinet. Doing it through this tool
 * rather than by moving the folder externally is what keeps both parents' logs honest about a
 * change in containment that neither of them would otherwise witness.
 *
 * The space's own log is untouched, deliberately. A space's chain is keyed to what happened inside
 * it, never to where it sits, which is exactly what lets a folder carry its whole history between
 * vaults with no ID system to repair.
 */
export function registerMoveSpaceTool(server: McpServer, vaultRoot: string): void {
	server.registerTool(
		"move_space",
		{
			title: "Move or rename a space",
			description:
				"Moves a space to a new vault-relative path, carrying its .aether/ log — and so its " +
				"entire history — with it. Renaming is the same operation with the same parent.\n\n" +
				"The moved space's own log is not touched: its chain records what happened inside it, " +
				"not where it sits. The old and new parents each record the change in containment, and " +
				"the context note is renamed to follow the folder. The destination's parent must " +
				"already be a claimed space.",
			inputSchema: {
				from_path: z.string().describe('Current vault-relative path of the space, e.g. "UserSpace/Trinidad".'),
				to_path: z.string().describe('New vault-relative path, e.g. "UserSpace/Colorado/Trinidad".'),
			},
		},
		async ({ from_path, to_path }) => {
			if (!(await isSpaceFs(vaultRoot, from_path))) return notASpace(from_path);

			const oldParentPath = from_path.split("/").slice(0, -1).join("/");
			const newParentPath = to_path.split("/").slice(0, -1).join("/");
			if (newParentPath && !(await isSpaceFs(vaultRoot, newParentPath))) {
				return fail(`destination parent "${newParentPath}" is not a claimed space — create it first.`);
			}

			let moved;
			try {
				moved = await moveSpaceFs(vaultRoot, from_path, to_path);
			} catch (err) {
				if (err instanceof WriteError) return fail(err.message);
				throw err;
			}

			const spins: Record<string, unknown> = {};
			if (oldParentPath && (await isSpaceFs(vaultRoot, oldParentPath))) {
				const oldParentRef = buildSpaceRefFs(vaultRoot, oldParentPath);
				spins.old_parent = await appendSubspaceEventFs(oldParentRef, "subspace_removed", moved.oldName);
				await regenerateContextFs(vaultRoot, oldParentRef);
			}
			if (newParentPath) {
				const newParentRef = buildSpaceRefFs(vaultRoot, newParentPath);
				spins.new_parent = await appendSubspaceEventFs(newParentRef, "subspace_created", moved.newName);
				await regenerateContextFs(vaultRoot, newParentRef);
			}
			await regenerateContextFs(vaultRoot, moved.to);

			return ok({ from_path, to_path, spins });
		},
	);
}
