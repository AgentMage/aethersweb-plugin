import { readdir, readFile, stat } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { sha256Hex, sha256HexBytes } from "../../src/core/hash";
import { AETHER_DIR, BINARY_EXTENSIONS, HEAD_FILE, LOG_FILE } from "../../src/core/constants";
import { isIgnoredPath } from "../../src/core/ignore";

/**
 * Node-`fs` mirror of src/space.ts's `SpaceRef`, addressed the same way (vault-relative path,
 * `/`-joined regardless of OS — matches Obsidian's own `normalizePath`). `absPath` is the only
 * field with no plugin-side equivalent, since the plugin never needs a real filesystem path.
 */
export interface SpaceRefFs {
	/** Vault-relative path, e.g. "UserSpace/Location". Never empty — the vault root is never a space. */
	path: string;
	absPath: string;
	aetherDir: string;
	logPath: string;
	headPath: string;
	/** <absPath>/<folder name>.md — the folder-note convention context note. */
	contextPath: string;
}

function folderName(vaultRelativePath: string): string {
	const parts = vaultRelativePath.split("/");
	return parts[parts.length - 1];
}

export function buildSpaceRefFs(vaultRoot: string, vaultRelativePath: string): SpaceRefFs {
	const absPath = join(vaultRoot, vaultRelativePath);
	const aetherDir = join(absPath, AETHER_DIR);
	return {
		path: vaultRelativePath,
		absPath,
		aetherDir,
		logPath: join(aetherDir, LOG_FILE),
		headPath: join(aetherDir, HEAD_FILE),
		contextPath: join(absPath, `${folderName(vaultRelativePath)}.md`),
	};
}

/**
 * The same rule the plugin applies, from the same module (`core/ignore.ts`) — applied here to both
 * folders and files, because raw `fs.readdir` has no equivalent to Obsidian's own index, which
 * never surfaces dotfiles/dotfolders in the first place. Sharing the implementation rather than
 * restating the rule is what keeps `walkSpacesFs` seeing the same tree the plugin does: an entry
 * one side records and the other ignores is precisely how a log and its filesystem drift apart.
 */
function isIgnoredName(name: string): boolean {
	return isIgnoredPath(name);
}

export async function isSpaceFs(vaultRoot: string, vaultRelativePath: string): Promise<boolean> {
	const logPath = join(vaultRoot, vaultRelativePath, AETHER_DIR, LOG_FILE);
	try {
		await stat(logPath);
		return true;
	} catch {
		return false;
	}
}

async function* walkFolderFs(vaultRoot: string, vaultRelativePath: string): AsyncGenerator<SpaceRefFs> {
	const absPath = join(vaultRoot, vaultRelativePath);
	const entries = await readdir(absPath, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory() || isIgnoredName(entry.name)) continue;
		const childRelPath = vaultRelativePath ? posix.join(vaultRelativePath, entry.name) : entry.name;
		if (await isSpaceFs(vaultRoot, childRelPath)) {
			yield buildSpaceRefFs(vaultRoot, childRelPath);
		}
		yield* walkFolderFs(vaultRoot, childRelPath);
	}
}

/** Walks every folder under the vault root, yielding a SpaceRefFs wherever isSpaceFs() is true. */
export function walkSpacesFs(vaultRoot: string): AsyncGenerator<SpaceRefFs> {
	return walkFolderFs(vaultRoot, "");
}

/** Direct file children of a space (dotfiles excluded — see isIgnoredName), excluding its own context note. */
export async function immediateFilesFs(ref: SpaceRefFs): Promise<string[]> {
	const entries = await readdir(ref.absPath, { withFileTypes: true });
	const out: string[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || isIgnoredName(entry.name)) continue;
		const absFilePath = join(ref.absPath, entry.name);
		if (absFilePath === ref.contextPath) continue;
		out.push(absFilePath);
	}
	return out;
}

/** Direct subfolders of a space that are themselves claimed spaces. */
export async function immediateSubspacesFs(vaultRoot: string, ref: SpaceRefFs): Promise<SpaceRefFs[]> {
	const entries = await readdir(ref.absPath, { withFileTypes: true });
	const results: SpaceRefFs[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || isIgnoredName(entry.name)) continue;
		const childRelPath = posix.join(ref.path, entry.name);
		if (await isSpaceFs(vaultRoot, childRelPath)) {
			results.push(buildSpaceRefFs(vaultRoot, childRelPath));
		}
	}
	return results;
}

/** Vault-relative path of a file relative to the space that (directly) contains it. */
export function relativePathFs(ref: SpaceRefFs, absFilePath: string): string {
	return relative(ref.absPath, absFilePath).split(sep).join("/");
}

export interface TreeNode {
	name: string;
	path: string;
	type: "folder" | "file";
	/** Folders only: whether this folder is a claimed space (has .aether/log.jsonl). */
	is_space?: boolean;
	/** Files only. */
	size?: number;
	children?: TreeNode[];
}

export interface ListTreeResult {
	tree: TreeNode[];
	/** True when MAX_TREE_ENTRIES was hit and the walk stopped early. */
	truncated: boolean;
}

const MAX_TREE_ENTRIES = 2000;

/**
 * Raw filesystem shape rooted at `under`, no space semantics — unlike walkSpacesFs, which only
 * ever yields claimed spaces. Each folder is marked `is_space` so a caller can tell a claimed
 * space from a plain folder (one waiting on create_space, say) without a second call per entry.
 */
export async function listTreeFs(
	vaultRoot: string,
	under: string,
	options: { maxDepth?: number; includeIgnored?: boolean } = {},
): Promise<ListTreeResult> {
	const { maxDepth, includeIgnored = false } = options;
	let entryCount = 0;
	let truncated = false;

	async function walk(relPath: string, depth: number): Promise<TreeNode[]> {
		if (truncated) return [];
		const entries = await readdir(join(vaultRoot, relPath), { withFileTypes: true });
		entries.sort((a, b) => a.name.localeCompare(b.name));

		const out: TreeNode[] = [];
		for (const entry of entries) {
			if (!includeIgnored && isIgnoredName(entry.name)) continue;
			if (entryCount >= MAX_TREE_ENTRIES) {
				truncated = true;
				break;
			}
			entryCount++;

			const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				const node: TreeNode = {
					name: entry.name,
					path: childRel,
					type: "folder",
					is_space: await isSpaceFs(vaultRoot, childRel),
				};
				if (maxDepth === undefined || depth < maxDepth) {
					node.children = await walk(childRel, depth + 1);
				}
				out.push(node);
			} else if (entry.isFile()) {
				out.push({
					name: entry.name,
					path: childRel,
					type: "file",
					size: (await stat(join(vaultRoot, childRel))).size,
				});
			}
		}
		return out;
	}

	const tree = await walk(under, 1);
	return { tree, truncated };
}

function extensionOf(absFilePath: string): string {
	const base = absFilePath.split("/").pop() ?? absFilePath;
	const dotIdx = base.lastIndexOf(".");
	return dotIdx === -1 ? "" : base.slice(dotIdx + 1).toLowerCase();
}

/** Content hash of a file — binary files via raw bytes, text via utf8 read. Never stores content. Mirrors space.ts::hashFile. */
export async function hashFileFs(absFilePath: string): Promise<string> {
	if (BINARY_EXTENSIONS.has(extensionOf(absFilePath))) {
		const buf = await readFile(absFilePath);
		// sha256HexBytes wants an ArrayBuffer; a Node Buffer is a Uint8Array *view*, possibly over
		// a larger pooled backing buffer, so byteOffset/byteLength must be respected here.
		const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
		return sha256HexBytes(arrayBuffer);
	}
	const text = await readFile(absFilePath, "utf8");
	return sha256Hex(text);
}
