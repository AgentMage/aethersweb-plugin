import type { App, TFile } from "obsidian";
import { BINARY_EXTENSIONS } from "./constants";
import { computeDiff } from "./diff";
import { appendSpin, readLog } from "./log";
import { foldLogToLastKnownContent } from "./content-fold";
import { hashFile } from "./space";
import type { SpaceRef, Spin, SpinPayload, SpinSource } from "./types";

/**
 * The single place a file_created/file_modified spin gets its content built — shared by
 * events.ts (observed) and reconcile.ts (detected) so the diff-vs-snapshot decision is made
 * once, not duplicated per call site. Always writes real content into the log (never just a
 * hash): full content for file_created and for binary changes, a unified diff for text changes
 * against whatever the log itself last recorded.
 *
 * `log`, if the caller already has it in hand (reconcile.ts's loop does), avoids a redundant
 * read; omitted, it's read fresh — the common case for events.ts's one-file-at-a-time calls.
 */
export async function recordFileContentSpin(
	ref: SpaceRef,
	spin_type: "file_created" | "file_modified",
	path: string,
	file: TFile,
	source: SpinSource,
	app: App,
	log?: Spin[],
): Promise<Spin> {
	const binary = BINARY_EXTENSIONS.has(file.extension.toLowerCase());
	const content_hash = await hashFile(file, app);
	const payload: SpinPayload = { path, content_hash, size: file.stat.size };

	if (binary) {
		payload.content = Buffer.from(await app.vault.readBinary(file)).toString("base64");
		payload.encoding = "base64";
	} else {
		const newText = await app.vault.cachedRead(file);
		if (spin_type === "file_created") {
			payload.content = newText;
			payload.encoding = "utf8";
		} else {
			const priorLog = log ?? (await readLog(ref, app));
			const prior = foldLogToLastKnownContent(priorLog)[path];
			if (prior?.content != null && prior.encoding === "utf8") {
				payload.diff = computeDiff(prior.content, newText);
				payload.encoding = "utf8";
			} else {
				// No usable text baseline (pre-instrumentation history, or the prior version was
				// recorded as binary) — fall back to a full snapshot rather than diff against nothing.
				payload.content = newText;
				payload.encoding = "utf8";
			}
		}
	}

	return appendSpin(ref, spin_type, source, payload, app);
}
