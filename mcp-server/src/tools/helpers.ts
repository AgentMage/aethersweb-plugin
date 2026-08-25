import type { SpaceRefFs } from "../space-fs";

/**
 * Every tool answers in the same two shapes, so a client never has to guess which it got.
 *
 * `compact` drops the indentation, and exists for the responses whose whole purpose is to be small
 * — a summary that spends 15% of itself on whitespace is not a summary. Everything else stays
 * pretty-printed, because a transcript a person may read is worth the bytes.
 */
export function ok(value: unknown, compact = false) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, compact ? undefined : 2) }] };
}

export function fail(message: string) {
	return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function notASpace(space_path: string) {
	return fail(`"${space_path}" is not a claimed space (no .aether/log.jsonl found).`);
}

export function isUnderOrEqual(ref: SpaceRefFs, under: string): boolean {
	return ref.path === under || ref.path.startsWith(`${under}/`);
}

export const SPACE_PATH_DESC = 'Vault-relative path of the space, e.g. "UserSpace/Location".';
