import type { App } from "obsidian";
import { normalizePath } from "obsidian";
import { verifyChain } from "./core/hash";
import { appendSpin, readHead, readLog, rewriteLog } from "./log";
import { regenerateContext } from "./context";
import type { SpaceRef, Spin, VerifyResult } from "./types";

export interface ChainRepairPlan {
	reason: VerifyResult["reason"];
	strategy: "fork_reconciled" | "truncated";
	/** Spins to keep, byte-for-byte unchanged, forming the new authoritative log. Already valid. */
	keep: Spin[];
	/** Spins removed from the authoritative chain — preserved verbatim in a quarantine file. */
	quarantine: Spin[];
}

/**
 * Diagnoses a broken chain and proposes a non-destructive fix. Two strategies, tried in order:
 *
 * 1. fork_reconciled — the shape left by the appendSpin race this plugin used to have (fixed in
 *    log.ts, see withLogLock): two spins computed from the same stale tail, so they share a seq
 *    and a prev_hash. Exactly one side of that fork is "live" — the one everything after it
 *    actually chains from — and by construction `head` always points into the live branch (it's
 *    whichever append's writeHead ran last). Walking backward from `head` via prev_hash
 *    reconstructs that live branch losslessly. The other branch is always a dead leaf (nothing
 *    was ever built on it, or it wouldn't be a fork) and gets quarantined whole. No reseq, no
 *    rehash, no lost history on the kept side — every kept spin's bytes are untouched, so its
 *    tamper-evidence up to this point stays intact.
 * 2. truncated — fallback for anything the fork walk can't cleanly explain (a genuinely
 *    corrupted/tampered line, a missing or dangling head). Keeps the longest prefix that still
 *    verifies clean on its own and quarantines everything from the first break onward;
 *    reconciliation will re-observe any real on-disk state afterward as fresh `detected` spins.
 *
 * Returns null if the chain isn't actually broken — nothing to repair.
 */
export function planChainRepair(log: Spin[], head: string | null): ChainRepairPlan | null {
	const verify = verifyChain(log);
	if (verify.ok) return null;

	return tryForkReconcile(log, head, verify.reason) ?? truncateAtBreak(log, verify);
}

function tryForkReconcile(
	log: Spin[],
	head: string | null,
	reason: VerifyResult["reason"],
): ChainRepairPlan | null {
	if (!head) return null;
	const byHash = new Map(log.map((s) => [s.hash, s] as const));
	let cur = byHash.get(head);
	if (!cur) return null;

	const chain: Spin[] = [];
	const seen = new Set<string>();
	while (cur) {
		if (seen.has(cur.hash)) return null; // cycle — not this bug's shape, fall back to truncation
		seen.add(cur.hash);
		chain.push(cur);
		if (cur.prev_hash === null) break;
		cur = byHash.get(cur.prev_hash);
		if (!cur) return null; // a parent is missing entirely — not a clean fork, fall back
	}
	chain.reverse();
	if (!verifyChain(chain).ok) return null; // reconstructed branch must itself be clean

	// Quarantine = every raw log line not consumed as the one representative its hash needed in
	// `chain`. Set-membership alone isn't enough here: a *literal* duplicate line (identical hash
	// appended twice, e.g. the same observed event double-fired) would otherwise vanish silently
	// instead of being preserved — one copy is the kept representative, the other still needs
	// somewhere to go.
	const unclaimed = new Set(seen);
	const quarantine: Spin[] = [];
	for (const line of log) {
		if (unclaimed.has(line.hash)) {
			unclaimed.delete(line.hash); // first occurrence claimed as the kept representative
		} else {
			quarantine.push(line);
		}
	}
	return { reason, strategy: "fork_reconciled", keep: chain, quarantine };
}

function truncateAtBreak(log: Spin[], verify: VerifyResult): ChainRepairPlan {
	// Longest prefix (by array position) that still verifies clean entirely on its own.
	let goodLength = 0;
	for (let i = 0; i < log.length; i++) {
		if (!verifyChain(log.slice(0, i + 1)).ok) break;
		goodLength = i + 1;
	}
	return {
		reason: verify.reason,
		strategy: "truncated",
		keep: log.slice(0, goodLength),
		quarantine: log.slice(goodLength),
	};
}

/**
 * Applies a chain repair: preserves every quarantined spin verbatim in a new timestamped file
 * alongside the log, replaces log.jsonl with just the kept (already-valid) spins, then appends a
 * `chain_repaired` audit spin — which also fixes head, as a normal side effect of appendSpin
 * reading the now-clean tail. The repair itself becomes part of the chain, not a silent rewrite
 * of history. Re-diagnoses fresh from disk rather than trusting a plan computed earlier (e.g. in
 * a confirmation dialog the user sat on) — if nothing's broken by the time this runs, it's a
 * no-op.
 */
export async function applyChainRepair(ref: SpaceRef, app: App): Promise<ChainRepairPlan | null> {
	const log = await readLog(ref, app);
	const head = await readHead(ref, app);
	const plan = planChainRepair(log, head);
	if (!plan) return null;

	const quarantineFile = `quarantine-${Date.now()}.jsonl`;
	const quarantinePath = normalizePath(`${ref.aetherDir}/${quarantineFile}`);
	const quarantineText = plan.quarantine.map((s) => JSON.stringify(s)).join("\n") + "\n";
	await app.vault.adapter.write(quarantinePath, quarantineText);

	await rewriteLog(ref, plan.keep, app);

	await appendSpin(
		ref,
		"chain_repaired",
		"observed",
		{
			broken_reason: plan.reason,
			repair_strategy: plan.strategy,
			quarantined_count: plan.quarantine.length,
			quarantine_file: quarantineFile,
		},
		app,
	);

	await regenerateContext(ref, app);
	return plan;
}
