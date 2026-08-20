import { App, PluginSettingTab, Setting } from "obsidian";
import { walkSpaces } from "./space";
import { reconcileVault } from "./reconcile";
import type AethersWebPlugin from "./main";
import type { AethersWebSettings, SpaceRef } from "./types";

export { DEFAULT_SETTINGS } from "./types";
export type { AethersWebSettings } from "./types";

export function isSpaceEnabled(ref: SpaceRef, settings: AethersWebSettings): boolean {
	return settings.globalEnabled && !settings.disabledSpaces.includes(ref.path);
}

export class AethersWebSettingTab extends PluginSettingTab {
	plugin: AethersWebPlugin;

	constructor(app: App, plugin: AethersWebPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Enable AethersWeb")
			.setDesc("Global switch. Disabling stops live event capture and reconciliation everywhere, without touching any existing log.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.globalEnabled).onChange(async (value) => {
					this.plugin.settings.globalEnabled = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Modify debounce (ms)")
			.setDesc("How long to wait after the last edit to a file before recording an observed file_modified spin.")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.debounceMs))
					.onChange(async (value) => {
						const ms = Number(value);
						if (Number.isFinite(ms) && ms >= 0) {
							this.plugin.settings.debounceMs = ms;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName("Run reconciliation now")
			.setDesc("Manually walk every space and catch up on any out-of-band edits.")
			.addButton((button) =>
				button.setButtonText("Reconcile").onClick(async () => {
					button.setDisabled(true);
					await reconcileVault(this.app, this.plugin.settings);
					button.setDisabled(false);
				}),
			);

		containerEl.createEl("h3", { text: "Spaces" });

		this.renderSpaceList(containerEl);
	}

	private async renderSpaceList(containerEl: HTMLElement): Promise<void> {
		const listEl = containerEl.createDiv();
		listEl.createEl("p", { text: "Loading spaces…" });

		const refs: SpaceRef[] = [];
		for await (const ref of walkSpaces(this.app)) {
			refs.push(ref);
		}

		listEl.empty();
		if (refs.length === 0) {
			listEl.createEl("p", { text: "No spaces found yet. Use the \"Create new user-space\" command to make one." });
			return;
		}

		for (const ref of refs) {
			new Setting(listEl)
				.setName(ref.path)
				.addToggle((toggle) =>
					toggle
						.setValue(!this.plugin.settings.disabledSpaces.includes(ref.path))
						.onChange(async (enabled) => {
							const disabled = new Set(this.plugin.settings.disabledSpaces);
							if (enabled) disabled.delete(ref.path);
							else disabled.add(ref.path);
							this.plugin.settings.disabledSpaces = Array.from(disabled);
							await this.plugin.saveSettings();
						}),
				);
		}
	}
}
