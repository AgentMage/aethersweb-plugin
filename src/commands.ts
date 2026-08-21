import { App, Modal, normalizePath, Notice, TFolder } from "obsidian";
import { AETHER_VIEW_TYPE } from "./aether-view";
import { scaffoldSpace } from "./bootstrap";
import { regenerateContext } from "./context";
import { verifyChain } from "./hash";
import { readLog } from "./log";
import { reconcileVault } from "./reconcile";
import { findOwningSpace, isSpace, walkSpaces } from "./space";
import type AethersWebPlugin from "./main";

class NamePromptModal extends Modal {
	private onSubmit: (name: string) => void;
	private title: string;
	private initialValue: string;
	private submitLabel: string;

	constructor(
		app: App,
		title: string,
		onSubmit: (name: string) => void,
		initialValue = "",
		submitLabel = "Create",
	) {
		super(app);
		this.title = title;
		this.onSubmit = onSubmit;
		this.initialValue = initialValue;
		this.submitLabel = submitLabel;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.title });

		const input = contentEl.createEl("input", { type: "text", attr: { placeholder: "Name" } });
		input.style.width = "100%";
		input.value = this.initialValue;
		input.focus();
		if (this.initialValue) input.select();
		input.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") this.submit(input.value);
		});

		const buttonRow = contentEl.createDiv({ attr: { style: "margin-top: 12px; text-align: right;" } });
		const submitBtn = buttonRow.createEl("button", { text: this.submitLabel });
		submitBtn.addEventListener("click", () => this.submit(input.value));
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private submit(value: string): void {
		const trimmed = value.trim();
		if (!trimmed) return;
		this.close();
		this.onSubmit(trimmed);
	}
}

export function registerCommands(plugin: AethersWebPlugin): void {
	const { app } = plugin;

	plugin.addCommand({
		id: "regenerate-context-current",
		name: "Regenerate context for current space",
		callback: async () => {
			const file = app.workspace.getActiveFile();
			const ref = await findOwningSpace(file?.parent ?? null, app);
			if (!ref) {
				new Notice("AethersWeb: no active file inside a space");
				return;
			}
			await regenerateContext(ref, app);
			new Notice(`AethersWeb: regenerated context for ${ref.path}`);
		},
	});

	plugin.addCommand({
		id: "verify-chain-current",
		name: "Verify chain for current space",
		callback: async () => {
			const file = app.workspace.getActiveFile();
			const ref = await findOwningSpace(file?.parent ?? null, app);
			if (!ref) {
				new Notice("AethersWeb: no active file inside a space");
				return;
			}
			const log = await readLog(ref, app);
			const result = verifyChain(log);
			new Notice(
				result.ok
					? `AethersWeb: ${ref.path} chain OK (${result.length} spins)`
					: `AethersWeb: ${ref.path} chain BROKEN at seq ${result.brokenAtSeq} (${result.reason})`,
			);
		},
	});

	plugin.addCommand({
		id: "verify-chain-vault",
		name: "Verify chain for entire vault",
		callback: async () => {
			let total = 0;
			const broken: string[] = [];
			for await (const ref of walkSpaces(app)) {
				total++;
				const log = await readLog(ref, app);
				const result = verifyChain(log);
				if (!result.ok) {
					broken.push(`${ref.path}: BROKEN at seq ${result.brokenAtSeq} (${result.reason})`);
				}
			}
			if (broken.length === 0) {
				new Notice(`AethersWeb: all ${total} space(s) verified OK`);
			} else {
				new Notice(`AethersWeb: ${broken.length}/${total} space(s) broken — see console`);
				console.warn("[AethersWeb] chain verification failures:\n" + broken.join("\n"));
			}
		},
	});

	plugin.addCommand({
		id: "repair-chain-current",
		name: "Repair chain for current space",
		callback: async () => {
			const file = app.workspace.getActiveFile();
			const ref = await findOwningSpace(file?.parent ?? null, app);
			if (!ref) {
				new Notice("AethersWeb: no active file inside a space");
				return;
			}
			const log = await readLog(ref, app);
			const result = verifyChain(log);
			if (result.ok) {
				new Notice(`AethersWeb: ${ref.path} chain is already OK`);
				return;
			}
			// Repair is a cooperative act, not a silent one — hand off to the log view, where the
			// user sees exactly what would be quarantined before confirming (see aether-view.ts).
			const existing = app.workspace.getLeavesOfType(AETHER_VIEW_TYPE);
			const leaf = existing[0] ?? app.workspace.getLeaf("tab");
			await leaf.setViewState({ type: AETHER_VIEW_TYPE, active: true, state: { spacePath: ref.path } });
			app.workspace.revealLeaf(leaf);
			new Notice(`AethersWeb: ${ref.path} chain is BROKEN — review and repair from the log view`);
		},
	});

	plugin.addCommand({
		id: "run-reconciliation",
		name: "Run reconciliation now",
		callback: async () => {
			const results = await reconcileVault(app, plugin.settings);
			const totalSpins = Array.from(results.values()).reduce((sum, spins) => sum + spins.length, 0);
			new Notice(`AethersWeb: reconciliation done — ${totalSpins} spin(s) across ${results.size} space(s)`);
		},
	});

	plugin.addCommand({
		id: "create-user-space",
		name: "Create new user-space",
		callback: () => {
			// A user-space's parent is the vault itself (the meta-container) — no SpaceRef to
			// resolve, but the card should still name where the new space lands.
			new NamePromptModal(app, `New space in "${app.vault.getName()}"`, async (name) => {
				try {
					const ref = await scaffoldSpace("", name, app);
					new Notice(`AethersWeb: created user-space ${ref.path}`);
				} catch (err) {
					console.error("[AethersWeb] failed to create user-space", err);
					new Notice(`AethersWeb: failed to create user-space — ${(err as Error).message}`);
				}
			}).open();
		},
	});

	plugin.addCommand({
		id: "create-subspace-here",
		name: "Create new subspace here",
		callback: async () => {
			const file = app.workspace.getActiveFile();
			const ref = await findOwningSpace(file?.parent ?? null, app);
			if (!ref) {
				new Notice("AethersWeb: no active file inside a space to attach a subspace to");
				return;
			}
			new NamePromptModal(app, `New space in "${ref.folder.name}"`, async (name) => {
				try {
					const child = await scaffoldSpace(ref.path, name, app);
					new Notice(`AethersWeb: created subspace ${child.path}`);
				} catch (err) {
					console.error("[AethersWeb] failed to create subspace", err);
					new Notice(`AethersWeb: failed to create subspace — ${(err as Error).message}`);
				}
			}).open();
		},
	});
}

/**
 * Adds left-ribbon icons — one-click affordances for actions that otherwise require right-clicking
 * a specific folder in the file explorer.
 *
 * "New space here" targets the same thing Obsidian's own file-explorer "+" (new-folder) button
 * doesn't: that core button always creates at vault root regardless of what's selected, and
 * there's no supported hook to redirect it. This targets the space containing the currently
 * active file instead (same targeting as the "Create new subspace here" command), so it lands in
 * the right place every time.
 *
 * "View .aether log" opens (or retargets an existing) log-view tab, same as the folder context
 * menu's "View .aether log" and the repair-chain-current command. It targets the active file's
 * owning space when there is one; otherwise it opens/reveals the tab as-is — untargeted, the view
 * shows its own "right-click a space folder" hint (or whatever space was last open in that tab)
 * rather than the ribbon icon refusing to do anything.
 */
export function registerRibbon(plugin: AethersWebPlugin): void {
	const { app } = plugin;

	const newSpaceEl = plugin.addRibbonIcon("folder-plus", "AethersWeb: new space here", async () => {
		const file = app.workspace.getActiveFile();
		const ref = await findOwningSpace(file?.parent ?? null, app);
		if (!ref) {
			new Notice("AethersWeb: no active file inside a space — open a note in the target space first, or use \"New space here\" from a folder's right-click menu");
			return;
		}
		new NamePromptModal(app, `New space in "${ref.folder.name}"`, async (name) => {
			try {
				const child = await scaffoldSpace(ref.path, name, app);
				new Notice(`AethersWeb: created space ${child.path}`);
			} catch (err) {
				console.error("[AethersWeb] failed to create space", err);
				new Notice(`AethersWeb: failed to create space — ${(err as Error).message}`);
			}
		}).open();
	});

	const logViewEl = plugin.addRibbonIcon("database", "AethersWeb: view .aether log", async () => {
		const file = app.workspace.getActiveFile();
		const ref = await findOwningSpace(file?.parent ?? null, app);
		const existing = app.workspace.getLeavesOfType(AETHER_VIEW_TYPE);
		const leaf = existing[0] ?? app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: AETHER_VIEW_TYPE,
			active: true,
			state: ref ? { spacePath: ref.path } : {},
		});
		app.workspace.revealLeaf(leaf);
	});

	// addRibbonIcon has no ordering option, so pin these to the bottom of the ribbon (just above
	// Obsidian's fixed Settings/Help icons) by moving each element to the end of its container, in
	// the order they should appear.
	newSpaceEl.parentElement?.appendChild(newSpaceEl);
	logViewEl.parentElement?.appendChild(logViewEl);
}

/**
 * Adds "New space here" to the right-click menu of every folder in the file explorer. This is
 * the precise-targeting counterpart to the create-* commands above: Obsidian's own native
 * "Create new folder" always lands at vault root regardless of what's selected (that's Obsidian's
 * placement logic, not something a plugin can redirect), so right-clicking the exact intended
 * parent and scaffolding straight into it is the only reliable way to put a new space where the
 * user is actually looking.
 */
export function registerContextMenus(plugin: AethersWebPlugin): void {
	const { app } = plugin;

	plugin.registerEvent(
		app.workspace.on("file-menu", (menu, file) => {
			if (!(file instanceof TFolder)) return;

			menu.addItem((item) =>
				item
					.setTitle("New space here")
					.setIcon("folder-plus")
					.onClick(() => {
						new NamePromptModal(app, `New space in "${file.name}"`, async (name) => {
							try {
								const ref = await scaffoldSpace(file.path, name, app);
								new Notice(`AethersWeb: created space ${ref.path}`);
							} catch (err) {
								console.error("[AethersWeb] failed to create space", err);
								new Notice(`AethersWeb: failed to create space — ${(err as Error).message}`);
							}
						}).open();
					}),
			);

			menu.addItem((item) =>
				item
					.setTitle("Rename space")
					.setIcon("pencil")
					.onClick(() => {
						// Renaming a folder never touches its own .aether/log.jsonl — that chain
						// is keyed to the folder's *contents*, not its path, and nothing in this
						// codebase re-initializes it on rename (only scaffoldSpace /
						// ensureSpaceInitialized do that, and neither is called here or from the
						// rename event handler in events.ts). fileManager.renameFile does the
						// actual move; Obsidian's own "rename" event then fires exactly once,
						// which events.ts's TFolder handler turns into a subspace_removed +
						// subspace_created pair in the *parent's* log only — the space's own
						// history, and its .aether/ folder, simply travel with it unchanged.
						new NamePromptModal(
							app,
							"Rename space to",
							async (name) => {
								const parentPath = file.parent ? file.parent.path : "";
								const newPath = normalizePath(parentPath ? `${parentPath}/${name}` : name);
								try {
									await app.fileManager.renameFile(file, newPath);
									new Notice(`AethersWeb: renamed to ${newPath}`);
								} catch (err) {
									console.error("[AethersWeb] failed to rename space", err);
									new Notice(`AethersWeb: failed to rename — ${(err as Error).message}`);
								}
							},
							file.name,
							"Rename",
						).open();
					}),
			);

			menu.addItem((item) =>
				item
					.setTitle("View .aether log")
					.setIcon("database")
					.onClick(async () => {
						if (!(await isSpace(file, app))) {
							new Notice("AethersWeb: this folder isn't a claimed space yet");
							return;
						}
						const existing = app.workspace.getLeavesOfType(AETHER_VIEW_TYPE);
						const leaf = existing[0] ?? app.workspace.getLeaf("tab");
						await leaf.setViewState({ type: AETHER_VIEW_TYPE, active: true, state: { spacePath: file.path } });
						app.workspace.revealLeaf(leaf);
					}),
			);
		}),
	);
}
