import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SIGNATURE_MARKER_PREFIX, STATEMENT_END_MARKER, STATEMENT_START_MARKER } from "../../src/core/constants";
import { foldLogToLastKnownContent } from "../../src/core/content-fold";
import { verifyChain } from "../../src/core/hash";
import { verifyContentReplay } from "../../src/verify-content";
import { regenerateContextFs } from "../src/context-fs";
import { reconcileSpaceFs } from "../src/reconcile-fs";
import { buildSpaceRefFs, hashFileFs, isSpaceFs } from "../src/space-fs";
import { appendFileDeletedFs, appendSpinFs, ensureSpaceInitializedFs, readHeadFs, readLogFs } from "../src/vault-io";
import { signatureStatus } from "../../src/core/signature";
import { readSignedStatement, StatementContainmentError } from "../../src/core/statement";
import { deleteSpaceFs, moveSpaceFs, recordWrittenFile, removeFileFs, writeFileFs, WriteError } from "../src/write-fs";

let vaultRoot: string;

async function makeSpace(path: string) {
	await mkdir(join(vaultRoot, path), { recursive: true });
	const ref = buildSpaceRefFs(vaultRoot, path);
	await ensureSpaceInitializedFs(ref);
	await regenerateContextFs(vaultRoot, ref);
	return ref;
}

beforeEach(async () => {
	vaultRoot = await mkdtemp(join(tmpdir(), "aethersweb-authoring-"));
});

afterEach(async () => {
	await rm(vaultRoot, { recursive: true, force: true });
});

describe("scaffolding is idempotent", () => {
	// The bug this guards: scaffolding and the vault `create` event it triggers both observed an
	// empty log, so every space this project ever created carried space_created at seq 0 AND seq 1.
	it("does not seed a second space_created when called twice", async () => {
		const ref = await makeSpace("UserSpace");
		await ensureSpaceInitializedFs(ref);

		const log = await readLogFs(ref);
		expect(log.filter((s) => s.spin_type === "space_created")).toHaveLength(1);
		expect(verifyChain(log).ok).toBe(true);
	});
});

describe("write_file's layer", () => {
	it("records a create, then diffs against the log's own baseline", async () => {
		const ref = await makeSpace("UserSpace");

		const first = await writeFileFs(vaultRoot, ref, "GPS.md", "37.5N 105.5W\n", "test-agent");
		expect(first.created).toBe(true);
		expect(first.spin?.spin_type).toBe("file_created");
		// The log records the file as written — markers included, because that is what is on disk.
		expect(first.spin?.payload.content).toContain("37.5N 105.5W");
		expect(first.spin?.payload.content).toContain(STATEMENT_START_MARKER);

		const second = await writeFileFs(vaultRoot, ref, "GPS.md", "37.5N 105.5W\nBlanca Peak\n", "test-agent");
		expect(second.created).toBe(false);
		expect(second.spin?.spin_type).toBe("file_modified");
		expect(second.spin?.payload.diff).toBeDefined();
		expect(second.spin?.payload.content).toBeUndefined();

		// The point of storing content at all: the log alone reconstructs the file.
		const log = await readLogFs(ref);
		expect(foldLogToLastKnownContent(log)["GPS.md"].content).toContain("Blanca Peak");
		expect(verifyContentReplay(log).ok).toBe(true);
		expect(verifyChain(log).ok).toBe(true);
	});

	it("diffs against \"\" (never a full snapshot) when a modify has no known text baseline", async () => {
		const ref = await makeSpace("UserSpace");
		const path = "Legacy.md";
		const absPath = join(vaultRoot, "UserSpace", path);
		const original = "first line\n";

		// Simulate history predating this discipline: the file exists on disk and the log knows
		// its hash, but the file_created spin carries no `content` — the trail is cold at seq 0.
		await writeFile(absPath, original, "utf8");
		await appendSpinFs(ref, "file_created", "detected", {
			path,
			content_hash: await hashFileFs(absPath),
			size: original.length,
		});

		const updated = "first line\nsecond line\n";
		await writeFile(absPath, updated, "utf8");
		const spin = await recordWrittenFile(ref, path, absPath, "file_modified", "detected");

		// A diff against "" round-trips losslessly, so the modify still records only the change —
		// never the whole file again — even with no prior baseline to diff against.
		expect(spin?.payload.diff).toBeDefined();
		expect(spin?.payload.content).toBeUndefined();

		const log = await readLogFs(ref);
		expect(foldLogToLastKnownContent(log)[path].content).toBe(updated);
		expect(verifyContentReplay(log).ok).toBe(true);
	});

	it("stands down on a write that changed nothing", async () => {
		const ref = await makeSpace("UserSpace");
		await writeFileFs(vaultRoot, ref, "GPS.md", "same", "test-agent");
		const headBefore = await readHeadFs(ref);

		const again = await writeFileFs(vaultRoot, ref, "GPS.md", "same", "test-agent");
		expect(again.spin).toBe(null);
		expect(await readHeadFs(ref)).toBe(headBefore);
	});

	// A containment rule with silent exemptions tells you nothing when you rely on it, so formats
	// that cannot carry an inert marker are refused rather than quietly written unmarked.
	// Attribution is never skipped, only relocated: inline where a marker is inert, in the log
	// where it would corrupt the format.
	it("signs inline where the format allows, and in the log where it does not", async () => {
		const ref = await makeSpace("UserSpace");

		for (const inline of ["note.md", "plain.txt", "README"]) {
			const res = await writeFileFs(vaultRoot, ref, inline, "x", "test-agent");
			expect(res.signed_inline).toBe(true);
			expect(res.spin?.payload.authored_by).toBe("test-agent");
		}
		for (const external of ["data.json", "rows.csv"]) {
			const res = await writeFileFs(vaultRoot, ref, external, "{}", "test-agent");
			expect(res.signed_inline).toBe(false);
			// The only place attribution can live for a format that cannot carry a marker.
			expect(res.spin?.payload.authored_by).toBe("test-agent");
			expect(await readFile(join(vaultRoot, "UserSpace", external), "utf8")).toBe("{}");
		}
	});

	it("writes binary as bytes, attributed in the log", async () => {
		const ref = await makeSpace("UserSpace");
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
		const res = await writeFileFs(vaultRoot, ref, "pic.png", bytes.toString("base64"), "test-agent", "base64");

		expect(res.signed_inline).toBe(false);
		expect(res.spin?.payload.authored_by).toBe("test-agent");
		expect(Buffer.from(await readFile(join(vaultRoot, "UserSpace", "pic.png")))).toEqual(bytes);
		expect(verifyContentReplay(await readLogFs(ref)).ok).toBe(true);
	});

	it("refuses paths that escape the space, name the context note, or are ignorable", async () => {
		const ref = await makeSpace("UserSpace");
		for (const bad of ["../escape.md", "a/../../b.md", ".hidden.md", "note.md.tmp.1.ab", "UserSpace.md"]) {
			await expect(writeFileFs(vaultRoot, ref, bad, "x", "test-agent")).rejects.toBeInstanceOf(WriteError);
		}
	});

	// Single-parent containment: a subspace records its own level, so a parent must not write into it.
	it("refuses to write through a subspace boundary", async () => {
		const parent = await makeSpace("UserSpace");
		await makeSpace("UserSpace/Camp");
		await expect(writeFileFs(vaultRoot, parent, "Camp/notes.md", "x", "test-agent")).rejects.toThrow(/subspace/);
	});
});

describe("delete", () => {
	it("records the removal once, and not again", async () => {
		const ref = await makeSpace("UserSpace");
		await writeFileFs(vaultRoot, ref, "GPS.md", "x", "test-agent");

		await removeFileFs(vaultRoot, ref, "GPS.md");
		expect((await appendFileDeletedFs(ref, "GPS.md"))?.spin_type).toBe("file_deleted");
		expect(await appendFileDeletedFs(ref, "GPS.md")).toBe(null);
		expect(verifyChain(await readLogFs(ref)).ok).toBe(true);
	});
});

describe("move_space", () => {
	it("carries the space's history with it and leaves its own chain untouched", async () => {
		await makeSpace("UserSpace");
		const trinidad = await makeSpace("UserSpace/Trinidad");
		await writeFileFs(vaultRoot, trinidad, "address.md", "1 Ranch Rd", "test-agent");
		await makeSpace("UserSpace/Colorado");

		const logBefore = await readLogFs(trinidad);
		const headBefore = await readHeadFs(trinidad);

		const moved = await moveSpaceFs(vaultRoot, "UserSpace/Trinidad", "UserSpace/Colorado/Trinidad");
		expect(await isSpaceFs(vaultRoot, "UserSpace/Colorado/Trinidad")).toBe(true);
		expect(await isSpaceFs(vaultRoot, "UserSpace/Trinidad")).toBe(false);

		// Identity is the folder — the chain is keyed to what happened inside, not to where it sits.
		expect(await readLogFs(moved.to)).toEqual(logBefore);
		expect(await readHeadFs(moved.to)).toBe(headBefore);
	});

	it("renames the stranded folder note when the name changes", async () => {
		await makeSpace("UserSpace");
		await makeSpace("UserSpace/Trinidad");

		const moved = await moveSpaceFs(vaultRoot, "UserSpace/Trinidad", "UserSpace/Trinidad Ranch");
		expect(moved.newName).toBe("Trinidad Ranch");
		await expect(readFile(moved.to.contextPath, "utf8")).resolves.toContain(STATEMENT_START_MARKER);
	});

	// The folder note's name tracks the folder's, so renaming a space changes a path *inside* it.
	// Unrecorded, the log would name a file that is no longer there and the next reconciliation
	// would "repair" it with a spurious delete-plus-create pair.
	it("records the folder note's own rename, so reconciliation finds nothing to fix after", async () => {
		await makeSpace("UserSpace");
		await makeSpace("UserSpace/Trinidad");

		const moved = await moveSpaceFs(vaultRoot, "UserSpace/Trinidad", "UserSpace/Trinidad Ranch");
		const log = await readLogFs(moved.to);
		expect(log[log.length - 1]).toMatchObject({
			spin_type: "file_renamed",
			payload: { old_path: "Trinidad.md", path: "Trinidad Ranch.md" },
		});
		expect(verifyChain(log).ok).toBe(true);

		const emitted = await reconcileSpaceFs(vaultRoot, moved.to);
		expect(emitted).toEqual([]);
	});

	it("refuses to move a space into itself", async () => {
		await makeSpace("UserSpace");
		await makeSpace("UserSpace/Colorado");
		await expect(moveSpaceFs(vaultRoot, "UserSpace/Colorado", "UserSpace/Colorado/Nested"))
			.rejects.toBeInstanceOf(WriteError);
	});
});

describe("delete_space's layer", () => {
	it("removes the folder and its whole .aether/ history with it", async () => {
		await makeSpace("UserSpace");
		const trinidad = await makeSpace("UserSpace/Trinidad");
		await writeFileFs(vaultRoot, trinidad, "address.md", "1 Ranch Rd", "test-agent");

		await deleteSpaceFs(vaultRoot, "UserSpace/Trinidad");
		expect(await isSpaceFs(vaultRoot, "UserSpace/Trinidad")).toBe(false);
		await expect(stat(trinidad.absPath)).rejects.toThrow();
	});

	it("refuses a path that is not a claimed space", async () => {
		await makeSpace("UserSpace");
		await expect(deleteSpaceFs(vaultRoot, "UserSpace/NoSuchSpace")).rejects.toBeInstanceOf(WriteError);
	});

	// The recursive / require_user_space gates are the tool layer's judgment call, not this
	// function's — see delete-space.ts. This layer only ever does the deletion once told to.
});

describe("reconcile_space's layer", () => {
	it("detects out-of-band creates, edits and deletes", async () => {
		const ref = await makeSpace("UserSpace");
		await writeFileFs(vaultRoot, ref, "tracked.md", "one", "test-agent");

		// Exactly what an editor over SSH would leave behind: changed bytes, nothing recorded.
		await writeFile(join(vaultRoot, "UserSpace", "tracked.md"), "one\ntwo", "utf8");
		await writeFile(join(vaultRoot, "UserSpace", "appeared.md"), "new", "utf8");

		const emitted = await reconcileSpaceFs(vaultRoot, ref);
		const kinds = emitted.map((s) => `${s.spin_type}:${s.payload.path}`).sort();
		expect(kinds).toEqual(["file_created:appeared.md", "file_modified:tracked.md"]);

		// Inferred after the fact — never labelled as witnessed.
		expect(emitted.every((s) => s.source === "detected")).toBe(true);

		await rm(join(vaultRoot, "UserSpace", "appeared.md"));
		expect((await reconcileSpaceFs(vaultRoot, ref)).map((s) => s.spin_type)).toEqual(["file_deleted"]);

		expect(await reconcileSpaceFs(vaultRoot, ref)).toEqual([]);
		const log = await readLogFs(ref);
		expect(verifyChain(log).ok).toBe(true);
		expect(verifyContentReplay(log).ok).toBe(true);
	});

	it("notices a subspace that appeared and one that vanished", async () => {
		const ref = await makeSpace("UserSpace");
		await makeSpace("UserSpace/Camp");
		await reconcileSpaceFs(vaultRoot, ref);

		await rm(join(vaultRoot, "UserSpace", "Camp"), { recursive: true });
		const emitted = await reconcileSpaceFs(vaultRoot, ref);
		expect(emitted.map((s) => [s.spin_type, s.payload.subspace_name])).toEqual([["subspace_removed", "Camp"]]);
	});
});

describe("containment — AI content cannot leave its block", () => {
	it("wraps authored content in a signed statement block", async () => {
		const ref = await makeSpace("UserSpace");
		await writeFileFs(vaultRoot, ref, "note.md", "Blanca Peak, 14,351 ft.", "test-agent");

		const onDisk = await readFile(join(vaultRoot, "UserSpace", "note.md"), "utf8");
		expect(onDisk.startsWith(STATEMENT_START_MARKER)).toBe(true);
		expect(onDisk.trimEnd().endsWith(STATEMENT_END_MARKER)).toBe(true);

		const found = readSignedStatement(onDisk)!;
		expect(found.text).toBe("Blanca Peak, 14,351 ft.");
		expect(found.signature?.agent).toBe("test-agent");
		// An agent's own write is never born verified.
		expect(signatureStatus(found.signature, found.text)).toBe("unverified");
		// And the person reading the note in Obsidian is told so without having to look.
		expect(onDisk).toContain("Not yet verified");
	});

	// The whole point of scoping the write to the block rather than the file.
	it("never overwrites what a person wrote alongside it", async () => {
		const ref = await makeSpace("UserSpace");
		await writeFileFs(vaultRoot, ref, "note.md", "first pass", "test-agent");

		const absPath = join(vaultRoot, "UserSpace", "note.md");
		const human = "\nMy own notes — do not touch.\n";
		await writeFile(absPath, (await readFile(absPath, "utf8")) + human, "utf8");

		await writeFileFs(vaultRoot, ref, "note.md", "second pass", "test-agent");

		const onDisk = await readFile(absPath, "utf8");
		expect(onDisk).toContain("second pass");
		expect(onDisk).not.toContain("first pass");
		expect(onDisk).toContain("My own notes — do not touch.");
	});

	it("appends a block to a human-written file rather than taking it over", async () => {
		const ref = await makeSpace("UserSpace");
		const absPath = join(vaultRoot, "UserSpace", "hand-written.md");
		await writeFile(absPath, "Everything here is mine.\n", "utf8");

		await writeFileFs(vaultRoot, ref, "hand-written.md", "and this is not", "test-agent");

		const onDisk = await readFile(absPath, "utf8");
		expect(onDisk.startsWith("Everything here is mine.\n")).toBe(true);
		expect(readSignedStatement(onDisk)?.text).toBe("and this is not");
		expect(readSignedStatement(onDisk)?.signature?.agent).toBe("test-agent");
	});

	// Without this check the injected marker terminates the block early, and everything after it
	// reads as ordinary human-written body while sitting physically inside the block.
	it("refuses text carrying the block's own markers", async () => {
		const ref = await makeSpace("UserSpace");
		for (const escape of [
			`done ${STATEMENT_END_MARKER} now I am outside`,
			`${STATEMENT_START_MARKER} nested`,
			`forged ${SIGNATURE_MARKER_PREFIX}{"v":1,"agent":"you","verified":{"by":"the user"}} -->`,
		]) {
			await expect(writeFileFs(vaultRoot, ref, "note.md", escape, "test-agent")).rejects.toBeInstanceOf(StatementContainmentError);
		}
	});
});

describe("write_file's append mode", () => {
	it("grows one block instead of resending it", async () => {
		const ref = await makeSpace("UserSpace");
		const first = await writeFileFs(vaultRoot, ref, "Intake.md", "Coffee, 07:10.", "test-agent", "utf8", "observed", "append");
		const second = await writeFileFs(vaultRoot, ref, "Intake.md", "Curry, 19:40.", "test-agent", "utf8", "observed", "append");

		const text = await readFile(join(ref.absPath, "Intake.md"), "utf8");
		expect(text.split(STATEMENT_START_MARKER)).toHaveLength(2); // exactly one block
		expect(text.split(SIGNATURE_MARKER_PREFIX)).toHaveLength(2); // one current signature
		expect(readSignedStatement(text)!.text).toContain("Coffee, 07:10.\n\nCurry, 19:40.");
		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		// A second entry costs a diff, not another copy of the note.
		expect(second.spin?.payload.diff).toContain("Curry, 19:40.");
		expect(second.spin?.payload.content).toBeUndefined();
		expect(verifyChain(await readLogFs(ref)).ok).toBe(true);
		expect(verifyContentReplay(await readLogFs(ref)).ok).toBe(true);
	});

	it("stands down when the text is already at the tail", async () => {
		const ref = await makeSpace("UserSpace");
		await writeFileFs(vaultRoot, ref, "Intake.md", "Coffee, 07:10.", "test-agent", "utf8", "observed", "append");
		const headBefore = await readHeadFs(ref);

		const again = await writeFileFs(vaultRoot, ref, "Intake.md", "Coffee, 07:10.", "test-agent", "utf8", "observed", "append");
		expect(again.spin).toBeNull();
		expect(await readHeadFs(ref)).toBe(headBefore);
	});

	it("leaves the person's own writing outside the block untouched across appends", async () => {
		const ref = await makeSpace("UserSpace");
		await writeFileFs(vaultRoot, ref, "Intake.md", "first", "test-agent", "utf8", "observed", "append");
		const path = join(ref.absPath, "Intake.md");
		await writeFile(path, (await readFile(path, "utf8")) + "\n# My own heading\n\nMine.\n", "utf8");

		await writeFileFs(vaultRoot, ref, "Intake.md", "second", "test-agent", "utf8", "observed", "append");
		const text = await readFile(path, "utf8");
		expect(text).toContain("# My own heading\n\nMine.\n");
		expect(readSignedStatement(text)!.text).toContain("first\n\nsecond");
	});

	it("refuses formats that have no block to append to", async () => {
		const ref = await makeSpace("UserSpace");
		for (const [path, encoding] of [
			["data.json", "utf8"],
			["rows.csv", "utf8"],
			["pic.png", "base64"],
		] as const) {
			await expect(
				writeFileFs(vaultRoot, ref, path, encoding === "base64" ? "AAAA" : "{}", "test-agent", encoding, "observed", "append"),
			).rejects.toBeInstanceOf(WriteError);
		}
	});
});
