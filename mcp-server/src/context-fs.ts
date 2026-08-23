import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CONTEXT_SCHEMA_VERSION, DEFAULT_STATEMENT_PLACEHOLDER } from "../../src/core/constants";
import { describeStatementDrift, spinsSinceStatement } from "../../src/core/drift";
import type { StatementDriftFacts } from "../../src/core/drift";
import {
	appendToSharedBlock,
	ensureSharedBlock,
	findStatementBlock,
	readSignedBlock,
	readSignedStatement,
	writeSignedBlock,
	writeSignedStatement,
} from "../../src/core/statement";
import type { StatementSignature } from "../../src/core/signature";
import { buildIndexText, parseFrontmatter, renderBody, stringifyFrontmatter } from "../../src/core/context-format";
import type { ContextFileEntry, ContextFrontmatter, ContextSubspaceEntry } from "../../src/core/types";
import { hashFileFs, immediateFilesFs, immediateSubspacesFs, relativePathFs } from "./space-fs";
import type { SpaceRefFs } from "./space-fs";
import { readHeadFs, readLogFs } from "./vault-io";
import { recordWrittenFile } from "./write-fs";

/**
 * The tip a space's statement was last generated against, read from the statement's own signature.
 * Mirrors src/context.ts::readStatementTip — the signature is the authority because `at_tip`
 * travels with the prose it describes, so a person editing their own writing elsewhere in the
 * folder note never registers as statement drift.
 */
async function readExistingStatementTip(contextPath: string): Promise<string | null> {
	try {
		return readSignedStatement(await readFile(contextPath, "utf8"))?.signature?.at_tip ?? null;
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
 * Rebuilds a space's machine index (`.aether/index.md`) from current filesystem truth, mirroring
 * context.ts::regenerateContext. Fully reconstructed every time, never patched incrementally.
 *
 * Writes nothing to the folder note beyond ensuring it exists with a statement block (and clearing
 * away a pre-split note's obsolete frontmatter), and appends nothing to the log. That is what lets
 * it run unconditionally after every spin without chasing its own tail — the index records
 * `source_tip`/`generated_at`, both of which change purely as a side effect of writing.
 */
export async function regenerateContextFs(vaultRoot: string, ref: SpaceRefFs): Promise<ContextFrontmatter> {
	// Before the index is built, not after: creating the folder note records a spin, so doing it
	// first means the index below is written against the head that already includes it. The other
	// order leaves the index a step behind its own space from the moment a space is created.
	await ensureFolderNoteFs(ref);

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

	const frontmatter: ContextFrontmatter = {
		aetherweb_schema: CONTEXT_SCHEMA_VERSION,
		space_path: ref.path,
		source_tip: head,
		generated_at: new Date().toISOString(),
		file_count: files.length,
		subspace_count: subspaces.length,
		files,
		subspaces,
	};

	await mkdir(dirname(ref.indexPath), { recursive: true });
	await writeFile(ref.indexPath, buildIndexText(frontmatter), "utf8");
	return frontmatter;
}

/**
 * Makes sure the folder note exists and carries both of its blocks — the statement and the shared
 * region — and, for a note written before the index moved into `.aether/`, strips the now-obsolete
 * frontmatter it still carries.
 *
 * The *only* thing regeneration does to the folder note, deliberately as close to nothing as
 * possible: everything in that file outside the two blocks belongs to the person who wrote it.
 * Mirrors src/context.ts::ensureFolderNote, including creating the shared block empty rather than
 * waiting for an agent to write in it — see core/statement.ts::ensureSharedBlock.
 */
async function ensureFolderNoteFs(ref: SpaceRefFs): Promise<void> {
	const relPath = relativePathFs(ref, ref.contextPath);
	if (!(await exists(ref.contextPath))) {
		await writeFile(ref.contextPath, renderBody(DEFAULT_STATEMENT_PLACEHOLDER).trimStart() + "\n", "utf8");
		// Recorded like any other file this process creates. Skipping it would leave the note on
		// disk but absent from the log, so the next reconciliation would "discover" it and record a
		// `detected` create for a file this very process just wrote.
		await recordWrittenFile(ref, relPath, ref.contextPath, "file_created", "observed");
		return;
	}

	const currentText = await readFile(ref.contextPath, "utf8");
	// One write, one spin, for both fixes — see the plugin's mirror of this for why.
	const migrated = stripLegacyIndexFrontmatterFs(currentText);
	const withShared = ensureSharedBlock(migrated) ?? migrated;
	if (withShared === currentText) return;

	await writeFile(ref.contextPath, withShared, "utf8");
	await recordWrittenFile(ref, relPath, ref.contextPath, "file_modified", "observed");
}

/**
 * Strips the leading frontmatter block from a pre-split folder note, or returns the text unchanged.
 * One-time migration, self-limiting: strips only when the block parses as *our own* index shape. A
 * person's own YAML frontmatter fails that parse and is left alone. Mirrors
 * src/context.ts::stripLegacyIndexFrontmatter.
 */
function stripLegacyIndexFrontmatterFs(currentText: string): string {
	const fmMatch = currentText.match(/^---\n[\s\S]*?\n---\n/);
	if (!fmMatch) return currentText;
	let isOurs = false;
	try {
		isOurs = parseFrontmatter(currentText) !== null;
	} catch {
		isOurs = /^---\naetherweb_schema: /.test(currentText);
	}
	if (!isOurs) return currentText;

	const rest = currentText.slice(fmMatch[0].length).replace(/^\n+/, "");
	return rest.length > 0 ? rest : renderBody(DEFAULT_STATEMENT_PLACEHOLDER).trimStart() + "\n";
}

/**
 * Writes new AI statement text into a space's folder note — mirrors context.ts::writeStatement.
 *
 * Scoped to the statement block and nothing else: the rest of the folder note is the person's own
 * writing, preserved byte for byte by replaceStatementBlock, which also throws if the text carries
 * the block's own markers (see core/statement.ts). The tip this was generated against is recorded
 * in the signature itself (`at_tip`), so it travels with the prose rather than in a separate field.
 *
 * The write is logged like any other file's, since the folder note is now an ordinary logged file.
 */
export async function writeStatementFs(
	vaultRoot: string,
	ref: SpaceRefFs,
	text: string,
	atTip: string,
	agent: string,
): Promise<void> {
	if (!(await exists(ref.contextPath))) {
		throw new Error(`[aethersweb-mcp-server] cannot write statement: no folder note at ${ref.contextPath}`);
	}
	const current = await readFile(ref.contextPath, "utf8");
	if (!findStatementBlock(current)) {
		throw new Error(`[aethersweb-mcp-server] statement markers not found in ${ref.contextPath}`);
	}

	const final = writeSignedStatement(current, text, agent, atTip, ref.contextPath);
	if (final === current) return; // byte-identical prose — signature and verification preserved

	await writeFile(ref.contextPath, final, "utf8");
	const spin = await recordWrittenFile(
		ref,
		relativePathFs(ref, ref.contextPath),
		ref.contextPath,
		"file_modified",
		"observed",
		agent,
	);
	// That spin advanced this space's head, so the index now trails it — regenerate for the same
	// reason every other authoring path does. Mirrors src/context.ts::writeStatement.
	if (spin) await regenerateContextFs(vaultRoot, ref);
}

/**
 * Writes into a space's shared block — mirrors context.ts::writeShared.
 *
 * Appending is the default and replacing is opt-in, for the reason spelled out on
 * `appendToSharedBlock`: a replace can only preserve the person's writing by re-emitting it, and
 * quietly paraphrasing someone's own words back at them is the one failure this codebase has no way
 * to detect after the fact. Appending is incapable of it.
 *
 * Unlike writeStatementFs, a missing shared block is not an error — a folder note written before
 * the shared region existed gets one here.
 */
export async function writeSharedFs(
	vaultRoot: string,
	ref: SpaceRefFs,
	text: string,
	agent: string,
	mode: "append" | "replace" = "append",
): Promise<void> {
	if (!(await exists(ref.contextPath))) {
		throw new Error(`[aethersweb-mcp-server] cannot write shared block: no folder note at ${ref.contextPath}`);
	}
	const current = await readFile(ref.contextPath, "utf8");
	const atTip = await readHeadFs(ref);
	const final =
		mode === "append"
			? appendToSharedBlock(current, text, agent, atTip, ref.contextPath)
			: writeSignedBlock(current, text, "shared", agent, atTip, ref.contextPath);
	if (final === current) return; // nothing new to add — signature and verification preserved

	await writeFile(ref.contextPath, final, "utf8");
	const spin = await recordWrittenFile(
		ref,
		relativePathFs(ref, ref.contextPath),
		ref.contextPath,
		"file_modified",
		"observed",
		agent,
	);
	if (spin) await regenerateContextFs(vaultRoot, ref);
}

/** The shared block's prose and signature, or null when the note has no shared block. */
export async function readSharedFs(
	ref: SpaceRefFs,
): Promise<{ text: string; signature: StatementSignature | null } | null> {
	try {
		return readSignedBlock(await readFile(ref.contextPath, "utf8"), "shared");
	} catch {
		return null;
	}
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
	has_index: boolean;
	/** source_tip (index) vs current_head — does regenerate_context need to run. */
	frontmatter_stale: boolean;
	/**
	 * The statement's own signature `at_tip` vs current_head — the raw fact, not a policy. True the
	 * moment a single spin has landed since the last statement, or when none has ever been written.
	 */
	statement_stale: boolean;
	/**
	 * The facts behind `statement_stale`: how many spins have piled up since the statement was
	 * written, and whether any of them changed this space's composition — see core/drift.ts. Null
	 * exactly when `statement_stale` is false (nothing to judge). Reported, never pre-filtered: the
	 * calling agent decides whether this is worth a write_statement call, since it can read the log
	 * and see what actually changed rather than only counting.
	 */
	statement_drift: StatementDriftFacts | null;
	subspaces: SubspaceStaleness[];
	/** frontmatter_stale || statement_stale || any subspace not "ok". */
	stale: boolean;
	/** Set only when the index exists but couldn't be parsed. */
	error?: string;
}

/**
 * Compares a space's derived state against current filesystem/log truth on both staleness axes:
 * the index's own source_tip and the statement's signature `at_tip` vs the actual head
 * (readHeadFs), and — since a subspace's own log never produces a parent log entry (chains are
 * independent per space) — each subspace tip recorded in the index vs that subspace's own actual
 * current head. Read-only: reports what's out of date, never fixes it (that's regenerate_context /
 * write_statement).
 */
export async function checkStalenessFs(vaultRoot: string, ref: SpaceRefFs): Promise<SpaceStaleness> {
	const current_head = await readHeadFs(ref);
	const has_index = await exists(ref.indexPath);

	let fm: ContextFrontmatter | null = null;
	let error: string | undefined;
	if (has_index) {
		try {
			fm = parseFrontmatter(await readFile(ref.indexPath, "utf8"));
			if (fm === null) error = "index has no frontmatter block";
		} catch (err) {
			error = `index parse error: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	const frontmatter_stale = fm ? fm.source_tip !== current_head : true;

	// Statement staleness is measured over the spins that are not the folder note's own — see
	// spinsSinceStatement. Writing a statement edits that note, and the note is a logged file, so
	// counting its own write would leave every statement permanently stale against itself.
	const recordedStatementTip = await readExistingStatementTip(ref.contextPath);
	const drifted = spinsSinceStatement(
		await readLogFs(ref),
		recordedStatementTip,
		relativePathFs(ref, ref.contextPath),
	);
	const statement_stale = recordedStatementTip === null || drifted.length > 0;
	const statement_drift = statement_stale ? describeStatementDrift(drifted, recordedStatementTip !== null) : null;
	const subspaces = await diffSubspaces(vaultRoot, ref, fm?.subspaces ?? []);
	const stale = frontmatter_stale || statement_stale || subspaces.some((s) => s.status !== "ok");

	return {
		space_path: ref.path,
		current_head,
		has_index,
		frontmatter_stale,
		statement_stale,
		statement_drift,
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
	/** true when regenerate_context needs to run: own index is stale, or a subspace tip drifted. */
	needs_regenerate_context: boolean;
	/**
	 * true when this space's statement is behind its current head at all — the raw fact, not a
	 * judgment about whether it's worth rewriting. Weigh `statement_drift` (and, where it matters,
	 * what read_log actually shows changed) to decide that; a space one trivial edit behind reports
	 * true here and may well not be worth a call.
	 */
	statement_stale: boolean;
	/** Facts behind `statement_stale`: spins accumulated, and any composition changes among them. */
	statement_drift: StatementDriftFacts | null;
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
 * index, so parent and child indexes can be regenerated in either order with the same result. The
 * ordering exists for write_statement instead — per that tool's description, a parent's statement
 * must place the space among its parent, siblings, and subspaces, which is more accurate when the
 * children it's reading about (via read_context / list_spaces) already carry fresh statements
 * rather than ones about to be rewritten anyway.
 *
 * Reports what is stale; does not pre-judge what is worth acting on. An earlier version filtered
 * the statement side through a fixed spin-count threshold, which made sense only for the automatic
 * generator this project never built — with generation always a deliberate agent call, that
 * judgment belongs to the caller, who can read the log and see what actually changed rather than
 * only counting. The plugin keeps a threshold for its own human-facing digest command, where a
 * predictable cutoff is the point.
 */
export async function planRegenerationFs(vaultRoot: string, refs: SpaceRefFs[]): Promise<RegenerationPlanEntry[]> {
	const entries: RegenerationPlanEntry[] = [];
	for (const ref of refs) {
		const status = await checkStalenessFs(vaultRoot, ref);
		const driftedSubspaces = status.subspaces.filter((s) => s.status !== "ok");
		const needs_regenerate_context = status.frontmatter_stale || driftedSubspaces.length > 0;
		if (!needs_regenerate_context && !status.statement_stale) continue;

		const reasons: string[] = [];
		if (status.frontmatter_stale) reasons.push("index source_tip behind current_head");
		if (status.statement_stale) reasons.push(...(status.statement_drift?.reasons ?? ["statement behind current_head"]));
		for (const s of driftedSubspaces) reasons.push(`subspace "${s.name}" ${s.status}`);

		entries.push({
			space_path: ref.path,
			depth: ref.path.split("/").length,
			needs_regenerate_context,
			statement_stale: status.statement_stale,
			statement_drift: status.statement_drift,
			reasons,
		});
	}

	entries.sort((a, b) => b.depth - a.depth || a.space_path.localeCompare(b.space_path));
	return entries;
}
