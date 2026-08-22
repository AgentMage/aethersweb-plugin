import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkStalenessFs, planRegenerationFs, regenerateContextFs, writeStatementFs } from "../src/context-fs";
import { buildSpaceRefFs } from "../src/space-fs";
import { appendSpinFs, readHeadFs, readLogFs } from "../src/vault-io";
import { reconcileSpaceFs } from "../src/reconcile-fs";
import { readSignedStatement } from "../../src/core/statement";

let vaultRoot: string;

beforeEach(async () => {
	vaultRoot = await mkdtemp(join(tmpdir(), "aethersweb-mcp-test-"));
	await mkdir(join(vaultRoot, "UserSpace", ".aether"), { recursive: true });
});

afterEach(async () => {
	await rm(vaultRoot, { recursive: true, force: true });
});

describe("context-fs.ts", () => {
	it("regenerateContextFs creates a folder note with the placeholder statement on first run", async () => {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(ref, "space_created", "observed", {});
		await writeFile(join(vaultRoot, "UserSpace", "notes.md"), "hello world");

		const fm = await regenerateContextFs(vaultRoot, ref);
		// The folder note counts as one of the space's own files now — it is a note the person
		// writes in, not a derived artifact hidden from its own index.
		expect(fm.files.map((f) => f.path).sort()).toEqual(["UserSpace.md", "notes.md"]);
		expect(fm.file_count).toBe(2);

		const text = await readFile(ref.contextPath, "utf8");
		expect(text).toContain("No AI state statement has been generated yet");
		expect(text.startsWith("---")).toBe(false); // the index lives in .aether/, not here
	});

	it("writeStatementFs then regenerateContextFs round-trips the statement text and tip untouched", async () => {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(ref, "space_created", "observed", {});
		await regenerateContextFs(vaultRoot, ref); // create the note first, like the plugin does

		const head = await readHeadFs(ref);
		await writeStatementFs(vaultRoot, ref, "This space is a scratch test fixture.", head!, "test-agent");

		// regenerate again — the index changes (generated_at), the statement must survive untouched
		await regenerateContextFs(vaultRoot, ref);

		const text = await readFile(ref.contextPath, "utf8");
		expect(text).toContain("This space is a scratch test fixture.");
		// The tip it was written against lives in the signature, not a separate frontmatter field.
		expect(readSignedStatement(text)?.signature?.at_tip).toBe(head);
		expect(text).not.toContain("---");
	});

	it("writeStatementFs refuses to write when no context note exists yet", async () => {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		await expect(writeStatementFs(vaultRoot, ref, "text", "sometip", "test-agent")).rejects.toThrow(/no folder note/);
	});

	// The whole reason the index moved into .aether/: it records source_tip and generated_at, both
	// of which change purely as a side effect of writing. Logged, it could never settle.
	it("regenerateContextFs never appends to the log, however many times it runs", async () => {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(ref, "space_created", "observed", {});
		await regenerateContextFs(vaultRoot, ref); // first run creates + logs the folder note

		const headAfterFirst = await readHeadFs(ref);
		const lenAfterFirst = (await readLogFs(ref)).length;

		for (let i = 0; i < 3; i++) await regenerateContextFs(vaultRoot, ref);

		expect(await readHeadFs(ref)).toBe(headAfterFirst);
		expect((await readLogFs(ref)).length).toBe(lenAfterFirst);
	});

	it("logs the statement write, and stands down on byte-identical prose", async () => {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(ref, "space_created", "observed", {});
		await regenerateContextFs(vaultRoot, ref);

		const before = (await readLogFs(ref)).length;
		await writeStatementFs(vaultRoot, ref, "A statement.", (await readHeadFs(ref))!, "test-agent");

		const afterWrite = await readLogFs(ref);
		expect(afterWrite.length).toBe(before + 1);
		expect(afterWrite[afterWrite.length - 1]).toMatchObject({
			spin_type: "file_modified",
			payload: { path: "UserSpace.md", authored_by: "test-agent" },
		});

		// Re-writing the same prose preserves the existing signature, so the file is byte-identical
		// and nothing is recorded — see core/statement.ts::writeSignedStatement.
		const head = await readHeadFs(ref);
		await writeStatementFs(vaultRoot, ref, "A statement.", head!, "test-agent");
		expect(await readHeadFs(ref)).toBe(head);
	});

	it("preserves the person's own writing around the block, and logs their edits", async () => {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(ref, "space_created", "observed", {});
		await regenerateContextFs(vaultRoot, ref);
		await writeStatementFs(vaultRoot, ref, "Generated.", (await readHeadFs(ref))!, "test-agent");

		// The person writes their own notes above and below the AI block.
		const withHuman = `My own notes about this place.\n\n${await readFile(ref.contextPath, "utf8")}\nA closing thought.\n`;
		await writeFile(ref.contextPath, withHuman, "utf8");
		await reconcileSpaceFs(vaultRoot, ref); // as if they wrote it with Obsidian closed

		const log = await readLogFs(ref);
		expect(log.some((s) => s.payload.path === "UserSpace.md" && s.source === "detected")).toBe(true);

		// A fresh statement replaces only the block; their words survive byte for byte.
		await writeStatementFs(vaultRoot, ref, "Regenerated.", (await readHeadFs(ref))!, "test-agent");
		const final = await readFile(ref.contextPath, "utf8");
		expect(final).toContain("My own notes about this place.");
		expect(final).toContain("A closing thought.");
		expect(final).toContain("Regenerated.");
		expect(final).not.toContain("Generated.\n");
	});

	it("strips a pre-split note's obsolete frontmatter, keeping the statement and signature", async () => {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(ref, "space_created", "observed", {});
		await regenerateContextFs(vaultRoot, ref);
		await writeStatementFs(vaultRoot, ref, "Survives the migration.", (await readHeadFs(ref))!, "test-agent");

		// Put the note back into the old shape: index frontmatter above the statement block.
		const body = await readFile(ref.contextPath, "utf8");
		const oldShape = `---\naetherweb_schema: 1\nspace_path: "UserSpace"\nsource_tip: "abc"\ngenerated_at: "x"\nfile_count: 0\nsubspace_count: 0\nfiles: []\nsubspaces: []\nstatement_tip: "abc"\n---\n\n${body}`;
		await writeFile(ref.contextPath, oldShape, "utf8");

		await regenerateContextFs(vaultRoot, ref);
		const migrated = await readFile(ref.contextPath, "utf8");
		expect(migrated.startsWith("---")).toBe(false);
		expect(migrated).toContain("Survives the migration.");
		expect(readSignedStatement(migrated)?.signature?.agent).toBe("test-agent");

		// Self-limiting: once stripped, a further run changes nothing.
		const head = await readHeadFs(ref);
		await regenerateContextFs(vaultRoot, ref);
		expect(await readFile(ref.contextPath, "utf8")).toBe(migrated);
		expect(await readHeadFs(ref)).toBe(head);
	});

	it("leaves a person's own YAML frontmatter alone", async () => {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(ref, "space_created", "observed", {});
		await regenerateContextFs(vaultRoot, ref);

		const theirs = `---\ntags: [places, colorado]\n---\n\nMy notes.\n\n${await readFile(ref.contextPath, "utf8")}`;
		await writeFile(ref.contextPath, theirs, "utf8");

		await regenerateContextFs(vaultRoot, ref);
		expect(await readFile(ref.contextPath, "utf8")).toBe(theirs);
	});
});

describe("context-fs.ts::checkStalenessFs", () => {
	it("reports maximally stale when no context note has ever been generated", async () => {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(ref, "space_created", "observed", {});

		const status = await checkStalenessFs(vaultRoot, ref);
		expect(status.has_index).toBe(false);
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
		await writeStatementFs(vaultRoot, ref, "Initial statement.", head!, "test-agent");

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
		expect(status.statement_drift?.neverWritten).toBe(true);
		expect(status.statement_drift?.reasons).toEqual(["no statement has ever been written for this space"]);
	});

	it("statement_drift is null when the statement isn't stale, and reports the raw pile-up otherwise", async () => {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(ref, "space_created", "observed", {});
		await regenerateContextFs(vaultRoot, ref);
		const head = await readHeadFs(ref);
		await writeStatementFs(vaultRoot, ref, "Initial.", head!, "test-agent");

		expect((await checkStalenessFs(vaultRoot, ref)).statement_drift).toBeNull();

		// A couple of routine edits — well under the default threshold.
		await appendSpinFs(ref, "file_created", "observed", { path: "a.md", content: "hi", content_hash: "x", encoding: "utf8" });
		await appendSpinFs(ref, "file_created", "observed", { path: "b.md", content: "hi", content_hash: "x", encoding: "utf8" });

		const status = await checkStalenessFs(vaultRoot, ref);
		expect(status.statement_stale).toBe(true);
		expect(status.statement_drift?.spinCount).toBe(2);
		expect(status.statement_drift?.structuralChanges).toEqual([]);
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
		await writeStatementFs(vaultRoot, parentRef, "All good.", parentHead!, "test-agent");

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
		await writeStatementFs(vaultRoot, parentRef, "All good.", head!, "test-agent");

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
		await writeStatementFs(vaultRoot, parentRef, "All good.", parentHead!, "test-agent"); // parent's own statement is fresh
		await regenerateContextFs(vaultRoot, childRef); // child frontmatter fresh, statement never written

		// Child's log advances after both were regenerated — the parent's recorded subspace tip
		// drifts even though the parent's own log/statement never changed.
		await appendSpinFs(childRef, "file_created", "observed", { path: "b.md", content: "hi", content_hash: "x", encoding: "utf8" });

		const plan = await planRegenerationFs(vaultRoot, [parentRef, childRef]);

		expect(plan.map((e) => e.space_path)).toEqual(["UserSpace/Sub", "UserSpace"]); // deepest-first

		const child = plan.find((e) => e.space_path === "UserSpace/Sub")!;
		expect(child.needs_regenerate_context).toBe(true); // own log moved past source_tip
		expect(child.statement_stale).toBe(true); // never written

		const parent = plan.find((e) => e.space_path === "UserSpace")!;
		expect(parent.needs_regenerate_context).toBe(true); // subspace drifted, though parent's own tips are fine
		expect(parent.statement_stale).toBe(false); // parent's own statement is still current
		expect(parent.reasons).toEqual(['subspace "Sub" drifted']);
	});

	it("reports a single trivial edit as statement drift rather than filtering it out", async () => {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(ref, "space_created", "observed", {});
		await regenerateContextFs(vaultRoot, ref);
		const head = await readHeadFs(ref);
		await writeStatementFs(vaultRoot, ref, "All good.", head!, "test-agent");

		// One routine edit, then the index is regenerated (cheap, happens on every change) — the
		// only thing left stale is the statement, by exactly one spin.
		await appendSpinFs(ref, "file_created", "observed", { path: "a.md", content: "hi", content_hash: "x", encoding: "utf8" });
		await regenerateContextFs(vaultRoot, ref);

		// Reported, not pre-judged: whether one edit is worth a write_statement call is the
		// caller's decision, so the facts reach them instead of being filtered away here.
		const plan = await planRegenerationFs(vaultRoot, [ref]);
		expect(plan).toHaveLength(1);
		expect(plan[0].statement_stale).toBe(true);
		expect(plan[0].needs_regenerate_context).toBe(false);
		expect(plan[0].statement_drift?.spinCount).toBe(1);
	});

	it("leaves a fully current space out of the plan", async () => {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(ref, "space_created", "observed", {});
		await regenerateContextFs(vaultRoot, ref);
		const head = await readHeadFs(ref);
		await writeStatementFs(vaultRoot, ref, "All good.", head!, "test-agent");
		await regenerateContextFs(vaultRoot, ref);

		// The statement's own write is the only thing after its tip, and that never counts as its
		// own drift — otherwise every statement would be stale the instant it was written.
		expect(await planRegenerationFs(vaultRoot, [ref])).toEqual([]);
	});

	it("counts accumulated routine edits in statement_drift", async () => {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(ref, "space_created", "observed", {});
		await regenerateContextFs(vaultRoot, ref);
		const head = await readHeadFs(ref);
		await writeStatementFs(vaultRoot, ref, "All good.", head!, "test-agent");

		for (let i = 0; i < 5; i++) {
			await appendSpinFs(ref, "file_created", "observed", { path: `f${i}.md`, content: "hi", content_hash: "x", encoding: "utf8" });
		}
		await regenerateContextFs(vaultRoot, ref);

		const plan = await planRegenerationFs(vaultRoot, [ref]);
		expect(plan).toHaveLength(1);
		expect(plan[0].statement_stale).toBe(true);
		expect(plan[0].needs_regenerate_context).toBe(false); // already regenerated above
		expect(plan[0].statement_drift?.spinCount).toBe(5);
		expect(plan[0].reasons).toEqual(["5 spin(s) have accumulated since the last statement"]);
	});

	it("flags a structural change in statement_drift, even with a single spin since the last statement", async () => {
		const parentRef = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(parentRef, "space_created", "observed", {});
		await regenerateContextFs(vaultRoot, parentRef);
		const head = await readHeadFs(parentRef);
		await writeStatementFs(vaultRoot, parentRef, "Just me so far.", head!, "test-agent");

		await mkdir(join(vaultRoot, "UserSpace", "Sub", ".aether"), { recursive: true });
		const childRef = buildSpaceRefFs(vaultRoot, "UserSpace/Sub");
		await appendSpinFs(childRef, "space_created", "observed", {});
		await appendSpinFs(parentRef, "subspace_created", "observed", { subspace_name: "Sub" });
		await regenerateContextFs(vaultRoot, parentRef);

		const plan = await planRegenerationFs(vaultRoot, [parentRef]);
		expect(plan).toHaveLength(1);
		expect(plan[0].statement_stale).toBe(true);
		expect(plan[0].statement_drift?.structuralChanges).toEqual(["subspace_created"]);
		expect(plan[0].reasons).toContain("composition changed since the last statement (subspace_created)");
	});
});
