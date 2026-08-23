import {
	BLOCK_MARKERS,
	RESERVED_MARKERS,
	DEFAULT_SHARED_PLACEHOLDER,
	SIGNATURE_MARKER_PREFIX,
} from "./constants";
import type { BlockKind } from "./constants";
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
 * Containment: AI-generated text goes inside a marked block, and cannot get out.
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
 *
 * There are two kinds of block, and everything below is written once and parameterized by which
 * (`BlockKind`, in `core/constants.ts`, where the reasoning for the split lives):
 *
 * - **statement** — AI-only and regenerated. Written here, replaced wholesale by the next
 *   regeneration, and never a place for anything that has to survive.
 * - **shared** — held in common. An agent writes into it through exactly the same containment and
 *   signing path, and so nothing about attribution weakens: what the agent wrote is still hashed
 *   and still signed. What changes is only what a *mismatch* between prose and hash means. In a
 *   statement it means AI text somebody edited; in a shared block it means the region did its job.
 *
 * One rule holds across both and is the reason a shared block can exist at all: **an AI write never
 * reaches outside a block.** A third region held in common is safe precisely because it is bounded
 * the same way the first one is — the person's own writing outside both is untouched by either.
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
	for (const marker of [...RESERVED_MARKERS, SIGNATURE_MARKER_PREFIX]) {
		if (text.includes(marker)) {
			throw new StatementContainmentError(
				`text contains the literal marker ${marker.trim()}, which would break it out of its ` +
					`own block, conjure a region of the other kind inside it, or forge its signature. ` +
					`Refer to the marker descriptively (e.g. "the statement END marker") rather than ` +
					`reproducing it.`,
			);
		}
	}
}

/**
 * Wraps text in a block of the given kind. The one place a block's shape is constructed.
 *
 * `sig` is omitted only for the unwritten-yet placeholder a fresh context note carries — there is
 * no author to attribute and nothing for a person to verify. All actual AI content is signed.
 */
export function wrapInBlock(
	text: string,
	kind: BlockKind = "statement",
	sig?: StatementSignature,
	path = "",
): string {
	assertContainable(text);
	const { start, end } = BLOCK_MARKERS[kind];
	const body = sig ? `${text.trim()}\n\n${renderSignature(sig, text, path, kind)}` : text.trim();
	return `${start}\n${body}\n${end}\n`;
}

/** `wrapInBlock` for the statement region. Kept as its own name because most callers mean this. */
export function wrapInStatementBlock(text: string, sig?: StatementSignature, path = ""): string {
	return wrapInBlock(text, "statement", sig, path);
}

/**
 * Wraps block contents that already *are* block contents — signature and all — without validating
 * them. The carry-forward path: context regeneration rebuilds a note's frontmatter and reinstates
 * its existing body verbatim, and that body legitimately contains the signature markers that
 * `wrapInStatementBlock` refuses in new AI text. Validating here would make a note impossible to
 * regenerate the moment its statement was signed.
 */
export function wrapPreservedBlockBody(inner: string, kind: BlockKind = "statement"): string {
	const { start, end } = BLOCK_MARKERS[kind];
	return `${start}\n${inner.trim()}\n${end}\n`;
}

/**
 * The signature comment plus the visible line rendered from it, always emitted as a pair.
 *
 * `path` is here only for the visible line: what it asks of the reader depends on where the content
 * sits (see `requiresVerification`). The marker itself is path-independent — a signature says who
 * wrote what, and moving a file does not change that.
 */
function renderSignature(
	sig: StatementSignature,
	text: string,
	path: string,
	kind: BlockKind = "statement",
): string {
	const status = signatureStatus(sig, text);
	const footer = renderSignatureFooter(sig, status, requiresVerification(path, kind), kind);
	return `${renderSignatureMarker(sig)}\n${footer}`;
}

export interface BlockBounds {
	start: number;
	end: number;
	innerStart: number;
	innerEnd: number;
}

/** Locates the first block of the given kind in a document, or null when it has none. */
export function findBlock(noteText: string, kind: BlockKind = "statement"): BlockBounds | null {
	const { start: startMarker, end: endMarker } = BLOCK_MARKERS[kind];
	const start = noteText.indexOf(startMarker);
	if (start === -1) return null;
	const innerStart = start + startMarker.length;
	const innerEnd = noteText.indexOf(endMarker, innerStart);
	if (innerEnd === -1) return null;
	return { start, end: innerEnd + endMarker.length, innerStart, innerEnd };
}

/** `findBlock` for the statement region. */
export function findStatementBlock(noteText: string): BlockBounds | null {
	return findBlock(noteText, "statement");
}

/**
 * Replaces one region of a document, leaving every other byte untouched.
 *
 * The preservation is the point, not a nicety. Because the write is scoped to the block, an agent
 * rewriting a note it authored cannot clobber a paragraph the person added underneath — the two
 * kinds of writing occupy separate, marked regions of the same file, and only one of them is
 * reachable from here. A document with no block yet gets one appended rather than being taken
 * over: existing text is presumed human until something says otherwise.
 */
export function replaceBlock(
	noteText: string,
	text: string,
	kind: BlockKind = "statement",
	sig?: StatementSignature,
	path = "",
): string {
	assertContainable(text);
	const inner = sig ? `${text.trim()}\n\n${renderSignature(sig, text, path, kind)}` : text.trim();
	const block = findBlock(noteText, kind);
	if (!block) return insertBlock(noteText, wrapInBlock(text, kind, sig, path), kind);
	return `${noteText.slice(0, block.innerStart)}\n${inner}\n${noteText.slice(block.innerEnd)}`;
}

/** `replaceBlock` for the statement region. */
export function replaceStatementBlock(
	noteText: string,
	text: string,
	sig?: StatementSignature,
	path = "",
): string {
	return replaceBlock(noteText, text, "statement", sig, path);
}

/**
 * Places a whole block into a document that has none of that kind, without disturbing a byte of
 * what is already there.
 *
 * A shared block goes directly after the statement block when there is one. That keeps the two
 * machine-touched regions adjacent at the top and — the part that actually matters — leaves the
 * person's own prose below them in one contiguous piece instead of sawing it in half. With no
 * statement block to anchor to, it appends, like everything else here.
 */
function insertBlock(noteText: string, blockText: string, kind: BlockKind): string {
	if (kind === "shared") {
		const statement = findBlock(noteText, "statement");
		if (statement) {
			const before = noteText.slice(0, statement.end);
			const rest = noteText.slice(statement.end).replace(/^\n+/, "");
			return `${before}\n\n${blockText}${rest.length > 0 ? `\n${rest}` : ""}`;
		}
	}
	const separator = noteText.length === 0 || noteText.endsWith("\n") ? "" : "\n";
	return `${noteText}${separator}${noteText.length > 0 ? "\n" : ""}${blockText}`;
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
export function writeSignedBlock(
	noteText: string,
	text: string,
	kind: BlockKind,
	agent: string,
	atTip: string | null,
	path: string,
): string {
	assertContainable(text);
	const existing = readSignedBlock(noteText, kind);
	if (existing?.signature && hashStatementText(existing.text) === hashStatementText(text)) {
		return noteText;
	}
	return replaceBlock(noteText, text, kind, buildSignature(text, agent, atTip), path);
}

/** `writeSignedBlock` for the statement region. */
export function writeSignedStatement(
	noteText: string,
	text: string,
	agent: string,
	atTip: string | null,
	path: string,
): string {
	return writeSignedBlock(noteText, text, "statement", agent, atTip, path);
}

/**
 * Adds to the shared block rather than replacing it — the default way an agent writes there.
 *
 * A full replace is the wrong default for a region held in common, and not by a small margin. To
 * replace it safely an agent would have to read the person's writing and re-emit it verbatim
 * alongside its own, which is exactly the operation a language model performs least reliably: the
 * failure mode is not a crash but a quiet paraphrase of someone's own words back at them, with a
 * signature underneath. Appending cannot do that. What was there stays byte for byte, and the
 * agent's contribution lands beneath it.
 *
 * The starting placeholder is the one thing this does overwrite. It is the system's own boilerplate
 * announcing that nobody has written here yet — leaving it stranded above the first real entry
 * would be keeping a sentence that has become false.
 *
 * Re-appending text already sitting at the end of the block is a no-op, for the same reason
 * re-writing identical statement prose is: an agent retrying a call should not leave the person
 * reading the same paragraph twice.
 */
export function appendToSharedBlock(
	noteText: string,
	text: string,
	agent: string,
	atTip: string | null,
	path: string,
): string {
	assertContainable(text);
	const addition = text.trim();
	const existing = readSignedBlock(noteText, "shared");
	const prior = existing && existing.text !== DEFAULT_SHARED_PLACEHOLDER ? existing.text.trim() : "";
	if (prior.length > 0 && prior.endsWith(addition)) return noteText;
	const combined = prior.length > 0 ? `${prior}\n\n${addition}` : addition;
	return replaceBlock(noteText, combined, "shared", buildSignature(combined, agent, atTip), path);
}

/**
 * Gives a folder note its shared block if it hasn't got one, and returns null if it already has.
 *
 * Called from regeneration, which otherwise does almost nothing to a folder note on purpose. This
 * earns its place there for the same reason creating the note at all does: a region held in common
 * that only appears once an agent has written in it is not held in common — the person would have
 * no place to leave a note *first*, and no way to know the place existed. It is created empty, and
 * from that moment regeneration never touches it again.
 */
export function ensureSharedBlock(noteText: string): string | null {
	if (findBlock(noteText, "shared")) return null;
	return insertBlock(noteText, wrapInBlock(DEFAULT_SHARED_PLACEHOLDER, "shared"), "shared");
}

/**
 * The document with the named regions cut out — what is left is the person's own writing and
 * nothing else. Removes back to front so each slice is taken against indices that are still valid.
 */
export function stripBlocks(noteText: string, kinds: BlockKind[] = ["statement", "shared"]): string {
	const bounds = kinds
		.map((kind) => findBlock(noteText, kind))
		.filter((b): b is BlockBounds => b !== null)
		.sort((a, b) => b.start - a.start);
	let out = noteText;
	for (const b of bounds) out = out.slice(0, b.start) + out.slice(b.end);
	return out.trim();
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

/** Reads the prose and signature of one region straight out of a whole document. */
export function readSignedBlock(
	noteText: string,
	kind: BlockKind = "statement",
): { text: string; signature: StatementSignature | null } | null {
	const block = findBlock(noteText, kind);
	if (!block) return null;
	return splitSignedBlock(noteText.slice(block.innerStart, block.innerEnd));
}

/** `readSignedBlock` for the statement region. */
export function readSignedStatement(noteText: string): { text: string; signature: StatementSignature | null } | null {
	return readSignedBlock(noteText, "statement");
}

/**
 * Re-writes a document's block with an updated signature, leaving the prose exactly as it is.
 * Used by verification, which must never touch a single character of what it is confirming.
 */
export function replaceSignature(
	noteText: string,
	sig: StatementSignature,
	path: string,
	kind: BlockKind = "statement",
): string | null {
	const existing = readSignedBlock(noteText, kind);
	if (!existing) return null;
	return replaceBlock(noteText, existing.text, kind, sig, path);
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

/**
 * Whether a path is a space's own context note — the folder note `<Space>/<Space>.md`.
 *
 * Structural rather than a lookup, because the filename convention *is* the identity: that is the
 * same thing `buildSpaceRef` computes, and it holds for a space whose folder has been moved,
 * renamed, or handed to another vault. A note directly at the vault root can never match, since the
 * root is never a space.
 */
export function isContextNotePath(path: string): boolean {
	const segments = path.split("/").filter((s) => s.length > 0);
	if (segments.length < 2) return false;
	return segments[segments.length - 1] === `${segments[segments.length - 2]}.md`;
}

/**
 * Whether AI content at this path is held for a person's confirmation.
 *
 * Everywhere except a space's context note, it is. An authored file is not derived from anything:
 * nothing regenerates it, nothing else in the vault says what it should contain, and the person
 * will read it back a year later as part of their own notes. That is content a machine wrote into
 * someone's world, and it stays pending until they say they stand behind it.
 *
 * A statement in a context note is the opposite case on every count. The note is derived and
 * disposable, rebuilt from the log whenever the space moves on; the log beside it is the authority
 * on what actually happened, so a statement that drifts is corrected by regenerating it, not by
 * someone having certified an earlier version. It is still contained, still signed, still visibly
 * attributed — it is simply not asked for. Demanding a signature on the one artifact the system
 * rewrites on its own would spend the person's attention where it changes nothing, and attention
 * spent on that is attention not spent on the file where a confirmation is the only record there
 * will ever be.
 *
 * A shared block is never held for confirmation either, and for a reason of its own rather than the
 * context note's: the person is a writer in that region, not a reviewer of it. Asking them to
 * certify a block they can and do type into themselves would be asking them to approve their own
 * sentences, and would turn every note they leave for an agent into an outstanding task.
 *
 * Not required is not forbidden: a person can still verify a statement, and that verification is
 * recorded exactly like any other. Nothing asks them to.
 */
export function requiresVerification(path: string, kind: BlockKind = "statement"): boolean {
	if (kind === "shared") return false;
	return !isContextNotePath(path);
}
