import { App, normalizePath, TFile, TFolder } from "obsidian";
import { AETHER_DIR, BINARY_EXTENSIONS, HEAD_FILE, IGNORED_TOP_LEVEL_SEGMENTS, LOG_FILE } from "./constants";
import { sha256Hex, sha256HexBytes } from "./hash";
import type { SpaceRef } from "./types";

function isIgnoredFolderName(name: string): boolean {
	return IGNORED_TOP_LEVEL_SEGMENTS.includes(name) || name.startsWith(".");
}

export function buildSpaceRef(folder: TFolder): SpaceRef {
	const aetherDir = normalizePath(`${folder.path}/${AETHER_DIR}`);
	return {
		folder,
		path: folder.path,
		aetherDir,
		logPath: normalizePath(`${aetherDir}/${LOG_FILE}`),
		headPath: normalizePath(`${aetherDir}/${HEAD_FILE}`),
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
		if (!(child instanceof TFolder) || isIgnoredFolderName(child.name)) continue;
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

/** Direct file children of a space, excluding its own context note. */
export function immediateFiles(ref: SpaceRef): TFile[] {
	return ref.folder.children.filter(
		(c): c is TFile => c instanceof TFile && c.path !== ref.contextPath,
	);
}

/** Direct subfolders of a space that are themselves claimed spaces. */
export async function immediateSubspaces(ref: SpaceRef, app: App): Promise<SpaceRef[]> {
	const subfolders = ref.folder.children.filter(
		(c): c is TFolder => c instanceof TFolder && !isIgnoredFolderName(c.name),
	);
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

/** Content hash of a file — binary files via raw bytes, text via cachedRead. Never stores content. */
export async function hashFile(file: TFile, app: App): Promise<string> {
	if (BINARY_EXTENSIONS.has(file.extension.toLowerCase())) {
		const bytes = await app.vault.readBinary(file);
		return sha256HexBytes(bytes);
	}
	const text = await app.vault.cachedRead(file);
	return sha256Hex(text);
}
