import { Plugin } from "obsidian";
import { AetherLogView, AETHER_VIEW_TYPE } from "./aether-view";
import { registerCommands, registerContextMenus, registerRibbon } from "./commands";
import { cancelPendingModifies, registerVaultEventHandlers } from "./events";
import { reconcileVault } from "./reconcile";
import { AethersWebSettingTab } from "./settings";
import { DEFAULT_SETTINGS } from "./types";
import type { AethersWebSettings } from "./types";

/** Minimum gap between focus-triggered reconciliation sweeps. */
const FOCUS_RECONCILE_THROTTLE_MS = 60_000;

export default class AethersWebPlugin extends Plugin {
	settings: AethersWebSettings = DEFAULT_SETTINGS;
	private reconcileInFlight: Promise<unknown> | null = null;

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
			await this.reconcile();
			registerVaultEventHandlers(this);
			this.registerCatchUpTriggers();
		});
	}

	onunload(): void {
		// Everything else is registered via this.registerEvent / this.registerInterval, which
		// Obsidian tears down automatically. Debounce timers are plain setTimeouts and are not.
		cancelPendingModifies();
	}

	/**
	 * Reconciliation used to run exactly once, at vault open. Live capture only sees what Obsidian
	 * itself sees, so everything that happened while it wasn't looking — an editor outside
	 * Obsidian, a sync client landing files, the MCP server authoring headlessly — stayed
	 * unrecorded until the next full restart, which for a vault left open for days is a long time
	 * to be quietly wrong. These are the cheap moments to catch up:
	 *
	 * - **Window focus**, throttled: the boundary right after the user was plausibly elsewhere.
	 * - **A timer**, for a vault left open and untouched while other processes write to it.
	 *
	 * Both funnel through the same single-flight `reconcile()`, so an overlapping trigger joins the
	 * run already in progress instead of starting a competing walk of the same tree.
	 */
	private registerCatchUpTriggers(): void {
		let lastFocusRun = 0;
		this.registerDomEvent(window, "focus", () => {
			if (Date.now() - lastFocusRun < FOCUS_RECONCILE_THROTTLE_MS) return;
			lastFocusRun = Date.now();
			void this.reconcile();
		});

		const minutes = this.settings.reconcileIntervalMinutes;
		if (minutes > 0) {
			this.registerInterval(
				window.setInterval(() => void this.reconcile(), minutes * 60_000),
			);
		}
	}

	/** Single-flight reconciliation: concurrent callers await the run already under way. */
	reconcile(): Promise<unknown> {
		if (!this.settings.globalEnabled) return Promise.resolve();
		if (this.reconcileInFlight) return this.reconcileInFlight;
		this.reconcileInFlight = reconcileVault(this.app, this.settings)
			.catch((err) => {
				console.error("[AethersWeb] reconciliation failed", err);
			})
			.finally(() => {
				this.reconcileInFlight = null;
			});
		return this.reconcileInFlight;
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
