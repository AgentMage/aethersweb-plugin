import { describe, expect, it } from "vitest";
import { baseNameOf, isIgnoredPath, isUnderOrEqual, parentPathOf, reparent } from "../../src/core/ignore";

describe("isIgnoredPath", () => {
	it("keeps ordinary user content", () => {
		expect(isIgnoredPath("Lillyverse/Colorado/Colorado.md")).toBe(false);
		expect(isIgnoredPath("Lillyverse")).toBe(false);
		expect(isIgnoredPath("Space/notes.with.dots.md")).toBe(false);
	});

	it("drops every dotted path segment, at any depth", () => {
		expect(isIgnoredPath(".obsidian/plugins/aethersweb/main.js")).toBe(true);
		expect(isIgnoredPath("Lillyverse/.aether/log.jsonl")).toBe(true);
		expect(isIgnoredPath("Lillyverse/.aether/.lock")).toBe(true);
		expect(isIgnoredPath(".stfolder/syncthing-folder-1a8f15.txt")).toBe(true);
		expect(isIgnoredPath(".stversions/Space/old.md")).toBe(true);
		expect(isIgnoredPath("Space/.DS_Store")).toBe(true);
		expect(isIgnoredPath(".trash/deleted.md")).toBe(true);
	});

	// The exact filename observed being logged as a real file_created in a live vault, then
	// reconciled away as a delete — two permanent spins for a file that never conceptually existed.
	it("drops Obsidian's atomic-save temp files", () => {
		expect(isIgnoredPath("Lillyverse/Lilly/yippee.md.tmp.124602.55cd6cc624c2")).toBe(true);
		expect(isIgnoredPath("Space/note.md.tmp.1.a0")).toBe(true);
	});

	it("drops sync conflict copies", () => {
		expect(isIgnoredPath("Space/note.sync-conflict-20260821-093000-ABC123.md")).toBe(true);
		expect(isIgnoredPath("Space/note (conflicted copy 2026-08-21).md")).toBe(true);
		expect(isIgnoredPath("Space/Thumbs.db")).toBe(true);
	});
});

describe("path helpers", () => {
	it("finds parents and base names, treating vault root as empty", () => {
		expect(parentPathOf("A/B/c.md")).toBe("A/B");
		expect(parentPathOf("A")).toBe("");
		expect(baseNameOf("A/B/c.md")).toBe("c.md");
		expect(baseNameOf("A")).toBe("A");
	});

	it("does not treat a sibling with a shared prefix as a descendant", () => {
		expect(isUnderOrEqual("A/B", "A/B")).toBe(true);
		expect(isUnderOrEqual("A/B/c", "A/B")).toBe(true);
		expect(isUnderOrEqual("A/Bee/c", "A/B")).toBe(false);
		expect(reparent("A/Bee/c", "A/B", "X/B")).toBe(null);
	});

	it("remaps descendants of a moved folder", () => {
		expect(reparent("Lillyverse/Trinidad/Roadrunner Ranch", "Lillyverse/Trinidad", "Lillyverse/Colorado/Trinidad"))
			.toBe("Lillyverse/Colorado/Trinidad/Roadrunner Ranch");
	});
});
