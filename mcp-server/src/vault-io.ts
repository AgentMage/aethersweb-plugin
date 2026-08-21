import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { buildNextSpin } from "../../src/core/hash";
import { shouldRecordFileDeleted, shouldRecordSubspaceEvent } from "../../src/core/guards";
import type { Spin, SpinPayload, SpinSource, SpinType } from "../../src/core/types";
import type { SpaceRefFs } from "./space-fs";
import { withSpaceLock } from "./lock";

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Reads and parses a space's log. Tolerates (and drops, with a warning) a trailing partial line. Mirrors log.ts::readLog. */
export async function readLogFs(ref: SpaceRefFs): Promise<Spin[]> {
	if (!(await exists(ref.logPath))) return [];
	const raw = await readFile(ref.logPath, "utf8");
	const lines = raw.split("\n").filter((l) => l.trim().length > 0);
	const spins: Spin[] = [];
	for (let i = 0; i < lines.length; i++) {
		try {
			spins.push(JSON.parse(lines[i]) as Spin);
		} catch (err) {
			if (i === lines.length - 1) {
				console.warn(`[aethersweb-mcp-server] dropped unparsable trailing log line in ${ref.logPath}`, err);
			} else {
				console.error(`[aethersweb-mcp-server] failed to parse log line ${i} in ${ref.logPath}`, err);
			}
		}
	}
	return spins;
}

/** Reads the head file, falling back to the log's last line if head is missing/stale-empty. Mirrors log.ts::readHead. */
export async function readHeadFs(ref: SpaceRefFs): Promise<string | null> {
	if (await exists(ref.headPath)) {
		const raw = (await readFile(ref.headPath, "utf8")).trim();
		if (raw.length > 0) return raw;
	}
	const log = await readLogFs(ref);
	return log.length > 0 ? log[log.length - 1].hash : null;
}

async function writeHeadFs(ref: SpaceRefFs, hash: string): Promise<void> {
	await writeFile(ref.headPath, hash, "utf8");
}

/**
 * Appends one spin to a space's log and rewrites its head — the MCP server's side of the single
 * write path log.ts::appendSpin is on the plugin side. Locked per space via lock.ts so two
 * concurrent tool calls in this process (and, best-effort, a concurrently-running plugin
 * instance) can't both compute the same next seq — see lock.ts's own caveats.
 */
export async function appendSpinFs(
	ref: SpaceRefFs,
	spin_type: SpinType,
	source: SpinSource,
	payload: SpinPayload,
): Promise<Spin> {
	return withSpaceLock(ref, () => appendSpinLocked(ref, spin_type, source, payload));
}

/** The append itself, assuming this space's lock is already held. */
async function appendSpinLocked(
	ref: SpaceRefFs,
	spin_type: SpinType,
	source: SpinSource,
	payload: SpinPayload,
	knownLog?: Spin[],
): Promise<Spin> {
	const log = knownLog ?? (await readLogFs(ref));
	const prevSpin = log.length > 0 ? log[log.length - 1] : null;
	const nextSeq = prevSpin ? prevSpin.seq + 1 : 0;
	const spin = buildNextSpin(prevSpin, nextSeq, spin_type, source, payload);
	const line = JSON.stringify(spin) + "\n";

	if (!(await exists(ref.aetherDir))) {
		await mkdir(ref.aetherDir, { recursive: true });
	}
	await writeFile(ref.logPath, line, { encoding: "utf8", flag: "a" });
	await writeHeadFs(ref, spin.hash);
	return spin;
}

export interface GuardedSpinFs {
	spin_type: SpinType;
	source: SpinSource;
	payload: SpinPayload;
}

/**
 * Appends only if, having read the log under the lock, the caller still wants to — the server's
 * side of log.ts::appendSpinGuarded, sharing the same decision predicates from `core/guards.ts`.
 * That sharing is the point: with this server authoring files and structure headlessly while the
 * plugin may also be watching the same vault, a rule enforced on only one side isn't a rule.
 */
export async function appendSpinGuardedFs(
	ref: SpaceRefFs,
	decide: (log: Spin[]) => GuardedSpinFs | null | Promise<GuardedSpinFs | null>,
): Promise<Spin | null> {
	return withSpaceLock(ref, async () => {
		const log = await readLogFs(ref);
		const decision = await decide(log);
		if (!decision) return null;
		return appendSpinLocked(ref, decision.spin_type, decision.source, decision.payload, log);
	});
}

/** Records a subspace's arrival/departure only if the log doesn't already say so. */
export async function appendSubspaceEventFs(
	ref: SpaceRefFs,
	kind: "subspace_created" | "subspace_removed",
	subspace_name: string,
	source: SpinSource = "observed",
): Promise<Spin | null> {
	return appendSpinGuardedFs(ref, (log) =>
		shouldRecordSubspaceEvent(log, kind, subspace_name)
			? { spin_type: kind, source, payload: { subspace_name } }
			: null,
	);
}

/** Records a file's disappearance only if the log currently believes that path exists. */
export async function appendFileDeletedFs(
	ref: SpaceRefFs,
	path: string,
	source: SpinSource = "observed",
): Promise<Spin | null> {
	return appendSpinGuardedFs(ref, (log) =>
		shouldRecordFileDeleted(log, path) ? { spin_type: "file_deleted", source, payload: { path } } : null,
	);
}

/**
 * Idempotent scaffold of a space's `.aether/`: mirrors log.ts::ensureSpaceInitialized. A folder
 * arriving with its own pre-existing log (moved in from another vault, per the portability model)
 * keeps its history and only has its head repaired.
 */
export async function ensureSpaceInitializedFs(ref: SpaceRefFs): Promise<void> {
	if (!(await exists(ref.aetherDir))) {
		await mkdir(ref.aetherDir, { recursive: true });
	}
	await withSpaceLock(ref, async () => {
		const log = await readLogFs(ref);
		if (log.length === 0) {
			await appendSpinLocked(ref, "space_created", "observed", {}, log);
			return;
		}
		const tail = log[log.length - 1];
		if ((await readHeadRaw(ref)) !== tail.hash) await writeHeadFs(ref, tail.hash);
	});
}

async function readHeadRaw(ref: SpaceRefFs): Promise<string | null> {
	if (!(await exists(ref.headPath))) return null;
	return (await readFile(ref.headPath, "utf8")).trim();
}
