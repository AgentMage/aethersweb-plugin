import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StatementContainmentError } from "../../../src/core/statement";
import { writeStatementFs } from "../context-fs";
import { buildSpaceRefFs, isSpaceFs } from "../space-fs";
import { readHeadFs } from "../vault-io";

/**
 * Not one of Spec.md's literal 5 tools, but Spec.md separately says the AI statement is "written
 * through this same server" — this is that write path, mirroring context.ts::writeStatement
 * (already documented there as "the future drop-in point for the MCP server / statement
 * generator"). Deliberately bypasses the log entirely: a statement is a non-authoritative,
 * disposable annotation, not a replayable file event, so it has no business becoming a SpinType.
 */
export function registerWriteStatementTool(server: McpServer, vaultRoot: string): void {
	server.registerTool(
		"write_statement",
		{
			title: "Write a space's AI state statement",
			description:
				"Writes new AI-generated statement text into a space's context note (between the " +
				"sentinel markers) and stamps statement_tip. Does not touch the objective frontmatter " +
				"and does not append a spin — the statement is derived/disposable, not authoritative.\n\n" +
				"Before generating: call read_context on this space, and don't stop there — read the " +
				"parent's context and list_spaces around it (siblings, subspaces). A space is a real " +
				"piece of someone's real life, not a record about it — see CLAUDE.md's \"What a space " +
				"is\" for the full doctrine this description operationalizes.\n\n" +
				"Every statement needs both halves, together, every time:\n" +
				"- WHAT the space is — its own character, read from its files and history, grounded " +
				"strictly in what the data supports. Nothing invented to fill a gap.\n" +
				"- WHERE it is — its position among its parent, siblings, and subspaces. Never written " +
				"as if it stood alone.\n\n" +
				"The frontmatter next to this text already carries the cold facts — file list, hashes, " +
				"counts, diffs — so this is not a second copy of that report. But it isn't free-standing " +
				"prose either: where the data is thin, silent, or drifted from what a sibling space " +
				"already records, say so plainly instead of smoothing it into a finished-sounding " +
				"sentence. The goal is verified clarity — handing the person back what the log and files " +
				"actually establish about their own subjective universe, kept visibly separate from " +
				"what's still open and worth them going to confirm themselves. A statement that resolves " +
				"every gap instead of naming it has failed at this, no matter how well it reads.",
			inputSchema: {
				space_path: z.string().describe('Vault-relative path of the space, e.g. "UserSpace/Location".'),
				text: z.string().describe("The AI-generated state statement text to write."),
				agent: z
					.string()
					.describe('Identify yourself for the signature, e.g. "claude-opus-5". Recorded alongside the statement.'),
				at_tip: z
					.string()
					.optional()
					.describe("The log tip hash this statement was generated against. Defaults to the space's current head."),
				expect_tip: z
					.string()
					.optional()
					.describe(
						"Refuse the write unless the space's head still equals this. Pass the head you read " +
						"before generating, so a statement is never stamped fresh against a log that moved on " +
						"while you were writing it.",
					),
			},
		},
		async ({ space_path, text, agent, at_tip, expect_tip }) => {
			if (!(await isSpaceFs(vaultRoot, space_path))) {
				return {
					content: [{ type: "text" as const, text: `"${space_path}" is not a claimed space (no .aether/log.jsonl found).` }],
					isError: true,
				};
			}
			const ref = buildSpaceRefFs(vaultRoot, space_path);
			const currentHead = await readHeadFs(ref);

			// Compare-and-swap on the head. Without it, a generation that takes a while — which is
			// every real one — can stamp statement_tip with a head reached *after* the text was
			// written, marking as current a statement that never saw the changes it now claims to
			// cover. Silent, and precisely inverted from the truth staleness exists to report.
			if (expect_tip !== undefined && expect_tip !== currentHead) {
				return {
					content: [{
						type: "text" as const,
						text:
							`Refusing to write: "${space_path}" has moved on since you read it ` +
							`(expected ${expect_tip}, now ${currentHead}). Re-read the space and regenerate ` +
							`the statement against its current state.`,
					}],
					isError: true,
				};
			}

			const atTip = at_tip ?? currentHead;
			if (atTip === null) {
				return {
					content: [{ type: "text" as const, text: `Space "${space_path}" has no log entries yet — nothing to stamp statement_tip against.` }],
					isError: true,
				};
			}
			try {
				await writeStatementFs(ref, text, atTip, agent);
			} catch (err) {
				if (err instanceof StatementContainmentError) {
					return { content: [{ type: "text" as const, text: err.message }], isError: true };
				}
				throw err;
			}
			return {
				content: [{
					type: "text",
					text: JSON.stringify({
						ok: true,
						statement_tip: atTip,
						signed_by: agent,
						verification: "pending — only a person can verify, in Obsidian",
					}, null, 2),
				}],
			};
		},
	);
}
