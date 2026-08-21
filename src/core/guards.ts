import { foldLogToLastKnownFiles, foldLogToLastKnownSubspaces } from "./fold-files";
import type { Spin } from "./types";

/**
 * Whether a log actually needs to be told something it may already know.
 *
 * These exist because the same real-world event reaches a space's log by more than one route, and
 * the routes cannot see each other. Scaffolding a space also fires the vault `create` event that
 * scaffolds spaces. Reconciliation walks the filesystem while live capture is watching it. A
 * folder move emits an event per descendant. Each route was independently correct and, together,
 * they wrote a history that disagreed with what happened: in a real vault, every scaffolded space
 * carried `space_created` at both seq 0 and seq 1, and its parent recorded the same arrival twice,
 * milliseconds apart.
 *
 * The fix is not to make the routes aware of each other — they genuinely can't be — but to make
 * the write conditional on the log's own state, decided under the log's lock. A second writer with
 * nothing new to say stands down. Kept pure and separate from `log.ts` so the decision is
 * inspectable and testable without an Obsidian `App` behind it.
 */

/** True when the log's record of this subspace's presence disagrees with what happened. */
export function shouldRecordSubspaceEvent(
	log: Spin[],
	kind: "subspace_created" | "subspace_removed",
	subspaceName: string,
): boolean {
	const present = foldLogToLastKnownSubspaces(log).has(subspaceName);
	return present !== (kind === "subspace_created");
}

/**
 * True when the log believes this path currently exists. Guards against recording a removal twice
 * (a delete event arriving after reconciliation already caught the same disappearance) and against
 * recording the removal of a path this space never knew about.
 */
export function shouldRecordFileDeleted(log: Spin[], path: string): boolean {
	const known = foldLogToLastKnownFiles(log)[path];
	return known !== undefined && !known.deleted;
}

/**
 * True when this content differs from what the log last recorded at this path.
 *
 * Obsidian fires `modify` on every save, including saves that changed nothing, and the debounce
 * window merges keystrokes but cannot distinguish a real edit from a no-op one. Recording those
 * costs a permanent line of history plus a full diff payload to state that nothing happened. The
 * comparison is exact — same path, same content hash, not deleted — never a heuristic.
 */
export function shouldRecordFileContent(log: Spin[], path: string, contentHash: string): boolean {
	const known = foldLogToLastKnownFiles(log)[path];
	return known === undefined || known.deleted || known.hash !== contentHash;
}
