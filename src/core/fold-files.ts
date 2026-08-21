import type { Spin } from "./types";

export interface FileState {
	hash: string;
	deleted: boolean;
}

/** Replays a space's own log into "what was last recorded per path", honoring create/modify/delete/rename. */
export function foldLogToLastKnownFiles(log: Spin[]): Record<string, FileState> {
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

/** Replays a space's own log into the current set of live subspace names (created minus removed). */
export function foldLogToLastKnownSubspaces(log: Spin[]): Set<string> {
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
