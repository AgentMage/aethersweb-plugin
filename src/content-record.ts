import type { App, TFile } from "obsidian";
import { BINARY_EXTENSIONS } from "./core/constants";
import { computeDiff } from "./core/diff";
import { appendSpinGuarded } from "./log";
import { foldLogToLastKnownContent } from "./core/content-fold";
import { shouldRecordFileContent } from "./core/guards";
import { hashFile } from "./space";
import type { SpaceRef, Spin, SpinPayload, SpinSource } from "./types";

/**
 * The single place a file_created/file_modified spin gets its content built — shared by
 * events.ts (observed) and reconcile.ts (detected) so the diff-vs-snapshot decision is made
 * once, not duplicated per call site. Always writes real content into the log (never just a
 * hash): full content for file_created and for binary changes, a unified diff for text changes
 * against whatever the log itself last recorded.
 *
 * Returns null when the log already records this exact content at this path — Obsidian fires
 * `modify` on every save, including saves that changed nothing, and the debounce window merges
 * keystrokes but cannot tell a real edit from a no-op one. Writing those anyway costs a permanent
 * line of history and a full diff payload to say "nothing happened"; a real vault had already
 * accumulated several. The check is exact, not heuristic: same path, same content_hash, not
 * deleted.
 *
 * The whole read-log/decide/append sequence runs under this space's lock via appendSpinGuarded,
 * so the baseline a diff is computed against is the same log line the diff is appended after —
 * it cannot be overtaken by a concurrent append between the two.
 */
export async function recordFileContentSpin(
	ref: SpaceRef,
	spin_type: "file_created" | "file_modified",
	path: string,
	file: TFile,
	source: SpinSource,
	app: App,
): Promise<Spin | null> {
	const binary = BINARY_EXTENSIONS.has(file.extension.toLowerCase());
	const content_hash = await hashFile(file, app);

	return appendSpinGuarded(ref, app, async (log) => {
		if (!shouldRecordFileContent(log, path, content_hash)) return null;

		const payload: SpinPayload = { path, content_hash, size: file.stat.size };

		if (binary) {
			payload.content = Buffer.from(await app.vault.readBinary(file)).toString("base64");
			payload.encoding = "base64";
		} else {
			const newText = await app.vault.cachedRead(file);
			payload.encoding = "utf8";
			const prior = spin_type === "file_modified" ? foldLogToLastKnownContent(log)[path] : undefined;
			if (prior?.content != null && prior.encoding === "utf8") {
				payload.diff = computeDiff(prior.content, newText);
			} else {
				// No usable text baseline (a create, pre-instrumentation history, or a prior version
				// recorded as binary) — full snapshot rather than a diff against nothing.
				payload.content = newText;
			}
		}

		return { spin_type, source, payload };
	});
}
