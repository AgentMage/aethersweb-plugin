import { SIGNATURE_MARKER_PREFIX, SIGNATURE_MARKER_SUFFIX } from "./constants";
import type { BlockKind } from "./constants";
import { sha256Hex } from "./hash";

/**
 * Attribution and verification for AI-generated content.
 *
 * Containing AI text in a block says *where* it is. It does not say who wrote it, when, against
 * what state, or whether the person whose vault this is has ever looked at it — and those are the
 * questions that actually matter when reading your own vault back a year later. A block of
 * confident prose with no provenance is worse than no prose, because it reads exactly like
 * something you wrote and remembered writing.
 *
 * So every AI write is signed, and the signature is checkable rather than decorative:
 *
 * - `content_sha256` is the hash of the prose it signs. A signature can therefore be confirmed
 *   against the text it sits above, instead of merely asserting something about it.
 * - `verified` is a person's confirmation, and it records the hash *they* read. If the prose is
 *   edited afterward, the hashes stop matching and the status reverts to `stale_verification` on
 *   its own. Verification cannot be quietly inherited by words nobody approved.
 *
 * Verification is deliberately not something an agent can perform — see `applyVerification`.
 */

export interface VerificationRecord {
	/** Who confirmed it. A person, never an agent. */
	by: string;
	at: string;
	/** Hash of the prose actually read at confirmation time. */
	content_sha256: string;
}

export interface StatementSignature {
	v: 1;
	/** Self-declared identity of the writer, e.g. "claude-opus-5". */
	agent: string;
	written_at: string;
	/** The log head the content was written against, when the content is a space statement. */
	at_tip: string | null;
	content_sha256: string;
	verified: VerificationRecord | null;
}

export type SignatureStatus = "unsigned" | "unverified" | "verified" | "stale_signature" | "stale_verification";

export function hashStatementText(text: string): string {
	return sha256Hex(text.trim());
}

export function buildSignature(text: string, agent: string, atTip: string | null): StatementSignature {
	return {
		v: 1,
		agent,
		written_at: new Date().toISOString(),
		at_tip: atTip,
		content_sha256: hashStatementText(text),
		verified: null,
	};
}

/** Serializes a signature into the HTML comment that carries it. One line, always. */
export function renderSignatureMarker(sig: StatementSignature): string {
	return `${SIGNATURE_MARKER_PREFIX}${JSON.stringify(sig)}${SIGNATURE_MARKER_SUFFIX}`;
}

/** Reads a signature back out of block text, or null when the content carries none. */
export function parseSignatureMarker(blockInner: string): StatementSignature | null {
	const start = blockInner.indexOf(SIGNATURE_MARKER_PREFIX);
	if (start === -1) return null;
	const from = start + SIGNATURE_MARKER_PREFIX.length;
	const end = blockInner.indexOf(SIGNATURE_MARKER_SUFFIX, from);
	if (end === -1) return null;
	try {
		const parsed = JSON.parse(blockInner.slice(from, end)) as StatementSignature;
		return parsed && parsed.v === 1 && typeof parsed.agent === "string" ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * The human-readable line rendered under signed content. Display only — `renderSignatureMarker`
 * above is the authority, and this is regenerated from it, never parsed back.
 *
 * It is visible on purpose. A signature nobody encounters while reading the note is provenance in
 * name only; the person has to be able to see, without going looking, that a machine wrote this
 * and whether they ever confirmed it.
 *
 * `verificationRequired` changes only what the line *asks of the reader*, never what it reports:
 * unconfirmed content is described as unconfirmed either way. It defaults to true so that content
 * whose placement is unknown is treated as content someone has to stand behind — see
 * `requiresVerification` in `statement.ts`, which is the one place that decides this.
 *
 * `kind` changes the wording for two reasons, and no further — the hashes underneath are identical
 * either way, only the sentence differs:
 *
 * - A shared block is not the agent's to sign as its own. The line reports who wrote there *last*,
 *   never that the text is AI-written, because the sentence above the signature may well be the
 *   person's.
 * - Prose that no longer matches its signature is, in a shared block, the region working exactly
 *   as intended: someone wrote in it, which is the point of holding one in common. Reporting that
 *   as "this signature no longer covers it" would read as damage and invite them to undo their own
 *   writing.
 */
export function renderSignatureFooter(
	sig: StatementSignature,
	status: SignatureStatus,
	verificationRequired = true,
	kind: BlockKind = "statement",
): string {
	const written = sig.written_at.slice(0, 10);

	if (kind === "shared") {
		// Deliberately not "AI-written by": a shared block is not the agent's to claim. The
		// signature records who wrote here last and what the block hashed to at that moment, and
		// that is exactly what this says. Anything stronger would put the person's own sentences
		// under an AI byline the first time an agent added a line beneath them.
		const head = `*— Shared block: yours and the agent’s. Last agent write by \`${sig.agent}\`, ${written}`;
		switch (status) {
			case "verified":
				return `${head}; verified by ${sig.verified?.by} on ${sig.verified?.at.slice(0, 10)}.*`;
			case "stale_verification":
				return `${head}; verified by ${sig.verified?.by}, written in since.*`;
			case "stale_signature":
				return `${head}; written in since.*`;
			default:
				return `${head}. Write in it freely — nothing here is regenerated over.*`;
		}
	}

	const head = `*— AI-written by \`${sig.agent}\`, ${written}.`;
	switch (status) {
		case "verified":
			return `${head} Verified by ${sig.verified?.by} on ${sig.verified?.at.slice(0, 10)}.*`;
		case "stale_verification":
			return `${head} Was verified by ${sig.verified?.by}, but the text has changed since — needs review.*`;
		case "stale_signature":
			return `${head} Text edited after signing — this signature no longer covers it.*`;
		default:
			return verificationRequired
				? `${head} **Not yet verified** — review it and confirm in Obsidian.*`
				: `${head} Derived from this space’s log and regenerated with it — not held for your confirmation.*`;
	}
}

/**
 * Whether signed content is actually waiting on the person — the question every "what still needs
 * me?" surface asks, and the only one that should drive a prompt.
 *
 * Where verification isn't required, nothing is pending: a statement nobody has confirmed is in its
 * normal state, and one whose confirmation lapsed because the log moved on is the system working as
 * intended rather than a task. `stale_signature` is never pending either — it says a person edited
 * AI prose, which is their own writing in an ill-fitting wrapper, not something to confirm.
 */
export function awaitsVerification(status: SignatureStatus, verificationRequired: boolean): boolean {
	return verificationRequired && (status === "unverified" || status === "stale_verification");
}

/**
 * What a signature actually establishes about the prose sitting above it, recomputed from hashes
 * every time rather than read off the footer. The footer is a rendering and can go out of date if
 * a person hand-edits the block; the hashes cannot.
 */
export function signatureStatus(sig: StatementSignature | null, currentText: string): SignatureStatus {
	if (!sig) return "unsigned";
	const currentHash = hashStatementText(currentText);

	// A lapsed verification is checked first and reported in preference to a lapsed signature.
	// Editing verified prose invalidates both hashes at once, and of the two facts, "someone
	// confirmed this and the words have changed since" is the one the person needs to act on;
	// "the signature no longer covers the text" is what it looks like when nobody ever confirmed it.
	if (sig.verified) {
		return sig.verified.content_sha256 === currentHash ? "verified" : "stale_verification";
	}
	return sig.content_sha256 === currentHash ? "unverified" : "stale_signature";
}

/**
 * Records a person's confirmation of the content as it currently stands.
 *
 * This is the one operation in the whole system that an agent must never perform, and the reason is
 * not caution — it is that an agent confirming its own output produces a signature that means
 * nothing while looking exactly like one that means something. Chain repair is plugin-only because
 * it is cooperative; verification is plugin-only because it is only worth anything when a person
 * did it. The MCP server can read every field below and write none of them.
 */
export function applyVerification(
	sig: StatementSignature,
	currentText: string,
	by: string,
): StatementSignature {
	return {
		...sig,
		verified: { by, at: new Date().toISOString(), content_sha256: hashStatementText(currentText) },
	};
}
