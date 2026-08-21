import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { planRegenerationFs } from "../context-fs";
import { walkSpacesFs } from "../space-fs";
import type { SpaceRefFs } from "../space-fs";
import { isUnderOrEqual } from "./helpers";

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
				"subtree), but returns only the spaces that actually need work, sorted deepest-first " +
				"so every subspace is planned before its own parent.\n\n" +
				"regenerate_context is mechanically order-independent — it always reads each " +
				"subspace's actual current head straight off disk, never off that subspace's own " +
				"context note. Order matters for write_statement instead: a parent's statement " +
				"places the space in the context of its universe and composition (see " +
				"write_statement's description), which reads better once the children it's reading " +
				"about already carry fresh statements rather than ones about to be rewritten anyway.\n\n" +
				"needs_write_statement is a judgment, not just a tip mismatch: a space whose " +
				"statement is only a handful of routine edits behind is left out of the plan " +
				"entirely — the point of a threshold is that trivial drift never shows up here " +
				"at all, so every space that does appear is worth the write_statement call. A " +
				"subspace appearing or vanishing, or no statement ever having been written, " +
				"always crosses it regardless of count.\n\n" +
				"Walk the returned plan in order and, per entry, call regenerate_context when " +
				"needs_regenerate_context is true and write_statement when needs_write_statement is " +
				"true — `reasons` explains what triggered each.",
			inputSchema: {
				under: z
					.string()
					.optional()
					.describe('Vault-relative folder path to scope the plan to, e.g. "UserSpace". Omit for the whole vault.'),
			},
		},
		async ({ under }) => {
			const refs: SpaceRefFs[] = [];
			for await (const ref of walkSpacesFs(vaultRoot)) {
				if (under && !isUnderOrEqual(ref, under)) continue;
				refs.push(ref);
			}
			const plan = await planRegenerationFs(vaultRoot, refs);
			return { content: [{ type: "text", text: JSON.stringify({ plan }, null, 2) }] };
		},
	);
}
