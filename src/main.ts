import { Plugin } from "obsidian";
import { AetherLogView, AETHER_VIEW_TYPE } from "./aether-view";
import { registerCommands, registerContextMenus, registerRibbon } from "./commands";
import { registerVaultEventHandlers } from "./events";
import { reconcileVault } from "./reconcile";
import { AethersWebSettingTab } from "./settings";
import { DEFAULT_SETTINGS } from "./types";
import type { AethersWebSettings } from "./types";

export default class AethersWebPlugin extends Plugin {
	settings: AethersWebSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new AethersWebSettingTab(this.app, this));
		this.registerView(AETHER_VIEW_TYPE, (leaf) => new AetherLogView(leaf, this));
		registerCommands(this);
		registerContextMenus(this);
		registerRibbon(this);

		// Reconciliation must complete before live event listeners attach, so reconciliation's
		// own writes are never double-counted as "observed" — and folder listings need the
		// workspace layout to be ready first.
		this.app.workspace.onLayoutReady(async () => {
			if (this.settings.globalEnabled) {
				await reconcileVault(this.app, this.settings);
			}
			registerVaultEventHandlers(this);
		});
	}

	onunload(): void {
		// No manual cleanup needed — everything is registered via this.registerEvent, which
		// Obsidian tears down automatically.
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
