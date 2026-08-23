import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { signatureStatus } from "../../../src/core/signature";
import { readSignedBlock, readSignedStatement, stripBlocks } from "../../../src/core/statement";
import { buildSpaceRefFs, isSpaceFs } from "../space-fs";
import { fail, notASpace, ok, SPACE_PATH_DESC } from "./helpers";

export function registerReadContextTool(server: McpServer, vaultRoot: string): void {
	server.registerTool(
		"read_context",
		{
			title: "Read a space's context",
			description:
				"Reads a space's derived context: the objective content list from its machine index " +
				"(.aether/index.md) as raw YAML, and the AI state statement's prose separated from its " +
				"signature. statement_status reports attribution, not approval: a statement is derived " +
				"from the log and regenerated with it, so `unverified` is its normal state rather than " +
				"something waiting on the user — do not tell them to go confirm it. It is still not " +
				"settled fact: check it against the log and the files, which are the authority, and " +
				"say where it has drifted.\n\n" +
				"The folder note has three regions and they are not interchangeable:\n" +
				"- statement_text — yours, and regenerated from the log whenever the space moves on. " +
				"Nothing you leave here survives the next write_statement.\n" +
				"- shared_text — the shared block, yours and the user's both (write_shared). Read it " +
				"before writing anything: what the user put there is addressed to whoever works in " +
				"this space next. Empty when nobody has written in it yet.\n" +
				"- note_text — the user's own writing, with both blocks stripped out. You cannot write " +
				"here at all. Take it seriously as context and never contradict it silently. Empty " +
				"when they haven't written any.",
			inputSchema: {
				space_path: z.string().describe(SPACE_PATH_DESC),
			},
		},
		async ({ space_path }) => {
			if (!(await isSpaceFs(vaultRoot, space_path))) return notASpace(space_path);
			const ref = buildSpaceRefFs(vaultRoot, space_path);

			let indexText: string;
			try {
				indexText = await readFile(ref.indexPath, "utf8");
			} catch {
				return fail(`No index found at ${ref.indexPath} — try regenerate_context first.`);
			}
			const fmMatch = indexText.match(/^---\n([\s\S]*?)\n---\n/);
			const frontmatter_text = fmMatch ? fmMatch[1] : "";

			const noteText = await readFile(ref.contextPath, "utf8").catch(() => "");

			// The statement's prose and its signature are returned apart, so neither the signature
			// comment nor its rendered line is mistaken for part of what the statement says. The
			// person's own writing is returned apart from both, for the same reason in reverse:
			// nothing they wrote should read as something an agent generated.
			const found = readSignedStatement(noteText);
			const shared = readSignedBlock(noteText, "shared");
			// Both blocks come out of note_text, not just the statement's. Leaving the shared block
			// in it would report text an agent is free to write in as the person's untouchable
			// writing — the one distinction this whole surface exists to keep straight.
			const note_text = stripBlocks(noteText);

			return ok({
				frontmatter_text,
				statement_text: found?.text ?? "",
				statement_signature: found?.signature ?? null,
				statement_status: found ? signatureStatus(found.signature, found.text) : "unsigned",
				shared_text: shared?.text ?? "",
				shared_signature: shared?.signature ?? null,
				shared_last_written_by: shared?.signature?.agent ?? null,
				note_text,
			});
		},
	);
}
