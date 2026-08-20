import type { TFile, TFolder } from "obsidian";
import { DEFAULT_DEBOUNCE_MS } from "./constants";

/** Every kind of event a space's own log can record. */
export type SpinType =
	| "space_created"
	| "file_created"
	| "file_modified"
	| "file_deleted"
	| "file_renamed"
	| "subspace_created"
	| "subspace_removed"
	/** Reserved for future log-pruning checkpoints (spec's "storage discipline"). Never emitted in v0.1. */
	| "checkpoint";

/**
 * Whether a spin was witnessed live by a running plugin instance, or inferred afterward
 * by the reconciliation pass. This distinction is load-bearing — never collapse it, never
 * infer one from the other after the fact.
 */
export type SpinSource = "observed" | "detected";

/**
 * Payload shape for a spin. Deliberately has NO hash-carrying field for subspace_created /
 * subspace_removed — a space's own log must never commit to a child space's chain. Child tip
 * hashes live only in this space's *context* (derived, disposable), never in its log
 * (authoritative). Do not add a hash field here for subspace events.
 */
export interface SpinPayload {
	/** Relative to this space's own folder. Never reaches into a subspace's contents. */
	path?: string;
	/** sha256 hex of file content. Only for file_created / file_modified. Never file content itself. */
	content_hash?: string;
	size?: number;
	/** Previous relative path, for file_renamed. */
	old_path?: string;
	/** Folder name only — never a hash — for subspace_created / subspace_removed. */
	subspace_name?: string;
}

export interface Spin {
	/** Monotonic within this space's log, starting at 0, strictly +1 per line. */
	seq: number;
	/** ISO 8601 UTC. */
	ts: string;
	spin_type: SpinType;
	source: SpinSource;
	payload: SpinPayload;
	/** Previous spin's hash in this space's log. Null only at seq 0. */
	prev_hash: string | null;
	/** sha256 of the canonical serialization of every field above, excluding this field itself. */
	hash: string;
}

/** A Spin before its hash has been computed. */
export type SpinDraft = Omit<Spin, "hash">;

export interface VerifyResult {
	ok: boolean;
	length: number;
	brokenAtSeq?: number;
	reason?: "hash_mismatch" | "prev_hash_mismatch" | "seq_gap" | "parse_error";
}

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

export interface ContextFileEntry {
	path: string;
	hash: string;
	size: number;
}

export interface ContextSubspaceEntry {
	name: string;
	/** Child space's own head hash, read from the child's head file — never from this space's log. */
	tip: string | null;
}

export interface ContextFrontmatter {
	aetherweb_schema: number;
	space_path: string;
	source_tip: string | null;
	generated_at: string;
	file_count: number;
	subspace_count: number;
	files: ContextFileEntry[];
	subspaces: ContextSubspaceEntry[];
	/** Tip the AI statement body was last generated against. Null = never generated. */
	statement_tip: string | null;
}

export interface AethersWebSettings {
	globalEnabled: boolean;
	/** Vault-relative space folder paths opted out of both live listening and reconciliation. */
	disabledSpaces: string[];
	debounceMs: number;
}

export const DEFAULT_SETTINGS: AethersWebSettings = {
	globalEnabled: true,
	disabledSpaces: [],
	debounceMs: DEFAULT_DEBOUNCE_MS,
};

/** Minimal shape used by fold/diff logic — a TFile is narrowed to just what's needed. */
export type HashableFile = TFile;
