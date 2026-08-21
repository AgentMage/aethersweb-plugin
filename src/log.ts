import type { App } from "obsidian";
import { buildNextSpin } from "./hash";
import { notifyLogChanged } from "./log-events";
import type { SpaceRef, Spin, SpinPayload, SpinSource, SpinType } from "./types";

/**
 * Serializes access to a single space's log by its log path. Without this, two spins racing
 * against the same log (e.g. a debounced modify timer firing while a rename handler is also
 * appending) can both read the same tail, both compute the same next seq, and both write —
 * producing duplicate seq numbers and a broken hash chain. Keyed per log path, so unrelated
 * spaces never wait on each other.
 */
const logLocks = new Map<string, Promise<unknown>>();

function withLogLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const prior = logLocks.get(key) ?? Promise.resolve();
	const run = prior.then(fn, fn);
	// Swallow the result/error here so a failed append never poisons the chain for the next
	// caller waiting on this key — each caller still sees its own `run`'s real outcome via the
	// returned promise.
	logLocks.set(key, run.then(
		() => undefined,
		() => undefined,
	));
	return run;
}

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
	return withLogLock(ref.logPath, async () => {
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
		notifyLogChanged(ref.logPath);
		return spin;
	});
}

/**
 * Overwrites a space's log with exactly `spins` — used only by chain repair (repair.ts). The log
 * is otherwise strictly append-only; this exists solely to drop orphaned/broken lines that a
 * repair has already preserved verbatim in a quarantine file. Runs under the same per-log lock as
 * appendSpin so a repair can never race a concurrent live append. Does not touch head — the
 * caller appends the audit `chain_repaired` spin right after, which fixes head as a normal
 * side effect of appendSpin.
 */
export async function rewriteLog(ref: SpaceRef, spins: Spin[], app: App): Promise<void> {
	return withLogLock(ref.logPath, async () => {
		const text = spins.map((s) => JSON.stringify(s)).join("\n") + (spins.length > 0 ? "\n" : "");
		await app.vault.adapter.write(ref.logPath, text);
		notifyLogChanged(ref.logPath);
	});
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
