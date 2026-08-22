import { normalizePath, TFile, TFolder } from "obsidian";
import { baseNameOf, isIgnoredPath, parentPathOf } from "./core/ignore";
import { RenameEchoTracker } from "./core/rename-echo";
import { regenerateContext } from "./context";
import { recordFileContentSpin } from "./content-record";
import { appendFileDeleted, appendSpin, appendSubspaceEvent, ensureSpaceInitialized } from "./log";
import { isSpaceEnabled } from "./settings";
import {
	buildSpaceRef,
	findExistingOwningSpaceByPath,
	findOwningSpaceByPath,
	isSpace,
	relativePath,
} from "./space";
import type AethersWebPlugin from "./main";
import type { SpaceRef } from "./types";

/** Per (space, relative-path) debounce: coalesces rapid successive modify events into one spin. */
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelPendingModify(key: string): void {
	const existing = pendingTimers.get(key);
	if (existing) {
		clearTimeout(existing);
		pendingTimers.delete(key);
	}
}

/**
 * Drops every in-flight debounce timer. Called on unload: a timer that fires after the plugin is
 * torn down would write through a stale `app` reference, and the edit it was holding is caught by
 * the next reconciliation as a `detected` spin anyway — which is the honest label for it, since no
 * live instance was watching by the time it landed.
 */
export function cancelPendingModifies(): void {
	for (const timer of pendingTimers.values()) clearTimeout(timer);
	pendingTimers.clear();
}

function scheduleObservedModify(plugin: AethersWebPlugin, ref: SpaceRef, file: TFile): void {
	const key = `${ref.path}::${relativePath(ref, file)}`;
	cancelPendingModify(key);

	const timer = setTimeout(async () => {
		pendingTimers.delete(key);
		try {
			const current = plugin.app.vault.getAbstractFileByPath(file.path);
			if (!(current instanceof TFile)) return; // deleted/moved before the timer fired
			const spin = await recordFileContentSpin(ref, "file_modified", relativePath(ref, current), current, "observed", plugin.app);
			if (spin) await regenerateContext(ref, plugin.app);
		} catch (err) {
			console.error("[AethersWeb] failed to record observed file_modified", err);
		}
	}, plugin.settings.debounceMs);
	pendingTimers.set(key, timer);
}

/**
 * Tracks folder moves so the descendant `rename` events Obsidian fires alongside them can be
 * recognized and dropped — see core/rename-echo.ts for why they are damaging, not merely noisy.
 */
const renameEchoes = new RenameEchoTracker();

/**
 * Registers live vault event listeners that translate Obsidian events into `observed` spins.
 * Must be called only AFTER the initial reconciliation pass completes, so reconciliation's own
 * writes are never double-counted as observed (see main.ts's onload sequencing).
 *
 * Every handler resolves the space it writes to from a *path string*, never from `file.parent`.
 * Obsidian detaches a file from its parent before firing `delete`, so `parent` is null exactly
 * where a delete handler needs it — see space.ts::findOwningSpaceByPath for what that cost.
 */
export function registerVaultEventHandlers(plugin: AethersWebPlugin): void {
	const { app } = plugin;
	const enabled = (ref: SpaceRef | null): ref is SpaceRef => ref !== null && isSpaceEnabled(ref, plugin.settings);

	plugin.registerEvent(
		app.vault.on("create", async (file) => {
			if (isIgnoredPath(file.path)) return;

			if (file instanceof TFolder) {
				// Any folder created (or dropped in) directly inside an existing claimed space
				// becomes a space itself immediately. ensureSpaceInitialized is idempotent: a folder
				// that arrives with its own pre-existing .aether/ (moved in from outside the vault —
				// restored from a backup, or copied from another vault, per the spec's portability
				// model) just gets its head repaired, never re-initialized or stomped.
				// Note: a bulk external drag-in of a whole folder *tree* can race a sibling file's
				// create event against this folder's still-in-flight scaffold; anything missed live
				// is caught by the next reconciliation pass as `detected` spins.
				const parentRef = await findOwningSpaceByPath(parentPathOf(file.path), app);
				if (!enabled(parentRef)) return;

				const ref = buildSpaceRef(file);
				await ensureSpaceInitialized(ref, app);
				await regenerateContext(ref, app);

				await appendSubspaceEvent(parentRef, "subspace_created", file.name, "observed", app);
				await regenerateContext(parentRef, app);
				return;
			}

			if (!(file instanceof TFile)) return;
			const ref = await findOwningSpaceByPath(parentPathOf(file.path), app);
			if (!enabled(ref)) return;
			const spin = await recordFileContentSpin(ref, "file_created", relativePath(ref, file), file, "observed", app);
			if (spin) await regenerateContext(ref, app);
		}),
	);

	plugin.registerEvent(
		app.vault.on("modify", async (file) => {
			if (isIgnoredPath(file.path) || !(file instanceof TFile)) return;
			const ref = await findOwningSpaceByPath(parentPathOf(file.path), app);
			if (!enabled(ref)) return;
			// The folder note is captured here like any other note. A statement write records itself
			// (context.ts::writeStatement); whichever of the two lands second finds the same content
			// hash already recorded and stands down — see core/guards.ts.
			scheduleObservedModify(plugin, ref, file);
		}),
	);

	plugin.registerEvent(
		app.vault.on("delete", async (file) => {
			if (isIgnoredPath(file.path)) return;

			if (file instanceof TFile) {
				const ref = await findExistingOwningSpaceByPath(parentPathOf(file.path), app);
				if (!enabled(ref)) return;
				const path = relativePath(ref, file);
				cancelPendingModify(`${ref.path}::${path}`);
				const spin = await appendFileDeleted(ref, path, "observed", app);
				if (spin) await regenerateContext(ref, app);
				return;
			}

			if (file instanceof TFolder) {
				// The deleted folder's own log (if it was a space) goes with it — nothing to record
				// there. If its parent survives and is a space, the parent sees a subspace_removed.
				const parentRef = await findExistingOwningSpaceByPath(parentPathOf(file.path), app);
				if (!enabled(parentRef)) return;
				const spin = await appendSubspaceEvent(parentRef, "subspace_removed", file.name, "observed", app);
				if (spin) await regenerateContext(parentRef, app);
			}
		}),
	);

	plugin.registerEvent(
		app.vault.on("rename", async (file, oldPath) => {
			if (isIgnoredPath(file.path) || isIgnoredPath(oldPath)) return;
			if (renameEchoes.isEcho(oldPath, file.path)) return;

			if (file instanceof TFolder) {
				await handleFolderRename(plugin, file, oldPath, enabled);
				return;
			}
			if (file instanceof TFile) {
				await handleFileRename(plugin, file, oldPath, enabled);
			}
		}),
	);
}

async function handleFolderRename(
	plugin: AethersWebPlugin,
	folder: TFolder,
	oldPath: string,
	enabled: (ref: SpaceRef | null) => ref is SpaceRef,
): Promise<void> {
	const { app } = plugin;
	renameEchoes.record(oldPath, folder.path);

	const oldName = baseNameOf(oldPath);
	const ref = buildSpaceRef(folder);
	const newParentRef = await findOwningSpaceByPath(parentPathOf(folder.path), app);
	const wasSpace = await isSpace(folder, app);

	if (!wasSpace) {
		// A plain, never-claimed folder. Dragged into a space it becomes one — the same rule the
		// `create` handler applies, reached by the other route a folder can enter a space. Dragged
		// anywhere else it stays outside the model entirely and nothing is recorded.
		if (!enabled(newParentRef)) return;
		await ensureSpaceInitialized(ref, app);
		await regenerateContext(ref, app);
	} else if (oldName !== folder.name) {
		// Obsidian never renames a folder's children when the folder itself is renamed — the
		// context note stays on disk under its old filename. Left alone, that orphan looks like
		// ordinary new content to reconciliation (or to a fresh regenerateContext call finding no
		// file at the new expected path), which spuriously advances this space's own chain just to
		// create a replacement note under the new name. Rename it in place instead, and refresh its
		// frontmatter (space_path) to match — neither step appends a spin, so the space's own head
		// is untouched either way.
		const oldNote = app.vault.getAbstractFileByPath(normalizePath(`${folder.path}/${oldName}.md`));
		if (oldNote instanceof TFile) {
			await app.fileManager.renameFile(oldNote, ref.contextPath);
		}
		await regenerateContext(ref, app);
	}

	// The removal belongs in the log of the folder that actually used to hold this one. If that
	// folder is gone too, this rename is part of a larger move whose own event already covers it.
	const oldParentRef = await findExistingOwningSpaceByPath(parentPathOf(oldPath), app);
	if (enabled(oldParentRef)) {
		const spin = await appendSubspaceEvent(oldParentRef, "subspace_removed", oldName, "observed", app);
		if (spin) await regenerateContext(oldParentRef, app);
	}

	if (enabled(newParentRef)) {
		const spin = await appendSubspaceEvent(newParentRef, "subspace_created", folder.name, "observed", app);
		if (spin) await regenerateContext(newParentRef, app);
	}
}

async function handleFileRename(
	plugin: AethersWebPlugin,
	file: TFile,
	oldPath: string,
	enabled: (ref: SpaceRef | null) => ref is SpaceRef,
): Promise<void> {
	const { app } = plugin;
	const newRef = await findOwningSpaceByPath(parentPathOf(file.path), app);
	const oldRef = await findExistingOwningSpaceByPath(parentPathOf(oldPath), app);

	// The folder note is no longer skipped here. When a space is renamed, handleFolderRename renames
	// the note to follow the folder (Foo/Foo.md -> FooBar/FooBar.md), which genuinely changes its
	// path *within* the space — so the space's own log has to record it. Skipping it would leave the
	// log naming a file that no longer exists on disk, and reconciliation (which now walks the
	// folder note too) would "fix" that with a spurious delete-plus-create pair. Note this is not
	// the same as the space itself moving, which still never touches the space's own log: a whole-
	// folder move leaves every descendant's relative path unchanged, and RenameEchoTracker drops
	// those echoes before they reach here.

	if (oldRef && newRef && oldRef.path === newRef.path) {
		const oldRelPath = oldPath.slice(oldRef.path.length + 1);
		if (!enabled(newRef)) return;
		cancelPendingModify(`${newRef.path}::${oldRelPath}`);
		await appendSpin(
			newRef,
			"file_renamed",
			"observed",
			{ old_path: oldRelPath, path: relativePath(newRef, file) },
			app,
		);
		await regenerateContext(newRef, app);
		return;
	}

	// The rename crossed a space boundary — a single file_renamed spin only makes sense within one
	// space's own log, so it reconciles honestly as a removal from one and an arrival in the other.
	if (enabled(oldRef)) {
		const oldRelPath = oldPath.slice(oldRef.path.length + 1);
		cancelPendingModify(`${oldRef.path}::${oldRelPath}`);
		const spin = await appendFileDeleted(oldRef, oldRelPath, "observed", app);
		if (spin) await regenerateContext(oldRef, app);
	}
	if (enabled(newRef)) {
		const spin = await recordFileContentSpin(newRef, "file_created", relativePath(newRef, file), file, "observed", app);
		if (spin) await regenerateContext(newRef, app);
	}
}
