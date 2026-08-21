import type { App } from "obsidian";
import { regenerateContext } from "./context";
import { recordFileContentSpin } from "./content-record";
import { foldLogToLastKnownFiles } from "./core/fold-files";
import { appendFileDeleted, appendSubspaceEvent, ensureSpaceInitialized, readLog } from "./log";
import { isSpaceEnabled } from "./settings";
import {
	buildSpaceRef,
	hashFile,
	immediateFiles,
	immediateSubfolders,
	immediateSubspaces,
	isSpace,
	relativePath,
	walkSpaces,
} from "./space";
import type { AethersWebSettings, SpaceRef, Spin } from "./types";

/**
 * Diffs current on-disk state against what a space's own log last recorded, appending
 * `detected` spins for anything that drifted while no live plugin instance was watching (e.g.
 * an out-of-band vim edit). Deliberately does NOT attempt heuristic rename detection — a
 * vanish+appear pair reconciles honestly as delete+create. True renames are only ever
 * `observed`, via Obsidian's own rename event (see events.ts).
 */
export async function reconcileSpace(ref: SpaceRef, app: App): Promise<Spin[]> {
	const log = await readLog(ref, app);
	const knownFiles = foldLogToLastKnownFiles(log);

	const emitted: Spin[] = [];
	const record = (spin: Spin | null): void => {
		if (spin) emitted.push(spin);
	};
	const currentPaths = new Set<string>();

	for (const file of immediateFiles(ref)) {
		const path = relativePath(ref, file);
		currentPaths.add(path);
		const currentHash = await hashFile(file, app);
		const prior = knownFiles[path];

		if (!prior || prior.deleted) {
			record(await recordFileContentSpin(ref, "file_created", path, file, "detected", app));
		} else if (prior.hash !== currentHash) {
			record(await recordFileContentSpin(ref, "file_modified", path, file, "detected", app));
		}
	}

	for (const [path, entry] of Object.entries(knownFiles)) {
		if (!entry.deleted && !currentPaths.has(path)) {
			record(await appendFileDeleted(ref, path, "detected", app));
		}
	}

	// Subspace drift is resolved against the *filesystem*, not against the folded log, and the
	// guarded append decides on its own whether each name is news. Both directions have to be
	// walked from current truth: a subspace deleted outside Obsidian leaves no event behind at
	// all, which is precisely how three folder deletions in a real vault produced exactly one
	// recorded removal.
	const currentSubNames = new Set((await immediateSubspaces(ref, app)).map((s) => s.folder.name));
	for (const name of currentSubNames) {
		record(await appendSubspaceEvent(ref, "subspace_created", name, "detected", app));
	}
	for (const name of foldLogToLastKnownSubspaceNames(log)) {
		if (!currentSubNames.has(name)) {
			record(await appendSubspaceEvent(ref, "subspace_removed", name, "detected", app));
		}
	}

	if (emitted.length > 0) {
		await regenerateContext(ref, app);
	}
	return emitted;
}

function foldLogToLastKnownSubspaceNames(log: Spin[]): Set<string> {
	const names = new Set<string>();
	for (const spin of log) {
		if (spin.spin_type === "subspace_created" && spin.payload.subspace_name) {
			names.add(spin.payload.subspace_name);
		} else if (spin.spin_type === "subspace_removed" && spin.payload.subspace_name) {
			names.delete(spin.payload.subspace_name);
		}
	}
	return names;
}

/**
 * Scaffolds any folder that sits inside a claimed space but was never claimed itself, depth-first
 * from each enabled space downward.
 *
 * Closes the one hole neither live capture nor reconciliation covered: `create` events only fire
 * while Obsidian is running, so a folder made any other way (`mkdir`, a sync client, an archive
 * unpacked into the vault, or the MCP server authoring structure headlessly) stayed unclaimed
 * forever — and an unclaimed folder is invisible to *both* passes. It isn't a subspace, so no
 * parent records it; it isn't a space, so nothing walks into it. Every file beneath it was
 * unrecorded permanently, with nothing anywhere indicating something was missing.
 *
 * Only descends into folders already under a claimed space. A bare top-level folder is never
 * auto-claimed: the vault root isn't a space, so promoting its children to user-spaces is a
 * decision about someone's world, not a caught-up observation.
 */
async function claimUnclaimedFolders(ref: SpaceRef, app: App, claimed: SpaceRef[]): Promise<void> {
	for (const folder of immediateSubfolders(ref)) {
		const wasSpace = await isSpace(folder, app);
		const childRef = buildSpaceRef(folder);
		if (!wasSpace) {
			await ensureSpaceInitialized(childRef, app);
			await regenerateContext(childRef, app);
			claimed.push(childRef);
		}
		await claimUnclaimedFolders(childRef, app, claimed);
	}
}

/**
 * Walks every claimed space in the vault and reconciles each enabled one. Runs on vault open, on
 * a timer, and when the window regains focus (see main.ts) — "once at startup" left every edit
 * made during a long session with Obsidian in the background unrecorded until the next restart.
 *
 * Claiming runs as a full pass before reconciliation, not interleaved with it, so a folder claimed
 * during this run is reconciled in the same run rather than waiting for the next one.
 */
export async function reconcileVault(app: App, settings: AethersWebSettings): Promise<Map<string, Spin[]>> {
	const results = new Map<string, Spin[]>();

	if (settings.autoClaimFolders) {
		const roots: SpaceRef[] = [];
		for await (const ref of walkSpaces(app)) {
			if (isSpaceEnabled(ref, settings)) roots.push(ref);
		}
		const newlyClaimed: SpaceRef[] = [];
		for (const ref of roots) {
			await claimUnclaimedFolders(ref, app, newlyClaimed);
		}
		if (newlyClaimed.length > 0) {
			console.info(`[AethersWeb] claimed ${newlyClaimed.length} previously unmanaged folder(s)`);
		}
	}

	for await (const ref of walkSpaces(app)) {
		if (!isSpaceEnabled(ref, settings)) continue;
		const emitted = await reconcileSpace(ref, app);
		if (emitted.length > 0) results.set(ref.path, emitted);
	}
	return results;
}
