import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { reconcileSubtreeFs } from "../reconcile-fs";
import { buildSpaceRefFs, isSpaceFs } from "../space-fs";
import { notASpace, ok, SPACE_PATH_DESC } from "./helpers";

/**
 * Catches a space's log up to what is actually on disk — the server's counterpart to the
 * reconciliation the plugin runs on vault open, on focus, and on a timer.
 *
 * Necessary because the plugin's version only runs inside Obsidian. Headless, nothing else would
 * ever notice a change made outside these tools, so a vault worked on over SSH would accumulate
 * silent gaps in its own history with nothing anywhere indicating something was missing.
 */
export function registerReconcileSpaceTool(server: McpServer, vaultRoot: string): void {
	server.registerTool(
		"reconcile_space",
		{
			title: "Reconcile a space against the filesystem",
			description:
				"Compares what is on disk against what a space's log last recorded, and appends " +
				"`detected` spins for anything that drifted — files added, changed, or removed by " +
				"something other than these tools (an editor over SSH, a sync client, the Obsidian " +
				"plugin while this server wasn't looking).\n\n" +
				"Everything it writes is labelled `detected`, never `observed`: these changes were " +
				"inferred by comparison, not witnessed. Renames are not guessed at — a vanish plus an " +
				"appearance is recorded as a delete plus a create, because the evidence supports " +
				"nothing stronger. Run this before reading a space you have reason to think changed " +
				"underneath you.",
			inputSchema: {
				space_path: z.string().describe(SPACE_PATH_DESC),
				recursive: z.boolean().default(false).describe("Also reconcile every subspace beneath it, deepest first."),
			},
		},
		async ({ space_path, recursive }) => {
			if (!(await isSpaceFs(vaultRoot, space_path))) return notASpace(space_path);
			const results = await reconcileSubtreeFs(vaultRoot, buildSpaceRefFs(vaultRoot, space_path), recursive);

			const spaces = Array.from(results.entries()).map(([path, spins]) => ({
				space_path: path,
				// Deliberately not viewSpin: a first-time reconcile can emit hundreds of spins, and two
				// 64-char hashes apiece would make this response the thing it is meant to keep small.
				// `source` is carried explicitly — that every one of these is `detected` is the single
				// most important fact about them, and it must live in the data, not only in this
				// tool's description.
				spins: spins.map((s) => ({
					seq: s.seq,
					spin_type: s.spin_type,
					source: s.source,
					path: s.payload.path ?? s.payload.subspace_name,
				})),
			}));
			const total = spaces.reduce((sum, s) => sum + s.spins.length, 0);
			return ok({ reconciled: space_path, recursive, total_spins: total, spaces });
		},
	);
}
