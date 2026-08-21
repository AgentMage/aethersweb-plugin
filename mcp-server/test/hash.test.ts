import { describe, expect, it } from "vitest";
import { buildNextSpin, computeSpinHash, verifyChain } from "../../src/core/hash";
import type { Spin } from "../../src/core/types";

describe("core/hash.ts (imported directly — the exact file the plugin uses)", () => {
	it("buildNextSpin chains prev_hash correctly and verifyChain accepts the result", () => {
		const first = buildNextSpin(null, 0, "space_created", "observed", {});
		const second = buildNextSpin(first, 1, "file_created", "observed", { path: "a.md", content_hash: "x" });
		const third = buildNextSpin(second, 2, "file_modified", "detected", { path: "a.md", content_hash: "y" });

		const result = verifyChain([first, second, third]);
		expect(result).toEqual({ ok: true, length: 3 });
	});

	it("verifyChain rejects a seq gap", () => {
		const first = buildNextSpin(null, 0, "space_created", "observed", {});
		const badSecond: Spin = { ...buildNextSpin(first, 2, "file_created", "observed", {}) };
		const result = verifyChain([first, badSecond]);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("seq_gap");
	});

	it("verifyChain rejects a tampered hash", () => {
		const first = buildNextSpin(null, 0, "space_created", "observed", {});
		const tampered: Spin = { ...first, hash: "0".repeat(64) };
		const result = verifyChain([tampered]);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("hash_mismatch");
	});

	it("computeSpinHash is deterministic regardless of payload key insertion order", () => {
		const draftA = { seq: 0, ts: "2026-01-01T00:00:00.000Z", spin_type: "file_created" as const, source: "observed" as const, payload: { path: "a.md", content_hash: "x" }, prev_hash: null };
		const draftB = { ...draftA, payload: { content_hash: "x", path: "a.md" } };
		expect(computeSpinHash(draftA)).toBe(computeSpinHash(draftB));
	});
});
