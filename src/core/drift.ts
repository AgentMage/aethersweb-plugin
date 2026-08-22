import { STATEMENT_DRIFT_THRESHOLD } from "./constants";
import type { Spin, SpinType } from "./types";

/**
 * The statement trigger: judges whether a stale statement is worth spending a write_statement call
 * on yet, versus a change too small to bother a person or an agent about.
 *
 * Nothing here decides *when* to check — that stays the caller's job (plan_regeneration, a plugin
 * command, a person). This only answers, given the spins that piled up since the statement was last
 * written, whether that pile-up is significant. See Spec.md's "The statement" and its
 * storage-discipline note that the statement is "debounced: on demand or past a threshold, never on
 * every keystroke, or deep edits cascade model calls up the tree" — this module is that threshold,
 * made concrete and shared between the plugin and the MCP server.
 */

/**
 * Spin types that change what a statement is required to say about a space's *composition* — the
 * "where it sits among parent, siblings, and subspaces" half of write_statement's job (Spec.md's
 * "The statement"). A structural change here is always worth a fresh statement regardless of how
 * many spins have piled up: the previous statement's placement claim is now wrong, not just dated.
 */
const STRUCTURAL_SPIN_TYPES: ReadonlySet<SpinType> = new Set(["subspace_created", "subspace_removed"]);

/** What actually happened since the last statement. Facts only — no judgment about what to do. */
export interface StatementDriftFacts {
	/** How many spins have accumulated since the last statement (or the whole log, if none exists). */
	spinCount: number;
	/** Structural spin types (deduped) found among those spins, if any. */
	structuralChanges: SpinType[];
	/** Human-readable description of what drifted. */
	reasons: string[];
	/** True when no statement has ever been written — there is no prior claim to weigh at all. */
	neverWritten: boolean;
}

export interface StatementDriftAssessment extends StatementDriftFacts {
	/** Whether this drift is worth spending a write_statement call on, per a caller's threshold. */
	significant: boolean;
}

/**
 * Finds every spin after the one whose hash equals `tip` — the range a fresh statement would be
 * judging. Returns the whole log when `tip` is null (no statement has ever been written) or isn't
 * found in it (the log was truncated or repaired past the spin the statement was written against —
 * treat the statement as fully drifted rather than guessing at a partial range).
 */
export function spinsSinceTip(log: Spin[], tip: string | null): Spin[] {
	if (tip === null) return log;
	const idx = log.findIndex((s) => s.hash === tip);
	if (idx === -1) return log;
	return log.slice(idx + 1);
}

/**
 * The spins a fresh statement would actually be judging: everything after the tip it was written
 * against, minus anything that happened to the folder note itself.
 *
 * That exclusion is what keeps the statement from chasing its own tail. Writing a statement edits
 * the folder note, which is an ordinary logged file, so the write advances the head the moment it
 * lands — measured naively, every statement would be stale against its own creation, forever. The
 * same filter also means a person writing their own notes in that file never reads as AI-statement
 * drift: their words are theirs, and nothing about them makes the statement's claims out of date.
 */
export function spinsSinceStatement(log: Spin[], tip: string | null, noteRelPath: string): Spin[] {
	return spinsSinceTip(log, tip).filter((s) => s.payload.path !== noteRelPath);
}

/**
 * Describes what has drifted since the last statement, without deciding what to do about it.
 *
 * This is what the MCP surface reports. Whether a given amount of drift is worth an LLM call is
 * the calling agent's judgment — it can read the log and see what actually changed, which a spin
 * count cannot capture. `assessStatementDrift` below adds a threshold on top for the plugin's own
 * human-facing digest, where a predictable cutoff is exactly what's wanted.
 */
export function describeStatementDrift(spinsSinceStatement: Spin[], hasStatement: boolean): StatementDriftFacts {
	if (!hasStatement) {
		return {
			spinCount: spinsSinceStatement.length,
			structuralChanges: [],
			reasons: ["no statement has ever been written for this space"],
			neverWritten: true,
		};
	}

	const structuralChanges = [
		...new Set(spinsSinceStatement.map((s) => s.spin_type).filter((t) => STRUCTURAL_SPIN_TYPES.has(t))),
	];

	const reasons: string[] = [];
	if (structuralChanges.length > 0) {
		reasons.push(`composition changed since the last statement (${structuralChanges.join(", ")})`);
	}
	if (spinsSinceStatement.length > 0) {
		reasons.push(`${spinsSinceStatement.length} spin(s) have accumulated since the last statement`);
	}

	return { spinCount: spinsSinceStatement.length, structuralChanges, reasons, neverWritten: false };
}

/**
 * Adds a significance judgment on top of the facts, for the plugin's "List spaces needing a fresh
 * statement" command — a person browsing a digest wants noise filtered out at a predictable cutoff.
 *
 * Two independent triggers, either is enough:
 * - **structural**: any subspace appeared or vanished in that range. The statement's placement
 *   claim is flatly wrong now, not just dated, no matter how few spins that took.
 * - **volume**: `threshold` or more spins piled up, even if every one was a routine file edit that
 *   individually changed nothing about what the statement says.
 *
 * A space with no prior statement is always significant — there is no existing claim that could
 * still be "close enough," so there is nothing to weigh against a threshold.
 */
export function assessStatementDrift(
	spinsSinceStatement: Spin[],
	hasStatement: boolean,
	threshold: number = STATEMENT_DRIFT_THRESHOLD,
): StatementDriftAssessment {
	const facts = describeStatementDrift(spinsSinceStatement, hasStatement);
	if (facts.neverWritten) return { ...facts, significant: true };
	const significant = facts.structuralChanges.length > 0 || facts.spinCount >= threshold;
	return { ...facts, significant };
}
