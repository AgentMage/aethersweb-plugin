import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { signatureStatus } from "../../../src/core/signature";
import { readSignedBlock, readSignedStatement } from "../../../src/core/statement";
import { checkStalenessFs } from "../context-fs";
import {
	buildSpaceRefFs,
	hashFileFs,
	immediateFilesFs,
	immediateSubspacesFs,
	isSpaceFs,
	relativePathFs,
} from "../space-fs";
import { readHeadFs } from "../vault-io";
import { notASpace, ok, SPACE_PATH_DESC } from "./helpers";

/**
 * One call that answers both halves of what a statement has to say: **what** a space is, and
 * **where** it sits.
 *
 * The tool surface used to make the second half expensive. `read_context` returned one space's
 * note; `list_spaces` returned a flat array of path strings. An agent asked to place a space among
 * its parent, siblings and subspaces had to reconstruct the tree by splitting paths, then issue a
 * call per neighbour — so the cheapest thing to do was describe the space alone, which is the one
 * thing a statement is never allowed to do. Making position a single cheap read is the schema
 * taking a side: containment is what AethersWeb models, so containment is what its primary read
 * returns.
 */
export function registerDescribeSpaceTool(server: McpServer, vaultRoot: string): void {
	server.registerTool(
		"describe_space",
		{
			title: "Describe a space and its position",
			description:
				"The primary read. Returns a space's own contents (files with hashes and sizes, log " +
				"head, current statement) together with its position in the tree (parent, siblings, " +
				"and each subspace with its tip and shape), plus staleness flags.\n\n" +
				"Also returns shared_text: the folder note's shared block, which you and the user " +
				"both write in (write_shared) and nothing regenerates. Read it before writing.\n\n" +
				"Prefer this over read_context when you are about to write a statement: it is what " +
				"the two required halves — what the space is, and where it sits — are read from. " +
				"Use read_file on the files it lists when the statement needs what they actually say " +
				"rather than that they exist.\n\n" +
				"statement_status reports the AI content's attribution: unsigned, unverified, verified, " +
				"stale_signature (edited after signing), or stale_verification (edited after a person " +
				"confirmed it). A statement is derived from the log and regenerated with it, so it is " +
				"not held for the user's confirmation — `unverified` is its ordinary state, not a task " +
				"to hand them. Never treat an unverified statement as settled either: the log and the " +
				"files are the authority, and `stale_signature` means a person edited the prose, so " +
				"those words are theirs and not yours to overwrite silently.",
			inputSchema: {
				space_path: z.string().describe(SPACE_PATH_DESC),
			},
		},
		async ({ space_path }) => {
			if (!(await isSpaceFs(vaultRoot, space_path))) return notASpace(space_path);
			const ref = buildSpaceRefFs(vaultRoot, space_path);

			const segments = space_path.split("/");
			const name = segments[segments.length - 1];
			const parentPath = segments.slice(0, -1).join("/");

			const files = [];
			for (const absFilePath of await immediateFilesFs(ref)) {
				files.push({ path: relativePathFs(ref, absFilePath), hash: await hashFileFs(absFilePath) });
			}

			const subspaces = [];
			for (const sub of await immediateSubspacesFs(vaultRoot, ref)) {
				const [subFiles, subSubs] = await Promise.all([
					immediateFilesFs(sub),
					immediateSubspacesFs(vaultRoot, sub),
				]);
				subspaces.push({
					name: sub.path.split("/").pop() ?? sub.path,
					path: sub.path,
					tip: await readHeadFs(sub),
					file_count: subFiles.length,
					subspace_count: subSubs.length,
				});
			}

			// Siblings come from the parent's own subspace listing rather than a path scan, so a
			// space is placed among the things its parent actually claims as children.
			let parent: { path: string; name: string } | null = null;
			let siblings: string[] = [];
			if (parentPath && (await isSpaceFs(vaultRoot, parentPath))) {
				const parentRef = buildSpaceRefFs(vaultRoot, parentPath);
				parent = { path: parentPath, name: parentPath.split("/").pop() ?? parentPath };
				siblings = (await immediateSubspacesFs(vaultRoot, parentRef))
					.map((s) => s.path.split("/").pop() ?? s.path)
					.filter((n) => n !== name);
			}

			let statement_text = "";
			let statement_signature = null;
			let statement_status = "unsigned";
			let shared_text = "";
			let shared_signature = null;
			try {
				const noteText = await readFile(ref.contextPath, "utf8");
				const found = readSignedStatement(noteText);
				if (found) {
					statement_text = found.text;
					statement_signature = found.signature;
					statement_status = signatureStatus(found.signature, found.text);
				}
				// The shared block is returned by the primary read for the same reason position is:
				// this is the call an agent makes before writing a statement, and anything the person
				// left for whoever works here next is worthless if the recommended path walks past it.
				const shared = readSignedBlock(noteText, "shared");
				if (shared) {
					shared_text = shared.text;
					shared_signature = shared.signature;
				}
			} catch {
				statement_text = "";
			}

			const staleness = await checkStalenessFs(vaultRoot, ref);

			return ok({
				space_path,
				name,
				depth: segments.length,
				head: await readHeadFs(ref),
				parent,
				siblings,
				subspaces,
				files,
				statement_text,
				// Who wrote the statement, and whether a person has confirmed it — reported, not
				// escalated. A statement is regenerated with the log, so "unverified" is where it
				// normally sits; the states that mean something here are "verified" (someone chose to
				// stand behind it anyway) and "stale_signature" (someone edited the prose by hand).
				// Content a person is actually asked to confirm lives in authored files, not here.
				statement_signature,
				statement_status,
				// The folder note's shared block: written by agents and by the person, and never
				// regenerated. Read it before writing anything about this space — and if what it
				// holds contradicts the statement you were about to write, say so rather than
				// writing around it.
				shared_text,
				shared_signature,
				staleness,
			});
		},
	);
}
