import { describe, expect, it } from "vitest";
import type { Spin } from "../../src/core/types";
import { viewSpin } from "../src/tools/spin-view";

function spin(payload: Spin["payload"], spin_type: Spin["spin_type"] = "file_created"): Spin {
	return { seq: 3, ts: "2026-08-24T00:00:00.000Z", spin_type, source: "observed", payload, prev_hash: "aa", hash: "bb" };
}

describe("viewSpin", () => {
	it("drops content by default and says so, leaving every other field alone", () => {
		const original = spin({ path: "GPS.md", content_hash: "h", size: 5, content: "hello", encoding: "utf8" });
		const view = viewSpin(original);

		expect(view.payload.content).toBeUndefined();
		expect(view.payload.content_omitted).toBe(true);
		expect(view.payload.content_bytes).toBe(5);
		expect(view.seq).toBe(original.seq);
		expect(view.hash).toBe(original.hash);
		expect(view.payload.content_hash).toBe("h");
		// The log itself is untouched — this is a view, not a mutation.
		expect(original.payload.content).toBe("hello");
	});

	it("re-adds only what was asked for", () => {
		const original = spin({ path: "a.md", content: "c", diff: "d" }, "file_modified");
		expect(viewSpin(original, { content: true }).payload).toMatchObject({ content: "c", content_omitted: true });
		expect(viewSpin(original, { content: true }).payload.diff).toBeUndefined();
		expect(viewSpin(original, { diff: true }).payload).toMatchObject({ diff: "d", content_omitted: true });
		const both = viewSpin(original, { content: true, diff: true }).payload;
		expect(both).toMatchObject({ content: "c", diff: "d" });
		// Nothing was dropped, so nothing claims anything was.
		expect(both.content_omitted).toBeUndefined();
		expect(both.content_bytes).toBeUndefined();
	});

	it("never annotates a payload that had no bytes in the first place", () => {
		// The distinction that matters: "you did not ask for the bytes" must never look like
		// "the log has no bytes", which is a real and separate state.
		for (const p of [
			{ old_path: "a.md", path: "b.md" },
			{ path: "gone.md" },
			{ subspace_name: "Camp" },
		]) {
			const view = viewSpin(spin(p, "file_renamed"));
			expect(view.payload.content_omitted).toBeUndefined();
			expect(view.payload).toEqual(p);
		}
	});

	it("counts dropped bytes, not UTF-16 code units", () => {
		const view = viewSpin(spin({ path: "a.md", content: "é" }));
		expect(view.payload.content_bytes).toBe(2);
	});

	it("strips base64 binary payloads the same way", () => {
		const view = viewSpin(spin({ path: "pic.png", content: "AAAA", encoding: "base64" }));
		expect(view.payload.content).toBeUndefined();
		expect(view.payload.encoding).toBe("base64");
		expect(view.payload.content_omitted).toBe(true);
	});

	it("passes null through", () => {
		expect(viewSpin(null)).toBeNull();
	});
});
