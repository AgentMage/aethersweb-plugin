import { reconcileSpaceFs } from "./reconcile-fs";
import { walkSpacesFs } from "./space-fs";

/**
 * The headless equivalent of the Obsidian plugin's own timer/focus-triggered `reconcile()`,
 * needed because HTTP mode can run for hours or days with no plugin open to ever notice a file a
 * sync client (Syncthing, in the deployed setup) dropped into the vault from another device.
 * Only started from server.ts's HTTP branch — a one-shot local stdio invocation already has the
 * plugin's own reconciliation, or a manual reconcile_space tool call, covering the same case.
 *
 * `walkSpacesFs` already flattens the whole vault tree, so one `reconcileSpaceFs` call per
 * yielded space is correct and sufficient on its own — no need for the recursive
 * `reconcileSubtreeFs` wrapper, which exists for the tool surface's per-subtree scoping, not a
 * whole-vault sweep.
 */
export function startReconcileSweep(vaultRoot: string, intervalMinutes: number): () => void {
	if (intervalMinutes <= 0) return () => {}; // 0 disables, matching the plugin's own convention

	let running = false; // single-flight, mirrors plugin.reconcile()'s spirit — no overlapping sweeps
	const sweepOnce = async (): Promise<void> => {
		if (running) return;
		running = true;
		try {
			for await (const ref of walkSpacesFs(vaultRoot)) {
				await reconcileSpaceFs(vaultRoot, ref);
			}
		} catch (err) {
			console.error("[aethersweb-mcp-server] reconciliation sweep failed:", err);
		} finally {
			running = false;
		}
	};

	void sweepOnce(); // catch up immediately on startup rather than waiting a full interval
	const timer = setInterval(() => void sweepOnce(), intervalMinutes * 60_000);
	return () => clearInterval(timer);
}
