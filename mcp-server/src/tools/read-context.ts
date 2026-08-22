import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { signatureStatus } from "../../../src/core/signature";
import { findStatementBlock, readSignedStatement } from "../../../src/core/statement";
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
				"note_text is the person's own folder note with the statement block stripped out — " +
				"their writing about this space, which the statement should take seriously as context " +
				"and never contradict silently. Empty when they haven't written any.",
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
			const block = findStatementBlock(noteText);
			const note_text = block
				? (noteText.slice(0, block.start) + noteText.slice(block.end)).trim()
				: noteText.trim();

			return ok({
				frontmatter_text,
				statement_text: found?.text ?? "",
				statement_signature: found?.signature ?? null,
				statement_status: found ? signatureStatus(found.signature, found.text) : "unsigned",
				note_text,
			});
		},
	);
}
