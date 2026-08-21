import { applyPatch, createPatch } from "diff";

/**
 * Unified diff from `oldText` to `newText`. The filename passed to jsdiff is cosmetic (it only
 * appears in the patch header, which nothing in this codebase parses) — a fixed placeholder
 * keeps output deterministic regardless of path.
 */
export function computeDiff(oldText: string, newText: string): string {
	return createPatch("content", oldText, newText, undefined, undefined);
}

/**
 * Applies a unified diff produced by computeDiff to reconstruct the new content from the old.
 * Returns null (never throws) on a patch that doesn't cleanly apply — callers use this to
 * detect corruption/mismatch during verification, not to crash on it.
 */
export function applyDiff(oldText: string, patch: string): string | null {
	const result = applyPatch(oldText, patch);
	return result === false ? null : result;
}
