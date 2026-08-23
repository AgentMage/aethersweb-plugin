/** Name of the per-space metadata folder. Never indexed by Obsidian's vault API. */
export const AETHER_DIR = ".aether";

/** Filenames inside a space's .aether/ folder. */
export const LOG_FILE = "log.jsonl";
export const HEAD_FILE = "head";
/**
 * The machine index: a space's objective content list (files, hashes, subspace tips, counts).
 * Lives here rather than in the folder note for the same reason `head` does — it is derived from
 * the log, rewritten on every spin, and never logged itself. The folder note is the person's.
 */
export const INDEX_FILE = "index.md";
/**
 * Cross-process advisory lock. Both writers — the Obsidian plugin's `log.ts` and the MCP server's
 * `lock.ts` — acquire this exclusive-create file before their read-tail/append/write-head sequence.
 * It is only meaningful because *both* honor it; a writer that skips it can still fork a chain.
 */
export const LOCK_FILE = ".lock";
/** A lock file older than this is treated as abandoned by a crashed holder and broken. */
export const STALE_LOCK_MS = 30_000;

/**
 * Current machine-index schema version. Bump on breaking frontmatter shape changes.
 * v2: the index moved out of the folder note into `.aether/index.md` and dropped `statement_tip`
 * (what a statement was generated against now lives in its own signature's `at_tip`).
 */
export const CONTEXT_SCHEMA_VERSION = 2;

/**
 * A folder note has three regions, and which one a stretch of text sits in is the whole answer to
 * "whose words are these":
 *
 * - **statement** — the AI's. Regenerated from the log whenever the space moves on. A person can
 *   type in it, but nothing promises to keep what they typed; the next statement replaces it.
 * - **shared** — both. An agent may write here and so may the person, and neither side's writing
 *   is treated as an intrusion on the other's. This is the only region where an AI write is
 *   expected to arrive on top of a person's words and vice versa.
 * - **everything else** — the person's, untouchable. No AI write reaches outside a block.
 *
 * The shared region exists because the other two leave nothing in between. Anything an agent needs
 * to leave behind that is *not* derived from the log — a question it wants answered, a running
 * checklist, notes toward the next session — had only two homes: inside the statement, where the
 * next regeneration silently eats it, or nowhere. And anything the person wanted to say *to* the
 * agent, at a place the agent would reliably look, had no home at all. Same file, same note, one
 * region deliberately held in common.
 */
export type BlockKind = "statement" | "shared";

/** Sentinel markers delimiting the AI state statement inside a context note's body. */
export const STATEMENT_START_MARKER = "<!-- AETHERWEB:STATEMENT:START -->";
export const STATEMENT_END_MARKER = "<!-- AETHERWEB:STATEMENT:END -->";

/**
 * Sentinel markers delimiting the shared region — written by agents and by the person, in the same
 * block, with no claim by either that the other's edits are damage to be undone.
 */
export const SHARED_START_MARKER = "<!-- AETHERWEB:SHARED:START -->";
export const SHARED_END_MARKER = "<!-- AETHERWEB:SHARED:END -->";

/** Start/end markers by region, so no caller has to pick a pair by hand. */
export const BLOCK_MARKERS: Record<BlockKind, { start: string; end: string }> = {
	statement: { start: STATEMENT_START_MARKER, end: STATEMENT_END_MARKER },
	shared: { start: SHARED_START_MARKER, end: SHARED_END_MARKER },
};

/**
 * Every sentinel that must never appear inside content written into a block. All four block
 * markers, not just the enclosing pair: text inside a statement carrying a shared START marker
 * would conjure a shared region inside AI-only prose, and the reverse hides shared text inside
 * something regeneration overwrites. The signature prefix is here because content carrying one
 * forges its own attribution.
 */
export const RESERVED_MARKERS = [
	STATEMENT_START_MARKER,
	STATEMENT_END_MARKER,
	SHARED_START_MARKER,
	SHARED_END_MARKER,
];

/**
 * Carries the machine-readable signature for the AI content in a block. Lives inside the block,
 * just above the closing marker. This is the authority on who wrote the content and whether a
 * person has confirmed it; the human-readable line rendered beneath it is display only.
 */
export const SIGNATURE_MARKER_PREFIX = "<!-- AETHERWEB:SIGNATURE ";
export const SIGNATURE_MARKER_SUFFIX = " -->";

/**
 * A fresh shared block's contents. Written once, at creation, and then owned by whoever writes in
 * it next — regeneration never restores it, because restoring it would mean deleting whatever the
 * two sides put there.
 */
export const DEFAULT_SHARED_PLACEHOLDER =
	"*(Shared space. You and any agent working in this vault can both write here, and neither " +
	"side's words get overwritten as a matter of course — unlike the statement above, which is " +
	"regenerated from this space's log. Open questions, running notes, things you want an agent " +
	"to know before it writes about this space.)*";

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
