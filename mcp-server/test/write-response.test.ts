import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { verifyContentReplay } from "../../src/verify-content";
import { regenerateContextFs } from "../src/context-fs";
import { buildSpaceRefFs } from "../src/space-fs";
import { ensureSpaceInitializedFs, readLogFs } from "../src/vault-io";
import { registerReadLogTool } from "../src/tools/read-log";
import { registerMoveFileTool } from "../src/tools/move-file";
import { registerReconcileSpaceTool } from "../src/tools/reconcile-space";
import { registerWriteFileTool } from "../src/tools/write-file";

/**
 * The first tests in this repo that drive a registered tool handler rather than the fs layer
 * beneath it. They have to: what this item changes is the *response*, which only exists at the
 * tool layer. The stub captures registrations the way the real McpServer does, minus transport.
 */
type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

function captureTools(register: (s: McpServer, root: string) => void, vaultRoot: string): Map<string, Handler> {
	const tools = new Map<string, Handler>();
	const stub = { registerTool: (name: string, _cfg: unknown, fn: Handler) => tools.set(name, fn) };
	register(stub as unknown as McpServer, vaultRoot);
	return tools;
}

async function call(tools: Map<string, Handler>, name: string, args: Record<string, unknown>) {
	const res = await tools.get(name)!(args);
	return { bytes: Buffer.byteLength(res.content[0].text, "utf8"), json: JSON.parse(res.content[0].text) };
}

let vaultRoot: string;
const TEN_KB = "Blanca Peak, 14,351 ft. ".repeat(440); // ~10 KB of prose

async function makeSpace(path: string) {
	await mkdir(join(vaultRoot, path), { recursive: true });
	const ref = buildSpaceRefFs(vaultRoot, path);
	await ensureSpaceInitializedFs(ref);
	await regenerateContextFs(vaultRoot, ref);
	return ref;
}

beforeEach(async () => {
	vaultRoot = await mkdtemp(join(tmpdir(), "aethersweb-write-response-"));
});
afterEach(async () => {
	await rm(vaultRoot, { recursive: true, force: true });
});

describe("write responses carry metadata, not the bytes the caller just sent", () => {
	it("answers a 10 KB write in well under a kilobyte, and loses nothing doing it", async () => {
		const ref = await makeSpace("UserSpace");
		const write = captureTools(registerWriteFileTool, vaultRoot);
		const read = captureTools(registerReadLogTool, vaultRoot);

		expect(Buffer.byteLength(TEN_KB, "utf8")).toBeGreaterThan(10_000);
		const res = await call(write, "write_file", {
			space_path: "UserSpace",
			path: "Intake Log.md",
			content: TEN_KB,
			agent: "test-agent",
			encoding: "utf8",
			return_content: false,
			return_diff: false,
		});

		expect(res.bytes).toBeLessThan(1000);
		expect(res.json.spin.payload.content).toBeUndefined();
		expect(res.json.spin.payload.content_omitted).toBe(true);
		expect(res.json.spin.payload.content_hash).toBeTruthy();

		// The other half of the claim: the log kept every byte, so this was a view and not a loss.
		const back = await call(read, "read_log", { space_path: "UserSpace", limit: 50, include_content: true });
		const created = back.json.spins.find(
			(s: { spin_type: string; payload: { path?: string } }) =>
				s.spin_type === "file_created" && s.payload.path === "Intake Log.md",
		);
		expect(created.payload.content).toContain("Blanca Peak");
		expect(back.bytes).toBeGreaterThan(10_000);
		expect(verifyContentReplay(await readLogFs(ref)).ok).toBe(true);
	});

	it("withholds the diff on a modify, and hands it over when asked", async () => {
		await makeSpace("UserSpace");
		const write = captureTools(registerWriteFileTool, vaultRoot);
		const base = { space_path: "UserSpace", path: "Intake Log.md", agent: "test-agent", encoding: "utf8" };

		await call(write, "write_file", { ...base, content: TEN_KB, return_content: false, return_diff: false });
		const quiet = await call(write, "write_file", {
			...base,
			content: `${TEN_KB}\nOne more line.`,
			return_content: false,
			return_diff: false,
		});
		expect(quiet.json.spin.payload.diff).toBeUndefined();
		expect(quiet.json.spin.payload.content_omitted).toBe(true);
		expect(quiet.bytes).toBeLessThan(1000);

		const loud = await call(write, "write_file", {
			...base,
			content: `${TEN_KB}\nAnd another.`,
			return_content: false,
			return_diff: true,
		});
		expect(loud.json.spin.payload.diff).toContain("And another.");
	});

	it("does not echo a file the caller never wrote when it crosses a space boundary", async () => {
		await makeSpace("UserSpace");
		await makeSpace("UserSpace/Camp");
		const write = captureTools(registerWriteFileTool, vaultRoot);
		const move = captureTools(registerMoveFileTool, vaultRoot);

		await call(write, "write_file", {
			space_path: "UserSpace",
			path: "notes.md",
			content: TEN_KB,
			agent: "test-agent",
			encoding: "utf8",
			return_content: false,
			return_diff: false,
		});
		const res = await call(move, "move_file", {
			from_space: "UserSpace",
			from_path: "notes.md",
			to_space: "UserSpace/Camp",
			to_path: "notes.md",
			return_content: false,
			return_diff: false,
		});

		expect(res.json.crossed_space).toBe(true);
		expect(res.json.spins.arrived.payload.content).toBeUndefined();
		expect(res.json.spins.arrived.payload.content_omitted).toBe(true);
		expect(res.bytes).toBeLessThan(1200);
	});

	it("keeps reconcile's own projection small, but says observed-vs-detected in the data", async () => {
		const ref = await makeSpace("UserSpace");
		await writeFile(join(ref.absPath, "dropped-in.md"), TEN_KB, "utf8");

		const tools = captureTools(registerReconcileSpaceTool, vaultRoot);
		const res = await call(tools, "reconcile_space", { space_path: "UserSpace", recursive: false });

		expect(res.json.total_spins).toBe(1);
		expect(res.json.spaces[0].spins[0].source).toBe("detected");
		expect(res.bytes).toBeLessThan(500);
	});
});
