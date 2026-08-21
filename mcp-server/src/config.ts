import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Resolves the vault root this server instance operates on: `--vault <path>` wins over
 * `AETHERSWEB_VAULT_PATH`. There is no default — an external process guessing at a vault
 * location is worse than refusing to start.
 */
export function resolveVaultRoot(argv: string[] = process.argv.slice(2)): string {
	const flagIdx = argv.indexOf("--vault");
	const raw = flagIdx !== -1 ? argv[flagIdx + 1] : process.env.AETHERSWEB_VAULT_PATH;

	if (!raw) {
		throw new Error(
			"[aethersweb-mcp-server] no vault path given — pass --vault <path> or set AETHERSWEB_VAULT_PATH",
		);
	}

	const root = resolve(raw);
	if (!existsSync(root) || !statSync(root).isDirectory()) {
		throw new Error(`[aethersweb-mcp-server] vault path does not exist or is not a directory: ${root}`);
	}
	return root;
}

/**
 * Resolves the port for HTTP mode: `--http <port>` wins over `AETHERSWEB_HTTP_PORT`. Returns
 * `undefined` when neither is set, which is what keeps stdio mode (one process per local client,
 * e.g. Claude Code on this machine) the default — HTTP mode is opt-in, not a replacement.
 */
export function resolveHttpPort(argv: string[] = process.argv.slice(2)): number | undefined {
	const flagIdx = argv.indexOf("--http");
	const raw = flagIdx !== -1 ? argv[flagIdx + 1] : process.env.AETHERSWEB_HTTP_PORT;
	if (!raw) return undefined;

	const port = Number(raw);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(`[aethersweb-mcp-server] invalid --http port: "${raw}"`);
	}
	return port;
}

/**
 * The bearer token HTTP mode requires on every request. Only called once HTTP mode is already
 * decided on (see resolveHttpPort) — stdio-only usage never needs this env var at all. Throws
 * rather than falling back to unauthenticated, since a network listener with no default is safer
 * than one with a guessable one.
 */
export function resolveHttpToken(): string {
	const token = process.env.AETHERSWEB_HTTP_TOKEN;
	if (!token) {
		throw new Error(
			"[aethersweb-mcp-server] --http/AETHERSWEB_HTTP_PORT is set but AETHERSWEB_HTTP_TOKEN is not — " +
				"refusing to start unauthenticated on a network port",
		);
	}
	return token;
}

/**
 * How often HTTP mode's headless reconciliation sweep (reconcile-sweep.ts) walks the whole vault.
 * Defaults to 5 minutes — frequent enough to fold in a phone-side Syncthing sync within a few
 * minutes, not so frequent it's constantly re-hashing every file. `0` disables the sweep entirely.
 */
export function resolveReconcileIntervalMinutes(): number {
	const raw = process.env.AETHERSWEB_RECONCILE_INTERVAL_MINUTES;
	if (!raw) return 5;

	const minutes = Number(raw);
	if (!Number.isFinite(minutes) || minutes < 0) {
		throw new Error(`[aethersweb-mcp-server] invalid AETHERSWEB_RECONCILE_INTERVAL_MINUTES: "${raw}"`);
	}
	return minutes;
}
