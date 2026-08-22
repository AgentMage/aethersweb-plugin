import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSpaceRefFs, immediateFilesFs, isSpaceFs, listTreeFs, walkSpacesFs } from "../src/space-fs";

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

	describe("listTreeFs", () => {
		it("shows the raw tree — plain folders included — marking which folders are claimed spaces", async () => {
			await claimSpace("UserSpace");
			await writeFile(join(vaultRoot, "UserSpace", "notes.md"), "hello");
			await mkdir(join(vaultRoot, "UserSpace", "NotYetASpace"), { recursive: true });

			const { tree, truncated } = await listTreeFs(vaultRoot, "");
			expect(truncated).toBe(false);

			const userSpace = tree.find((n) => n.name === "UserSpace");
			expect(userSpace).toMatchObject({ type: "folder", is_space: true });
			expect(userSpace?.children?.map((c) => c.name).sort()).toEqual(["NotYetASpace", "notes.md"]);
			expect(userSpace?.children?.find((c) => c.name === "NotYetASpace")).toMatchObject({
				type: "folder",
				is_space: false,
			});
			expect(userSpace?.children?.find((c) => c.name === "notes.md")).toMatchObject({ type: "file", size: 5 });
		});

		it("omits dotted paths by default and includes them with includeIgnored", async () => {
			await claimSpace("UserSpace");

			const hidden = await listTreeFs(vaultRoot, "");
			expect(hidden.tree.find((n) => n.name === "UserSpace")?.children).toEqual([]);

			const shown = await listTreeFs(vaultRoot, "", { includeIgnored: true });
			expect(shown.tree.find((n) => n.name === "UserSpace")?.children?.map((c) => c.name)).toEqual([".aether"]);
		});

		it("stops descending past maxDepth", async () => {
			await mkdir(join(vaultRoot, "A", "B", "C"), { recursive: true });

			const { tree } = await listTreeFs(vaultRoot, "", { maxDepth: 2 });
			const a = tree.find((n) => n.name === "A");
			const b = a?.children?.find((n) => n.name === "B");
			expect(b?.children).toBeUndefined();
		});
	});
});
