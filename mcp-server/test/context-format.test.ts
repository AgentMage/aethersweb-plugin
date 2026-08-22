import { describe, expect, it } from "vitest";
import { buildIndexText, parseFrontmatter, stringifyFrontmatter } from "../../src/core/context-format";
import type { ContextFrontmatter } from "../../src/core/types";

const baseFm: ContextFrontmatter = {
	aetherweb_schema: 1,
	space_path: "UserSpace/Location",
	source_tip: "abc123",
	generated_at: "2026-08-20T00:00:00.000Z",
	file_count: 1,
	subspace_count: 1,
	files: [{ path: "notes.md", hash: "deadbeef", size: 42 }],
	subspaces: [{ name: "Sub", tip: "def456" }],
};

describe("context-format.ts::parseFrontmatter", () => {
	it("round-trips a non-empty, non-null frontmatter through stringifyFrontmatter/buildIndexText", () => {
		const text = buildIndexText(baseFm);
		expect(parseFrontmatter(text)).toEqual(baseFm);
	});

	it("round-trips empty files/subspaces and all-null tips", () => {
		const fm: ContextFrontmatter = {
			...baseFm,
			source_tip: null,
			file_count: 0,
			subspace_count: 1,
			files: [],
			subspaces: [{ name: "Sub", tip: null }],
		};
		const text = buildIndexText(fm);
		expect(parseFrontmatter(text)).toEqual(fm);
	});

	it("round-trips a path/name requiring JSON escaping", () => {
		const fm: ContextFrontmatter = {
			...baseFm,
			files: [{ path: 'weird "quoted" näme.md', hash: "h", size: 1 }],
			subspaces: [{ name: 'Sub "Space" 🌀', tip: null }],
		};
		const text = buildIndexText(fm);
		expect(parseFrontmatter(text)).toEqual(fm);
	});

	it("returns null when there's no frontmatter block at all", () => {
		expect(parseFrontmatter("just some plain text, no frontmatter here")).toBeNull();
	});

	it("throws on a hand-corrupted block: wrong key at a fixed position", () => {
		const text = buildIndexText(baseFm).replace("space_path:", "totally_wrong_key:");
		expect(() => parseFrontmatter(text)).toThrow();
	});

	it("throws when file_count doesn't match the actual files: entry count", () => {
		const text = buildIndexText(baseFm).replace("file_count: 1", "file_count: 2");
		expect(() => parseFrontmatter(text)).toThrow(/file_count/);
	});

	it("throws on a non-integer where an integer is expected", () => {
		const text = buildIndexText(baseFm).replace("file_count: 1", "file_count: not-a-number");
		expect(() => parseFrontmatter(text)).toThrow();
	});
});
