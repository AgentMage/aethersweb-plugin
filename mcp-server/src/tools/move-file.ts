import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { regenerateContextFs } from "../context-fs";
import { buildSpaceRefFs, isSpaceFs } from "../space-fs";
import { appendFileDeletedFs, appendSpinGuardedFs } from "../vault-io";
import { recordWrittenFile, resolveWritablePath, WriteError } from "../write-fs";
import { fail, notASpace, ok } from "./helpers";
import { viewSpin } from "./spin-view";

/**
 * Moves a file, within one space or between two.
 *
 * The two cases record differently, and that difference is not cosmetic. Inside one space a move
 * is a `file_renamed` spin, so replaying the log follows the file across the rename and keeps its
 * content history continuous. Across a boundary there is no single log that could hold such a
 * spin — a space's log records only its own level — so it reconciles honestly as a departure from
 * one log and an arrival in the other. Same rule the plugin's own rename handler follows.
 */
export function registerMoveFileTool(server: McpServer, vaultRoot: string): void {
	server.registerTool(
		"move_file",
		{
			title: "Move or rename a file",
			description:
				"Moves a file within a space, or from one space to another, recording it correctly in " +
				"each case: a file_renamed spin when it stays inside one space (so its content history " +
				"stays continuous across the rename), or a removal from the source log plus an arrival " +
				"in the destination log when it crosses a space boundary, since no single log can " +
				"speak for both.\n\n" +
				"Spins come back as metadata only. That matters most when crossing a boundary: the " +
				"arrival is recorded as a create, so its payload holds the whole file — a file you did " +
				"not write and may never have read. Set return_content to see it, or read_log it later.",
			inputSchema: {
				from_space: z.string().describe('Vault-relative path of the space the file is in now.'),
				from_path: z.string().describe("Path relative to from_space."),
				to_space: z.string().describe("Vault-relative path of the destination space (same as from_space to rename in place)."),
				to_path: z.string().describe("Path relative to to_space."),
				return_content: z
					.boolean()
					.default(false)
					.describe("Echo recorded content back in the spin payloads. Off by default."),
				return_diff: z.boolean().default(false).describe("Echo recorded diffs back in the spin payloads. Off by default."),
			},
		},
		async ({ from_space, from_path, to_space, to_path, return_content, return_diff }) => {
			const view = { content: return_content, diff: return_diff };
			if (!(await isSpaceFs(vaultRoot, from_space))) return notASpace(from_space);
			if (!(await isSpaceFs(vaultRoot, to_space))) return notASpace(to_space);

			const fromRef = buildSpaceRefFs(vaultRoot, from_space);
			const toRef = buildSpaceRefFs(vaultRoot, to_space);

			try {
				const fromAbs = await resolveWritablePath(vaultRoot, fromRef, from_path);
				const toAbs = await resolveWritablePath(vaultRoot, toRef, to_path);

				try {
					await stat(fromAbs);
				} catch {
					return fail(`no file at "${from_path}" in ${from_space}.`);
				}
				let destinationExists = true;
				try {
					await stat(toAbs);
				} catch {
					destinationExists = false;
				}
				if (destinationExists) return fail(`"${to_path}" already exists in ${to_space}.`);

				await mkdir(dirname(toAbs), { recursive: true });
				await rename(fromAbs, toAbs);

				if (from_space === to_space) {
					const spin = await appendSpinGuardedFs(fromRef, () => ({
						spin_type: "file_renamed" as const,
						source: "observed" as const,
						payload: { old_path: from_path, path: to_path },
					}));
					await regenerateContextFs(vaultRoot, fromRef);
					return ok({ from_space, from_path, to_space, to_path, crossed_space: false, spin: viewSpin(spin, view) });
				}

				const removed = await appendFileDeletedFs(fromRef, from_path);
				const arrived = await recordWrittenFile(toRef, to_path, toAbs, "file_created");
				await regenerateContextFs(vaultRoot, fromRef);
				await regenerateContextFs(vaultRoot, toRef);
				return ok({
					from_space,
					from_path,
					to_space,
					to_path,
					crossed_space: true,
					spins: { removed: viewSpin(removed, view), arrived: viewSpin(arrived, view) },
				});
			} catch (err) {
				if (err instanceof WriteError) return fail(err.message);
				throw err;
			}
		},
	);
}
