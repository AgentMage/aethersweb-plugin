import { App, normalizePath, TFolder } from "obsidian";
import { regenerateContext } from "./context";
import { appendSubspaceEvent, ensureSpaceInitialized } from "./log";
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
 * Both writes here are idempotent against the vault `create` event `createFolder` fires under
 * them. They did not used to be, which is why every space this plugin ever scaffolded was born
 * carrying `space_created` at both seq 0 and seq 1, and announced to its parent twice.
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
			// Guarded, because `vault.createFolder` above fires a `create` event whose handler
			// records this same arrival. Whichever runs second finds the parent already knows.
			await appendSubspaceEvent(parentRef, "subspace_created", name, "observed", app);
			await regenerateContext(parentRef, app);
		}
	}

	return ref;
}
