import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Spin } from "../../../src/core/types";
import { buildSpaceRefFs, isSpaceFs } from "../space-fs";
import { readLogFs } from "../vault-io";
import { notASpace, ok, SPACE_PATH_DESC } from "./helpers";

/**
 * Reads what actually happened in a space.
 *
 * The log is the authoritative artifact in this whole model, and until now nothing could read it:
 * `verify_chain` reported only whether it was intact, and `read_context` returned the derived note
 * built from it. An agent could confirm a space's history was unbroken while having no way to see
 * what that history was.
 *
 * `include_content` is off by default and that default matters. Since the log carries real content
 * — full snapshots on creation, unified diffs on every text change — a space with an actively
 * edited file holds far more payload than an agent asking "what happened here lately" needs, and
 * paying for all of it by default would make the honest call the expensive one.
 */
export function registerReadLogTool(server: McpServer, vaultRoot: string): void {
	server.registerTool(
		"read_log",
		{
			title: "Read a space's log",
			description:
				"Returns spins from a space's hash-chained log, newest last. The log records only this " +
				"space's own level — a subspace's changes live in that subspace's log, never here.\n\n" +
				"Metadata only by default (seq, timestamp, type, observed-vs-detected source, path, " +
				"content hash). Set include_content to also return the recorded file content and " +
				"diffs, which is what lets you reconstruct what a file said at any point — but is " +
				"considerably larger.",
			inputSchema: {
				space_path: z.string().describe(SPACE_PATH_DESC),
				limit: z.number().int().positive().max(500).default(50).describe("Most recent spins to return."),
				before_seq: z.number().int().nonnegative().optional().describe("Return spins earlier than this seq, for paging back."),
				include_content: z.boolean().default(false).describe("Include recorded content and diffs in payloads."),
			},
		},
		async ({ space_path, limit, before_seq, include_content }) => {
			if (!(await isSpaceFs(vaultRoot, space_path))) return notASpace(space_path);
			const full = await readLogFs(buildSpaceRefFs(vaultRoot, space_path));
			const scoped = before_seq === undefined ? full : full.filter((s) => s.seq < before_seq);
			const page = scoped.slice(Math.max(0, scoped.length - limit));

			return ok({
				space_path,
				total_spins: full.length,
				returned: page.length,
				has_earlier: page.length > 0 && page[0].seq > 0,
				spins: include_content ? page : page.map(stripContent),
			});
		},
	);
}

/**
 * A spin as returned when content is excluded. Deliberately its own type rather than a `Spin` with
 * fields bolted on: `content_omitted` is a fact about this response, not about the log, and
 * `Spin` is the shape the hash chain is computed over.
 */
type SpinView = Omit<Spin, "payload"> & {
	payload: Omit<Spin["payload"], "content" | "diff"> & {
		content_omitted?: true;
		content_bytes?: number;
	};
};

/** Keeps every field that says *what happened*, drops the bytes that say *what it contained*. */
function stripContent(spin: Spin): SpinView {
	const { content, diff, ...payload } = spin.payload;
	const omitted = content ?? diff;
	return {
		...spin,
		payload: omitted === undefined ? payload : { ...payload, content_omitted: true, content_bytes: omitted.length },
	};
}
