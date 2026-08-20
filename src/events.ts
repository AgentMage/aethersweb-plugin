import { TFile, TFolder } from "obsidian";
import { regenerateContext } from "./context";
import { appendSpin } from "./log";
import { isSpaceEnabled } from "./settings";
import { findOwningSpace, hashFile, isSpace, relativePath } from "./space";
import type AethersWebPlugin from "./main";
import type { SpaceRef } from "./types";

function isIgnorablePath(path: string): boolean {
	return path.startsWith(".obsidian/") || path === ".obsidian" || path.includes("/.aether/") || path.startsWith(".aether/");
}

function parentPathOf(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? "" : path.slice(0, idx);
}

/** Per (space, relative-path) debounce: coalesces rapid successive modify events into one spin. */
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleObservedModify(plugin: AethersWebPlugin, ref: SpaceRef, file: TFile): void {
	const key = `${ref.path}::${relativePath(ref, file)}`;
	const existing = pendingTimers.get(key);
	if (existing) clearTimeout(existing);

	const timer = setTimeout(async () => {
		pendingTimers.delete(key);
		try {
			const current = plugin.app.vault.getAbstractFileByPath(file.path);
			if (!(current instanceof TFile)) return; // deleted/moved before the timer fired
			const hash = await hashFile(current, plugin.app);
			await appendSpin(
				ref,
				"file_modified",
				"observed",
				{ path: relativePath(ref, current), content_hash: hash, size: current.stat.size },
				plugin.app,
			);
			await regenerateContext(ref, plugin.app);
		} catch (err) {
			console.error("[AethersWeb] failed to record observed file_modified", err);
		}
	}, plugin.settings.debounceMs);
	pendingTimers.set(key, timer);
}

/**
 * Registers live vault event listeners that translate Obsidian events into `observed` spins.
 * Must be called only AFTER the initial reconciliation pass completes, so reconciliation's own
 * writes are never double-counted as observed (see main.ts's onload sequencing).
 */
export function registerVaultEventHandlers(plugin: AethersWebPlugin): void {
	const { app } = plugin;

	plugin.registerEvent(
		app.vault.on("create", async (file) => {
			if (isIgnorablePath(file.path) || !(file instanceof TFile)) return;
			const ref = await findOwningSpace(file.parent, app);
			if (!ref || file.path === ref.contextPath || !isSpaceEnabled(ref, plugin.settings)) return;
			const hash = await hashFile(file, app);
			await appendSpin(
				ref,
				"file_created",
				"observed",
				{ path: relativePath(ref, file), content_hash: hash, size: file.stat.size },
				app,
			);
			await regenerateContext(ref, app);
		}),
	);

	plugin.registerEvent(
		app.vault.on("modify", async (file) => {
			if (isIgnorablePath(file.path) || !(file instanceof TFile)) return;
			const ref = await findOwningSpace(file.parent, app);
			if (!ref || file.path === ref.contextPath || !isSpaceEnabled(ref, plugin.settings)) return;
			scheduleObservedModify(plugin, ref, file);
		}),
	);

	plugin.registerEvent(
		app.vault.on("delete", async (file) => {
			if (isIgnorablePath(file.path)) return;

			if (file instanceof TFile) {
				const ref = await findOwningSpace(file.parent, app);
				if (!ref || !isSpaceEnabled(ref, plugin.settings)) return;
				await appendSpin(ref, "file_deleted", "observed", { path: relativePath(ref, file) }, app);
				await regenerateContext(ref, app);
				return;
			}

			if (file instanceof TFolder) {
				// The deleted folder's own log (if it was a space) goes with it — nothing to record
				// there. If its parent is a space, the parent sees a subspace_removed.
				const parentRef = await findOwningSpace(file.parent, app);
				if (parentRef && isSpaceEnabled(parentRef, plugin.settings)) {
					await appendSpin(parentRef, "subspace_removed", "observed", { subspace_name: file.name }, app);
					await regenerateContext(parentRef, app);
				}
			}
		}),
	);

	plugin.registerEvent(
		app.vault.on("rename", async (file, oldPath) => {
			if (isIgnorablePath(file.path) || isIgnorablePath(oldPath)) return;

			if (file instanceof TFolder) {
				if (!(await isSpace(file, app))) return; // plain folder move, not a space boundary event
				const oldParentPath = parentPathOf(oldPath);
				const oldName = oldPath.split("/").pop() ?? file.name;
				const oldParentFolder = oldParentPath
					? app.vault.getAbstractFileByPath(oldParentPath)
					: app.vault.getRoot();

				if (oldParentFolder instanceof TFolder) {
					const oldParentRef = await findOwningSpace(oldParentFolder, app);
					if (oldParentRef && isSpaceEnabled(oldParentRef, plugin.settings)) {
						await appendSpin(oldParentRef, "subspace_removed", "observed", { subspace_name: oldName }, app);
						await regenerateContext(oldParentRef, app);
					}
				}

				const newParentRef = await findOwningSpace(file.parent, app);
				if (newParentRef && isSpaceEnabled(newParentRef, plugin.settings)) {
					await appendSpin(newParentRef, "subspace_created", "observed", { subspace_name: file.name }, app);
					await regenerateContext(newParentRef, app);
				}
				return;
			}

			if (file instanceof TFile) {
				const ref = await findOwningSpace(file.parent, app);
				if (!ref || file.path === ref.contextPath || !isSpaceEnabled(ref, plugin.settings)) return;

				const oldParentPath = parentPathOf(oldPath);
				if (oldParentPath !== ref.path) {
					// Rename crossed a space boundary — a single file_renamed spin only makes sense
					// within one space's own log, so record it as delete-from-old + create-in-new.
					const oldParentFolder = oldParentPath
						? app.vault.getAbstractFileByPath(oldParentPath)
						: app.vault.getRoot();
					if (oldParentFolder instanceof TFolder) {
						const oldRef = await findOwningSpace(oldParentFolder, app);
						if (oldRef && isSpaceEnabled(oldRef, plugin.settings)) {
							const oldRelPath = oldPath.slice(oldRef.path.length + 1);
							await appendSpin(oldRef, "file_deleted", "observed", { path: oldRelPath }, app);
							await regenerateContext(oldRef, app);
						}
					}
					const hash = await hashFile(file, app);
					await appendSpin(
						ref,
						"file_created",
						"observed",
						{ path: relativePath(ref, file), content_hash: hash, size: file.stat.size },
						app,
					);
					await regenerateContext(ref, app);
					return;
				}

				const oldRelPath = oldPath.slice(ref.path.length + 1);
				await appendSpin(
					ref,
					"file_renamed",
					"observed",
					{ old_path: oldRelPath, path: relativePath(ref, file) },
					app,
				);
				await regenerateContext(ref, app);
			}
		}),
	);
}
