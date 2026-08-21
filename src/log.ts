import type { App } from "obsidian";
import { LOCK_FILE, STALE_LOCK_MS } from "./core/constants";
import { shouldRecordFileDeleted, shouldRecordSubspaceEvent } from "./core/guards";
import { buildNextSpin } from "./core/hash";
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

const LOCK_RETRY_MS = 50;
const LOCK_MAX_WAIT_MS = 10_000;

/**
 * Acquires the cross-process advisory lock the MCP server also takes (`.aether/.lock`, see
 * `mcp-server/src/lock.ts`). The in-process queue above is exact but only covers this Obsidian
 * instance; with the MCP server now authoring files and structure headlessly, "only one of
 * {plugin, server} writes at a time" stopped being a safe assumption, so the plugin honors the
 * same file the server does. Best-effort by nature: exclusive-create is atomic, but a holder that
 * dies leaves the file behind, hence the staleness break.
 *
 * `.aether/` is written through the raw adapter, which has no exclusive-create primitive — so
 * exists-then-write is the closest available, and the residual window is why repair.ts's
 * `fork_reconciled` strategy still exists as the backstop.
 */
async function acquireFileLock(ref: SpaceRef, app: App): Promise<string> {
	const lockPath = `${ref.aetherDir}/${LOCK_FILE}`;
	const deadline = Date.now() + LOCK_MAX_WAIT_MS;

	for (;;) {
		if (!(await app.vault.adapter.exists(lockPath))) {
			await app.vault.adapter.write(lockPath, String(Date.now()));
			return lockPath;
		}
		let heldSince = 0;
		try {
			heldSince = Number((await app.vault.adapter.read(lockPath)).trim());
		} catch {
			continue; // vanished between exists() and read() — retry immediately
		}
		if (!Number.isFinite(heldSince) || Date.now() - heldSince > STALE_LOCK_MS) {
			await app.vault.adapter.remove(lockPath).catch(() => undefined);
			continue;
		}
		if (Date.now() > deadline) {
			throw new Error(`[AethersWeb] timed out waiting for lock at ${lockPath}`);
		}
		await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
	}
}

async function withSpaceLock<T>(ref: SpaceRef, app: App, fn: () => Promise<T>): Promise<T> {
	return withLogLock(ref.logPath, async () => {
		const lockPath = await acquireFileLock(ref, app);
		try {
			return await fn();
		} finally {
			await app.vault.adapter.remove(lockPath).catch(() => undefined);
		}
	});
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

/**
 * The actual append, assuming the caller already holds this space's lock. Never exported: every
 * public entry point below wraps it in withSpaceLock, so there is exactly one place that decides
 * what the next seq and prev_hash are, and it always runs alone.
 */
async function appendSpinLocked(
	ref: SpaceRef,
	spin_type: SpinType,
	source: SpinSource,
	payload: SpinPayload,
	app: App,
	knownLog?: Spin[],
): Promise<Spin> {
	const log = knownLog ?? (await readLog(ref, app));
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
}

/** Appends one spin to a space's log and rewrites its head. The unconditional write path. */
export async function appendSpin(
	ref: SpaceRef,
	spin_type: SpinType,
	source: SpinSource,
	payload: SpinPayload,
	app: App,
): Promise<Spin> {
	return withSpaceLock(ref, app, () => appendSpinLocked(ref, spin_type, source, payload, app));
}

/** What `appendSpinGuarded`'s decision callback returns when it wants a spin written. */
export interface GuardedSpin {
	spin_type: SpinType;
	source: SpinSource;
	payload: SpinPayload;
}

/**
 * Appends a spin only if, having read the log under the lock, the caller still wants to — the
 * fix for a whole class of duplicate-entry bugs where a decision was made against a log read
 * *outside* the lock and was already stale by the time the write landed.
 *
 * Every duplicate observed in a real vault had this shape: a folder scaffold and the vault
 * `create` event it triggers both read an empty log and both wrote `space_created` 6ms apart;
 * a folder move wrote `subspace_created` into a parent that already recorded that child. `decide`
 * runs with the authoritative log in hand and returns null to mean "the log already says this",
 * so the second writer stands down instead of appending a redundant line.
 */
export async function appendSpinGuarded(
	ref: SpaceRef,
	app: App,
	decide: (log: Spin[]) => GuardedSpin | null | Promise<GuardedSpin | null>,
): Promise<Spin | null> {
	return withSpaceLock(ref, app, async () => {
		const log = await readLog(ref, app);
		const decision = await decide(log);
		if (!decision) return null;
		return appendSpinLocked(ref, decision.spin_type, decision.source, decision.payload, app, log);
	});
}

/**
 * Overwrites a space's log with exactly `spins` — used only by chain repair (repair.ts). The log
 * is otherwise strictly append-only; this exists solely to drop orphaned/broken lines that a
 * repair has already preserved verbatim in a quarantine file. Runs under the same per-space lock as
 * appendSpin so a repair can never race a concurrent live append. Does not touch head — the
 * caller appends the audit `chain_repaired` spin right after, which fixes head as a normal
 * side effect of appendSpin.
 */
export async function rewriteLog(ref: SpaceRef, spins: Spin[], app: App): Promise<void> {
	return withSpaceLock(ref, app, async () => {
		const text = spins.map((s) => JSON.stringify(s)).join("\n") + (spins.length > 0 ? "\n" : "");
		await app.vault.adapter.write(ref.logPath, text);
		notifyLogChanged(ref.logPath);
	});
}

/**
 * Idempotent: creates .aether/, an empty log, and the seq-0 space_created spin if any of those
 * are missing. If the log already has entries, repairs `head` in case it's stale (e.g. after a
 * crash mid-write) — log.jsonl is always the source of truth, head is only its cache.
 *
 * The emptiness check and the seq-0 append happen under one lock hold. They used to be separate
 * awaits, which is why every space scaffolded by this plugin was born with `space_created` at
 * both seq 0 and seq 1: `scaffoldSpace` and the vault `create` event its own `createFolder` fires
 * each called this, and both observed an empty log before either had written.
 */
export async function ensureSpaceInitialized(ref: SpaceRef, app: App): Promise<void> {
	if (!(await app.vault.adapter.exists(ref.aetherDir))) {
		await app.vault.adapter.mkdir(ref.aetherDir);
	}

	await withSpaceLock(ref, app, async () => {
		const log = await readLog(ref, app);
		if (log.length === 0) {
			await appendSpinLocked(ref, "space_created", "observed", {}, app, log);
			return;
		}

		const tail = log[log.length - 1];
		const headExists = await app.vault.adapter.exists(ref.headPath);
		const currentHead = headExists ? (await app.vault.adapter.read(ref.headPath)).trim() : null;
		if (currentHead !== tail.hash) {
			await writeHead(ref, tail.hash, app);
		}
	});
}

/**
 * Records that a subspace appeared in / disappeared from this space, but only if the log doesn't
 * already say so. Containment is the thing AethersWeb actually models, so a parent log that
 * claims a child was created twice and never removed is a corrupted ontology, not just noise —
 * and both duplicate shapes were observed in a real vault:
 *
 * - `scaffoldSpace` and the vault `create` event its own `createFolder` fires both appended
 *   `subspace_created` for the same child, milliseconds apart.
 * - Moving a folder makes Obsidian fire `rename` for every descendant too; each descendant's
 *   handler re-announced children the parent had already recorded.
 *
 * Folding the log under the lock makes both harmless: the state is already what the event
 * describes, so there is nothing to record. Returns null when it stood down.
 */
export async function appendSubspaceEvent(
	ref: SpaceRef,
	kind: "subspace_created" | "subspace_removed",
	subspace_name: string,
	source: SpinSource,
	app: App,
): Promise<Spin | null> {
	return appendSpinGuarded(ref, app, (log) =>
		shouldRecordSubspaceEvent(log, kind, subspace_name)
			? { spin_type: kind, source, payload: { subspace_name } }
			: null,
	);
}

/**
 * Records a file's disappearance, but only if the log currently believes that path exists. Guards
 * against re-deleting an already-deleted path (a delete event arriving after reconciliation
 * already caught the same removal) and against deleting a path this space never knew about.
 */
export async function appendFileDeleted(
	ref: SpaceRef,
	path: string,
	source: SpinSource,
	app: App,
): Promise<Spin | null> {
	return appendSpinGuarded(ref, app, (log) =>
		shouldRecordFileDeleted(log, path) ? { spin_type: "file_deleted", source, payload: { path } } : null,
	);
}
