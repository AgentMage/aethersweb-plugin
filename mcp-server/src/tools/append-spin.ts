import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SpinType } from "../../../src/core/types";
import { regenerateContextFs } from "../context-fs";
import { buildSpaceRefFs, isSpaceFs } from "../space-fs";
import { appendSpinFs } from "../vault-io";
import { fail, ok } from "./helpers";
import { viewSpin } from "./spin-view";

/**
 * What this tool may still write, now that real authoring tools exist.
 *
 * It used to accept nearly every SpinType, which made the log a place a client could *assert*
 * things into rather than a record of what happened: `file_created` with a caller-supplied
 * content_hash is a history entry nothing on disk has to agree with. Every type removed below has
 * a tool that performs the change and records it from the bytes it actually wrote —
 * `write_file`, `delete_file`, `move_file`, `create_space`, `move_space` — or is caught by
 * `reconcile_space` when it happened outside this server entirely.
 *
 * What is left is `checkpoint`: reserved for log-pruning, describing the log itself rather than
 * making a claim about the filesystem. `chain_repaired` stays excluded as it always was — its
 * presence is what repair UIs read as "this break was already handled", so a fabricated one is a
 * genuine integrity hole.
 */
const APPENDABLE_SPIN_TYPES = ["checkpoint"] as const satisfies readonly SpinType[];

export function registerAppendSpinTool(server: McpServer, vaultRoot: string): void {
	server.registerTool(
		"append_spin",
		{
			title: "Append a spin to a space's log",
			description:
				"Appends one event to a space's authoritative, hash-chained log and regenerates its " +
				"context note. The target must already be a claimed space (v1 does not scaffold new " +
				"spaces through this server — that stays a plugin-only GUI action). chain_repaired is " +
				"not appendable here; it's written only by the plugin's own repair flow.",
			inputSchema: {
				space_path: z.string().describe('Vault-relative path of the space, e.g. "UserSpace/Location".'),
				spin_type: z.enum(APPENDABLE_SPIN_TYPES),
				source: z.enum(["observed", "detected"]).default("observed"),
				payload: z
					.object({
						path: z.string().optional(),
						content_hash: z.string().optional(),
						size: z.number().optional(),
						content: z.string().optional(),
						diff: z.string().optional(),
						encoding: z.enum(["utf8", "base64"]).optional(),
						old_path: z.string().optional(),
						subspace_name: z.string().optional(),
					})
					.default({}),
				return_content: z
					.boolean()
					.default(false)
					.describe("Echo any recorded content/diff back in the spin payload. Off by default."),
			},
		},
		async ({ space_path, spin_type, source, payload, return_content }) => {
			if (!(await isSpaceFs(vaultRoot, space_path))) {
				return fail(`"${space_path}" is not a claimed space (no .aether/log.jsonl found) — space creation is plugin-only in v1.`);
			}
			const ref = buildSpaceRefFs(vaultRoot, space_path);
			const spin = await appendSpinFs(ref, spin_type, source, payload);
			await regenerateContextFs(vaultRoot, ref);
			return ok({ spin: viewSpin(spin, { content: return_content, diff: return_content }) });
		},
	);
}
