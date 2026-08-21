/** Name of the per-space metadata folder. Never indexed by Obsidian's vault API. */
export const AETHER_DIR = ".aether";

/** Filenames inside a space's .aether/ folder. */
export const LOG_FILE = "log.jsonl";
export const HEAD_FILE = "head";
/**
 * Cross-process advisory lock. Both writers — the Obsidian plugin's `log.ts` and the MCP server's
 * `lock.ts` — acquire this exclusive-create file before their read-tail/append/write-head sequence.
 * It is only meaningful because *both* honor it; a writer that skips it can still fork a chain.
 */
export const LOCK_FILE = ".lock";
/** A lock file older than this is treated as abandoned by a crashed holder and broken. */
export const STALE_LOCK_MS = 30_000;

/** Current context-note frontmatter schema version. Bump on breaking frontmatter shape changes. */
export const CONTEXT_SCHEMA_VERSION = 1;

/** Sentinel markers delimiting the AI state statement inside a context note's body. */
export const STATEMENT_START_MARKER = "<!-- AETHERWEB:STATEMENT:START -->";
export const STATEMENT_END_MARKER = "<!-- AETHERWEB:STATEMENT:END -->";

/**
 * Carries the machine-readable signature for the AI content in a block. Lives inside the block,
 * just above the closing marker. This is the authority on who wrote the content and whether a
 * person has confirmed it; the human-readable line rendered beneath it is display only.
 */
export const SIGNATURE_MARKER_PREFIX = "<!-- AETHERWEB:SIGNATURE ";
export const SIGNATURE_MARKER_SUFFIX = " -->";

export const DEFAULT_STATEMENT_PLACEHOLDER =
	"*(No AI state statement has been generated yet for this space. This section will be " +
	"populated by the AethersWeb MCP server / statement generator in a future phase. This " +
	"placeholder is safe to leave as-is — context regeneration will never overwrite content " +
	"outside these markers once statement generation is wired up.)*";

/**
 * Filenames that are never user content, whatever folder they turn up in. Dotted names don't
 * need listing here — `core/ignore.ts` drops every dotted path segment wholesale.
 */
export const IGNORED_EXACT_NAMES = new Set(["Thumbs.db", "desktop.ini"]);

/**
 * Transient write artifacts that appear briefly under a *visible* name. Matched against the final
 * path segment only. The first pattern is Obsidian's own atomic-save temp file
 * (`Note.md.tmp.<pid>.<rand>`) — observed being recorded as a real file_created in a live vault,
 * then reconciled away as a delete. The rest are the conflict-copy names cloud sync tools leave
 * behind, which are real files but are never the vault's own record of what happened.
 */
export const IGNORED_NAME_PATTERNS: RegExp[] = [
	/\.tmp\.\d+\.[0-9a-f]+$/i,
	/\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]+\b/i,
	/ \(conflicted copy .*\)/i,
	/ \(.*'s conflicted copy .*\)/i,
];

/** Default per-file debounce window (ms) before an observed edit is turned into a spin. */
export const DEFAULT_DEBOUNCE_MS = 2000;

/** Default gap between background reconciliation sweeps. */
export const DEFAULT_RECONCILE_INTERVAL_MINUTES = 15;

/**
 * How long after a folder rename its descendants' own rename events are treated as echoes of it.
 * Obsidian emits them synchronously right after the ancestor's, so this only has to outlast one
 * event-loop drain — see events.ts::isRenameEcho.
 */
export const RENAME_ECHO_WINDOW_MS = 2000;

/**
 * Default number of spins that may accumulate since a space's last statement before the drift is
 * treated as significant on volume alone — see core/drift.ts. Mirrors Spec.md's storage-discipline
 * note that the AI statement is "debounced: on demand or past a threshold, never on every
 * keystroke, or deep edits cascade model calls up the tree." Low enough that a space doesn't sit
 * silently unaddressed for dozens of edits, high enough that a single saved keystroke doesn't
 * queue an LLM call.
 */
export const STATEMENT_DRIFT_THRESHOLD = 5;

/** Binary file extensions hashed via readBinary rather than cachedRead. */
export const BINARY_EXTENSIONS = new Set([
	"png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico",
	"pdf", "mp3", "wav", "ogg", "flac", "m4a",
	"mp4", "mov", "webm", "mkv", "avi",
	"zip", "7z", "rar", "tar", "gz",
	"woff", "woff2", "ttf", "otf",
]);
