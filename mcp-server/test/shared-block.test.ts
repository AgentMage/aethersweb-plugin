import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_SHARED_PLACEHOLDER,
	SHARED_END_MARKER,
	SHARED_START_MARKER,
	SIGNATURE_MARKER_PREFIX,
	STATEMENT_END_MARKER,
	STATEMENT_START_MARKER,
} from "../../src/core/constants";
import { signatureStatus } from "../../src/core/signature";
import {
	appendToSharedBlock,
	ensureSharedBlock,
	findBlock,
	readSignedBlock,
	StatementContainmentError,
	stripBlocks,
	writeSignedBlock,
} from "../../src/core/statement";
import { regenerateContextFs, writeSharedFs, writeStatementFs } from "../src/context-fs";
import { buildSpaceRefFs } from "../src/space-fs";
import { appendSpinFs, readHeadFs, readLogFs } from "../src/vault-io";

const AGENT = "test-agent";
const NOTE = "UserSpace/UserSpace.md";

describe("the shared block, in isolation", () => {
	it("is placed after the statement block, not through the person's prose", () => {
		const note =
			`${STATEMENT_START_MARKER}\nstatement\n${STATEMENT_END_MARKER}\n\n` +
			"# My own heading\n\nA paragraph I wrote.\n";
		const withShared = ensureSharedBlock(note)!;

		expect(withShared.indexOf(SHARED_START_MARKER)).toBeGreaterThan(withShared.indexOf(STATEMENT_END_MARKER));
		expect(withShared.indexOf(SHARED_END_MARKER)).toBeLessThan(withShared.indexOf("# My own heading"));
		// The person's prose comes through as one unbroken piece.
		expect(withShared).toContain("# My own heading\n\nA paragraph I wrote.\n");
	});

	it("is appended when there is no statement block to sit under", () => {
		const withShared = ensureSharedBlock("Only my own writing.\n")!;
		expect(withShared.startsWith("Only my own writing.")).toBe(true);
		expect(withShared).toContain(SHARED_START_MARKER);
	});

	it("is left completely alone once it exists — placeholder or not", () => {
		const note = `${SHARED_START_MARKER}\nsomething someone wrote\n${SHARED_END_MARKER}\n`;
		expect(ensureSharedBlock(note)).toBe(null);
	});

	it("appending keeps what is already there byte for byte", () => {
		let note = ensureSharedBlock("")!;
		note = appendToSharedBlock(note, "A question I left for the agent.", AGENT, "tip-1", NOTE);
		note = appendToSharedBlock(note, "The agent's answer.", AGENT, "tip-2", NOTE);

		const shared = readSignedBlock(note, "shared")!;
		expect(shared.text).toContain("A question I left for the agent.");
		expect(shared.text).toContain("The agent's answer.");
		expect(shared.text.indexOf("A question")).toBeLessThan(shared.text.indexOf("The agent's answer"));
	});

	it("appending replaces the starting placeholder rather than stacking under it", () => {
		const note = appendToSharedBlock(ensureSharedBlock("")!, "First real entry.", AGENT, null, NOTE);
		expect(readSignedBlock(note, "shared")!.text).toBe("First real entry.");
		expect(note).not.toContain(DEFAULT_SHARED_PLACEHOLDER);
	});

	it("re-appending the same trailing text is a no-op, so a retried call does not double it", () => {
		const once = appendToSharedBlock(ensureSharedBlock("")!, "Left a note.", AGENT, null, NOTE);
		expect(appendToSharedBlock(once, "Left a note.", AGENT, null, NOTE)).toBe(once);
	});

	it("a person writing in the block does not damage the statement, and vice versa", () => {
		let note = ensureSharedBlock(`${STATEMENT_START_MARKER}\nthe statement\n${STATEMENT_END_MARKER}\n`)!;
		note = appendToSharedBlock(note, "agent note", AGENT, null, NOTE);
		note = writeSignedBlock(note, "a fresh statement", "statement", AGENT, "tip", NOTE);

		expect(readSignedBlock(note, "statement")!.text).toBe("a fresh statement");
		expect(readSignedBlock(note, "shared")!.text).toBe("agent note");
		expect(note.split(SHARED_START_MARKER)).toHaveLength(2);
	});

	it("refuses text carrying any block marker, including the other kind's", () => {
		const base = ensureSharedBlock("")!;
		for (const marker of [SHARED_END_MARKER, SHARED_START_MARKER, STATEMENT_START_MARKER, STATEMENT_END_MARKER]) {
			expect(() => appendToSharedBlock(base, `escape ${marker} out`, AGENT, null, NOTE)).toThrow(
				StatementContainmentError,
			);
		}
		expect(() => appendToSharedBlock(base, `${SIGNATURE_MARKER_PREFIX}{}`, AGENT, null, NOTE)).toThrow(
			StatementContainmentError,
		);
	});

	it("signs what the agent wrote, and reports a later hand-edit as co-written rather than damaged", () => {
		const note = appendToSharedBlock(ensureSharedBlock("")!, "the agent's line", AGENT, "tip", NOTE);
		const sig = readSignedBlock(note, "shared")!.signature!;
		expect(sig.agent).toBe(AGENT);
		expect(signatureStatus(sig, "the agent's line")).toBe("unverified");

		// The visible line never claims the whole block is AI-written, because it isn't.
		expect(note).toContain("Shared block: yours and the agent’s");
		expect(note).not.toContain(`AI-written by \`${AGENT}\``);

		// Once the person types in it, the hash stops matching — that is the region working.
		const edited = note.replace("the agent's line", "the agent's line\n\nand mine underneath");
		expect(signatureStatus(sig, readSignedBlock(edited, "shared")!.text)).toBe("stale_signature");
	});

	it("stripBlocks leaves only the person's untouchable writing", () => {
		let note = `${STATEMENT_START_MARKER}\nstatement\n${STATEMENT_END_MARKER}\n\nMy own words.\n`;
		note = ensureSharedBlock(note)!;
		note = appendToSharedBlock(note, "shared line", AGENT, null, NOTE);
		expect(stripBlocks(note)).toBe("My own words.");
	});
});

describe("the shared block, through the server", () => {
	let vaultRoot: string;

	beforeEach(async () => {
		vaultRoot = await mkdtemp(join(tmpdir(), "aethersweb-shared-test-"));
		await mkdir(join(vaultRoot, "UserSpace", ".aether"), { recursive: true });
	});

	afterEach(async () => {
		await rm(vaultRoot, { recursive: true, force: true });
	});

	async function claimedSpace() {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(ref, "space_created", "observed", {});
		await regenerateContextFs(vaultRoot, ref);
		return ref;
	}

	it("a new folder note is created with all three regions", async () => {
		const ref = await claimedSpace();
		const text = await readFile(ref.contextPath, "utf8");

		expect(findBlock(text, "statement")).not.toBe(null);
		expect(findBlock(text, "shared")).not.toBe(null);
		expect(text.indexOf(SHARED_START_MARKER)).toBeGreaterThan(text.indexOf(STATEMENT_END_MARKER));
		expect(readSignedBlock(text, "shared")!.text).toBe(DEFAULT_SHARED_PLACEHOLDER);
	});

	it("a folder note written before the shared block existed gets one on the next regeneration", async () => {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(ref, "space_created", "observed", {});
		// A pre-existing note in the old two-region shape, with the person's own writing in it.
		await writeFile(
			ref.contextPath,
			`${STATEMENT_START_MARKER}\nold statement\n${STATEMENT_END_MARKER}\n\nWhat I wrote about this space.\n`,
			"utf8",
		);

		await regenerateContextFs(vaultRoot, ref);
		const text = await readFile(ref.contextPath, "utf8");

		expect(findBlock(text, "shared")).not.toBe(null);
		expect(readSignedBlock(text, "statement")!.text).toBe("old statement");
		expect(text).toContain("What I wrote about this space.");
	});

	it("adding the shared block is a one-time migration — regenerating again writes nothing", async () => {
		const ref = await claimedSpace();
		const before = await readFile(ref.contextPath, "utf8");
		const spinsBefore = (await readLogFs(ref)).length;

		await regenerateContextFs(vaultRoot, ref);

		expect(await readFile(ref.contextPath, "utf8")).toBe(before);
		expect((await readLogFs(ref)).length).toBe(spinsBefore);
	});

	it("writeSharedFs appends, logs the write on the folder note, and leaves the statement alone", async () => {
		const ref = await claimedSpace();
		const head = await readHeadFs(ref);
		await writeStatementFs(vaultRoot, ref, "What this space is.", head!, AGENT);

		await writeSharedFs(vaultRoot, ref, "Open question: is this the right home for the invoices?", AGENT);
		await writeSharedFs(vaultRoot, ref, "Still open as of today.", AGENT);

		const text = await readFile(ref.contextPath, "utf8");
		expect(readSignedBlock(text, "statement")!.text).toBe("What this space is.");
		const shared = readSignedBlock(text, "shared")!;
		expect(shared.text).toContain("Open question: is this the right home for the invoices?");
		expect(shared.text).toContain("Still open as of today.");

		// Logged as an ordinary modification of the folder note — no new spin type.
		const log = await readLogFs(ref);
		const noteSpins = log.filter((s) => s.spin_type === "file_modified" && s.payload.path === "UserSpace.md");
		expect(noteSpins.length).toBeGreaterThanOrEqual(2);
	});

	it("regeneration never rewrites what is in the shared block", async () => {
		const ref = await claimedSpace();
		await writeSharedFs(vaultRoot, ref, "Something worth keeping.", AGENT);
		await writeFile(join(vaultRoot, "UserSpace", "new.md"), "content", "utf8");

		await regenerateContextFs(vaultRoot, ref);

		expect(readSignedBlock(await readFile(ref.contextPath, "utf8"), "shared")!.text).toBe("Something worth keeping.");
	});

	it("a shared write does not make the statement stale — the folder note's own spins never do", async () => {
		const ref = await claimedSpace();
		const head = await readHeadFs(ref);
		await writeStatementFs(vaultRoot, ref, "Current and correct.", head!, AGENT);
		const { checkStalenessFs } = await import("../src/context-fs");
		expect((await checkStalenessFs(vaultRoot, ref)).statement_stale).toBe(false);

		await writeSharedFs(vaultRoot, ref, "A note for later.", AGENT);

		expect((await checkStalenessFs(vaultRoot, ref)).statement_stale).toBe(false);
	});

	it('mode "replace" rewrites the whole block, and only when asked for', async () => {
		const ref = await claimedSpace();
		await writeSharedFs(vaultRoot, ref, "First.", AGENT);
		await writeSharedFs(vaultRoot, ref, "Consolidated.", AGENT, "replace");

		const shared = readSignedBlock(await readFile(ref.contextPath, "utf8"), "shared")!;
		expect(shared.text).toBe("Consolidated.");
	});

	it("writing the identical text again changes nothing on disk and records no spin", async () => {
		const ref = await claimedSpace();
		await writeSharedFs(vaultRoot, ref, "Said once.", AGENT);
		const before = await readFile(ref.contextPath, "utf8");
		const spinsBefore = (await readLogFs(ref)).length;

		await writeSharedFs(vaultRoot, ref, "Said once.", AGENT);

		expect(await readFile(ref.contextPath, "utf8")).toBe(before);
		expect((await readLogFs(ref)).length).toBe(spinsBefore);
	});
});
