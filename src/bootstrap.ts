import { App, normalizePath, TFolder } from "obsidian";
import { regenerateContext } from "./context";
import { appendSpin, ensureSpaceInitialized } from "./log";
import { buildSpaceRef, isSpace } from "./space";
import type { SpaceRef } from "./types";

/**
 * Creates a new space at parentPath/name and fully initializes it: folder, .aether/log.jsonl +
 * head (seq-0 space_created spin), and its context note. If parentPath is a folder that is
 * itself a claimed space, the parent's log gets a subspace_created spin (name only, never a
 * hash) and its context is regenerated to pick up the child's tip. If parentPath is empty
 * (vault root) or not itself a space, no parent log is touched — the vault root is never a
 * space per spec dogma, so creating the first user-space only performs steps 1–3.
 *
 * This is the single scaffolding path for both the first user-space and every later subspace —
 * no divergent logic between them.
 */
export async function scaffoldSpace(parentPath: string, name: string, app: App): Promise<SpaceRef> {
	const spacePath = normalizePath(parentPath ? `${parentPath}/${name}` : name);

	if (!(await app.vault.adapter.exists(spacePath))) {
		await app.vault.createFolder(spacePath);
	}

	const folder = app.vault.getAbstractFileByPath(spacePath);
	if (!(folder instanceof TFolder)) {
		throw new Error(`[AethersWeb] failed to create space folder at ${spacePath}`);
	}

	const ref = buildSpaceRef(folder);
	await ensureSpaceInitialized(ref, app);
	await regenerateContext(ref, app);

	if (parentPath) {
		const parentFolder = app.vault.getAbstractFileByPath(parentPath);
		if (parentFolder instanceof TFolder && (await isSpace(parentFolder, app))) {
			const parentRef = buildSpaceRef(parentFolder);
			await appendSpin(parentRef, "subspace_created", "observed", { subspace_name: name }, app);
			await regenerateContext(parentRef, app);
		}
	}

	return ref;
}
