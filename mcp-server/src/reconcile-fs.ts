import { foldLogToLastKnownFiles, foldLogToLastKnownSubspaces } from "../../src/core/fold-files";
import type { Spin } from "../../src/core/types";
import { regenerateContextFs } from "./context-fs";
import {
	buildSpaceRefFs,
	immediateFilesFs,
	immediateSubspacesFs,
	isSpaceFs,
	relativePathFs,
	hashFileFs,
} from "./space-fs";
import type { SpaceRefFs } from "./space-fs";
import { appendFileDeletedFs, appendSubspaceEventFs, readLogFs } from "./vault-io";
import { recordWrittenFile } from "./write-fs";

/**
 * The server's own catch-up pass, mirroring the plugin's `reconcile.ts`.
 *
 * Reconciliation used to exist only inside Obsidian, which was fine while Obsidian was the only
 * thing that ever touched the vault. It stopped being fine the moment this server became a real
 * writer: in the headless case there is no plugin to open the vault later and notice, so a file
 * edited over SSH, landed by a sync client, or written by any tool other than these ones simply
 * never entered the record. Not "recorded late" — never.
 *
 * Everything it emits is `detected`, and that label is the whole point. These changes were
 * inferred after the fact by comparing the filesystem against the log; nothing witnessed them
 * happen. Collapsing that distinction into `observed` would make the log claim an eyewitness it
 * never had.
 *
 * Renames are deliberately not inferred. A file vanishing from one path while another appears
 * elsewhere with the same bytes is *consistent* with a rename and equally consistent with a copy
 * and a delete; guessing would fabricate continuity the evidence doesn't support. It reconciles
 * honestly as a delete plus a create.
 */
export async function reconcileSpaceFs(vaultRoot: string, ref: SpaceRefFs): Promise<Spin[]> {
	const log = await readLogFs(ref);
	const knownFiles = foldLogToLastKnownFiles(log);
	const emitted: Spin[] = [];
	const record = (spin: Spin | null): void => {
		if (spin) emitted.push(spin);
	};

	const currentPaths = new Set<string>();
	for (const absFilePath of await immediateFilesFs(ref)) {
		const relPath = relativePathFs(ref, absFilePath);
		if (absFilePath === ref.contextPath) continue;
		currentPaths.add(relPath);
		const prior = knownFiles[relPath];
		const currentHash = await hashFileFs(absFilePath);
		if (!prior || prior.deleted) {
			record(await recordWrittenFile(ref, relPath, absFilePath, "file_created", "detected"));
		} else if (prior.hash !== currentHash) {
			record(await recordWrittenFile(ref, relPath, absFilePath, "file_modified", "detected"));
		}
	}

	for (const [path, entry] of Object.entries(knownFiles)) {
		if (!entry.deleted && !currentPaths.has(path)) {
			record(await appendFileDeletedFs(ref, path, "detected"));
		}
	}

	const currentSubNames = new Set(
		(await immediateSubspacesFs(vaultRoot, ref)).map((s) => s.path.split("/").pop() ?? s.path),
	);
	for (const name of currentSubNames) {
		record(await appendSubspaceEventFs(ref, "subspace_created", name, "detected"));
	}
	for (const name of foldLogToLastKnownSubspaces(log)) {
		if (!currentSubNames.has(name)) {
			record(await appendSubspaceEventFs(ref, "subspace_removed", name, "detected"));
		}
	}

	if (emitted.length > 0) await regenerateContextFs(vaultRoot, ref);
	return emitted;
}

/**
 * Reconciles a space and, optionally, everything beneath it. Depth-first so a subspace's log is
 * current before its parent records that subspace's tip.
 */
export async function reconcileSubtreeFs(
	vaultRoot: string,
	ref: SpaceRefFs,
	recursive: boolean,
): Promise<Map<string, Spin[]>> {
	const results = new Map<string, Spin[]>();
	if (recursive) {
		for (const sub of await immediateSubspacesFs(vaultRoot, ref)) {
			for (const [path, spins] of await reconcileSubtreeFs(vaultRoot, sub, true)) {
				results.set(path, spins);
			}
		}
	}
	const emitted = await reconcileSpaceFs(vaultRoot, ref);
	if (emitted.length > 0) results.set(ref.path, emitted);
	return results;
}

export { buildSpaceRefFs, isSpaceFs };
