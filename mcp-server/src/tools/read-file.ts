import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { BINARY_EXTENSIONS } from "../../../src/core/constants";
import { buildSpaceRefFs, isSpaceFs } from "../space-fs";
import { fail, notASpace, ok, SPACE_PATH_DESC } from "./helpers";

const MAX_TEXT_BYTES = 512 * 1024;

/**
 * Reads a file a space actually holds.
 *
 * Its absence was the single largest hole in the surface. `write_statement` is instructed to
 * ground itself "strictly in what the data supports", but every read tool returned *metadata* —
 * paths, hashes, sizes, counts. An agent could see that a space contained `GPS.md` and never learn
 * what it said. Locally that was survivable because the client had its own filesystem tools; over
 * a remote or headless connection it is not, and a statement written from a file listing alone is
 * exactly the invented-to-fill-a-gap prose the doctrine forbids.
 */
export function registerReadFileTool(server: McpServer, vaultRoot: string): void {
	server.registerTool(
		"read_file",
		{
			title: "Read a file inside a space",
			description:
				"Returns the contents of one file belonging to a space, addressed by its path relative " +
				"to that space. Text is returned as-is; binary files are returned base64-encoded with " +
				"encoding: \"base64\". Read the files a statement will describe — a file list tells you " +
				"a space has notes, not what it is.",
			inputSchema: {
				space_path: z.string().describe(SPACE_PATH_DESC),
				path: z.string().describe('Path relative to the space, e.g. "GPS.md".'),
			},
		},
		async ({ space_path, path }) => {
			if (!(await isSpaceFs(vaultRoot, space_path))) return notASpace(space_path);
			if (path.split("/").some((s) => s === "" || s === "." || s === "..")) {
				return fail(`path must be relative to the space, with no traversal segments: "${path}"`);
			}

			const ref = buildSpaceRefFs(vaultRoot, space_path);
			const absPath = join(ref.absPath, path);

			let size: number;
			try {
				size = (await stat(absPath)).size;
			} catch {
				return fail(`no file at "${path}" in ${space_path}.`);
			}

			const ext = (path.split("/").pop() ?? "").split(".").pop()?.toLowerCase() ?? "";
			if (BINARY_EXTENSIONS.has(ext)) {
				return ok({ space_path, path, size, encoding: "base64", content: (await readFile(absPath)).toString("base64") });
			}
			if (size > MAX_TEXT_BYTES) {
				return fail(`"${path}" is ${size} bytes, over the ${MAX_TEXT_BYTES}-byte read limit.`);
			}
			return ok({ space_path, path, size, encoding: "utf8", content: await readFile(absPath, "utf8") });
		},
	);
}
