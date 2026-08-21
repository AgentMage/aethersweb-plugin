import { describe, expect, it } from "vitest";
import { RenameEchoTracker } from "../../src/core/rename-echo";

/**
 * Reconstructs the exact event burst a real vault produced: `Lillyverse/Trinidad` was dragged into
 * `Lillyverse/Colorado`, and Obsidian fired a rename for Trinidad *and* for each of its two
 * subspaces. The descendant events were handled as genuine moves, so Trinidad's own log gained a
 * second `subspace_created` for both children (seq 6 and 7) while neither removal was recorded.
 */
describe("RenameEchoTracker", () => {
	const MOVE = ["Lillyverse/Trinidad", "Lillyverse/Colorado/Trinidad"] as const;

	it("recognizes the descendant renames a folder move propagates", () => {
		const tracker = new RenameEchoTracker();
		tracker.record(MOVE[0], MOVE[1], 1000);

		for (const child of ["Roadrunner Ranch", "Marc O's Ranch", "Trinidad.md"]) {
			expect(tracker.isEcho(`${MOVE[0]}/${child}`, `${MOVE[1]}/${child}`, 1001)).toBe(true);
		}
		// ...including one nested deeper than a direct child.
		expect(tracker.isEcho(`${MOVE[0]}/Roadrunner Ranch/gps.md`, `${MOVE[1]}/Roadrunner Ranch/gps.md`, 1001)).toBe(true);
	});

	it("does not swallow the move that caused the echoes", () => {
		const tracker = new RenameEchoTracker();
		tracker.record(MOVE[0], MOVE[1], 1000);
		expect(tracker.isEcho(MOVE[0], MOVE[1], 1000)).toBe(false);
	});

	it("does not swallow a genuine rename happening in the same burst", () => {
		const tracker = new RenameEchoTracker();
		tracker.record(MOVE[0], MOVE[1], 1000);

		// A real rename of a descendant: it moved with the folder AND changed its own name, so the
		// new path is not what the remap alone would produce.
		expect(tracker.isEcho(`${MOVE[0]}/Roadrunner Ranch`, `${MOVE[1]}/Roadrunner Ranch (old)`, 1001)).toBe(false);
		// An unrelated space moving elsewhere entirely.
		expect(tracker.isEcho("Lillyverse/Colorado/Blanca", "Lillyverse/Blanca", 1001)).toBe(false);
	});

	it("expires, so a later real move of the same path is not mistaken for an echo", () => {
		const tracker = new RenameEchoTracker(2000);
		tracker.record(MOVE[0], MOVE[1], 1000);
		expect(tracker.isEcho(`${MOVE[0]}/Roadrunner Ranch`, `${MOVE[1]}/Roadrunner Ranch`, 1500)).toBe(true);
		expect(tracker.isEcho(`${MOVE[0]}/Roadrunner Ranch`, `${MOVE[1]}/Roadrunner Ranch`, 9000)).toBe(false);
	});
});
