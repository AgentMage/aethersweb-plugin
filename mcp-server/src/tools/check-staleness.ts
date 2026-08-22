import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SpaceStaleness } from "../context-fs";
import { checkStalenessFs } from "../context-fs";
import { walkSpacesFs } from "../space-fs";
import { isUnderOrEqual } from "./helpers";

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
				"counterpart, sorted deepest-first.",
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
