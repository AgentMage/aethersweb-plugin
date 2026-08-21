import { IGNORED_EXACT_NAMES, IGNORED_NAME_PATTERNS } from "./constants";

/**
 * The single decision point for "is this path something a space's log should ever mention?".
 * Shared by the plugin's live event handlers, its reconciliation pass, and the MCP server's
 * filesystem walk — an entry ignored by one and recorded by the other is exactly how a space's
 * log and the filesystem drift apart, so there is deliberately only one implementation.
 *
 * Three rules, in order:
 *
 * 1. Any path segment starting with `.` is invisible. This covers `.obsidian/`, `.aether/`,
 *    `.trash/`, `.git/`, and — the reason this generalized from a two-name allowlist — the
 *    sync sidecars a real vault accumulates: Syncthing's `.stfolder`/`.stversions`, and
 *    `.DS_Store`. Obsidian itself never surfaces dotted paths as notes, so nothing is lost.
 * 2. Exact filenames that are never user content (`Thumbs.db`, `desktop.ini`).
 * 3. Transient write artifacts that briefly exist under a *visible* name and would otherwise be
 *    recorded as real files before vanishing. Obsidian's own atomic-save temp files are the
 *    observed case: `yippee.md.tmp.124602.55cd6cc624c2` was logged as a genuine file_created,
 *    then reconciled away as a delete — two spins of pure noise in a space's permanent history
 *    for a file that never conceptually existed.
 */
export function isIgnoredPath(path: string): boolean {
	const segments = path.split("/").filter((s) => s.length > 0);
	if (segments.length === 0) return false;

	for (const segment of segments) {
		if (segment.startsWith(".")) return true;
	}

	const name = segments[segments.length - 1];
	if (IGNORED_EXACT_NAMES.has(name)) return true;
	return IGNORED_NAME_PATTERNS.some((re) => re.test(name));
}

/** Vault-relative parent path of a path, or "" for a top-level entry (the vault root itself). */
export function parentPathOf(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? "" : path.slice(0, idx);
}

/** Final path segment (a file or folder's own name). */
export function baseNameOf(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? path : path.slice(idx + 1);
}

/** True when `path` is `ancestor` itself, or lies anywhere beneath it. */
export function isUnderOrEqual(path: string, ancestor: string): boolean {
	return path === ancestor || path.startsWith(`${ancestor}/`);
}

/**
 * Rewrites a path that lived under `fromRoot` to the equivalent path under `toRoot`. Used to
 * recognize the descendant "echo" events Obsidian fires after a folder move — see events.ts's
 * rename handler.
 */
export function reparent(path: string, fromRoot: string, toRoot: string): string | null {
	if (!isUnderOrEqual(path, fromRoot)) return null;
	return toRoot + path.slice(fromRoot.length);
}
