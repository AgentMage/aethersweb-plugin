import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkStalenessFs, regenerateContextFs, summarizeStaleness, writeStatementFs } from "../src/context-fs";
import { buildSpaceRefFs, walkSpacesFs } from "../src/space-fs";
import type { SpaceRefFs } from "../src/space-fs";
import { appendSpinFs, ensureSpaceInitializedFs, readHeadFs } from "../src/vault-io";

let vaultRoot: string;

async function makeSpace(path: string): Promise<SpaceRefFs> {
	await mkdir(join(vaultRoot, path), { recursive: true });
	const ref = buildSpaceRefFs(vaultRoot, path);
	await ensureSpaceInitializedFs(ref);
	await regenerateContextFs(vaultRoot, ref);
	return ref;
}

async function summarize(): Promise<ReturnType<typeof summarizeStaleness>> {
	const spaces = [];
	for await (const ref of walkSpacesFs(vaultRoot)) spaces.push(await checkStalenessFs(vaultRoot, ref));
	return summarizeStaleness(spaces);
}

/** The real vault's shape: deep, human-worded paths — the worst case for a path-listing summary. */
const REAL_PATHS = [
	"Lilly", "Lilly/Body", "Lilly/Body/Intake", "Lilly/Mind", "Lilly/Meta", "Lilly/Meta/Settings",
	"Lilly/The Wave", "Lilly/The Wave/Galley", "Lilly/The Wave/Galley/Upper Pantry",
	"Lilly/The Wave/Galley/Upper Pantry/Under Sink", "Lilly/The Wave/Galley/Fridge Unit",
	"Lilly/The Wave/Galley/Fridge Unit/Cold Box", "Lilly/The Wave/Galley/Dry Goods",
	"Lilly/The Wave/Berth", "Lilly/The Wave/Head", "Lilly/The Wave/Engine Bay",
	"Lilly/The Wave/Engine Bay/Propane", "Lilly/The Wave/Deck", "Lilly/The Wave/Deck/Solar",
	"Lilly/Projects", "Lilly/Projects/AethersWeb", "Lilly/Projects/AethersWeb/Spec",
	"Lilly/People", "Lilly/People/Correspondence", "Lilly/Places", "Lilly/Places/Trinidad",
	"Lilly/Places/Trinidad/Ranch", "Lilly/Archive",
];

beforeEach(async () => {
	vaultRoot = await mkdtemp(join(tmpdir(), "aethersweb-staleness-"));
});
afterEach(async () => {
	await rm(vaultRoot, { recursive: true, force: true });
});

describe("summarizeStaleness", () => {
	it("counts the two kinds of stale apart, and lists them apart", async () => {
		const written = await makeSpace("UserSpace");
		await writeStatementFs(vaultRoot, written, "What this space is.", (await readHeadFs(written))!, "test-agent");
		await makeSpace("UserSpace/NeverWritten");

		// Drift the written space by one spin that is not the folder note's own.
		await writeFile(join(written.absPath, "GPS.md"), "37.5N", "utf8");
		await appendSpinFs(written, "file_created", "observed", { path: "GPS.md", content_hash: "h", size: 5 });

		const summary = await summarize();
		expect(summary.total_spaces).toBe(2);
		expect(summary.never_written).toEqual(["UserSpace/NeverWritten"]);
		expect(summary.never_written_count).toBe(1);
		expect(summary.stale.map((e) => e.space_path)).toEqual(["UserSpace"]);
		// Disjoint by construction — a space is in one list or the other, never both.
		expect(summary.stale.some((e) => summary.never_written.includes(e.space_path))).toBe(false);
	});

	it("counts spins since the statement, not the folder note's own writes", async () => {
		// The regression that matters: writing a statement edits the folder note, which is a logged
		// file. Counting its own spins would leave every statement stale against its own creation.
		const ref = await makeSpace("UserSpace");
		await writeStatementFs(vaultRoot, ref, "First pass.", (await readHeadFs(ref))!, "test-agent");
		await writeStatementFs(vaultRoot, ref, "Second pass.", (await readHeadFs(ref))!, "test-agent");
		await appendSpinFs(ref, "file_created", "observed", { path: "GPS.md", content_hash: "h", size: 5 });

		const entry = (await summarize()).stale.find((e) => e.space_path === "UserSpace")!;
		expect(entry.spin_count).toBe(1);
	});

	it("does not let a drifted subspace tip masquerade as a composition change", async () => {
		const parent = await makeSpace("UserSpace");
		await makeSpace("UserSpace/Camp");
		await writeStatementFs(vaultRoot, parent, "Placed among its children.", (await readHeadFs(parent))!, "test-agent");
		// The child's log moves on. That is index staleness in the parent — never a claim about the
		// parent's own composition, which has not changed.
		await appendSpinFs(buildSpaceRefFs(vaultRoot, "UserSpace/Camp"), "file_created", "observed", {
			path: "a.md",
			content_hash: "h",
			size: 1,
		});

		const entry = (await summarize()).stale.find((e) => e.space_path === "UserSpace")!;
		expect(entry.needs_context).toBe(true);
		expect(entry.structural).toBe(false);
	});

	it("summarises a 28-space vault in under a kilobyte, where the full walk needs kilobytes", async () => {
		for (const path of REAL_PATHS) await makeSpace(path);

		const spaces = [];
		for await (const ref of walkSpacesFs(vaultRoot)) spaces.push(await checkStalenessFs(vaultRoot, ref));
		expect(spaces).toHaveLength(28);

		const summary = Buffer.byteLength(JSON.stringify(summarizeStaleness(spaces)), "utf8");
		const full = Buffer.byteLength(JSON.stringify({ spaces }, null, 2), "utf8");

		expect(summary).toBeLessThan(1024);
		// Proves a reduction, not merely a small number.
		expect(full).toBeGreaterThan(8 * 1024);
	});
});
