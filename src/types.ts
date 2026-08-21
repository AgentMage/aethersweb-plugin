import type { TFile, TFolder } from "obsidian";
import { DEFAULT_DEBOUNCE_MS, DEFAULT_RECONCILE_INTERVAL_MINUTES } from "./core/constants";

export * from "./core/types";

/** Resolved handle to a space: its folder plus its .aether/ and context-note paths. */
export interface SpaceRef {
	folder: TFolder;
	/** Vault-relative path to this space's folder. Equals folder.path; kept for clarity at call sites. */
	path: string;
	aetherDir: string;
	logPath: string;
	headPath: string;
	/** <path>/<folder.name>.md — the folder-note convention context note. */
	contextPath: string;
}

export interface AethersWebSettings {
	globalEnabled: boolean;
	/** Vault-relative space folder paths opted out of both live listening and reconciliation. */
	disabledSpaces: string[];
	debounceMs: number;
	/**
	 * Scaffold folders found inside a claimed space that were never claimed themselves. On by
	 * default: it matches what live capture already does for folders created while Obsidian is
	 * running, and without it a folder created any other way stays invisible to every pass
	 * forever (see reconcile.ts::claimUnclaimedFolders).
	 */
	autoClaimFolders: boolean;
	/** Minutes between background reconciliation sweeps. 0 disables the timer (open/focus still run). */
	reconcileIntervalMinutes: number;
	/**
	 * The name recorded when you verify AI content. A verification's whole value is that a person
	 * stands behind it, so it is signed with who that was.
	 */
	verifierName: string;
}

export const DEFAULT_SETTINGS: AethersWebSettings = {
	globalEnabled: true,
	disabledSpaces: [],
	debounceMs: DEFAULT_DEBOUNCE_MS,
	autoClaimFolders: true,
	reconcileIntervalMinutes: DEFAULT_RECONCILE_INTERVAL_MINUTES,
	verifierName: "me",
};

/** Minimal shape used by fold/diff logic — a TFile is narrowed to just what's needed. */
export type HashableFile = TFile;
