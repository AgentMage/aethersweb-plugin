import { App, normalizePath, TFile, TFolder } from "obsidian";
import { AETHER_DIR, BINARY_EXTENSIONS, HEAD_FILE, INDEX_FILE, LOG_FILE } from "./core/constants";
import { sha256Hex, sha256HexBytes } from "./core/hash";
import { isIgnoredPath, parentPathOf } from "./core/ignore";
import type { SpaceRef } from "./types";

export function buildSpaceRef(folder: TFolder): SpaceRef {
	const aetherDir = normalizePath(`${folder.path}/${AETHER_DIR}`);
	return {
		folder,
		path: folder.path,
		aetherDir,
		logPath: normalizePath(`${aetherDir}/${LOG_FILE}`),
		headPath: normalizePath(`${aetherDir}/${HEAD_FILE}`),
		indexPath: normalizePath(`${aetherDir}/${INDEX_FILE}`),
		contextPath: normalizePath(`${folder.path}/${folder.name}.md`),
	};
}

/**
 * A folder is a space iff it has been claimed by AethersWeb (its .aether/log.jsonl exists).
 * Per spec "every folder is a space" describes the containment model; a folder only becomes
 * a *managed* space once scaffolded. The vault root is never a space (see space.ts callers —
 * walkSpaces starts there but never yields it: it has no .aether/ and never gets one).
 */
export async function isSpace(folder: TFolder, app: App): Promise<boolean> {
	const logPath = normalizePath(`${folder.path}/${AETHER_DIR}/${LOG_FILE}`);
	return app.vault.adapter.exists(logPath);
}

async function* walkFolder(folder: TFolder, app: App): AsyncGenerator<SpaceRef> {
	for (const child of folder.children) {
		if (!(child instanceof TFolder) || isIgnoredPath(child.path)) continue;
		if (await isSpace(child, app)) {
			yield buildSpaceRef(child);
		}
		yield* walkFolder(child, app);
	}
}

/** Walks every folder in the vault, yielding a SpaceRef wherever isSpace() is true. */
export function walkSpaces(app: App): AsyncGenerator<SpaceRef> {
	return walkFolder(app.vault.getRoot(), app);
}

/**
 * Direct file children of a space, excluding anything ignorable.
 *
 * The folder note is deliberately *included*. It used to be excluded as a derived artifact, but
 * now that the machine index lives in `.aether/index.md` the folder note is an ordinary note a
 * person writes in — so leaving it out would mean reconciliation never notices their own edits to
 * it (made with Obsidian closed, or arriving via a sync client), which is exactly how a log and
 * its filesystem drift apart.
 */
export function immediateFiles(ref: SpaceRef): TFile[] {
	return ref.folder.children.filter((c): c is TFile => c instanceof TFile && !isIgnoredPath(c.path));
}

/**
 * Direct subfolders of a space, claimed or not. Distinct from `immediateSubspaces` below: per
 * spec, every folder *is* a space, but only a scaffolded one is a *managed* space — so this is
 * what reconciliation walks when deciding which folders still need claiming.
 */
export function immediateSubfolders(ref: SpaceRef): TFolder[] {
	return ref.folder.children.filter(
		(c): c is TFolder => c instanceof TFolder && !isIgnoredPath(c.path),
	);
}

/** Direct subfolders of a space that are themselves claimed spaces. */
export async function immediateSubspaces(ref: SpaceRef, app: App): Promise<SpaceRef[]> {
	const subfolders = immediateSubfolders(ref);
	const results: SpaceRef[] = [];
	for (const sub of subfolders) {
		if (await isSpace(sub, app)) results.push(buildSpaceRef(sub));
	}
	return results;
}

/** Vault-relative path of a file relative to the space that (directly) contains it. */
export function relativePath(ref: SpaceRef, file: TFile): string {
	return file.path.slice(ref.folder.path.length + 1);
}

/**
 * Walks up from a starting folder (inclusive) to find the nearest ancestor that is a claimed
 * space. Returns null if none is found before the vault root (root's `.parent` is null, so
 * the walk terminates naturally without special-casing root).
 */
export async function findOwningSpace(startFolder: TFolder | null, app: App): Promise<SpaceRef | null> {
	let folder = startFolder;
	while (folder) {
		if (await isSpace(folder, app)) return buildSpaceRef(folder);
		folder = folder.parent;
	}
	return null;
}

/**
 * The same upward walk as `findOwningSpace`, but driven by a path string rather than by a live
 * `TFolder.parent` link — and this is the load-bearing difference, not a convenience.
 *
 * Obsidian detaches a `TAbstractFile` from its parent before firing the `delete` event, so
 * `file.parent` is null exactly when a delete handler needs it most. That single fact meant the
 * folder branch of this plugin's delete handler had never once fired successfully: across an
 * entire real vault, every `observed` `subspace_removed` came from the *rename* handler, and the
 * only delete-sourced one was a `detected` spin written by reconciliation hours later. Three
 * folders deleted, one recorded.
 *
 * Resolving from the path is immune to that, because a deleted entry's *ancestors* are still in
 * the index — it's only the entry itself that's gone. `startPath` is expected to be a folder path;
 * pass `parentPathOfPath(file.path)` for a file. An empty string means the vault root, which is
 * never a space, so the walk terminates there and returns null.
 */
export async function findOwningSpaceByPath(startPath: string, app: App): Promise<SpaceRef | null> {
	let path = startPath;
	for (;;) {
		if (path === "") return null;
		const folder = app.vault.getAbstractFileByPath(path);
		if (folder instanceof TFolder && (await isSpace(folder, app))) {
			return buildSpaceRef(folder);
		}
		path = parentPathOf(path);
	}
}

/** Owning space of the *container* of a vault path — the space a file at `path` belongs to. */
export function findOwningSpaceOfPath(path: string, app: App): Promise<SpaceRef | null> {
	return findOwningSpaceByPath(parentPathOf(path), app);
}

/**
 * Like `findOwningSpaceByPath`, but refuses to walk upward past a container that no longer
 * exists. For the *departed* side of an event — where a file was deleted from, where a rename
 * moved it out of — this distinction decides correctness, not robustness:
 *
 * - The container still exists (a note deleted out of a live space, possibly nested in a plain
 *   unclaimed folder): walking up finds the space that recorded the file, which is exactly the
 *   log the removal belongs in.
 * - The container is gone too (a whole folder deleted, or an ancestor moved away): its log was
 *   deleted or travelled with it, so there is nothing to append to. Walking up here would write
 *   the removal into a *grandparent's* log, inventing a containment relationship that never
 *   existed — an ancestor's log claiming direct children it never had.
 */
export async function findExistingOwningSpaceByPath(startPath: string, app: App): Promise<SpaceRef | null> {
	if (startPath === "") return null;
	if (!(app.vault.getAbstractFileByPath(startPath) instanceof TFolder)) return null;
	return findOwningSpaceByPath(startPath, app);
}

/** Content hash of a file — binary files via raw bytes, text via cachedRead. Never stores content. */
export async function hashFile(file: TFile, app: App): Promise<string> {
	if (BINARY_EXTENSIONS.has(file.extension.toLowerCase())) {
		const bytes = await app.vault.readBinary(file);
		return sha256HexBytes(bytes);
	}
	const text = await app.vault.cachedRead(file);
	return sha256Hex(text);
}
