import {
	DEFAULT_STATEMENT_PLACEHOLDER,
	STATEMENT_END_MARKER,
	STATEMENT_START_MARKER,
} from "./constants";
import { wrapPreservedBlockBody } from "./statement";
import type { ContextFileEntry, ContextFrontmatter, ContextSubspaceEntry } from "./types";

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
 * Hand-rolled, deterministic YAML for the fixed context-note frontmatter shape — used by both the
 * Obsidian plugin (every write, not only a brand-new note — see context.ts) and the MCP server,
 * which has no Obsidian YAML serializer to defer to anyway. Both sides writing this exact shape,
 * rather than the plugin deferring to Obsidian's own frontmatter serializer for updates, is what
 * keeps every context note parseable by parseFrontmatter regardless of which side last touched it.
 */
export function stringifyFrontmatter(fm: ContextFrontmatter): string {
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

/**
 * The mirror-image of `stringifyFrontmatter`: parses a context note's raw text back into a
 * `ContextFrontmatter` object. Since `stringifyFrontmatter` is the *only* producer of this text
 * and its shape is fixed (deterministic key order, `JSON.stringify`-quoted strings, `files: []` /
 * `subspaces: []` vs the indented-list form), a line-cursor reading that exact shape is exact —
 * not a general YAML parser, deliberately.
 *
 * Returns `null` when `noteText` has no `---\n...\n---\n` frontmatter block at all — "no context
 * note yet" / "not our format", not an error. Throws a plain `Error` when a block *is* present but
 * a line doesn't match the shape `stringifyFrontmatter` produces (wrong key at a fixed position,
 * `file_count`/`subspace_count` not matching the actual list length, non-integer where an int is
 * expected) — "corrupted/foreign note", which callers must handle distinctly from `null`.
 */
export function parseFrontmatter(noteText: string): ContextFrontmatter | null {
	const fmMatch = noteText.match(/^---\n([\s\S]*?)\n---\n/);
	if (!fmMatch) return null;
	const lines = fmMatch[1].split("\n");
	let i = 0;

	function nextLine(): string {
		if (i >= lines.length) throw new Error("parseFrontmatter: unexpected end of frontmatter block");
		return lines[i++];
	}

	// `JSON.stringify` escaping (used by yamlString/yamlScalar) means a string value never
	// contains a literal newline, so a whole-line "key: <rest of line>" capture is always exact.
	function scalar(key: string): string {
		const line = nextLine();
		const match = line.match(new RegExp(`^${key}: (.*)$`));
		if (!match) throw new Error(`parseFrontmatter: expected "${key}:", got "${line}"`);
		return match[1];
	}

	function asInt(raw: string): number {
		if (!/^\d+$/.test(raw)) throw new Error(`parseFrontmatter: expected integer, got "${raw}"`);
		return Number(raw);
	}

	function asString(raw: string): string {
		return JSON.parse(raw) as string;
	}

	function asNullableString(raw: string): string | null {
		return raw === "null" ? null : asString(raw);
	}

	const aetherweb_schema = asInt(scalar("aetherweb_schema"));
	const space_path = asString(scalar("space_path"));
	const source_tip = asNullableString(scalar("source_tip"));
	const generated_at = asString(scalar("generated_at"));
	const file_count = asInt(scalar("file_count"));
	const subspace_count = asInt(scalar("subspace_count"));

	// Scans structurally (by indentation prefix, not by trusting file_count/subspace_count as a
	// loop bound) so a genuinely corrupted count is caught by the explicit check below rather than
	// silently driving the loop into the next section and failing with an unrelated message.
	const files: ContextFileEntry[] = [];
	const filesHeader = nextLine();
	if (filesHeader === "files:") {
		while (i < lines.length && / {2}- path: /.test(lines[i])) {
			const pathMatch = nextLine().match(/^ {2}- path: (.*)$/)!;
			const hashLine = nextLine().match(/^ {4}hash: (.*)$/);
			if (!hashLine) throw new Error(`parseFrontmatter: expected file "hash:" line`);
			const sizeLine = nextLine().match(/^ {4}size: (.*)$/);
			if (!sizeLine) throw new Error(`parseFrontmatter: expected file "size:" line`);
			files.push({ path: asString(pathMatch[1]), hash: asString(hashLine[1]), size: asInt(sizeLine[1]) });
		}
	} else if (filesHeader !== "files: []") {
		throw new Error(`parseFrontmatter: expected "files:" or "files: []", got "${filesHeader}"`);
	}
	if (files.length !== file_count) {
		throw new Error(`parseFrontmatter: file_count (${file_count}) does not match ${files.length} files entries`);
	}

	const subspaces: ContextSubspaceEntry[] = [];
	const subspacesHeader = nextLine();
	if (subspacesHeader === "subspaces:") {
		while (i < lines.length && / {2}- name: /.test(lines[i])) {
			const nameMatch = nextLine().match(/^ {2}- name: (.*)$/)!;
			const tipLine = nextLine().match(/^ {4}tip: (.*)$/);
			if (!tipLine) throw new Error(`parseFrontmatter: expected subspace "tip:" line`);
			subspaces.push({ name: asString(nameMatch[1]), tip: asNullableString(tipLine[1]) });
		}
	} else if (subspacesHeader !== "subspaces: []") {
		throw new Error(`parseFrontmatter: expected "subspaces:" or "subspaces: []", got "${subspacesHeader}"`);
	}
	if (subspaces.length !== subspace_count) {
		throw new Error(`parseFrontmatter: subspace_count (${subspace_count}) does not match ${subspaces.length} subspaces entries`);
	}

	const statement_tip = asNullableString(scalar("statement_tip"));

	return {
		aetherweb_schema,
		space_path,
		source_tip,
		generated_at,
		file_count,
		subspace_count,
		files,
		subspaces,
		statement_tip,
	};
}

/** Extracts the AI statement body text from between the sentinel markers, or the default placeholder if absent. */
export function extractStatementBlock(noteText: string): string {
	const startIdx = noteText.indexOf(STATEMENT_START_MARKER);
	const endIdx = noteText.indexOf(STATEMENT_END_MARKER);
	if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
		return DEFAULT_STATEMENT_PLACEHOLDER;
	}
	return noteText.slice(startIdx + STATEMENT_START_MARKER.length, endIdx).trim();
}

/**
 * A context note's body: one statement block. Takes raw block contents (which for an already-signed
 * note include its signature), so this is the carry-forward path — new AI text is written through
 * `statement.ts`'s signing functions instead, which validate and attribute it.
 */
export function renderBody(statementText: string): string {
	return `\n${wrapPreservedBlockBody(statementText)}`;
}

export function buildNoteText(fm: ContextFrontmatter, body: string): string {
	return `---\n${stringifyFrontmatter(fm)}\n---\n${body}`;
}
