import type { SpaceRefFs } from "../space-fs";

/** Every tool answers in the same two shapes, so a client never has to guess which it got. */
export function ok(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
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
