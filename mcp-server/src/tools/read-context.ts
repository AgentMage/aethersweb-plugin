import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { signatureStatus } from "../../../src/core/signature";
import { readSignedStatement } from "../../../src/core/statement";
import { buildSpaceRefFs, isSpaceFs } from "../space-fs";

export function registerReadContextTool(server: McpServer, vaultRoot: string): void {
	server.registerTool(
		"read_context",
		{
			title: "Read a space's context",
			description:
				"Reads a space's context note: the objective frontmatter content list as raw YAML, and " +
				"the AI state statement's prose separated from its signature. statement_status says " +
				"whether a person has verified the statement — unverified text is not settled fact, " +
				"and only the user can change that, in Obsidian.",
			inputSchema: {
				space_path: z.string().describe('Vault-relative path of the space, e.g. "UserSpace/Location".'),
			},
		},
		async ({ space_path }) => {
			if (!(await isSpaceFs(vaultRoot, space_path))) {
				return errorResult(`"${space_path}" is not a claimed space (no .aether/log.jsonl found).`);
			}
			const ref = buildSpaceRefFs(vaultRoot, space_path);

			let text: string;
			try {
				text = await readFile(ref.contextPath, "utf8");
			} catch {
				return errorResult(`No context note found at ${ref.contextPath} — try regenerate_context first.`);
			}

			const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n/);
			const frontmatter_text = fmMatch ? fmMatch[1] : "";

			// The statement's prose and its signature are returned apart, so neither the signature
			// comment nor its rendered line is mistaken for part of what the statement says.
			const found = readSignedStatement(text);
			return {
				content: [{
					type: "text",
					text: JSON.stringify({
						frontmatter_text,
						statement_text: found?.text ?? "",
						statement_signature: found?.signature ?? null,
						statement_status: found ? signatureStatus(found.signature, found.text) : "unsigned",
					}, null, 2),
				}],
			};
		},
	);
}

function errorResult(message: string) {
	return { content: [{ type: "text" as const, text: message }], isError: true };
}
