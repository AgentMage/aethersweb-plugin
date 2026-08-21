import { App, TFile } from "obsidian";
import { CONTEXT_SCHEMA_VERSION, DEFAULT_STATEMENT_PLACEHOLDER } from "./core/constants";
import {
	findStatementBlock,
	readSignedStatement,
	replaceSignature,
	writeSignedStatement,
} from "./core/statement";
import { applyVerification, signatureStatus } from "./core/signature";
import type { SignatureStatus, StatementSignature } from "./core/signature";
import { buildNoteText, renderBody } from "./core/context-format";
import { readHead } from "./log";
import { hashFile, immediateFiles, immediateSubspaces, relativePath } from "./space";
import type { ContextFileEntry, ContextFrontmatter, ContextSubspaceEntry, SpaceRef } from "./types";

/**
 * Serializes context regeneration per space. `processFrontMatter` is a read-modify-write on a
 * whole file; two of them interleaved on the same note (a debounced modify landing while a rename
 * regenerates, say) can lose one side's rebuild entirely. Unrelated spaces never wait on each
 * other.
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

	await app.fileManager.processFrontMatter(existingFile, (fm: Record<string, unknown>) => {
		// full rebuild, not a patch — matches "objective content list regenerates on every change"
		for (const key of Object.keys(fm)) delete fm[key];
		Object.assign(fm, frontmatter);
	});
	// Body (including the statement block) is untouched: processFrontMatter only rewrites the
	// YAML block. This is exactly why the sentinel-marker approach is safe.
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
	await app.vault.modify(existing, writeSignedStatement(current, text, agent, atTip));
	await app.fileManager.processFrontMatter(existing, (fm: Record<string, unknown>) => {
		fm.statement_tip = atTip;
	});
}

export interface StatementReview {
	status: SignatureStatus;
	signature: StatementSignature | null;
	text: string;
}

/** Reads a note's AI content and what its signature currently establishes about it. */
export async function reviewStatement(contextPath: string, app: App): Promise<StatementReview | null> {
	const file = app.vault.getAbstractFileByPath(contextPath);
	if (!(file instanceof TFile)) return null;
	const found = readSignedStatement(await app.vault.read(file));
	if (!found) return null;
	return { status: signatureStatus(found.signature, found.text), signature: found.signature, text: found.text };
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
export async function verifyStatement(contextPath: string, verifier: string, app: App): Promise<StatementReview | null> {
	const file = app.vault.getAbstractFileByPath(contextPath);
	if (!(file instanceof TFile)) return null;
	const current = await app.vault.read(file);
	const found = readSignedStatement(current);
	if (!found?.signature) return null;

	const updated = applyVerification(found.signature, found.text, verifier);
	const rewritten = replaceSignature(current, updated);
	if (rewritten === null) return null;
	await app.vault.modify(file, rewritten);
	return { status: signatureStatus(updated, found.text), signature: updated, text: found.text };
}
