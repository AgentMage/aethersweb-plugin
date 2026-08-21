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
