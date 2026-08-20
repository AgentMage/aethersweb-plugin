import type { App } from "obsidian";
import { regenerateContext } from "./context";
import { appendSpin, readLog } from "./log";
import { isSpaceEnabled } from "./settings";
import { hashFile, immediateFiles, immediateSubspaces, relativePath, walkSpaces } from "./space";
import type { AethersWebSettings, SpaceRef, Spin } from "./types";

interface FileState {
	hash: string;
	deleted: boolean;
}

/** Replays a space's own log into "what was last recorded per path", honoring create/modify/delete/rename. */
function foldLogToLastKnownFiles(log: Spin[]): Record<string, FileState> {
	const state: Record<string, FileState> = {};
	for (const spin of log) {
		switch (spin.spin_type) {
			case "file_created":
			case "file_modified":
				if (spin.payload.path && spin.payload.content_hash) {
					state[spin.payload.path] = { hash: spin.payload.content_hash, deleted: false };
				}
				break;
			case "file_deleted":
				if (spin.payload.path && state[spin.payload.path]) {
					state[spin.payload.path].deleted = true;
				}
				break;
			case "file_renamed":
				if (spin.payload.old_path && spin.payload.path) {
					const prior = state[spin.payload.old_path];
					delete state[spin.payload.old_path];
					state[spin.payload.path] = prior ?? { hash: spin.payload.content_hash ?? "", deleted: false };
				}
				break;
			default:
				break; // space_created / subspace_* / checkpoint don't affect file state
		}
	}
	return state;
}

function foldLogToLastKnownSubspaces(log: Spin[]): Set<string> {
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
 * Diffs current on-disk state against what a space's own log last recorded, appending
 * `detected` spins for anything that drifted while no live plugin instance was watching (e.g.
 * an out-of-band vim edit). Deliberately does NOT attempt heuristic rename detection — a
 * vanish+appear pair reconciles honestly as delete+create. True renames are only ever
 * `observed`, via Obsidian's own rename event (see events.ts).
 */
export async function reconcileSpace(ref: SpaceRef, app: App): Promise<Spin[]> {
	const log = await readLog(ref, app);
	const knownFiles = foldLogToLastKnownFiles(log);
	const knownSubspaceNames = foldLogToLastKnownSubspaces(log);

	const emitted: Spin[] = [];
	const currentPaths = new Set<string>();

	for (const file of immediateFiles(ref)) {
		const path = relativePath(ref, file);
		currentPaths.add(path);
		const currentHash = await hashFile(file, app);
		const prior = knownFiles[path];

		if (!prior || prior.deleted) {
			emitted.push(
				await appendSpin(
					ref,
					"file_created",
					"detected",
					{ path, content_hash: currentHash, size: file.stat.size },
					app,
				),
			);
		} else if (prior.hash !== currentHash) {
			emitted.push(
				await appendSpin(
					ref,
					"file_modified",
					"detected",
					{ path, content_hash: currentHash, size: file.stat.size },
					app,
				),
			);
		}
	}

	for (const [path, entry] of Object.entries(knownFiles)) {
		if (!entry.deleted && !currentPaths.has(path)) {
			emitted.push(await appendSpin(ref, "file_deleted", "detected", { path }, app));
		}
	}

	const currentSubspaces = await immediateSubspaces(ref, app);
	const currentSubNames = new Set(currentSubspaces.map((s) => s.folder.name));

	for (const name of currentSubNames) {
		if (!knownSubspaceNames.has(name)) {
			emitted.push(await appendSpin(ref, "subspace_created", "detected", { subspace_name: name }, app));
		}
	}
	for (const name of knownSubspaceNames) {
		if (!currentSubNames.has(name)) {
			emitted.push(await appendSpin(ref, "subspace_removed", "detected", { subspace_name: name }, app));
		}
	}

	if (emitted.length > 0) {
		await regenerateContext(ref, app);
	}
	return emitted;
}

/** Walks every claimed space in the vault and reconciles each enabled one. Run once on vault open. */
export async function reconcileVault(app: App, settings: AethersWebSettings): Promise<Map<string, Spin[]>> {
	const results = new Map<string, Spin[]>();
	for await (const ref of walkSpaces(app)) {
		if (!isSpaceEnabled(ref, settings)) continue;
		const emitted = await reconcileSpace(ref, app);
		if (emitted.length > 0) results.set(ref.path, emitted);
	}
	return results;
}
