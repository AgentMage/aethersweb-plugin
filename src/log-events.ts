/**
 * Tiny in-process pub/sub for ".aether/log.jsonl at this path just changed." `.aether/` is a
 * dotfolder Obsidian never indexes, so its own vault "modify" events never fire for a log write —
 * every write to any space's log funnels through appendSpin/rewriteLog in log.ts, so notifying
 * from there is the one place that reliably catches all of them: live "observed" writes,
 * reconciliation's "detected" writes, and repair.ts's rewrites alike. Used by aether-view.ts to
 * auto-refresh the log view for whichever space it's currently showing, without polling.
 */
type Listener = () => void;

const listeners = new Map<string, Set<Listener>>();

export function onLogChanged(logPath: string, cb: Listener): void {
	let set = listeners.get(logPath);
	if (!set) {
		set = new Set();
		listeners.set(logPath, set);
	}
	set.add(cb);
}

export function offLogChanged(logPath: string, cb: Listener): void {
	const set = listeners.get(logPath);
	if (!set) return;
	set.delete(cb);
	if (set.size === 0) listeners.delete(logPath);
}

export function notifyLogChanged(logPath: string): void {
	const set = listeners.get(logPath);
	if (!set) return;
	for (const cb of set) cb();
}
