import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StatementContainmentError } from "../../../src/core/statement";
import { writeStatementFs } from "../context-fs";
import { buildSpaceRefFs, isSpaceFs } from "../space-fs";
import { readHeadFs } from "../vault-io";
import { fail, notASpace, ok, SPACE_PATH_DESC } from "./helpers";

/**
 * Not one of Spec.md's literal 5 tools, but Spec.md separately says the AI statement is "written
 * through this same server" — this is that write path, mirroring context.ts::writeStatement
 * (already documented there as "the future drop-in point for the MCP server / statement
 * generator"). No new SpinType: the write is recorded as an ordinary `file_modified` on the folder
 * note, because that note is an ordinary file a person also writes in. What makes the statement
 * distinguishable from their words is containment and the signature, not a special log entry.
 *
 * The tool description below is deliberately operational only — what to read first, what a
 * statement must contain, what it must not do — and deliberately carries none of CLAUDE.md's
 * "What a space is" voice/tone doctrine. That's intentional: this description reaches every
 * caller regardless of which agent or client is driving the server, so it shouldn't be the
 * channel that sets personality. Tone stays wherever the calling agent's own instructions
 * (CLAUDE.md, system prompt, etc.) come from. Since the two documents describe the same
 * underlying behavior from different angles, they can drift: if CLAUDE.md's "What a space is"
 * section changes in a way that changes what a statement must *contain* (not just how it should
 * sound), check whether the operational content below still matches.
 */
export function registerWriteStatementTool(server: McpServer, vaultRoot: string): void {
	server.registerTool(
		"write_statement",
		{
			title: "Write a space's AI state statement",
			description:
				"Writes new AI-generated statement text into a space's folder note (between the " +
				"sentinel markers). Everything outside that block is preserved byte for byte, and it " +
				"is not all the same thing: the shared block is yours and the user's both — write " +
				"there with write_shared — and the rest of the note is the user's own writing about " +
				"the space, which you cannot write in at all. Read both, take them seriously, and " +
				"never contradict them silently.\n\n" +
				"This block is regenerated. Anything that has to outlive the next statement — an open " +
				"question, a thread for the next session — belongs in write_shared, not here.\n\n" +
				"Before generating: call read_context on this space, then read the parent's context " +
				"and list_spaces around it (siblings, subspaces). Do not generate from this space's " +
				"own context alone.\n\n" +
				"Every statement needs both parts, together, every time:\n" +
				"- WHAT the space is — grounded strictly in what its own files and history support. " +
				"Do not invent content to fill a gap.\n" +
				"- WHERE it is — its position among its parent, siblings, and subspaces. Do not write " +
				"it as if the space stood alone.\n\n" +
				"The machine index already carries the cold facts — file list, hashes, " +
				"counts, diffs — so do not restate that report. Where the data is thin, silent, or has " +
				"drifted from what a sibling space already records, state that plainly as part of the " +
				"content: an unresolved gap is itself something to report, not something to fill in or " +
				"leave out.",
			inputSchema: {
				space_path: z.string().describe(SPACE_PATH_DESC),
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
			if (!(await isSpaceFs(vaultRoot, space_path))) return notASpace(space_path);
			const ref = buildSpaceRefFs(vaultRoot, space_path);
			const currentHead = await readHeadFs(ref);

			// Compare-and-swap on the head. Without it, a generation that takes a while — which is
			// every real one — can sign the statement with a head reached *after* the text was
			// written, marking as current a statement that never saw the changes it now claims to
			// cover. Silent, and precisely inverted from the truth staleness exists to report.
			if (expect_tip !== undefined && expect_tip !== currentHead) {
				return fail(
					`Refusing to write: "${space_path}" has moved on since you read it ` +
						`(expected ${expect_tip}, now ${currentHead}). Re-read the space and regenerate ` +
						`the statement against its current state.`,
				);
			}

			const atTip = at_tip ?? currentHead;
			if (atTip === null) {
				return fail(`Space "${space_path}" has no log entries yet — nothing to sign a statement against.`);
			}
			try {
				await writeStatementFs(vaultRoot, ref, text, atTip, agent);
			} catch (err) {
				if (err instanceof StatementContainmentError) return fail(err.message);
				throw err;
			}
			return ok({
				ok: true,
				at_tip: atTip,
				signed_by: agent,
				verification:
					"not required — a statement is derived from the log and regenerated with it, so " +
					"it is not held for the user's confirmation. Do not ask them to go verify it.",
			});
		},
	);
}
