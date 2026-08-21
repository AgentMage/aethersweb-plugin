import { RENAME_ECHO_WINDOW_MS } from "./constants";
import { isUnderOrEqual, reparent } from "./ignore";

interface RenameRecord {
	from: string;
	to: string;
	at: number;
}

/**
 * Recognizes the descendant `rename` events Obsidian fires after a folder move.
 *
 * Moving a folder emits a rename not only for that folder but for everything beneath it. Those
 * descendant events report no change in containment — a note's parent folder is the same folder,
 * which merely sits somewhere new — so a space's log should say nothing about them. Handled
 * naively they actively corrupt it, and did: each descendant's *old* parent path no longer
 * resolved (so its removal was silently dropped) while its *new* parent path did (so a duplicate
 * arrival was appended). A real vault has a space announcing its own two children a second time,
 * in its own log, at the moment its grandparent was dragged elsewhere.
 *
 * A rename is an echo when some recently-recorded folder move, applied as a path remap, turns its
 * old path into exactly its new path. That is precise rather than heuristic: it matches only
 * renames that are the ancestor's move mechanically propagated, and never a genuine rename that
 * happens to occur nearby.
 *
 * The window exists because these events arrive in the same synchronous burst as their ancestor's,
 * so it only has to outlast one event-loop drain. `now` is injectable for tests.
 */
export class RenameEchoTracker {
	private records: RenameRecord[] = [];

	constructor(private readonly windowMs: number = RENAME_ECHO_WINDOW_MS) {}

	/** Records a folder move so its descendants' propagated renames can be recognized. */
	record(from: string, to: string, now: number = Date.now()): void {
		this.records = this.records.filter((r) => now - r.at < this.windowMs);
		this.records.push({ from, to, at: now });
	}

	/** True when this rename is a descendant echo of a folder move recorded within the window. */
	isEcho(oldPath: string, newPath: string, now: number = Date.now()): boolean {
		return this.records.some(
			(r) =>
				now - r.at < this.windowMs &&
				oldPath !== r.from &&
				isUnderOrEqual(oldPath, r.from) &&
				reparent(oldPath, r.from, r.to) === newPath,
		);
	}
}
