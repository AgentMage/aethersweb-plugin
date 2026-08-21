import { sha256Hex, sha256HexBase64 } from "./hash";
import { foldLogToLastKnownFiles } from "./reconcile";
import { foldLogToLastKnownContent } from "./content-fold";
import type { Spin } from "./types";

export interface ContentMismatch {
	path: string;
	expectedHash: string;
	/** null when the log had no reconstructable baseline for this path at all. */
	reconstructedHash: string | null;
}

export interface ContentVerifyResult {
	ok: boolean;
	/** Paths whose reconstructed content was checked against the log's own recorded hash. */
	checked: number;
	/** Paths with a known baseline whose reconstructed content did NOT match the recorded hash. */
	mismatches: ContentMismatch[];
	/** Paths with no reconstructable baseline (history predates this feature) — informational, not failures. */
	unverifiable: string[];
}

/**
 * The check that makes "the log can reconstruct current state" a strict, verified rule rather
 * than an assumption — the content analogue of verifyChain's hash-chain check. For every
 * non-deleted path the log knows about, replays file_created's content + each file_modified's
 * diff (foldLogToLastKnownContent) and confirms the result hashes to the same content_hash the
 * log itself last recorded for that path (foldLogToLastKnownFiles). A path whose earliest spin
 * predates this feature (no content/diff ever recorded) has no baseline to replay — that's
 * reported separately as `unverifiable`, not as a mismatch, since it's a known, called-out gap
 * (see CLAUDE.md), not a corruption.
 */
export function verifyContentReplay(log: Spin[]): ContentVerifyResult {
	const knownHashes = foldLogToLastKnownFiles(log);
	const knownContent = foldLogToLastKnownContent(log);

	let checked = 0;
	const mismatches: ContentMismatch[] = [];
	const unverifiable: string[] = [];

	for (const [path, hashEntry] of Object.entries(knownHashes)) {
		if (hashEntry.deleted) continue;
		const contentEntry = knownContent[path];

		if (contentEntry?.content == null) {
			unverifiable.push(path);
			continue;
		}

		checked++;
		// Binary content is hashed the same way hashFile (space.ts) hashes it on disk — as raw
		// bytes, not as the base64 string that carries those bytes through the log.
		const reconstructedHash =
			contentEntry.encoding === "base64"
				? sha256HexBase64(contentEntry.content)
				: sha256Hex(contentEntry.content);
		if (reconstructedHash !== hashEntry.hash) {
			mismatches.push({ path, expectedHash: hashEntry.hash, reconstructedHash });
		}
	}

	return { ok: mismatches.length === 0, checked, mismatches, unverifiable };
}
