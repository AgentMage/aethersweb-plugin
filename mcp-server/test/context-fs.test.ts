import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkStalenessFs, planRegenerationFs, regenerateContextFs, writeStatementFs } from "../src/context-fs";
import { buildSpaceRefFs } from "../src/space-fs";
import { appendSpinFs, readHeadFs } from "../src/vault-io";

let vaultRoot: string;

beforeEach(async () => {
	vaultRoot = await mkdtemp(join(tmpdir(), "aethersweb-mcp-test-"));
	await mkdir(join(vaultRoot, "UserSpace", ".aether"), { recursive: true });
});

afterEach(async () => {
	await rm(vaultRoot, { recursive: true, force: true });
});

describe("context-fs.ts", () => {
	it("regenerateContextFs creates a context note with the placeholder statement on first run", async () => {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(ref, "space_created", "observed", {});
		await writeFile(join(vaultRoot, "UserSpace", "notes.md"), "hello world");

		const fm = await regenerateContextFs(vaultRoot, ref);
		expect(fm.file_count).toBe(1);
		expect(fm.files[0].path).toBe("notes.md");
		expect(fm.statement_tip).toBeNull();

		const text = await readFile(ref.contextPath, "utf8");
		expect(text).toContain("No AI state statement has been generated yet");
	});

	it("writeStatementFs then regenerateContextFs round-trips the statement text and tip untouched", async () => {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(ref, "space_created", "observed", {});
		await regenerateContextFs(vaultRoot, ref); // create the note first, like the plugin does

		const head = await readHeadFs(ref);
		await writeStatementFs(ref, "This space is a scratch test fixture.", head!, "test-agent");

		// regenerate again — objective frontmatter changes (generated_at), statement must survive
		const fm = await regenerateContextFs(vaultRoot, ref);
		expect(fm.statement_tip).toBe(head);

		const text = await readFile(ref.contextPath, "utf8");
		expect(text).toContain("This space is a scratch test fixture.");
		expect(text).toContain(`statement_tip: ${JSON.stringify(head)}`);
	});

	it("writeStatementFs refuses to write when no context note exists yet", async () => {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		await expect(writeStatementFs(ref, "text", "sometip", "test-agent")).rejects.toThrow(/no context note/);
	});
});

describe("context-fs.ts::checkStalenessFs", () => {
	it("reports maximally stale when no context note has ever been generated", async () => {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(ref, "space_created", "observed", {});

		const status = await checkStalenessFs(vaultRoot, ref);
		expect(status.has_context_note).toBe(false);
		expect(status.frontmatter_stale).toBe(true);
		expect(status.statement_stale).toBe(true);
		expect(status.stale).toBe(true);
		expect(status.error).toBeUndefined();
	});

	it("frontmatter_stale and statement_stale are both true after an own-space edit not yet regenerated", async () => {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(ref, "space_created", "observed", {});
		await regenerateContextFs(vaultRoot, ref);
		const head = await readHeadFs(ref);
		await writeStatementFs(ref, "Initial statement.", head!, "test-agent");

		// fresh at this point
		expect((await checkStalenessFs(vaultRoot, ref)).stale).toBe(false);

		// a new spin advances the head without regenerating the context
		await appendSpinFs(ref, "file_created", "observed", { path: "a.md", content: "hi", content_hash: "x", encoding: "utf8" });

		const status = await checkStalenessFs(vaultRoot, ref);
		expect(status.frontmatter_stale).toBe(true);
		expect(status.statement_stale).toBe(true);
		expect(status.stale).toBe(true);
	});

	it("statement_stale is true in isolation when the statement was never written", async () => {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(ref, "space_created", "observed", {});
		await regenerateContextFs(vaultRoot, ref); // no writeStatementFs call

		const status = await checkStalenessFs(vaultRoot, ref);
		expect(status.frontmatter_stale).toBe(false);
		expect(status.statement_stale).toBe(true);
		expect(status.stale).toBe(true);
		expect(status.statement_drift?.significant).toBe(true);
		expect(status.statement_drift?.reasons).toEqual(["no statement has ever been written for this space"]);
	});

	it("statement_drift is null when the statement isn't stale, and reports low volume as not-yet-significant", async () => {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(ref, "space_created", "observed", {});
		await regenerateContextFs(vaultRoot, ref);
		const head = await readHeadFs(ref);
		await writeStatementFs(ref, "Initial.", head!, "test-agent");

		expect((await checkStalenessFs(vaultRoot, ref)).statement_drift).toBeNull();

		// A couple of routine edits — well under the default threshold.
		await appendSpinFs(ref, "file_created", "observed", { path: "a.md", content: "hi", content_hash: "x", encoding: "utf8" });
		await appendSpinFs(ref, "file_created", "observed", { path: "b.md", content: "hi", content_hash: "x", encoding: "utf8" });

		const status = await checkStalenessFs(vaultRoot, ref);
		expect(status.statement_stale).toBe(true);
		expect(status.statement_drift?.significant).toBe(false);
		expect(status.statement_drift?.spinCount).toBe(2);
	});

	it("reports subspace drift when a child's log advances without the parent being regenerated", async () => {
		const parentRef = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(parentRef, "space_created", "observed", {});
		await mkdir(join(vaultRoot, "UserSpace", "Sub", ".aether"), { recursive: true });
		const childRef = buildSpaceRefFs(vaultRoot, "UserSpace/Sub");
		await appendSpinFs(childRef, "space_created", "observed", {});
		await appendSpinFs(parentRef, "subspace_created", "observed", { subspace_name: "Sub" });

		await regenerateContextFs(vaultRoot, parentRef); // records the child's current tip
		expect((await checkStalenessFs(vaultRoot, parentRef)).frontmatter_stale).toBe(false);

		await appendSpinFs(childRef, "file_created", "observed", { path: "b.md", content: "hi", content_hash: "x", encoding: "utf8" });

		const status = await checkStalenessFs(vaultRoot, parentRef);
		expect(status.frontmatter_stale).toBe(false); // parent's own log hasn't moved
		expect(status.subspaces).toEqual([
			expect.objectContaining({ name: "Sub", status: "drifted" }),
		]);
		expect(status.stale).toBe(true);
	});

	it("reports missing_from_context when a subspace exists on disk but was never recorded", async () => {
		const parentRef = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(parentRef, "space_created", "observed", {});
		await regenerateContextFs(vaultRoot, parentRef); // no subspaces yet

		await mkdir(join(vaultRoot, "UserSpace", "Sub", ".aether"), { recursive: true });
		const childRef = buildSpaceRefFs(vaultRoot, "UserSpace/Sub");
		await appendSpinFs(childRef, "space_created", "observed", {});

		const status = await checkStalenessFs(vaultRoot, parentRef);
		expect(status.subspaces).toEqual([
			expect.objectContaining({ name: "Sub", status: "missing_from_context", recorded_tip: null }),
		]);
		expect(status.stale).toBe(true);
	});

	it("reports missing_on_disk when a recorded subspace is no longer a claimed space", async () => {
		const parentRef = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(parentRef, "space_created", "observed", {});
		await mkdir(join(vaultRoot, "UserSpace", "Sub", ".aether"), { recursive: true });
		const childRef = buildSpaceRefFs(vaultRoot, "UserSpace/Sub");
		await appendSpinFs(childRef, "space_created", "observed", {});
		await appendSpinFs(parentRef, "subspace_created", "observed", { subspace_name: "Sub" });
		await regenerateContextFs(vaultRoot, parentRef);

		await rm(join(vaultRoot, "UserSpace", "Sub", ".aether"), { recursive: true, force: true });

		const status = await checkStalenessFs(vaultRoot, parentRef);
		expect(status.subspaces).toEqual([
			expect.objectContaining({ name: "Sub", status: "missing_on_disk", actual_tip: null }),
		]);
		expect(status.stale).toBe(true);
	});

	it("stale is false when everything — own tips and every subspace — is up to date", async () => {
		const parentRef = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(parentRef, "space_created", "observed", {});
		await mkdir(join(vaultRoot, "UserSpace", "Sub", ".aether"), { recursive: true });
		const childRef = buildSpaceRefFs(vaultRoot, "UserSpace/Sub");
		await appendSpinFs(childRef, "space_created", "observed", {});
		await appendSpinFs(parentRef, "subspace_created", "observed", { subspace_name: "Sub" });

		await regenerateContextFs(vaultRoot, parentRef);
		const parentHead = await readHeadFs(parentRef);
		await writeStatementFs(parentRef, "All good.", parentHead!, "test-agent");

		const status = await checkStalenessFs(vaultRoot, parentRef);
		expect(status.frontmatter_stale).toBe(false);
		expect(status.statement_stale).toBe(false);
		expect(status.subspaces).toEqual([expect.objectContaining({ name: "Sub", status: "ok" })]);
		expect(status.stale).toBe(false);
	});
});

describe("context-fs.ts::planRegenerationFs", () => {
	it("returns an empty plan when nothing is stale", async () => {
		const parentRef = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(parentRef, "space_created", "observed", {});
		await regenerateContextFs(vaultRoot, parentRef);
		const head = await readHeadFs(parentRef);
		await writeStatementFs(parentRef, "All good.", head!, "test-agent");

		expect(await planRegenerationFs(vaultRoot, [parentRef])).toEqual([]);
	});

	it("orders a stale child before its stale parent, deepest-first, and isolates subspace drift from the parent's own tips", async () => {
		const parentRef = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(parentRef, "space_created", "observed", {});
		await mkdir(join(vaultRoot, "UserSpace", "Sub", ".aether"), { recursive: true });
		const childRef = buildSpaceRefFs(vaultRoot, "UserSpace/Sub");
		await appendSpinFs(childRef, "space_created", "observed", {});
		await appendSpinFs(parentRef, "subspace_created", "observed", { subspace_name: "Sub" });

		await regenerateContextFs(vaultRoot, parentRef);
		const parentHead = await readHeadFs(parentRef);
		await writeStatementFs(parentRef, "All good.", parentHead!, "test-agent"); // parent's own statement is fresh
		await regenerateContextFs(vaultRoot, childRef); // child frontmatter fresh, statement never written

		// Child's log advances after both were regenerated — the parent's recorded subspace tip
		// drifts even though the parent's own log/statement never changed.
		await appendSpinFs(childRef, "file_created", "observed", { path: "b.md", content: "hi", content_hash: "x", encoding: "utf8" });

		const plan = await planRegenerationFs(vaultRoot, [parentRef, childRef]);

		expect(plan.map((e) => e.space_path)).toEqual(["UserSpace/Sub", "UserSpace"]); // deepest-first

		const child = plan.find((e) => e.space_path === "UserSpace/Sub")!;
		expect(child.needs_regenerate_context).toBe(true); // own log moved past source_tip
		expect(child.needs_write_statement).toBe(true); // never written

		const parent = plan.find((e) => e.space_path === "UserSpace")!;
		expect(parent.needs_regenerate_context).toBe(true); // subspace drifted, though parent's own tips are fine
		expect(parent.needs_write_statement).toBe(false); // parent's own statement_tip is still current
		expect(parent.reasons).toEqual(['subspace "Sub" drifted']);
	});

	it("leaves a space out of the plan entirely when its only staleness is a statement below the drift threshold", async () => {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(ref, "space_created", "observed", {});
		await regenerateContextFs(vaultRoot, ref);
		const head = await readHeadFs(ref);
		await writeStatementFs(ref, "All good.", head!, "test-agent");

		// One routine edit, then frontmatter is regenerated (cheap, happens on every change) — the
		// only thing left stale is the statement, and it's nowhere near the threshold.
		await appendSpinFs(ref, "file_created", "observed", { path: "a.md", content: "hi", content_hash: "x", encoding: "utf8" });
		await regenerateContextFs(vaultRoot, ref);

		expect(await planRegenerationFs(vaultRoot, [ref])).toEqual([]);
	});

	it("includes a space once enough routine edits accumulate to cross the drift threshold", async () => {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(ref, "space_created", "observed", {});
		await regenerateContextFs(vaultRoot, ref);
		const head = await readHeadFs(ref);
		await writeStatementFs(ref, "All good.", head!, "test-agent");

		for (let i = 0; i < 5; i++) {
			await appendSpinFs(ref, "file_created", "observed", { path: `f${i}.md`, content: "hi", content_hash: "x", encoding: "utf8" });
		}
		await regenerateContextFs(vaultRoot, ref);

		const plan = await planRegenerationFs(vaultRoot, [ref]);
		expect(plan).toHaveLength(1);
		expect(plan[0].needs_write_statement).toBe(true);
		expect(plan[0].needs_regenerate_context).toBe(false); // already regenerated above
		expect(plan[0].reasons).toEqual(["5 spin(s) have accumulated since the last statement"]);
	});

	it("includes a space immediately on a structural change, even with a single spin since the last statement", async () => {
		const parentRef = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(parentRef, "space_created", "observed", {});
		await regenerateContextFs(vaultRoot, parentRef);
		const head = await readHeadFs(parentRef);
		await writeStatementFs(parentRef, "Just me so far.", head!, "test-agent");

		await mkdir(join(vaultRoot, "UserSpace", "Sub", ".aether"), { recursive: true });
		const childRef = buildSpaceRefFs(vaultRoot, "UserSpace/Sub");
		await appendSpinFs(childRef, "space_created", "observed", {});
		await appendSpinFs(parentRef, "subspace_created", "observed", { subspace_name: "Sub" });
		await regenerateContextFs(vaultRoot, parentRef);

		const plan = await planRegenerationFs(vaultRoot, [parentRef]);
		expect(plan).toHaveLength(1);
		expect(plan[0].needs_write_statement).toBe(true);
		expect(plan[0].reasons).toEqual(["composition changed since the last statement (subspace_created)"]);
	});
});
