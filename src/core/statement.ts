import {
	SIGNATURE_MARKER_PREFIX,
	STATEMENT_END_MARKER,
	STATEMENT_START_MARKER,
} from "./constants";
import {
	buildSignature,
	hashStatementText,
	parseSignatureMarker,
	renderSignatureFooter,
	renderSignatureMarker,
	signatureStatus,
} from "./signature";
import type { StatementSignature } from "./signature";

/**
 * Containment: AI-generated text goes inside an AETHERSWEB:STATEMENT block, and cannot get out.
 *
 * The markers were always the convention, but nothing enforced them — they were assumed rather
 * than checked, in two different ways:
 *
 * 1. `write_statement` sliced *around* the markers and never inspected the text going between
 *    them. Statement text containing an END marker terminates its own block early: every reader
 *    finds the first END with `indexOf`, so the remainder sits physically inside the block while
 *    reading as ordinary human-written body. Not a hypothetical — a statement discussing this
 *    vault's own format is a natural thing for an agent to write.
 * 2. `write_file` wrote wherever it was told, unmarked. An agent authoring a note produced text
 *    indistinguishable from the person's own.
 *
 * Both matter for the same reason. A vault meant to hand someone back verified clarity about their
 * own world has to keep visible which words are theirs and which a machine supplied. Once that is
 * ambiguous it cannot be recovered later by inspection — nothing in the file says who wrote what.
 *
 * Containment alone only answers *where* the AI content is. Every block written through here also
 * carries a signature saying who wrote it, when, against what state, and whether a person has
 * confirmed it — see `core/signature.ts`. Placement and attribution are written together because a
 * block that could exist without a signature would make the signature optional in practice.
 */

export class StatementContainmentError extends Error {}

/**
 * Refuses text that would break out of its own block.
 *
 * Rejecting rather than silently escaping is deliberate. Mangling markers into lookalikes would
 * keep the write working while quietly altering what the agent said, and this codebase does not
 * smooth over things it cannot honestly resolve. The caller is told exactly what to change.
 */
export function assertContainable(text: string): void {
	for (const marker of [STATEMENT_START_MARKER, STATEMENT_END_MARKER, SIGNATURE_MARKER_PREFIX]) {
		if (text.includes(marker)) {
			throw new StatementContainmentError(
				`statement text contains the literal marker ${marker.trim()}, which would break it out ` +
					`of its own block or forge its signature. Refer to the marker descriptively ` +
					`(e.g. "the statement END marker") rather than reproducing it.`,
			);
		}
	}
}

/**
 * Wraps text in a statement block. The one place the block's shape is constructed.
 *
 * `sig` is omitted only for the unwritten-yet placeholder a fresh context note carries — there is
 * no author to attribute and nothing for a person to verify. All actual AI content is signed.
 */
export function wrapInStatementBlock(text: string, sig?: StatementSignature): string {
	assertContainable(text);
	const body = sig ? `${text.trim()}\n\n${renderSignature(sig, text)}` : text.trim();
	return `${STATEMENT_START_MARKER}\n${body}\n${STATEMENT_END_MARKER}\n`;
}

/**
 * Wraps block contents that already *are* block contents — signature and all — without validating
 * them. The carry-forward path: context regeneration rebuilds a note's frontmatter and reinstates
 * its existing body verbatim, and that body legitimately contains the signature markers that
 * `wrapInStatementBlock` refuses in new AI text. Validating here would make a note impossible to
 * regenerate the moment its statement was signed.
 */
export function wrapPreservedBlockBody(inner: string): string {
	return `${STATEMENT_START_MARKER}\n${inner.trim()}\n${STATEMENT_END_MARKER}\n`;
}

/** The signature comment plus the visible line rendered from it, always emitted as a pair. */
function renderSignature(sig: StatementSignature, text: string): string {
	return `${renderSignatureMarker(sig)}\n${renderSignatureFooter(sig, signatureStatus(sig, text))}`;
}

/** Locates the first statement block in a document, or null when it has none. */
export function findStatementBlock(
	noteText: string,
): { start: number; end: number; innerStart: number; innerEnd: number } | null {
	const start = noteText.indexOf(STATEMENT_START_MARKER);
	if (start === -1) return null;
	const innerStart = start + STATEMENT_START_MARKER.length;
	const innerEnd = noteText.indexOf(STATEMENT_END_MARKER, innerStart);
	if (innerEnd === -1) return null;
	return { start, end: innerEnd + STATEMENT_END_MARKER.length, innerStart, innerEnd };
}

/**
 * Replaces the AI-written portion of a document, leaving every other byte untouched.
 *
 * The preservation is the point, not a nicety. Because the write is scoped to the block, an agent
 * rewriting a note it authored cannot clobber a paragraph the person added underneath — the two
 * kinds of writing occupy separate, marked regions of the same file, and only one of them is
 * reachable from here. A document with no block yet gets one appended rather than being taken
 * over: existing text is presumed human until something says otherwise.
 */
export function replaceStatementBlock(noteText: string, text: string, sig?: StatementSignature): string {
	assertContainable(text);
	const inner = sig ? `${text.trim()}\n\n${renderSignature(sig, text)}` : text.trim();
	const block = findStatementBlock(noteText);
	if (!block) {
		const separator = noteText.length === 0 || noteText.endsWith("\n") ? "" : "\n";
		return `${noteText}${separator}${noteText.length > 0 ? "\n" : ""}${wrapInStatementBlock(text, sig)}`;
	}
	return `${noteText.slice(0, block.innerStart)}\n${inner}\n${noteText.slice(block.innerEnd)}`;
}

/**
 * Signs `text` and writes it into `noteText`'s block — the normal path for any AI write.
 * `agent` is self-declared, as signatures are; what makes it worth anything is that the hash
 * beside it can be checked, and that a person's verification is recorded separately.
 *
 * Writing prose byte-identical to what is already there leaves the existing signature completely
 * untouched, which matters for two reasons that both follow from hashing the content rather than
 * the event:
 *
 * - **A person's verification survives.** They confirmed these exact words; re-writing the same
 *   words changes nothing they approved, so silently discarding their confirmation would be wrong.
 * - **Nothing happened, so nothing is recorded.** A fresh `written_at` on every call would make the
 *   file differ each time, defeating the no-op suppression downstream and filling a space's history
 *   with entries reporting that its statement is unchanged.
 */
export function writeSignedStatement(
	noteText: string,
	text: string,
	agent: string,
	atTip: string | null,
): string {
	assertContainable(text);
	const existing = readSignedStatement(noteText);
	if (existing?.signature && hashStatementText(existing.text) === hashStatementText(text)) {
		return noteText;
	}
	return replaceStatementBlock(noteText, text, buildSignature(text, agent, atTip));
}

/**
 * Splits a block's raw contents into the prose a reader cares about and the signature attached to
 * it. Callers displaying or re-signing statement text want the prose; `extractStatementBlock`
 * (context-format.ts) deliberately keeps returning the raw inner text, because context
 * regeneration carries the body forward verbatim and must not strip the signature off it.
 */
export function splitSignedBlock(blockInner: string): { text: string; signature: StatementSignature | null } {
	const signature = parseSignatureMarker(blockInner);
	const markerIdx = blockInner.indexOf(SIGNATURE_MARKER_PREFIX);
	const text = (markerIdx === -1 ? blockInner : blockInner.slice(0, markerIdx)).trim();
	return { text, signature };
}

/** Reads the prose and signature straight out of a whole document. */
export function readSignedStatement(noteText: string): { text: string; signature: StatementSignature | null } | null {
	const block = findStatementBlock(noteText);
	if (!block) return null;
	return splitSignedBlock(noteText.slice(block.innerStart, block.innerEnd));
}

/**
 * Re-writes a document's block with an updated signature, leaving the prose exactly as it is.
 * Used by verification, which must never touch a single character of what it is confirming.
 */
export function replaceSignature(noteText: string, sig: StatementSignature): string | null {
	const existing = readSignedStatement(noteText);
	if (!existing) return null;
	return replaceStatementBlock(noteText, existing.text, sig);
}

/**
 * Whether a file can carry an inline signed block, i.e. whether an HTML comment is inert in it.
 *
 * A marker written into JSON or CSV corrupts the file, and bytes cannot carry one at all — so these
 * formats get their attribution from the log instead, where every AI-originated spin records the
 * agent that produced it. Writing them is allowed; going unsigned is not. Inline where the format
 * permits, in the log where it does not, never nowhere.
 */
const STATEMENT_WRITABLE_EXTENSIONS = new Set(["md", "markdown", "txt"]);

export function isStatementWritable(path: string): boolean {
	const name = path.split("/").pop() ?? path;
	const dotIdx = name.lastIndexOf(".");
	if (dotIdx <= 0) return true; // no extension — treated as plain text
	return STATEMENT_WRITABLE_EXTENSIONS.has(name.slice(dotIdx + 1).toLowerCase());
}

export const STATEMENT_WRITABLE_HINT = "markdown or plain text (.md, .markdown, .txt, or no extension)";
