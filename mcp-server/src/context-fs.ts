import { readFile, stat, writeFile } from "node:fs/promises";
import { CONTEXT_SCHEMA_VERSION, DEFAULT_STATEMENT_PLACEHOLDER } from "../../src/core/constants";
import { findStatementBlock, writeSignedStatement } from "../../src/core/statement";
import { buildNoteText, extractStatementBlock, parseFrontmatter, renderBody, stringifyFrontmatter } from "../../src/core/context-format";
import type { ContextFileEntry, ContextFrontmatter, ContextSubspaceEntry } from "../../src/core/types";
import { hashFileFs, immediateFilesFs, immediateSubspacesFs, relativePathFs } from "./space-fs";
import type { SpaceRefFs } from "./space-fs";
import { readHeadFs } from "./vault-io";

async function readExistingStatementTip(contextPath: string): Promise<string | null> {
	try {
		const text = await readFile(contextPath, "utf8");
		return parseFrontmatter(text)?.statement_tip ?? null;
	} catch {
		return null;
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Rebuilds a space's context note on disk, mirroring context.ts::regenerateContext. Frontmatter
 * is always fully reconstructed from current filesystem truth via stringifyFrontmatter — the
 * plugin only does this for brand-new notes (existing ones go through Obsidian's own
 * processFrontMatter), but since this server has no such serializer to defer to, every write here
 * is a full rewrite. The AI statement body (between the sentinel markers) is read back and
 * carried forward verbatim, never touched by this function — matches the plugin's own contract.
 */
export async function regenerateContextFs(vaultRoot: string, ref: SpaceRefFs): Promise<ContextFrontmatter> {
	const head = await readHeadFs(ref);

	const files: ContextFileEntry[] = [];
	for (const absFilePath of await immediateFilesFs(ref)) {
		files.push({
			path: relativePathFs(ref, absFilePath),
			hash: await hashFileFs(absFilePath),
			size: (await stat(absFilePath)).size,
		});
	}

	const subspaces: ContextSubspaceEntry[] = [];
	for (const sub of await immediateSubspacesFs(vaultRoot, ref)) {
		subspaces.push({ name: sub.path.split("/").pop() ?? sub.path, tip: await readHeadFs(sub) });
	}

	const noteExists = await exists(ref.contextPath);
	const statementTip = noteExists ? await readExistingStatementTip(ref.contextPath) : null;
	const statementBody = noteExists
		? extractStatementBlock(await readFile(ref.contextPath, "utf8"))
		: DEFAULT_STATEMENT_PLACEHOLDER;

	const frontmatter: ContextFrontmatter = {
		aetherweb_schema: CONTEXT_SCHEMA_VERSION,
		space_path: ref.path,
		source_tip: head,
		generated_at: new Date().toISOString(),
		file_count: files.length,
		subspace_count: subspaces.length,
		files,
		subspaces,
		statement_tip: statementTip,
	};

	await writeFile(ref.contextPath, buildNoteText(frontmatter, renderBody(statementBody)), "utf8");
	return frontmatter;
}

/**
 * Writes new AI statement text and stamps statement_tip, without touching the objective
 * frontmatter fields — mirrors context.ts::writeStatement, the function it's explicitly
 * documented as "the future drop-in point for the MCP server / statement generator" for.
 */
export async function writeStatementFs(ref: SpaceRefFs, text: string, atTip: string, agent: string): Promise<void> {
	if (!(await exists(ref.contextPath))) {
		throw new Error(`[aethersweb-mcp-server] cannot write statement: no context note at ${ref.contextPath}`);
	}
	const current = await readFile(ref.contextPath, "utf8");
	if (!findStatementBlock(current)) {
		throw new Error(`[aethersweb-mcp-server] statement markers not found in ${ref.contextPath}`);
	}

	// Body substitution first — scoped to the block, which lives below the frontmatter and so
	// cannot touch it. Throws if the text carries the block's own markers; see core/statement.ts.
	const withNewStatement = writeSignedStatement(current, text, agent, atTip, ref.contextPath);

	// statement_tip lives inside the frontmatter block, entirely outside the region just edited —
	// safe to patch independently with a whole-text regex rather than re-parsing/reassembling
	// the frontmatter block.
	const tipLine = `statement_tip: ${JSON.stringify(atTip)}`;
	const final = /^statement_tip:.*$/m.test(withNewStatement)
		? withNewStatement.replace(/^statement_tip:.*$/m, tipLine)
		: withNewStatement.replace(/^---\n([\s\S]*?)\n---\n/, (_whole, fm: string) => `---\n${fm}\n${tipLine}\n---\n`);

	await writeFile(ref.contextPath, final, "utf8");
}

export interface SubspaceStaleness {
	name: string;
	/**
	 * "ok": recorded tip matches the subspace's actual current head.
	 * "drifted": the subspace's own log has moved on since the parent last recorded its tip.
	 * "missing_from_context": a claimed subspace exists on disk but isn't in the parent's
	 *   recorded list at all (parent has never been regenerated since the subspace was created).
	 * "missing_on_disk": the parent recorded this subspace but it's no longer a claimed space
	 *   (folder removed, or its .aether/log.jsonl gone).
	 */
	status: "ok" | "drifted" | "missing_from_context" | "missing_on_disk";
	recorded_tip: string | null;
	actual_tip: string | null;
}

export interface SpaceStaleness {
	space_path: string;
	current_head: string | null;
	has_context_note: boolean;
	/** source_tip (frontmatter) vs current_head — does regenerate_context need to run. */
	frontmatter_stale: boolean;
	/** statement_tip vs current_head — does write_statement need to run. Also true when no statement has ever been written. */
	statement_stale: boolean;
	subspaces: SubspaceStaleness[];
	/** frontmatter_stale || statement_stale || any subspace not "ok". */
	stale: boolean;
	/** Set only when the context note exists but its frontmatter couldn't be parsed. */
	error?: string;
}

/**
 * Compares a space's context note against current filesystem/log truth on both staleness axes:
 * this space's own source_tip/statement_tip vs its actual head (readHeadFs), and — since a
 * subspace's own log never produces a parent log entry (chains are independent per space) —
 * each subspace tip recorded in this space's frontmatter vs that subspace's own actual current
 * head. Read-only: reports what's out of date, never fixes it (that's regenerate_context /
 * write_statement).
 */
export async function checkStalenessFs(vaultRoot: string, ref: SpaceRefFs): Promise<SpaceStaleness> {
	const current_head = await readHeadFs(ref);
	const has_context_note = await exists(ref.contextPath);

	let fm: ContextFrontmatter | null = null;
	let error: string | undefined;
	if (has_context_note) {
		try {
			fm = parseFrontmatter(await readFile(ref.contextPath, "utf8"));
			if (fm === null) error = "context note has no frontmatter block";
		} catch (err) {
			error = `frontmatter parse error: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	const frontmatter_stale = fm ? fm.source_tip !== current_head : true;
	const statement_stale = fm ? fm.statement_tip !== current_head : true;
	const subspaces = await diffSubspaces(vaultRoot, ref, fm?.subspaces ?? []);
	const stale = frontmatter_stale || statement_stale || subspaces.some((s) => s.status !== "ok");

	return {
		space_path: ref.path,
		current_head,
		has_context_note,
		frontmatter_stale,
		statement_stale,
		subspaces,
		stale,
		...(error ? { error } : {}),
	};
}

async function diffSubspaces(
	vaultRoot: string,
	ref: SpaceRefFs,
	recorded: ContextSubspaceEntry[],
): Promise<SubspaceStaleness[]> {
	const actualRefs = await immediateSubspacesFs(vaultRoot, ref);
	const actualByName = new Map(actualRefs.map((r) => [r.path.split("/").pop() ?? r.path, r]));
	const recordedByName = new Map(recorded.map((s) => [s.name, s]));

	const names = new Set([...actualByName.keys(), ...recordedByName.keys()]);
	const results: SubspaceStaleness[] = [];
	for (const name of [...names].sort()) {
		const actualRef = actualByName.get(name);
		const recordedEntry = recordedByName.get(name);

		if (actualRef && recordedEntry) {
			const actual_tip = await readHeadFs(actualRef);
			results.push({
				name,
				status: recordedEntry.tip === actual_tip ? "ok" : "drifted",
				recorded_tip: recordedEntry.tip,
				actual_tip,
			});
		} else if (actualRef) {
			results.push({ name, status: "missing_from_context", recorded_tip: null, actual_tip: await readHeadFs(actualRef) });
		} else if (recordedEntry) {
			results.push({ name, status: "missing_on_disk", recorded_tip: recordedEntry.tip, actual_tip: null });
		}
	}
	return results;
}

export interface RegenerationPlanEntry {
	space_path: string;
	/** Number of "/"-separated segments in space_path — deeper means further from the vault root. */
	depth: number;
	/** true when regenerate_context needs to run: own frontmatter is stale, or a subspace tip drifted. */
	needs_regenerate_context: boolean;
	/** true when write_statement needs to run: statement_tip is behind current_head (or was never set). */
	needs_write_statement: boolean;
	reasons: string[];
}

/**
 * Runs checkStalenessFs over the given spaces and returns only the ones that actually need work,
 * sorted deepest-first. Depth-descending is a valid bottom-up order here — and a plain sort key is
 * enough, no graph-shaped topological sort needed — because containment is strictly single-parent
 * (CLAUDE.md's "every folder is a space, no exceptions"): for any ancestor/descendant pair the
 * descendant always has strictly more path segments than the ancestor.
 *
 * Bottom-up order is *not* needed for correctness of regenerate_context itself: it always reads a
 * subspace's actual current head straight off disk (readHeadFs), never off that subspace's own
 * context note, so parent and child frontmatter can be regenerated in either order with the same
 * result. The ordering exists for write_statement instead — per that tool's tone brief, a parent's
 * statement is meant to place the space in the context of its universe and composition, which
 * reads better when the children it's reading about (via read_context / list_spaces) already carry
 * fresh statements rather than ones about to be rewritten anyway.
 */
export async function planRegenerationFs(vaultRoot: string, refs: SpaceRefFs[]): Promise<RegenerationPlanEntry[]> {
	const entries: RegenerationPlanEntry[] = [];
	for (const ref of refs) {
		const status = await checkStalenessFs(vaultRoot, ref);
		if (!status.stale) continue;

		const driftedSubspaces = status.subspaces.filter((s) => s.status !== "ok");
		const reasons: string[] = [];
		if (status.frontmatter_stale) reasons.push("source_tip behind current_head");
		if (status.statement_stale) reasons.push("statement_tip behind current_head");
		for (const s of driftedSubspaces) reasons.push(`subspace "${s.name}" ${s.status}`);

		entries.push({
			space_path: ref.path,
			depth: ref.path.split("/").length,
			needs_regenerate_context: status.frontmatter_stale || driftedSubspaces.length > 0,
			needs_write_statement: status.statement_stale,
			reasons,
		});
	}

	entries.sort((a, b) => b.depth - a.depth || a.space_path.localeCompare(b.space_path));
	return entries;
}
