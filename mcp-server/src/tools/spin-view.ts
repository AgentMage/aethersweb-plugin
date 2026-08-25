import type { Spin, SpinPayload } from "../../../src/core/types";

/**
 * What a spin looks like on the wire, as opposed to in the log.
 *
 * The log carries real content — full text on create, a unified diff on every text change, base64
 * on binary — and that is the point of it: replaying a path's spins reconstructs what a file said
 * at any moment, not merely that it changed. None of that needs to travel back to the caller who
 * just wrote it. A `write_file` that answers with the 8 KB it was handed a moment ago has told the
 * model nothing it did not already know, at the cost of the one budget a long session actually
 * runs out of.
 *
 * So every tool that hands back a spin hands back this instead, and the flags to opt into the bytes
 * are off by default. Nothing about the log changes — `read_log(include_content: true)` still
 * returns every byte, which is the proof that this is a view and not a loss.
 *
 * Deliberately its own type rather than a `Spin` with fields bolted on: `content_omitted` is a fact
 * about *this response*, not about the log, and `Spin` is the shape the hash chain is computed
 * over. A caller must never be able to confuse "I did not ask for the bytes" with "the log has no
 * bytes" — the second is a real and different state (see `verifyContentReplay`'s `unverifiable`).
 */
export type SpinView = Omit<Spin, "payload"> & {
	payload: Omit<SpinPayload, "content" | "diff"> & {
		content?: string;
		diff?: string;
		/** Set only when this response dropped bytes the log does hold. */
		content_omitted?: true;
		/** How many bytes were dropped, so a caller can judge whether to ask for them. */
		content_bytes?: number;
	};
};

export interface SpinViewOptions {
	/** Include `payload.content` — the full recorded text/base64. Off by default. */
	content?: boolean;
	/** Include `payload.diff` — the recorded unified diff. Off by default. */
	diff?: boolean;
}

export function viewSpin(spin: Spin, options?: SpinViewOptions): SpinView;
export function viewSpin(spin: Spin | null, options?: SpinViewOptions): SpinView | null;
/**
 * Strips the bytes out of a spin's payload, re-adding whichever the caller asked for.
 *
 * A payload with neither field — a rename, a delete, a subspace event — passes through untouched
 * and, importantly, un-annotated: `content_omitted` appears only where something was actually
 * dropped, so its presence always means the log has more than this response does.
 */
export function viewSpin(spin: Spin | null, options: SpinViewOptions = {}): SpinView | null {
	if (spin === null) return null;
	const { content, diff, ...rest } = spin.payload;
	const payload: SpinView["payload"] = { ...rest };

	if (options.content && content !== undefined) payload.content = content;
	if (options.diff && diff !== undefined) payload.diff = diff;

	// Count what the log holds and this response does not — not what the log holds overall.
	const droppedContent = options.content ? undefined : content;
	const droppedDiff = options.diff ? undefined : diff;
	const droppedBytes =
		(droppedContent === undefined ? 0 : Buffer.byteLength(droppedContent, "utf8")) +
		(droppedDiff === undefined ? 0 : Buffer.byteLength(droppedDiff, "utf8"));
	if (droppedBytes > 0) {
		payload.content_omitted = true;
		payload.content_bytes = droppedBytes;
	}

	return { ...spin, payload };
}
