import { describe, expect, it } from "vitest";
import {
	shouldRecordFileContent,
	shouldRecordFileDeleted,
	shouldRecordSubspaceEvent,
} from "../../src/core/guards";
import { buildNextSpin } from "../../src/core/hash";
import type { Spin, SpinPayload, SpinType } from "../../src/core/types";

/** Builds a valid chain, so these fixtures are logs the verifier would also accept. */
function chain(entries: [SpinType, SpinPayload][]): Spin[] {
	const log: Spin[] = [];
	for (const [spin_type, payload] of entries) {
		const prev = log.length > 0 ? log[log.length - 1] : null;
		log.push(buildNextSpin(prev, log.length, spin_type, "observed", payload));
	}
	return log;
}

describe("shouldRecordSubspaceEvent", () => {
	// The shape found in every space this plugin scaffolded: `scaffoldSpace` and the vault
	// `create` event its own `createFolder` fires both announced the same arrival to the parent.
	it("stands down when the parent already records the arrival", () => {
		const log = chain([["space_created", {}], ["subspace_created", { subspace_name: "Colorado" }]]);
		expect(shouldRecordSubspaceEvent(log, "subspace_created", "Colorado")).toBe(false);
	});

	it("records a genuinely new subspace", () => {
		const log = chain([["space_created", {}], ["subspace_created", { subspace_name: "Colorado" }]]);
		expect(shouldRecordSubspaceEvent(log, "subspace_created", "Trinidad")).toBe(true);
	});

	it("records a removal once, then stands down", () => {
		const created = chain([["space_created", {}], ["subspace_created", { subspace_name: "Avatar" }]]);
		expect(shouldRecordSubspaceEvent(created, "subspace_removed", "Avatar")).toBe(true);

		const removed = chain([
			["space_created", {}],
			["subspace_created", { subspace_name: "Avatar" }],
			["subspace_removed", { subspace_name: "Avatar" }],
		]);
		expect(shouldRecordSubspaceEvent(removed, "subspace_removed", "Avatar")).toBe(false);
	});

	// Avatar was created and deleted three times in a real vault. With deletes missed, the log read
	// created/created/created — so a re-creation after a *recorded* removal must still be recorded.
	it("records a re-creation after a removal", () => {
		const log = chain([
			["space_created", {}],
			["subspace_created", { subspace_name: "Avatar" }],
			["subspace_removed", { subspace_name: "Avatar" }],
		]);
		expect(shouldRecordSubspaceEvent(log, "subspace_created", "Avatar")).toBe(true);
	});

	it("never records a removal for a subspace the log never knew", () => {
		const log = chain([["space_created", {}]]);
		expect(shouldRecordSubspaceEvent(log, "subspace_removed", "NeverExisted")).toBe(false);
	});
});

describe("shouldRecordFileDeleted", () => {
	const withFile = chain([
		["space_created", {}],
		["file_created", { path: "GPS.md", content_hash: "aaa" }],
	]);

	it("records the first removal", () => {
		expect(shouldRecordFileDeleted(withFile, "GPS.md")).toBe(true);
	});

	it("stands down on a second removal, and on a path it never knew", () => {
		const deleted = chain([
			["space_created", {}],
			["file_created", { path: "GPS.md", content_hash: "aaa" }],
			["file_deleted", { path: "GPS.md" }],
		]);
		expect(shouldRecordFileDeleted(deleted, "GPS.md")).toBe(false);
		expect(shouldRecordFileDeleted(withFile, "Unknown.md")).toBe(false);
	});

	it("follows a rename, so the removal lands on the path the log actually holds", () => {
		const renamed = chain([
			["space_created", {}],
			["file_created", { path: "Untitled.md", content_hash: "aaa" }],
			["file_renamed", { old_path: "Untitled.md", path: "RV.md" }],
		]);
		expect(shouldRecordFileDeleted(renamed, "RV.md")).toBe(true);
		expect(shouldRecordFileDeleted(renamed, "Untitled.md")).toBe(false);
	});
});

describe("shouldRecordFileContent", () => {
	const log = chain([
		["space_created", {}],
		["file_created", { path: "RV.md", content_hash: "hash-1" }],
	]);

	it("suppresses a save that changed nothing", () => {
		expect(shouldRecordFileContent(log, "RV.md", "hash-1")).toBe(false);
	});

	it("records a real edit, and a brand-new path", () => {
		expect(shouldRecordFileContent(log, "RV.md", "hash-2")).toBe(true);
		expect(shouldRecordFileContent(log, "New.md", "hash-1")).toBe(true);
	});

	// A file restored byte-identical after deletion is a real event: the log says it is gone.
	it("records a re-creation with identical content after a delete", () => {
		const deleted = chain([
			["space_created", {}],
			["file_created", { path: "RV.md", content_hash: "hash-1" }],
			["file_deleted", { path: "RV.md" }],
		]);
		expect(shouldRecordFileContent(deleted, "RV.md", "hash-1")).toBe(true);
	});
});
