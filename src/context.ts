import { App, TFile } from "obsidian";
import {
	CONTEXT_SCHEMA_VERSION,
	DEFAULT_STATEMENT_PLACEHOLDER,
	STATEMENT_END_MARKER,
	STATEMENT_START_MARKER,
} from "./constants";
import { readHead } from "./log";
import { hashFile, immediateFiles, immediateSubspaces, relativePath } from "./space";
import type { ContextFileEntry, ContextFrontmatter, ContextSubspaceEntry, SpaceRef } from "./types";

/** JSON string escaping is a valid YAML double-quoted scalar — reused for simplicity/correctness. */
function yamlString(s: string): string {
	return JSON.stringify(s);
}

function yamlScalar(v: string | number | null): string {
	if (v === null) return "null";
	if (typeof v === "number") return String(v);
	return yamlString(v);
}

/**
 * Hand-rolled, deterministic YAML for the fixed context-note frontmatter shape — used only when
 * creating a brand-new note. Updates to an existing note go through Obsidian's own
 * processFrontMatter (fileManager.ts), which serializes properly and doesn't need this.
 */
function stringifyFrontmatter(fm: ContextFrontmatter): string {
	const lines: string[] = [];
	lines.push(`aetherweb_schema: ${fm.aetherweb_schema}`);
	lines.push(`space_path: ${yamlString(fm.space_path)}`);
	lines.push(`source_tip: ${yamlScalar(fm.source_tip)}`);
	lines.push(`generated_at: ${yamlString(fm.generated_at)}`);
	lines.push(`file_count: ${fm.file_count}`);
	lines.push(`subspace_count: ${fm.subspace_count}`);

	if (fm.files.length === 0) {
		lines.push(`files: []`);
	} else {
		lines.push(`files:`);
		for (const f of fm.files) {
			lines.push(`  - path: ${yamlString(f.path)}`);
			lines.push(`    hash: ${yamlString(f.hash)}`);
			lines.push(`    size: ${f.size}`);
		}
	}

	if (fm.subspaces.length === 0) {
		lines.push(`subspaces: []`);
	} else {
		lines.push(`subspaces:`);
		for (const s of fm.subspaces) {
			lines.push(`  - name: ${yamlString(s.name)}`);
			lines.push(`    tip: ${yamlScalar(s.tip)}`);
		}
	}

	lines.push(`statement_tip: ${yamlScalar(fm.statement_tip)}`);
	return lines.join("\n");
}

function extractStatementBlock(noteText: string): string {
	const startIdx = noteText.indexOf(STATEMENT_START_MARKER);
	const endIdx = noteText.indexOf(STATEMENT_END_MARKER);
	if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
		return DEFAULT_STATEMENT_PLACEHOLDER;
	}
	return noteText.slice(startIdx + STATEMENT_START_MARKER.length, endIdx).trim();
}

function renderBody(statementText: string): string {
	return `\n${STATEMENT_START_MARKER}\n${statementText}\n${STATEMENT_END_MARKER}\n`;
}

function buildNoteText(fm: ContextFrontmatter, body: string): string {
	return `---\n${stringifyFrontmatter(fm)}\n---\n${body}`;
}

/**
 * Rebuilds a space's context note: frontmatter is fully reconstructed from current filesystem
 * truth (this space's own files + each direct subspace's recorded tip) — never patched
 * incrementally, so the note stays fully disposable/regenerable. The AI statement body (between
 * the sentinel markers) and its `statement_tip` are read back and carried forward verbatim;
 * this function never writes statement content — that's the future MCP server's job.
 */
export async function regenerateContext(ref: SpaceRef, app: App): Promise<void> {
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

	let statementTip: string | null = null;
	if (existingFile) {
		const cache = app.metadataCache.getFileCache(existingFile);
		const cachedTip = cache?.frontmatter?.statement_tip;
		statementTip = typeof cachedTip === "string" ? cachedTip : null;
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
 * Future drop-in point for the MCP server / statement generator: writes new AI statement text
 * and stamps statement_tip, without touching the objective frontmatter fields above. Exported
 * now (unused in v0.1) so the shape of the eventual integration is settled.
 */
export async function writeStatement(ref: SpaceRef, text: string, atTip: string, app: App): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(ref.contextPath);
	if (!(existing instanceof TFile)) {
		throw new Error(`[AethersWeb] cannot write statement: no context note at ${ref.contextPath}`);
	}
	const current = await app.vault.read(existing);
	const startIdx = current.indexOf(STATEMENT_START_MARKER);
	const endIdx = current.indexOf(STATEMENT_END_MARKER);
	if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
		throw new Error(`[AethersWeb] statement markers not found in ${ref.contextPath}`);
	}
	const before = current.slice(0, startIdx + STATEMENT_START_MARKER.length);
	const after = current.slice(endIdx);
	await app.vault.modify(existing, `${before}\n${text.trim()}\n${after}`);
	await app.fileManager.processFrontMatter(existing, (fm: Record<string, unknown>) => {
		fm.statement_tip = atTip;
	});
}
