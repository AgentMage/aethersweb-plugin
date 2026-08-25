import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { planRegenerationFs } from "../context-fs";
import { walkSpacesFs } from "../space-fs";
import type { SpaceRefFs } from "../space-fs";
import { isUnderOrEqual, ok } from "./helpers";

/**
 * The tree-aware counterpart to check_staleness: same underlying staleness check, but filtered to
 * only what's actually stale and pre-sorted into a bottom-up order — see planRegenerationFs's own
 * doc comment for why depth-descending is a valid order here and why it matters for statements but
 * not for frontmatter. Still read-only/planning-only: this tool never calls regenerate_context or
 * write_statement itself, since (per this server's README) no LLM call happens in this process —
 * the MCP client remains the one doing the actual regeneration and statement generation.
 */
export function registerPlanRegenerationTool(server: McpServer, vaultRoot: string): void {
	server.registerTool(
		"plan_regeneration",
		{
			title: "Plan a bottom-up regeneration order",
			description:
				"Runs the same staleness check as check_staleness (optionally scoped `under` a " +
				"subtree), but returns only the spaces with something stale, sorted deepest-first " +
				"so every subspace is planned before its own parent.\n\n" +
				"regenerate_context is mechanically order-independent — it always reads each " +
				"subspace's actual current head straight off disk, never off that subspace's own " +
				"index. Order matters for write_statement instead: a parent's statement " +
				"places the space in the context of its universe and composition (see " +
				"write_statement's description), which reads better once the children it's reading " +
				"about already carry fresh statements rather than ones about to be rewritten anyway.\n\n" +
				"statement_stale is reported raw, not pre-filtered: it is true the moment one spin " +
				"lands after the statement was written, so a space one trivial edit behind appears " +
				"here too. Weigh statement_drift yourself — a composition change (a subspace " +
				"appearing or vanishing) or no statement ever written is always worth the call; a " +
				"pile of routine edits may not be, and read_log tells you which you have far better " +
				"than the count does.\n\n" +
				"Walk the returned plan in order and, per entry, call regenerate_context when " +
				"needs_regenerate_context is true, and write_statement where you judge the drift " +
				"worth it — `reasons` explains what changed.",
			inputSchema: {
				under: z
					.string()
					.optional()
					.describe('Vault-relative folder path to scope the plan to, e.g. "UserSpace". Omit for the whole vault.'),
				summary: z
					.boolean()
					.default(false)
					.describe("Keep the ordering but drop the prose — space_path and the two flags only."),
			},
		},
		async ({ under, summary }) => {
			const refs: SpaceRefFs[] = [];
			for await (const ref of walkSpacesFs(vaultRoot)) {
				if (under && !isUnderOrEqual(ref, under)) continue;
				refs.push(ref);
			}
			const plan = await planRegenerationFs(vaultRoot, refs);
			// `reasons` is duplicated into every entry from statement_drift, so the prose is most of
			// this response's weight. The ordering is the part that cannot be reconstructed.
			if (summary) {
				return ok(
					{
						total: plan.length,
						plan: plan.map((e) => ({
							space_path: e.space_path,
							needs_regenerate_context: e.needs_regenerate_context,
							statement_stale: e.statement_stale,
						})),
					},
					true,
				);
			}
			return ok({ plan });
		},
	);
}
