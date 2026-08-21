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

export interface StatementDriftAssessment {
	/** Whether this drift is worth spending a write_statement call on. */
	significant: boolean;
	/** How many spins have accumulated since the last statement (or the whole log, if none exists). */
	spinCount: number;
	/** Structural spin types (deduped) found among those spins, if any. */
	structuralChanges: SpinType[];
	/** Human-readable grounds for `significant` — empty when not significant. */
	reasons: string[];
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
 * Judges drift significance from the spins recorded since the last statement.
 *
 * Two independent triggers, either is enough to make the drift significant:
 * - **structural**: any subspace appeared or vanished in that range. The statement's placement
 *   claim is flatly wrong now, not just dated, no matter how few spins that took.
 * - **volume**: `threshold` or more spins piled up since the last statement, even if every one of
 *   them was a routine file edit that individually changed nothing about what the statement says.
 *
 * A space with no prior statement (`hasStatement: false`) is always significant — there is no
 * existing claim about the space that could still be "close enough," so there is nothing to weigh
 * against a threshold.
 */
export function assessStatementDrift(
	spinsSinceStatement: Spin[],
	hasStatement: boolean,
	threshold: number = STATEMENT_DRIFT_THRESHOLD,
): StatementDriftAssessment {
	if (!hasStatement) {
		return {
			significant: true,
			spinCount: spinsSinceStatement.length,
			structuralChanges: [],
			reasons: ["no statement has ever been written for this space"],
		};
	}

	const structuralChanges = [
		...new Set(spinsSinceStatement.map((s) => s.spin_type).filter((t) => STRUCTURAL_SPIN_TYPES.has(t))),
	];

	const reasons: string[] = [];
	if (structuralChanges.length > 0) {
		reasons.push(`composition changed since the last statement (${structuralChanges.join(", ")})`);
	}
	if (spinsSinceStatement.length >= threshold) {
		reasons.push(`${spinsSinceStatement.length} spin(s) have accumulated since the last statement`);
	}

	return {
		significant: reasons.length > 0,
		spinCount: spinsSinceStatement.length,
		structuralChanges,
		reasons,
	};
}
