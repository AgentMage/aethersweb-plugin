/** Name of the per-space metadata folder. Never indexed by Obsidian's vault API. */
export const AETHER_DIR = ".aether";

/** Filenames inside a space's .aether/ folder. */
export const LOG_FILE = "log.jsonl";
export const HEAD_FILE = "head";

/** Current context-note frontmatter schema version. Bump on breaking frontmatter shape changes. */
export const CONTEXT_SCHEMA_VERSION = 1;

/** Sentinel markers delimiting the AI state statement inside a context note's body. */
export const STATEMENT_START_MARKER = "<!-- AETHERWEB:STATEMENT:START -->";
export const STATEMENT_END_MARKER = "<!-- AETHERWEB:STATEMENT:END -->";

export const DEFAULT_STATEMENT_PLACEHOLDER =
	"*(No AI state statement has been generated yet for this space. This section will be " +
	"populated by the AethersWeb MCP server / statement generator in a future phase. This " +
	"placeholder is safe to leave as-is — context regeneration will never overwrite content " +
	"outside these markers once statement generation is wired up.)*";

/** Vault paths / path segments the plugin must never treat as space content. */
export const IGNORED_TOP_LEVEL_SEGMENTS = [".obsidian", AETHER_DIR];

/** Default per-file debounce window (ms) before an observed edit is turned into a spin. */
export const DEFAULT_DEBOUNCE_MS = 2000;

/** Binary file extensions hashed via readBinary rather than cachedRead. */
export const BINARY_EXTENSIONS = new Set([
	"png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico",
	"pdf", "mp3", "wav", "ogg", "flac", "m4a",
	"mp4", "mov", "webm", "mkv", "avi",
	"zip", "7z", "rar", "tar", "gz",
	"woff", "woff2", "ttf", "otf",
]);
