import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { regenerateContextFs } from "../context-fs";
import { buildSpaceRefFs, isSpaceFs } from "../space-fs";
import { appendFileDeletedFs } from "../vault-io";
import { StatementContainmentError } from "../../../src/core/statement";
import { removeFileFs, writeFileFs, WriteError } from "../write-fs";
import { fail, notASpace, ok, SPACE_PATH_DESC } from "./helpers";
import { viewSpin } from "./spin-view";

/**
 * Writing a file and recording that it was written are one operation here, not two.
 *
 * The alternative the surface used to offer was `append_spin`: write the file however you like,
 * then describe it to the log separately. That makes the log a claim rather than a record — the
 * content hash is whatever the caller says it is, and nothing checks it against the bytes on disk.
 * These tools hash what they actually wrote, so a space's history cannot disagree with its
 * filesystem no matter what the caller believes.
 *
 * Authored content is additionally confined to an AETHERSWEB:STATEMENT block and signed, so a
 * vault always says plainly which words are the person's, which a machine supplied, who supplied
 * them, and whether the person has ever confirmed them — see core/statement.ts and
 * core/signature.ts.
 */
export function registerWriteFileTool(server: McpServer, vaultRoot: string): void {
	server.registerTool(
		"write_file",
		{
			title: "Write a file into a space",
			description:
				"Writes AI-generated content into a file inside a space and records it in that space's " +
				"log in one step. Every write is attributed to you via `agent`.\n\n" +
				"For markdown and plain text, **the content is written inside a signed " +
				"AETHERSWEB:STATEMENT block.** `content` is therefore the AI-written portion of the " +
				"file, not the whole file: anything outside the block is left exactly as it was, so a " +
				"person's own writing in the same note is never overwritten, and a file with no block " +
				"yet gets one appended rather than taken over. Reading the file back returns more than " +
				"you passed whenever a human has written alongside it.\n\n" +
				"Formats that cannot carry an HTML comment (JSON, CSV, binary) are written as-is and " +
				"attributed in the log instead — set encoding: \"base64\" for binary. Attribution is " +
				"never skipped, only relocated.\n\n" +
				"Text containing a statement or signature marker verbatim is refused: it would break " +
				"out of its own block or forge its signature. Refer to markers descriptively.\n\n" +
				"The signature records that an agent wrote this, and unlike a space statement — which is " +
				"derived from the log and regenerated with it — an authored file is held for the " +
				"person: it stands unverified until they confirm it in Obsidian. You cannot verify " +
				"your own output; that is the point of the record.\n\n" +
				"mode defaults to \"replace\", which rewrites the whole block. Use \"append\" to add " +
				"beneath what the block already holds — your text lands under it with a blank line " +
				"between, and you send only the new part rather than the whole note. Append is refused " +
				"for JSON, CSV and binary, which have no block to append to. Either way the block is " +
				"re-signed, so a person's earlier verification of it lapses.\n\n" +
				"Returns spin: null when the resulting file is byte-identical to what the log already " +
				"holds. The path is relative to the space and may not reach into a subspace.\n\n" +
				"The response carries metadata only: the recorded content and diff are left out, since " +
				"they are the text you just sent. The log still records both in full — read them back " +
				"with read_log(include_content: true), or set return_content / return_diff here.",
			inputSchema: {
				space_path: z.string().describe(SPACE_PATH_DESC),
				path: z.string().describe('Path relative to the space, e.g. "GPS.md".'),
				content: z
					.string()
					.describe("The AI-written portion of the file. Written inside a signed AETHERSWEB:STATEMENT block where the format allows; content outside the block is preserved."),
				agent: z
					.string()
					.describe('Identify yourself for the signature, e.g. "claude-opus-5". Recorded in the file and in the log.'),
				encoding: z.enum(["utf8", "base64"]).default("utf8").describe("Use base64 for binary files."),
				mode: z
					.enum(["replace", "append"])
					.default("replace")
					.describe('"replace" (default) rewrites the whole block. "append" adds your text beneath what is already in it.'),
				return_content: z
					.boolean()
					.default(false)
					.describe("Echo the recorded content back in the spin payload. Off by default — on a create it is the text you just sent."),
				return_diff: z
					.boolean()
					.default(false)
					.describe("Echo the recorded unified diff back in the spin payload. Off by default."),
			},
		},
		async ({ space_path, path, content, agent, encoding, mode, return_content, return_diff }) => {
			if (!(await isSpaceFs(vaultRoot, space_path))) return notASpace(space_path);
			const ref = buildSpaceRefFs(vaultRoot, space_path);
			try {
				const { spin, created, signed_inline } = await writeFileFs(
					vaultRoot,
					ref,
					path,
					content,
					agent,
					encoding,
					"observed",
					mode,
				);
				if (spin) await regenerateContextFs(vaultRoot, ref);
				return ok({
					space_path,
					path,
					created,
					mode,
					signed_inline,
					verification: "pending — only a person can verify, in Obsidian",
					spin: viewSpin(spin, { content: return_content, diff: return_diff }),
				});
			} catch (err) {
				if (err instanceof WriteError || err instanceof StatementContainmentError) return fail(err.message);
				throw err;
			}
		},
	);
}

export function registerDeleteFileTool(server: McpServer, vaultRoot: string): void {
	server.registerTool(
		"delete_file",
		{
			title: "Delete a file from a space",
			description:
				"Removes a file from a space and records the removal in that space's log. Returns " +
				"spin: null when the log already had the path recorded as gone. Deletes the file " +
				"outright — there is no undo through this server; the log preserves what it contained.",
			inputSchema: {
				space_path: z.string().describe(SPACE_PATH_DESC),
				path: z.string().describe('Path relative to the space, e.g. "GPS.md".'),
			},
		},
		async ({ space_path, path }) => {
			if (!(await isSpaceFs(vaultRoot, space_path))) return notASpace(space_path);
			const ref = buildSpaceRefFs(vaultRoot, space_path);
			try {
				await removeFileFs(vaultRoot, ref, path);
				const spin = await appendFileDeletedFs(ref, path);
				if (spin) await regenerateContextFs(vaultRoot, ref);
				return ok({ space_path, path, deleted: true, spin: viewSpin(spin) });
			} catch (err) {
				if (err instanceof WriteError) return fail(err.message);
				throw err;
			}
		},
	);
}
