import { App, Modal, Notice, TFolder } from "obsidian";
import { scaffoldSpace } from "./bootstrap";
import { regenerateContext } from "./context";
import { verifyChain } from "./hash";
import { readLog } from "./log";
import { reconcileVault } from "./reconcile";
import { findOwningSpace, walkSpaces } from "./space";
import type AethersWebPlugin from "./main";

class NamePromptModal extends Modal {
	private onSubmit: (name: string) => void;
	private title: string;

	constructor(app: App, title: string, onSubmit: (name: string) => void) {
		super(app);
		this.title = title;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.title });

		const input = contentEl.createEl("input", { type: "text", attr: { placeholder: "Name" } });
		input.style.width = "100%";
		input.focus();
		input.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") this.submit(input.value);
		});

		const buttonRow = contentEl.createDiv({ attr: { style: "margin-top: 12px; text-align: right;" } });
		const submitBtn = buttonRow.createEl("button", { text: "Create" });
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
			new NamePromptModal(app, "New user-space name", async (name) => {
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
		callback: () => {
			const file = app.workspace.getActiveFile();
			new NamePromptModal(app, "New subspace name", async (name) => {
				const ref = await findOwningSpace(file?.parent ?? null, app);
				if (!ref) {
					new Notice("AethersWeb: no active file inside a space to attach a subspace to");
					return;
				}
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
 * Adds a left-ribbon "New space here" icon — a one-click affordance for the same targeting
 * Obsidian's own file-explorer "+" (new-folder) button doesn't do: that core button always
 * creates at vault root regardless of what's selected, and there's no supported hook to redirect
 * it. This ribbon icon targets the space containing the currently active file instead (same
 * targeting as the "Create new subspace here" command), so it lands in the right place every time.
 */
export function registerRibbon(plugin: AethersWebPlugin): void {
	const { app } = plugin;

	const ribbonEl = plugin.addRibbonIcon("folder-plus", "AethersWeb: new space here", () => {
		const file = app.workspace.getActiveFile();
		new NamePromptModal(app, "New space name", async (name) => {
			const ref = await findOwningSpace(file?.parent ?? null, app);
			if (!ref) {
				new Notice("AethersWeb: no active file inside a space — open a note in the target space first, or use \"New space here\" from a folder's right-click menu");
				return;
			}
			try {
				const child = await scaffoldSpace(ref.path, name, app);
				new Notice(`AethersWeb: created space ${child.path}`);
			} catch (err) {
				console.error("[AethersWeb] failed to create space", err);
				new Notice(`AethersWeb: failed to create space — ${(err as Error).message}`);
			}
		}).open();
	});

	// addRibbonIcon has no ordering option, so pin it to the bottom of the ribbon (just above
	// Obsidian's fixed Settings/Help icons) by moving the element to the end of its container.
	ribbonEl.parentElement?.appendChild(ribbonEl);
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
						new NamePromptModal(app, "New space name", async (name) => {
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
		}),
	);
}
