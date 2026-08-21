import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyChain } from "../../src/core/hash";
import { buildSpaceRefFs } from "../src/space-fs";
import { appendSpinFs, readHeadFs, readLogFs } from "../src/vault-io";

let vaultRoot: string;

beforeEach(async () => {
	vaultRoot = await mkdtemp(join(tmpdir(), "aethersweb-mcp-test-"));
	await mkdir(join(vaultRoot, "UserSpace", ".aether"), { recursive: true });
});

afterEach(async () => {
	await rm(vaultRoot, { recursive: true, force: true });
});

describe("vault-io.ts::appendSpinFs", () => {
	it("produces a chain that core/hash.ts::verifyChain accepts — the no-drift check", async () => {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");

		await appendSpinFs(ref, "space_created", "observed", {});
		await appendSpinFs(ref, "file_created", "observed", { path: "a.md", content_hash: "x", content: "hi", encoding: "utf8" });
		await appendSpinFs(ref, "file_modified", "observed", { path: "a.md", content_hash: "y", diff: "..." });

		const log = await readLogFs(ref);
		expect(log).toHaveLength(3);
		expect(log.map((s) => s.seq)).toEqual([0, 1, 2]);
		expect(verifyChain(log)).toEqual({ ok: true, length: 3 });
	});

	it("keeps head in sync with the log's last hash", async () => {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		const first = await appendSpinFs(ref, "space_created", "observed", {});
		const second = await appendSpinFs(ref, "file_created", "observed", { path: "a.md", content_hash: "x" });

		expect(await readHeadFs(ref)).toBe(second.hash);
		expect(second.prev_hash).toBe(first.hash);
	});

	it("serializes concurrent appends into a single valid chain (no duplicate seq)", async () => {
		const ref = buildSpaceRefFs(vaultRoot, "UserSpace");
		await appendSpinFs(ref, "space_created", "observed", {});

		await Promise.all([
			appendSpinFs(ref, "file_created", "observed", { path: "a.md", content_hash: "a" }),
			appendSpinFs(ref, "file_created", "observed", { path: "b.md", content_hash: "b" }),
			appendSpinFs(ref, "file_created", "observed", { path: "c.md", content_hash: "c" }),
		]);

		const log = await readLogFs(ref);
		expect(log).toHaveLength(4);
		expect(log.map((s) => s.seq)).toEqual([0, 1, 2, 3]);
		expect(verifyChain(log).ok).toBe(true);
	});
});
