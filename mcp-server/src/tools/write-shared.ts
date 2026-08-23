import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StatementContainmentError } from "../../../src/core/statement";
import { writeSharedFs } from "../context-fs";
import { buildSpaceRefFs, isSpaceFs } from "../space-fs";
import { fail, notASpace, ok, SPACE_PATH_DESC } from "./helpers";

/**
 * The write path for the folder note's third region — the one the person and an agent both hold.
 *
 * It exists because the other two regions leave nothing in between. A statement is regenerated from
 * the log, so anything an agent leaves there is gone the next time the space moves on; everything
 * outside the blocks is the person's and no AI write reaches it. That left nowhere for the things
 * that are neither derived nor private: a question an agent wants answered before it writes about a
 * space, a running list it is keeping across sessions, a note the person wants an agent to read
 * first. This is that place, and it is the same file the person already reads.
 *
 * `mode` defaults to "append" deliberately — see context-fs.ts::writeSharedFs. The description
 * below says so plainly rather than leaving it as a parameter default a caller might override
 * casually, because the cost of a careless replace lands on the person's own words.
 */
export function registerWriteSharedTool(server: McpServer, vaultRoot: string): void {
	server.registerTool(
		"write_shared",
		{
			title: "Write into a space's shared block",
			description:
				"Writes into the shared block of a space's folder note — the one region of the note " +
				"that belongs to you and the user both. Unlike the statement block, nothing here is " +
				"regenerated over; unlike the rest of the note, you are allowed to write in it.\n\n" +
				"Read it first (read_context returns it as shared_text). The user writes here too, and " +
				"what they left is addressed to whoever works in this space next — that is you.\n\n" +
				"Use it for what does not belong in a statement: a question you need answered before " +
				"you can describe this space honestly, an open thread you want the next session to " +
				"pick up, a correction you are not certain enough about to assert. A statement says " +
				"what the space is, grounded in the log; this says what is still unresolved between " +
				"the two of you. Do not restate the statement here, and do not use it as scratch " +
				"space — the user reads this file.\n\n" +
				'mode defaults to "append", which leaves everything already in the block untouched and ' +
				'puts your text beneath it. Use "replace" only to rewrite text you yourself put there ' +
				"and only when you have just read it — a replace overwrites the user's words in this " +
				"block as readily as your own, and re-typing their sentences is not preserving them.",
			inputSchema: {
				space_path: z.string().describe(SPACE_PATH_DESC),
				text: z.string().describe("What to write into the shared block."),
				agent: z
					.string()
					.describe('Identify yourself for the signature, e.g. "claude-opus-5". Recorded as the last writer.'),
				mode: z
					.enum(["append", "replace"])
					.optional()
					.describe(
						'"append" (default) adds your text below what is already there. "replace" rewrites the ' +
							"whole block, including anything the user wrote in it.",
					),
			},
		},
		async ({ space_path, text, agent, mode }) => {
			if (!(await isSpaceFs(vaultRoot, space_path))) return notASpace(space_path);
			const ref = buildSpaceRefFs(vaultRoot, space_path);
			try {
				await writeSharedFs(vaultRoot, ref, text, agent, mode ?? "append");
			} catch (err) {
				if (err instanceof StatementContainmentError) return fail(err.message);
				throw err;
			}
			return ok({
				ok: true,
				mode: mode ?? "append",
				signed_by: agent,
				verification:
					"not required — the shared block is the user's to write in as much as yours, so it is " +
					"never held for their confirmation. Do not ask them to go verify it.",
			});
		},
	);
}
