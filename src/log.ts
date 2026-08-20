import type { App } from "obsidian";
import { buildNextSpin } from "./hash";
import type { SpaceRef, Spin, SpinPayload, SpinSource, SpinType } from "./types";

/**
 * All .aether/* I/O goes through the raw filesystem adapter (app.vault.adapter), never the
 * indexed vault file API (app.vault.create/modify/read) — Obsidian does not track dotfolders,
 * so .aether/ files never appear as TFile objects.
 */

/** Reads and parses a space's log. Tolerates (and drops, with a warning) a trailing partial line. */
export async function readLog(ref: SpaceRef, app: App): Promise<Spin[]> {
	if (!(await app.vault.adapter.exists(ref.logPath))) return [];
	const raw = await app.vault.adapter.read(ref.logPath);
	const lines = raw.split("\n").filter((l) => l.trim().length > 0);
	const spins: Spin[] = [];
	for (let i = 0; i < lines.length; i++) {
		try {
			spins.push(JSON.parse(lines[i]) as Spin);
		} catch (err) {
			if (i === lines.length - 1) {
				console.warn(`[AethersWeb] dropped unparsable trailing log line in ${ref.logPath}`, err);
			} else {
				console.error(`[AethersWeb] failed to parse log line ${i} in ${ref.logPath}`, err);
			}
		}
	}
	return spins;
}

/** Reads the head file, falling back to the log's last line if head is missing/stale-empty. */
export async function readHead(ref: SpaceRef, app: App): Promise<string | null> {
	if (await app.vault.adapter.exists(ref.headPath)) {
		const raw = (await app.vault.adapter.read(ref.headPath)).trim();
		if (raw.length > 0) return raw;
	}
	const log = await readLog(ref, app);
	return log.length > 0 ? log[log.length - 1].hash : null;
}

async function writeHead(ref: SpaceRef, hash: string, app: App): Promise<void> {
	await app.vault.adapter.write(ref.headPath, hash);
}

/** Appends one spin to a space's log and rewrites its head. The single write path for all events. */
export async function appendSpin(
	ref: SpaceRef,
	spin_type: SpinType,
	source: SpinSource,
	payload: SpinPayload,
	app: App,
): Promise<Spin> {
	const log = await readLog(ref, app);
	const prevSpin = log.length > 0 ? log[log.length - 1] : null;
	const nextSeq = prevSpin ? prevSpin.seq + 1 : 0;
	const spin = buildNextSpin(prevSpin, nextSeq, spin_type, source, payload);
	const line = JSON.stringify(spin) + "\n";

	if (await app.vault.adapter.exists(ref.logPath)) {
		await app.vault.adapter.append(ref.logPath, line);
	} else {
		await app.vault.adapter.write(ref.logPath, line);
	}
	await writeHead(ref, spin.hash, app);
	return spin;
}

/**
 * Idempotent: creates .aether/, an empty log, and the seq-0 space_created spin if any of those
 * are missing. If the log already has entries, repairs `head` in case it's stale (e.g. after a
 * crash mid-write) — log.jsonl is always the source of truth, head is only its cache.
 */
export async function ensureSpaceInitialized(ref: SpaceRef, app: App): Promise<void> {
	if (!(await app.vault.adapter.exists(ref.aetherDir))) {
		await app.vault.adapter.mkdir(ref.aetherDir);
	}

	const log = await readLog(ref, app);
	if (log.length === 0) {
		await appendSpin(ref, "space_created", "observed", {}, app);
		return;
	}

	const tail = log[log.length - 1];
	const headExists = await app.vault.adapter.exists(ref.headPath);
	const currentHead = headExists ? (await app.vault.adapter.read(ref.headPath)).trim() : null;
	if (currentHead !== tail.hash) {
		await writeHead(ref, tail.hash, app);
	}
}
