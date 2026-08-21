import { describe, expect, it } from "vitest";
import { assessStatementDrift, spinsSinceTip } from "../../src/core/drift";
import type { Spin } from "../../src/core/types";

function makeSpin(seq: number, spin_type: Spin["spin_type"], hash: string): Spin {
	return {
		seq,
		ts: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
		spin_type,
		source: "observed",
		payload: {},
		prev_hash: seq === 0 ? null : `h${seq - 1}`,
		hash,
	};
}

describe("core/drift.ts::spinsSinceTip", () => {
	it("returns the whole log when tip is null", () => {
		const log = [makeSpin(0, "space_created", "h0"), makeSpin(1, "file_created", "h1")];
		expect(spinsSinceTip(log, null)).toEqual(log);
	});

	it("returns only spins after the matching hash", () => {
		const log = [makeSpin(0, "space_created", "h0"), makeSpin(1, "file_created", "h1"), makeSpin(2, "file_created", "h2")];
		expect(spinsSinceTip(log, "h1")).toEqual([log[2]]);
	});

	it("returns an empty array when the tip is the log's current tail", () => {
		const log = [makeSpin(0, "space_created", "h0"), makeSpin(1, "file_created", "h1")];
		expect(spinsSinceTip(log, "h1")).toEqual([]);
	});

	it("falls back to the whole log when the tip is no longer present (truncated/repaired past it)", () => {
		const log = [makeSpin(5, "file_created", "h5"), makeSpin(6, "file_created", "h6")];
		expect(spinsSinceTip(log, "gone")).toEqual(log);
	});
});

describe("core/drift.ts::assessStatementDrift", () => {
	it("is always significant when no statement has ever been written, even with zero spins since", () => {
		const result = assessStatementDrift([], false);
		expect(result.significant).toBe(true);
		expect(result.reasons).toEqual(["no statement has ever been written for this space"]);
	});

	it("is not significant for a handful of routine edits under the threshold", () => {
		const spins = [makeSpin(1, "file_created", "h1"), makeSpin(2, "file_modified", "h2")];
		const result = assessStatementDrift(spins, true, 5);
		expect(result.significant).toBe(false);
		expect(result.reasons).toEqual([]);
		expect(result.spinCount).toBe(2);
	});

	it("becomes significant once the spin count reaches the threshold", () => {
		const spins = Array.from({ length: 5 }, (_, i) => makeSpin(i, "file_modified", `h${i}`));
		const result = assessStatementDrift(spins, true, 5);
		expect(result.significant).toBe(true);
		expect(result.reasons).toEqual(["5 spin(s) have accumulated since the last statement"]);
	});

	it("is significant on a single structural spin regardless of count", () => {
		const spins = [makeSpin(1, "subspace_created", "h1")];
		const result = assessStatementDrift(spins, true, 5);
		expect(result.significant).toBe(true);
		expect(result.structuralChanges).toEqual(["subspace_created"]);
		expect(result.reasons).toEqual(["composition changed since the last statement (subspace_created)"]);
	});

	it("dedupes repeated structural spin types and reports both triggers when both apply", () => {
		const spins = [
			makeSpin(1, "subspace_created", "h1"),
			makeSpin(2, "subspace_removed", "h2"),
			makeSpin(3, "subspace_created", "h3"),
		];
		const result = assessStatementDrift(spins, true, 3);
		expect(result.structuralChanges).toEqual(["subspace_created", "subspace_removed"]);
		expect(result.reasons).toEqual([
			"composition changed since the last statement (subspace_created, subspace_removed)",
			"3 spin(s) have accumulated since the last statement",
		]);
	});

	it("uses the shared default threshold when none is passed", () => {
		const belowDefault = Array.from({ length: 4 }, (_, i) => makeSpin(i, "file_modified", `h${i}`));
		expect(assessStatementDrift(belowDefault, true).significant).toBe(false);
		const atDefault = Array.from({ length: 5 }, (_, i) => makeSpin(i, "file_modified", `h${i}`));
		expect(assessStatementDrift(atDefault, true).significant).toBe(true);
	});
});
