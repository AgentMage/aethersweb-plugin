import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSpaceRefFs, immediateFilesFs, isSpaceFs, walkSpacesFs } from "../src/space-fs";

let vaultRoot: string;

beforeEach(async () => {
	vaultRoot = await mkdtemp(join(tmpdir(), "aethersweb-mcp-test-"));
});

afterEach(async () => {
	await rm(vaultRoot, { recursive: true, force: true });
});

async function claimSpace(vaultRelativePath: string): Promise<void> {
	const absDir = join(vaultRoot, vaultRelativePath, ".aether");
	await mkdir(absDir, { recursive: true });
	await writeFile(join(absDir, "log.jsonl"), "");
}

describe("space-fs.ts", () => {
	it("isSpaceFs is true only for folders with .aether/log.jsonl", async () => {
		await mkdir(join(vaultRoot, "PlainFolder"), { recursive: true });
		await claimSpace("ClaimedSpace");

		expect(await isSpaceFs(vaultRoot, "PlainFolder")).toBe(false);
		expect(await isSpaceFs(vaultRoot, "ClaimedSpace")).toBe(true);
	});

	it("walkSpacesFs finds nested claimed spaces and skips dotfolders / unclaimed folders", async () => {
		await claimSpace("UserSpace");
		await claimSpace("UserSpace/Location");
		await mkdir(join(vaultRoot, "UserSpace", "NotAClaimedFolder"), { recursive: true });
		await mkdir(join(vaultRoot, ".obsidian"), { recursive: true });

		const found: string[] = [];
		for await (const ref of walkSpacesFs(vaultRoot)) found.push(ref.path);

		expect(found.sort()).toEqual(["UserSpace", "UserSpace/Location"]);
	});

	it("immediateFilesFs excludes the space's own context note and dotfiles", async () => {
		await claimSpace("UserSpace");
		await writeFile(join(vaultRoot, "UserSpace", "notes.md"), "hello");
		await writeFile(join(vaultRoot, "UserSpace", "UserSpace.md"), "context note");
		await writeFile(join(vaultRoot, "UserSpace", ".hidden"), "nope");

		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		const files = await immediateFilesFs(ref);

		expect(files).toEqual([join(vaultRoot, "UserSpace", "notes.md")]);
	});
});
