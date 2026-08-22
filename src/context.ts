import { App, TFile } from "obsidian";
import { CONTEXT_SCHEMA_VERSION, DEFAULT_STATEMENT_PLACEHOLDER } from "./core/constants";
import { assessStatementDrift, spinsSinceStatement } from "./core/drift";
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
import { buildIndexText, parseFrontmatter, renderBody } from "./core/context-format";
import { recordFileContentSpin } from "./content-record";
import { readHead, readLog } from "./log";
import { hashFile, immediateFiles, immediateSubspaces, relativePath } from "./space";
import type { ContextFileEntry, ContextFrontmatter, ContextSubspaceEntry, SpaceRef } from "./types";

/**
 * Serializes index regeneration per space. Regenerating rebuilds the whole index file from current
 * truth; two of those interleaved on the same space (a debounced modify landing while a rename
 * regenerates, say) can lose one side's rebuild entirely. Unrelated spaces never wait on each other.
 */
const contextLocks = new Map<string, Promise<unknown>>();

function withContextLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const prior = contextLocks.get(key) ?? Promise.resolve();
	const run = prior.then(fn, fn);
	contextLocks.set(key, run.then(() => undefined, () => undefined));
	return run;
}

/**
 * Reads the tip a space's statement was last generated against, from the statement's own signature.
 *
 * The signature is the authority here rather than a separate stored field: `at_tip` travels with
 * the prose it describes, so it cannot fall out of sync with it. It also means a person editing
 * their own writing elsewhere in the folder note never looks like statement drift — only the
 * statement's own regeneration moves this value.
 */
async function readStatementTip(contextPath: string, app: App): Promise<string | null> {
	const file = app.vault.getAbstractFileByPath(contextPath);
	if (!(file instanceof TFile)) return null;
	return readSignedStatement(await app.vault.read(file))?.signature?.at_tip ?? null;
}

/**
 * Rebuilds a space's machine index (`.aether/index.md`) from current filesystem truth — this
 * space's own files plus each direct subspace's recorded tip. Fully reconstructed every time,
 * never patched incrementally: the index is derived and disposable, the log is authoritative.
 *
 * Writes nothing to the folder note and appends nothing to the log. That is what lets this run
 * unconditionally after every spin without chasing its own tail — the index records `source_tip`
 * and `generated_at`, both of which change purely as a side effect of writing, so an index that
 * were itself logged could never settle. Living in `.aether/` (like `head`, for the same reason)
 * is what keeps it out of that loop entirely.
 */
export function regenerateContext(ref: SpaceRef, app: App): Promise<void> {
	return withContextLock(ref.indexPath, () => regenerateContextLocked(ref, app));
}

async function regenerateContextLocked(ref: SpaceRef, app: App): Promise<void> {
	// Before the index is built, not after: creating the folder note records a spin, so doing it
	// first means the index below is written against the head that already includes it. The other
	// order leaves the index a step behind its own space from the moment a space is created.
	await ensureFolderNote(ref, app);

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

	// Written straight through the adapter, not the vault API: `.aether/` is Obsidian-ignored, so
	// there is no TFile to hand app.vault.modify and nothing indexes this path.
	await app.vault.adapter.write(ref.indexPath, buildIndexText(frontmatter));
}

/**
 * Makes sure the folder note exists and carries a statement block — and, for a note written before
 * the index moved into `.aether/`, strips the now-obsolete frontmatter it still carries.
 *
 * This is the *only* thing regeneration does to the folder note, and it is deliberately as close
 * to nothing as possible. Everything in that file outside the statement block belongs to the
 * person who wrote it: regeneration must never rebuild it from parts, only create it when absent
 * and clear away what this plugin itself left behind in an older shape.
 */
async function ensureFolderNote(ref: SpaceRef, app: App): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(ref.contextPath);
	if (!(existing instanceof TFile)) {
		const created = await app.vault.create(ref.contextPath, renderBody(DEFAULT_STATEMENT_PLACEHOLDER).trimStart() + "\n");
		// Recorded like any other file this plugin creates. The vault's own `create` event will fire
		// for it too; whichever lands second finds the same content hash recorded and stands down.
		await recordFileContentSpin(ref, "file_created", relativePath(ref, created), created, "observed", app);
		return;
	}

	// One-time migration, self-limiting: strip a leading frontmatter block only when it parses as
	// *our own* index shape. A person's own YAML frontmatter fails that parse and is left alone —
	// "starts with ---" would not be a safe enough test to delete someone's content on.
	const currentText = await app.vault.read(existing);
	const fmMatch = currentText.match(/^---\n[\s\S]*?\n---\n/);
	if (!fmMatch) return;
	let isOurs = false;
	try {
		isOurs = parseFrontmatter(currentText) !== null;
	} catch {
		// A block in our shape but corrupted/older still throws; treat it as ours to clean up,
		// since a person's own frontmatter would not have got far enough into the parse to throw.
		isOurs = /^---\naetherweb_schema: /.test(currentText);
	}
	if (!isOurs) return;

	const rest = currentText.slice(fmMatch[0].length).replace(/^\n+/, "");
	await app.vault.modify(existing, rest.length > 0 ? rest : renderBody(DEFAULT_STATEMENT_PLACEHOLDER).trimStart() + "\n");
	await recordFileContentSpin(ref, "file_modified", relativePath(ref, existing), existing, "observed", app);
}

/**
 * Writes AI statement text into a space's folder note. The plugin-side mirror of the MCP server's
 * `write_statement`.
 *
 * Scoped to the statement block and nothing else. The rest of the folder note is the person's own
 * writing, and `replaceStatementBlock` preserves it byte for byte — it also refuses text carrying
 * the block's own markers, since slicing around markers without inspecting what goes between them
 * let a statement terminate its own block early, leaving everything after the injected marker
 * inside the block physically while reading, to every reader, as ordinary human-written text.
 *
 * The tip this was generated against is recorded in the signature itself (`at_tip`), not in a
 * separate field — so it travels with the prose it describes and cannot fall out of sync with it.
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
		throw new Error(`[AethersWeb] cannot write statement: no folder note at ${ref.contextPath}`);
	}
	const current = await app.vault.read(existing);
	if (!findStatementBlock(current)) {
		throw new Error(`[AethersWeb] statement markers not found in ${ref.contextPath}`);
	}
	const final = writeSignedStatement(current, text, agent, atTip, ref.contextPath);
	if (final === current) return; // byte-identical prose — signature and verification preserved

	await app.vault.modify(existing, final);

	// The folder note is an ordinary logged file, so this write is recorded like any other. The
	// vault's own `modify` event will also fire for it; whichever of the two lands second finds the
	// same content hash already recorded and stands down (core/guards.ts).
	const spin = await recordFileContentSpin(ref, "file_modified", relativePath(ref, existing), existing, "observed", app);
	if (spin) await regenerateContext(ref, app);
}

/**
 * The plugin-side counterpart to the MCP server's checkStalenessFs statement half: whether this
 * space's statement is behind its current head at all, and if so, whether that drift is
 * significant enough to be worth a write_statement call (core/drift.ts) — never on every keystroke.
 *
 * Returns null when there's nothing to judge: no spins yet, or the statement is already current.
 * `threshold` is a parameter rather than baked in so callers can pass the user's own setting
 * (`AethersWebSettings.statementDriftThreshold`) instead of the shared default.
 *
 * The comparison point is the statement's own signature (`at_tip`), so a person editing their own
 * writing elsewhere in the folder note never registers as statement drift — only what the
 * statement was actually generated against moves it.
 */
export async function checkStatementDrift(
	ref: SpaceRef,
	app: App,
	threshold?: number,
): Promise<StatementDriftAssessment | null> {
	const head = await readHead(ref, app);
	if (head === null) return null;

	const statementTip = await readStatementTip(ref.contextPath, app);
	const log = await readLog(ref, app);
	// Excludes the folder note's own spins — see spinsSinceStatement. Writing a statement edits
	// that note, so counting its own write would leave every statement stale against itself.
	const drifted = spinsSinceStatement(log, statementTip, ref.contextPath.slice(ref.path.length + 1));
	if (statementTip !== null && drifted.length === 0) return null;

	return assessStatementDrift(drifted, statementTip !== null, threshold);
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
