import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { signatureStatus } from "../../../src/core/signature";
import { readSignedStatement } from "../../../src/core/statement";
import { buildSpaceRefFs, isSpaceFs } from "../space-fs";
import { fail, notASpace, ok, SPACE_PATH_DESC } from "./helpers";

export function registerReadContextTool(server: McpServer, vaultRoot: string): void {
	server.registerTool(
		"read_context",
		{
			title: "Read a space's context",
			description:
				"Reads a space's context note: the objective frontmatter content list as raw YAML, and " +
				"the AI state statement's prose separated from its signature. statement_status reports " +
				"attribution, not approval: a statement is derived from the log and regenerated with " +
				"it, so `unverified` is its normal state rather than something waiting on the user — " +
				"do not tell them to go confirm it. It is still not settled fact: check it against the " +
				"log and the files, which are the authority, and say where it has drifted.",
			inputSchema: {
				space_path: z.string().describe(SPACE_PATH_DESC),
			},
		},
		async ({ space_path }) => {
			if (!(await isSpaceFs(vaultRoot, space_path))) return notASpace(space_path);
			const ref = buildSpaceRefFs(vaultRoot, space_path);

			let text: string;
			try {
				text = await readFile(ref.contextPath, "utf8");
			} catch {
				return fail(`No context note found at ${ref.contextPath} — try regenerate_context first.`);
			}

			const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n/);
			const frontmatter_text = fmMatch ? fmMatch[1] : "";

			// The statement's prose and its signature are returned apart, so neither the signature
			// comment nor its rendered line is mistaken for part of what the statement says.
			const found = readSignedStatement(text);
			return ok({
				frontmatter_text,
				statement_text: found?.text ?? "",
				statement_signature: found?.signature ?? null,
				statement_status: found ? signatureStatus(found.signature, found.text) : "unsigned",
			});
		},
	);
}
