import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SpaceStaleness } from "../context-fs";
import { checkStalenessFs } from "../context-fs";
import { walkSpacesFs } from "../space-fs";
import type { SpaceRefFs } from "../space-fs";

export function registerCheckStalenessTool(server: McpServer, vaultRoot: string): void {
	server.registerTool(
		"check_staleness",
		{
			title: "Check context staleness",
			description:
				"For every space (optionally scoped `under` a subtree), compares its context note's " +
				"recorded source_tip/statement_tip against its actual current log head, and each " +
				"recorded subspace tip against that subspace's own actual current head, to report " +
				"what needs regenerate_context or write_statement. Read-only — flags staleness, " +
				"never fixes it.\n\n" +
				"statement_stale is the raw fact (does statement_tip differ from current_head at " +
				"all); statement_drift is the judgment on top of it — whether the spins since the " +
				"last statement are actually worth a write_statement call, or just a trivial edit or " +
				"two not yet worth bothering anyone about. plan_regeneration is the tree-aware, " +
				"drift-filtered counterpart if you want only the spaces that cross that bar.",
			inputSchema: {
				under: z
					.string()
					.optional()
					.describe('Vault-relative folder path to scope the check to, e.g. "UserSpace". Omit for the whole vault.'),
			},
		},
		async ({ under }) => {
			const spaces: SpaceStaleness[] = [];
			for await (const ref of walkSpacesFs(vaultRoot)) {
				if (under && !isUnderOrEqual(ref, under)) continue;
				spaces.push(await checkStalenessFs(vaultRoot, ref));
			}
			return { content: [{ type: "text", text: JSON.stringify({ spaces }, null, 2) }] };
		},
	);
}

function isUnderOrEqual(ref: SpaceRefFs, under: string): boolean {
	return ref.path === under || ref.path.startsWith(`${under}/`);
}
