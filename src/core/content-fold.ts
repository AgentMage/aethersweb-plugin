import { applyDiff } from "./diff";
import type { Spin } from "./types";

export interface ContentState {
	/** Reconstructed content, or null when no baseline exists (pre-instrumentation history). */
	content: string | null;
	encoding: "utf8" | "base64";
	deleted: boolean;
}

/**
 * Replays a space's own log into "what content was last recorded per path", by applying each
 * file_created's full content and each file_modified's diff in order. Mirrors
 * reconcile.ts's foldLogToLastKnownFiles traversal exactly, but carries reconstructed content
 * forward instead of just a hash — this is what lets the log actually answer "what did this file
 * contain", not only "did this file change". A modify spin recorded before this feature shipped
 * (no `content`/`diff` field), or a diff with no known prior baseline to apply it to, yields
 * content: null rather than fabricating one — the trail goes cold there, not silently wrong.
 *
 * Kept in its own module (not reconcile.ts, not content-record.ts) since both of those depend on
 * it and it depends on neither, avoiding a circular import between them.
 */
export function foldLogToLastKnownContent(log: Spin[]): Record<string, ContentState> {
	const state: Record<string, ContentState> = {};
	for (const spin of log) {
		switch (spin.spin_type) {
			case "file_created":
				if (spin.payload.path) {
					state[spin.payload.path] = {
						content: spin.payload.content ?? null,
						encoding: spin.payload.encoding ?? "utf8",
						deleted: false,
					};
				}
				break;
			case "file_modified":
				if (spin.payload.path) {
					const prior = state[spin.payload.path];
					if (spin.payload.content !== undefined) {
						state[spin.payload.path] = {
							content: spin.payload.content,
							encoding: spin.payload.encoding ?? "utf8",
							deleted: false,
						};
					} else if (spin.payload.diff !== undefined && prior?.content != null) {
						state[spin.payload.path] = {
							content: applyDiff(prior.content, spin.payload.diff),
							encoding: spin.payload.encoding ?? "utf8",
							deleted: false,
						};
					} else {
						state[spin.payload.path] = { content: null, encoding: "utf8", deleted: false };
					}
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
					state[spin.payload.path] = prior ?? { content: null, encoding: "utf8", deleted: false };
				}
				break;
			default:
				break; // space_created / subspace_* / checkpoint / chain_repaired don't affect file content
		}
	}
	return state;
}
