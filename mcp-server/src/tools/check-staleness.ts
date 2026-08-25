import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SpaceStaleness } from "../context-fs";
import { checkStalenessFs, summarizeStaleness } from "../context-fs";
import { walkSpacesFs } from "../space-fs";
import { isUnderOrEqual, ok } from "./helpers";

export function registerCheckStalenessTool(server: McpServer, vaultRoot: string): void {
	server.registerTool(
		"check_staleness",
		{
			title: "Check context staleness",
			description:
				"For every space (optionally scoped `under` a subtree), compares its machine index's " +
				"recorded source_tip — and the statement's own signature at_tip — against its actual " +
				"current log head, and each recorded subspace tip against that subspace's own actual " +
				"current head, to report what needs regenerate_context or write_statement. Read-only " +
				"— flags staleness, never fixes it.\n\n" +
				"statement_stale is a fact, not a recommendation: it is true the moment a single spin " +
				"lands after the statement was written. statement_drift carries what actually piled " +
				"up (spin count, and whether any of it changed the space's composition). Deciding " +
				"whether that is worth a write_statement call is yours — read the log and see what " +
				"changed rather than going by the count alone. plan_regeneration is the tree-aware " +
				"counterpart, sorted deepest-first.\n\n" +
				"Full detail by default. `stale_only` keeps the same per-space shape but drops spaces " +
				"with nothing stale. `summary` returns counts plus one line per stale space, and the " +
				"bare paths of spaces that have never had a statement written at all — enough to decide " +
				"where to look, not enough to act on. `summary` supersedes `stale_only`.\n\n" +
				"In summary mode `structural` means a subspace appeared or vanished among this space's " +
				"own spins. It is not the subspace-tip drift reported by `needs_context` — that is index " +
				"staleness, which lives in the parent's index and never in its log.",
			inputSchema: {
				under: z
					.string()
					.optional()
					.describe('Vault-relative folder path to scope the check to, e.g. "UserSpace". Omit for the whole vault.'),
				stale_only: z
					.boolean()
					.default(false)
					.describe("Return only the spaces with something stale, in the same per-space shape."),
				summary: z
					.boolean()
					.default(false)
					.describe("Return counts and one line per stale space instead of full detail. Supersedes stale_only."),
			},
		},
		async ({ under, stale_only, summary }) => {
			const spaces: SpaceStaleness[] = [];
			for await (const ref of walkSpacesFs(vaultRoot)) {
				if (under && !isUnderOrEqual(ref, under)) continue;
				spaces.push(await checkStalenessFs(vaultRoot, ref));
			}

			// Neither flag saves any work — the walk still reads every log. This is payload control.
			if (summary) return ok(summarizeStaleness(spaces), true);
			if (stale_only) {
				// The two counts come along so that "nothing is stale" stays distinguishable from
				// "`under` matched no spaces at all".
				return ok({
					total_spaces: spaces.length,
					stale_count: spaces.filter((s) => s.stale).length,
					spaces: spaces.filter((s) => s.stale),
				});
			}
			return ok({ spaces });
		},
	);
}
