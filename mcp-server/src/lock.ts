import { open, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { LOCK_FILE, STALE_LOCK_MS } from "../../src/core/constants";
import type { SpaceRefFs } from "./space-fs";

const RETRY_DELAY_MS = 50;
const MAX_WAIT_MS = 10_000;

/** In-process queue per log path — exact, not advisory, for calls within this one server instance. */
const inProcessLocks = new Map<string, Promise<unknown>>();

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return typeof err === "object" && err !== null && "code" in err;
}

async function acquireFileLock(lockPath: string): Promise<void> {
	const deadline = Date.now() + MAX_WAIT_MS;
	for (;;) {
		try {
			const handle = await open(lockPath, "wx");
			await handle.close();
			return;
		} catch (err) {
			if (!isNodeError(err) || err.code !== "EEXIST") throw err;

			try {
				const st = await stat(lockPath);
				if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
					await unlink(lockPath).catch(() => undefined);
					continue; // a crashed holder left this behind — retry immediately
				}
			} catch {
				continue; // vanished between our EEXIST and this stat — retry
			}

			if (Date.now() > deadline) {
				throw new Error(`[aethersweb-mcp-server] timed out waiting for lock at ${lockPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
		}
	}
}

async function releaseFileLock(lockPath: string): Promise<void> {
	await unlink(lockPath).catch(() => undefined);
}

/**
 * Serializes access to one space's log: exactly, via an in-memory queue, for concurrent calls
 * within this one process; best-effort across processes via a `.aether/.lock` exclusive-create
 * file (stale after STALE_LOCK_MS, in case a crashed holder left one behind).
 *
 * The plugin's own `log.ts` now acquires this same file (`core/constants.ts`'s LOCK_FILE) before
 * every append, so this is a genuine two-party lock rather than a one-sided gesture — necessary
 * once this server authors files and structure headlessly, where "only one writer is active at a
 * time" stopped being a safe assumption.
 *
 * It remains advisory in the strict sense: exclusive-create is atomic, but a process killed mid-
 * hold leaves the file behind (hence the staleness break), and the plugin's adapter has no
 * exclusive-create primitive, so its acquire is exists-then-write with a narrow residual window.
 * repair.ts's `fork_reconciled` strategy stays the backstop for that remainder.
 */
export function withSpaceLock<T>(ref: SpaceRefFs, fn: () => Promise<T>): Promise<T> {
	const key = ref.logPath;

	const runLocked = async (): Promise<T> => {
		const lockPath = join(ref.aetherDir, LOCK_FILE);
		await acquireFileLock(lockPath);
		try {
			return await fn();
		} finally {
			await releaseFileLock(lockPath);
		}
	};

	const prior = inProcessLocks.get(key) ?? Promise.resolve();
	const run = prior.then(runLocked, runLocked);
	// Swallow the result/error here so a failed call never poisons the queue for the next caller
	// waiting on this key — each caller still observes its own `run`'s real outcome.
	inProcessLocks.set(
		key,
		run.then(
			() => undefined,
			() => undefined,
		),
	);
	return run;
}
