import { createHash } from "crypto";
import type { Spin, SpinDraft, SpinPayload, VerifyResult } from "./types";

export function sha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

export function sha256HexBytes(bytes: ArrayBuffer): string {
	return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

/** Hashes the raw bytes a base64 string decodes to — matches sha256HexBytes' result for the same bytes. */
export function sha256HexBase64(base64: string): string {
	return createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
}

/** Recursively sorts object keys so payload serialization never depends on insertion order. */
function sortedPayload(payload: SpinPayload): SpinPayload {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(payload).sort()) {
		out[key] = (payload as Record<string, unknown>)[key];
	}
	return out as SpinPayload;
}

/**
 * Deterministic serialization of a spin, EXCLUDING its own `hash` field (a spin can't hash
 * itself). Fixed key order so this never depends on JSON.stringify's insertion-order behavior
 * across differently-shaped payloads.
 */
export function canonicalSpinString(spin: SpinDraft): string {
	return JSON.stringify({
		seq: spin.seq,
		ts: spin.ts,
		spin_type: spin.spin_type,
		source: spin.source,
		payload: sortedPayload(spin.payload),
		prev_hash: spin.prev_hash,
	});
}

export function computeSpinHash(spinWithoutHash: SpinDraft): string {
	return sha256Hex(canonicalSpinString(spinWithoutHash));
}

/** Builds and hashes the next spin in a space's chain, given the previous spin (or null at seq 0). */
export function buildNextSpin(
	prevSpin: Spin | null,
	seq: number,
	spin_type: Spin["spin_type"],
	source: Spin["source"],
	payload: SpinPayload,
	ts: string = new Date().toISOString(),
): Spin {
	const draft: SpinDraft = {
		seq,
		ts,
		spin_type,
		source,
		payload,
		prev_hash: prevSpin ? prevSpin.hash : null,
	};
	return { ...draft, hash: computeSpinHash(draft) };
}

/**
 * Walks a space's log top to bottom, recomputing each line's hash from its own fields and
 * confirming: (1) it matches the stored `hash`, (2) `prev_hash` matches the previous line's
 * stored `hash` (or is null at seq 0), (3) `seq` increases by exactly 1 from 0. Stops and
 * reports at the first break — a chain is either fully intact up to some point, or it isn't.
 */
export function verifyChain(spins: Spin[]): VerifyResult {
	let prevHash: string | null = null;
	for (let i = 0; i < spins.length; i++) {
		const spin = spins[i];

		if (spin.seq !== i) {
			return { ok: false, length: spins.length, brokenAtSeq: spin.seq, reason: "seq_gap" };
		}
		if (spin.prev_hash !== prevHash) {
			return { ok: false, length: spins.length, brokenAtSeq: spin.seq, reason: "prev_hash_mismatch" };
		}
		const { hash, ...rest } = spin;
		const recomputed = computeSpinHash(rest);
		if (recomputed !== hash) {
			return { ok: false, length: spins.length, brokenAtSeq: spin.seq, reason: "hash_mismatch" };
		}
		prevHash = hash;
	}
	return { ok: true, length: spins.length };
}
