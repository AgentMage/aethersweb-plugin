import { App, TFile } from "obsidian";
import { CONTEXT_SCHEMA_VERSION, DEFAULT_STATEMENT_PLACEHOLDER } from "./core/constants";
import { assessStatementDrift, spinsSinceTip } from "./core/drift";
import type { StatementDriftAssessment } from "./core/drift";
import {
	findStatementBlock,
	readSignedStatement,
	replaceSignature,
	requiresVerification,
	writeSignedStatement,
} from "./core/statement";
import { applyVerification, awaitsVerification, signatureStatus } from "./core/signature";
import type { SignatureStatus, StatementSignature } from "./core/signature";
import { buildNoteText, renderBody } from "./core/context-format";
import { readHead, readLog } from "./log";
import { hashFile, immediateFiles, immediateSubspaces, relativePath } from "./space";
import type { ContextFileEntry, ContextFrontmatter, ContextSubspaceEntry, SpaceRef } from "./types";

/**
 * Serializes context regeneration per space. Regenerating is a read-modify-write on a whole file
 * (read the current text, rebuild frontmatter, write the whole thing back); two of those
 * interleaved on the same note (a debounced modify landing while a rename regenerates, say) can
 * lose one side's rebuild entirely. Unrelated spaces never wait on each other.
 */
const contextLocks = new Map<string, Promise<unknown>>();

function withContextLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const prior = contextLocks.get(key) ?? Promise.resolve();
	const run = prior.then(fn, fn);
	contextLocks.set(key, run.then(() => undefined, () => undefined));
	return run;
}

/**
 * Reads the statement tip a context note already carries, straight from the file's own text.
 *
 * Deliberately not `metadataCache.getFileCache` — that is a cache, and it is empty or stale in
 * exactly the situations regeneration runs in: a note created moments ago, a note just renamed by
 * the folder-rename handler, a startup pass racing the initial index. A miss there reads as
 * `statement_tip: null`, which doesn't fail loudly; it silently reports every statement in the
 * vault as never-generated, and the next write stamps over a tip that was fine.
 */
async function readStatementTip(contextPath: string, app: App): Promise<string | null> {
	const file = app.vault.getAbstractFileByPath(contextPath);
	if (!(file instanceof TFile)) return null;
	const text = await app.vault.read(file);
	const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
	if (!fmMatch) return null;
	const line = fmMatch[1].split("\n").find((l) => l.startsWith("statement_tip:"));
	if (!line) return null;
	const raw = line.slice("statement_tip:".length).trim();
	if (raw === "" || raw === "null" || raw === "~") return null;
	return raw.replace(/^["']|["']$/g, "");
}

/**
 * Rebuilds a space's context note: frontmatter is fully reconstructed from current filesystem
 * truth (this space's own files + each direct subspace's recorded tip) — never patched
 * incrementally, so the note stays fully disposable/regenerable. The AI statement body (between
 * the sentinel markers) and its `statement_tip` are read back and carried forward verbatim;
 * this function never writes statement content — that's the future MCP server's job.
 */
export function regenerateContext(ref: SpaceRef, app: App): Promise<void> {
	return withContextLock(ref.contextPath, () => regenerateContextLocked(ref, app));
}

async function regenerateContextLocked(ref: SpaceRef, app: App): Promise<void> {
	const head = await readHead(ref, app);

	const files: ContextFileEntry[] = [];
	for (const f of immediateFiles(ref)) {
		files.push({
			path: relativePath(ref, f),
			hash: await hashFile(f, app),
			size: f.stat.size,
		});
	}

	const subspaceRefs = await immediateSubspaces(ref, app);
	const subspaces: ContextSubspaceEntry[] = [];
	for (const sub of subspaceRefs) {
		subspaces.push({ name: sub.folder.name, tip: await readHead(sub, app) });
	}

	const existing = app.vault.getAbstractFileByPath(ref.contextPath);
	const existingFile = existing instanceof TFile ? existing : null;
	const statementTip = existingFile ? await readStatementTip(ref.contextPath, app) : null;

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

	if (!existingFile) {
		const body = renderBody(DEFAULT_STATEMENT_PLACEHOLDER);
		await app.vault.create(ref.contextPath, buildNoteText(frontmatter, body));
		return;
	}

	// Full rebuild, not a patch — matches "objective content list regenerates on every change".
	// Written as raw text via stringifyFrontmatter/buildNoteText (through app.vault.modify) rather
	// than app.fileManager.processFrontMatter: processFrontMatter always re-serializes the *entire*
	// frontmatter block from Obsidian's own object model, even to change one field, and Obsidian's
	// YAML writer drops quotes around plain scalars (a bare `space_path` or `generated_at`) that
	// core/context-format.ts's parseFrontmatter — deliberately a strict, non-general parser tied to
	// stringifyFrontmatter's exact quoted shape — cannot read. The result was silent: every context
	// note this plugin ever regenerated became unparseable to the MCP server's
	// check_staleness/plan_regeneration/write_statement, exactly the cross-package drift
	// core/context-format.ts being shared code is supposed to rule out. Body (including the
	// statement block) is preserved untouched by slicing it straight out of the current text.
	const currentText = await app.vault.read(existingFile);
	const fmBlockMatch = currentText.match(/^---\n[\s\S]*?\n---\n/);
	const body = fmBlockMatch ? currentText.slice(fmBlockMatch[0].length) : currentText;
	await app.vault.modify(existingFile, buildNoteText(frontmatter, body));
}

/**
 * Writes AI statement text into a context note and stamps statement_tip, without touching the
 * objective frontmatter above. The plugin-side mirror of the MCP server's `write_statement`.
 *
 * The text is written *through* `replaceStatementBlock`, which refuses text carrying the block's
 * own markers. Slicing around the markers without inspecting what goes between them let a statement
 * terminate its own block early — everything after the injected marker then sat inside the block
 * physically while reading, to every reader, as ordinary human-written body.
 */
export async function writeStatement(
	ref: SpaceRef,
	text: string,
	atTip: string,
	app: App,
	agent: string,
): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(ref.contextPath);
	if (!(existing instanceof TFile)) {
		throw new Error(`[AethersWeb] cannot write statement: no context note at ${ref.contextPath}`);
	}
	const current = await app.vault.read(existing);
	if (!findStatementBlock(current)) {
		throw new Error(`[AethersWeb] statement markers not found in ${ref.contextPath}`);
	}
	const withNewStatement = writeSignedStatement(current, text, agent, atTip, ref.contextPath);

	// statement_tip lives inside the frontmatter block. Patched as raw text — mirroring the MCP
	// server's writeStatementFs — rather than through processFrontMatter, which reformats every
	// other field in the block via Obsidian's own (unquoted) YAML style and would silently make the
	// note unparseable to the server's strict parseFrontmatter; see regenerateContextLocked's
	// comment for the full story. Safe to patch independently of the body edit above: this line
	// lives entirely outside the region that edit touched.
	const tipLine = `statement_tip: ${JSON.stringify(atTip)}`;
	const final = /^statement_tip:.*$/m.test(withNewStatement)
		? withNewStatement.replace(/^statement_tip:.*$/m, tipLine)
		: withNewStatement.replace(/^---\n([\s\S]*?)\n---\n/, (_whole, fm: string) => `---\n${fm}\n${tipLine}\n---\n`);

	await app.vault.modify(existing, final);
}

/**
 * The plugin-side counterpart to the MCP server's checkStalenessFs statement half: whether this
 * space's statement is behind its current head at all, and if so, whether that drift is
 * significant enough to be worth a write_statement call (core/drift.ts) — never on every keystroke.
 *
 * Returns null when there's nothing to judge: no spins yet, or the statement is already current.
 * `threshold` is a parameter rather than baked in so callers can pass the user's own setting
 * (`AethersWebSettings.statementDriftThreshold`) instead of the shared default.
 */
export async function checkStatementDrift(
	ref: SpaceRef,
	app: App,
	threshold?: number,
): Promise<StatementDriftAssessment | null> {
	const head = await readHead(ref, app);
	if (head === null) return null;

	const statementTip = await readStatementTip(ref.contextPath, app);
	if (statementTip === head) return null;

	const log = await readLog(ref, app);
	return assessStatementDrift(spinsSinceTip(log, statementTip), statementTip !== null, threshold);
}

export interface StatementReview {
	status: SignatureStatus;
	signature: StatementSignature | null;
	text: string;
	/** Whether this content is held for the person's confirmation — false in a context note. */
	verificationRequired: boolean;
	/** Whether it is actually waiting on them right now. Only this should ever prompt. */
	awaitsPerson: boolean;
}

/**
 * Reads a note's AI content and what its signature currently establishes about it. Works on any
 * note, not only a context note — an agent-authored file carries the same block, and it is the one
 * a person is actually asked to confirm.
 */
export async function reviewStatement(notePath: string, app: App): Promise<StatementReview | null> {
	const file = app.vault.getAbstractFileByPath(notePath);
	if (!(file instanceof TFile)) return null;
	const found = readSignedStatement(await app.vault.read(file));
	if (!found) return null;
	const status = signatureStatus(found.signature, found.text);
	const verificationRequired = requiresVerification(notePath);
	return {
		status,
		signature: found.signature,
		text: found.text,
		verificationRequired,
		awaitsPerson: awaitsVerification(status, verificationRequired),
	};
}

/**
 * Records that a person has read the AI content in a note and stands behind it.
 *
 * Plugin-only, and that is the substance of the feature rather than a restriction around it: a
 * verification an agent could write would look identical to one a person wrote and mean nothing.
 * The MCP server can read every field this sets and write none of them.
 *
 * Only the signature is rewritten — not one character of the prose being confirmed changes, so what
 * the person read is exactly what the recorded hash covers.
 */
export async function verifyStatement(notePath: string, verifier: string, app: App): Promise<StatementReview | null> {
	const file = app.vault.getAbstractFileByPath(notePath);
	if (!(file instanceof TFile)) return null;
	const current = await app.vault.read(file);
	const found = readSignedStatement(current);
	if (!found?.signature) return null;

	const updated = applyVerification(found.signature, found.text, verifier);
	const rewritten = replaceSignature(current, updated, notePath);
	if (rewritten === null) return null;
	await app.vault.modify(file, rewritten);
	const status = signatureStatus(updated, found.text);
	const verificationRequired = requiresVerification(notePath);
	return {
		status,
		signature: updated,
		text: found.text,
		verificationRequired,
		awaitsPerson: awaitsVerification(status, verificationRequired),
	};
}
