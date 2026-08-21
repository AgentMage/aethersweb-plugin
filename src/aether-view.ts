import { ItemView, Notice, setIcon, TFolder, WorkspaceLeaf } from "obsidian";
import type { ViewStateResult } from "obsidian";
import { verifyChain } from "./hash";
import { readLog } from "./log";
import { buildSpaceRef, findOwningSpace, immediateSubspaces, isSpace } from "./space";
import type AethersWebPlugin from "./main";
import type { SpaceRef, Spin, SpinPayload, SpinType } from "./types";

export const AETHER_VIEW_TYPE = "aethersweb-aether-view";

interface AetherLogViewState {
	spacePath?: string;
}

const TYPE_ICONS: Record<SpinType, string> = {
	space_created: "sparkles",
	file_created: "file-plus",
	file_modified: "file-pen-line",
	file_deleted: "file-x",
	file_renamed: "file-symlink",
	subspace_created: "folder-plus",
	subspace_removed: "folder-minus",
	checkpoint: "flag",
};

const ALL_TYPES: SpinType[] = [
	"space_created",
	"file_created",
	"file_modified",
	"file_deleted",
	"file_renamed",
	"subspace_created",
	"subspace_removed",
	"checkpoint",
];

function formatPayload(payload: SpinPayload): string {
	const parts: string[] = [];
	if (payload.path) parts.push(payload.path);
	if (payload.old_path) parts.push(`← ${payload.old_path}`);
	if (payload.subspace_name) parts.push(payload.subspace_name);
	if (payload.size !== undefined) parts.push(`${payload.size}B`);
	return parts.length > 0 ? parts.join("  ") : "—";
}

function formatRelativeTime(iso: string): string {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return iso;
	const diffMs = Date.now() - then;
	const sec = Math.round(diffMs / 1000);
	if (sec < 5) return "just now";
	if (sec < 60) return `${sec}s ago`;
	const min = Math.round(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.round(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.round(hr / 24);
	if (day < 30) return `${day}d ago`;
	return new Date(iso).toLocaleDateString();
}

function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return ((...args: never[]) => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => fn(...args), ms);
	}) as T;
}

/**
 * Read-only, table-per-space inspector for a single space's `.aether/log.jsonl`, opened via
 * "View .aether log" in a folder's right-click menu (see commands.ts). Renders it as a
 * database-style grid — one row per spin — rather than a file listing, since the log itself
 * (not the .aether/ folder's contents in general) is the thing worth inspecting: chain
 * integrity, seq/hash/prev_hash linkage, observed vs detected provenance.
 *
 * `.aether/` is a dotfolder Obsidian never indexes into the vault tree, so this reads the log
 * directly via readLog() (raw adapter), same as the rest of the plugin's own .aether/ I/O.
 */
export class AetherLogView extends ItemView {
	private plugin: AethersWebPlugin;
	private spacePath: string | null = null;

	// In-memory only — reset per render(), not persisted across reloads.
	private cachedLog: Spin[] = [];
	private searchQuery = "";
	private excludedTypes = new Set<SpinType>();
	private detectedOnly = false;
	private newestFirst = true;
	private expandedSeqs = new Set<number>();
	private tableWrap: HTMLElement | null = null;
	private brokenAtSeq: number | undefined;

	constructor(leaf: WorkspaceLeaf, plugin: AethersWebPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return AETHER_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.spacePath ? `.aether: ${this.spacePath.split("/").pop()}` : ".aether log";
	}

	getIcon(): string {
		return "database";
	}

	getState(): Record<string, unknown> {
		return { spacePath: this.spacePath };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const spacePath = (state as AetherLogViewState | undefined)?.spacePath;
		if (typeof spacePath === "string" && spacePath !== this.spacePath) {
			this.spacePath = spacePath;
			this.searchQuery = "";
			this.excludedTypes.clear();
			this.detectedOnly = false;
			this.expandedSeqs.clear();
		}
		await super.setState(state, result);
		await this.render();
	}

	async onOpen(): Promise<void> {
		this.addAction("refresh-cw", "Refresh", () => this.render());
		this.addAction("copy", "Copy log as JSON", async () => {
			await navigator.clipboard.writeText(JSON.stringify(this.cachedLog, null, 2));
			new Notice("AethersWeb: log copied as JSON");
		});
		await this.render();
	}

	private async switchTo(spacePath: string): Promise<void> {
		await this.leaf.setViewState({
			type: AETHER_VIEW_TYPE,
			active: true,
			state: { spacePath },
		});
	}

	private async render(): Promise<void> {
		const { app, contentEl } = this;
		contentEl.empty();
		contentEl.addClass("aetherweb-log-view");

		if (!this.spacePath) {
			this.renderEmpty(contentEl, "database", 'Right-click a space folder → "View .aether log" to open one here.');
			return;
		}

		const folder = app.vault.getAbstractFileByPath(this.spacePath);
		if (!(folder instanceof TFolder) || !(await isSpace(folder, app))) {
			this.renderEmpty(contentEl, "alert-triangle", `"${this.spacePath}" is not a claimed space (or no longer exists).`);
			return;
		}

		const ref = buildSpaceRef(folder);
		this.cachedLog = await readLog(ref, app);
		const result = verifyChain(this.cachedLog);

		// ---- header: title + chain badge ----
		const header = contentEl.createDiv({ cls: "aetherweb-log-header" });
		const titleWrap = header.createDiv({ cls: "aetherweb-log-title" });
		titleWrap.createEl("h3", { text: ref.path });

		const badge = header.createDiv({
			cls: `aetherweb-chain-badge ${result.ok ? "is-ok" : "is-broken"}`,
		});
		setIcon(badge, result.ok ? "check-circle-2" : "alert-circle");
		badge.createSpan({
			text: result.ok ? "chain OK" : `BROKEN @ seq ${result.brokenAtSeq} (${result.reason})`,
		});

		await this.renderNav(contentEl, ref);

		if (this.cachedLog.length === 0) {
			this.renderEmpty(contentEl, "inbox", "This space's log is empty.");
			return;
		}

		// ---- stat chips ----
		const counts = new Map<SpinType, number>();
		let detectedCount = 0;
		for (const spin of this.cachedLog) {
			counts.set(spin.spin_type, (counts.get(spin.spin_type) ?? 0) + 1);
			if (spin.source === "detected") detectedCount++;
		}
		const statRow = contentEl.createDiv({ cls: "aetherweb-stat-row" });
		statRow.createSpan({ cls: "aetherweb-stat-chip", text: `${this.cachedLog.length} spin(s)` });
		if (detectedCount > 0) {
			statRow.createSpan({ cls: "aetherweb-stat-chip is-detected", text: `${detectedCount} detected` });
		}
		for (const type of ALL_TYPES) {
			const n = counts.get(type);
			if (n) statRow.createSpan({ cls: "aetherweb-stat-chip", text: `${n} ${type}` });
		}

		// ---- toolbar: search, type filters, detected-only, order ----
		const toolbar = contentEl.createDiv({ cls: "aetherweb-toolbar" });
		const search = toolbar.createEl("input", {
			cls: "aetherweb-search-input",
			attr: { type: "text", placeholder: "Filter by path, subspace, or type…" },
		});
		search.value = this.searchQuery;
		const onSearch = debounce(() => {
			this.searchQuery = search.value;
			this.renderTable();
		}, 150);
		search.addEventListener("input", onSearch);

		const typeFilters = toolbar.createDiv({ cls: "aetherweb-type-filters" });
		for (const type of ALL_TYPES) {
			if (!counts.get(type)) continue;
			const active = !this.excludedTypes.has(type);
			const chip = typeFilters.createSpan({
				cls: `aetherweb-type-chip type-${type} ${active ? "is-active" : "is-inactive"}`,
				text: type,
			});
			chip.addEventListener("click", () => {
				const nowActive = this.excludedTypes.has(type); // about to flip, so this is the state we're entering
				if (this.excludedTypes.has(type)) this.excludedTypes.delete(type);
				else this.excludedTypes.add(type);
				chip.toggleClass("is-active", nowActive);
				chip.toggleClass("is-inactive", !nowActive);
				this.renderTable();
			});
		}

		const detectedBtn = toolbar.createEl("button", {
			cls: `aetherweb-toolbar-btn ${this.detectedOnly ? "is-active" : ""}`,
			text: "Detected only",
		});
		detectedBtn.addEventListener("click", () => {
			this.detectedOnly = !this.detectedOnly;
			detectedBtn.toggleClass("is-active", this.detectedOnly);
			this.renderTable();
		});

		const orderBtn = toolbar.createEl("button", { cls: "aetherweb-toolbar-btn", text: "" });
		const setOrderLabel = () => {
			orderBtn.setText(this.newestFirst ? "Newest first" : "Oldest first");
		};
		setOrderLabel();
		orderBtn.addEventListener("click", () => {
			this.newestFirst = !this.newestFirst;
			setOrderLabel();
			this.renderTable();
		});

		// ---- table (rebuilt independently on filter/search/order changes) ----
		this.tableWrap = contentEl.createDiv({ cls: "aetherweb-table-wrap" });
		this.renderTable(result.ok ? undefined : result.brokenAtSeq);
	}

	/**
	 * Simple up/down navigation scoped to the current space: a "goto" link to its immediate
	 * super-space (if any) and one per immediate sub-space. Deliberately not a vault-wide tree —
	 * that was tried and didn't earn its keep; this only ever shows what's one hop away from
	 * wherever you already are.
	 */
	private async renderNav(container: HTMLElement, ref: SpaceRef): Promise<void> {
		const { app } = this;
		const nav = container.createDiv({ cls: "aetherweb-nav" });

		const parentRef = await findOwningSpace(ref.folder.parent, app);
		if (parentRef) {
			const up = nav.createSpan({ cls: "aetherweb-nav-link is-up" });
			setIcon(up, "arrow-up");
			up.createSpan({ text: parentRef.folder.name });
			up.addEventListener("click", () => void this.switchTo(parentRef.path));
		}

		const children = await immediateSubspaces(ref, app);
		for (const child of children) {
			const down = nav.createSpan({ cls: "aetherweb-nav-link is-down" });
			setIcon(down, "arrow-down");
			down.createSpan({ text: child.folder.name });
			down.addEventListener("click", () => void this.switchTo(child.path));
		}

		if (!parentRef && children.length === 0) {
			nav.createSpan({ cls: "aetherweb-nav-empty", text: "No super-space or sub-spaces." });
		}
	}

	private renderEmpty(container: HTMLElement, icon: string, text: string): void {
		const empty = container.createDiv({ cls: "aetherweb-log-empty" });
		const iconEl = empty.createDiv();
		setIcon(iconEl, icon);
		empty.createEl("p", { text });
	}

	private renderTable(brokenAtSeq?: number): void {
		if (brokenAtSeq !== undefined) this.brokenAtSeq = brokenAtSeq;
		const wrap = this.tableWrap;
		if (!wrap) return;
		wrap.empty();

		const query = this.searchQuery.trim().toLowerCase();
		let rows = this.cachedLog.filter((spin) => {
			if (this.excludedTypes.has(spin.spin_type)) return false;
			if (this.detectedOnly && spin.source !== "detected") return false;
			if (!query) return true;
			const haystack = [
				spin.spin_type,
				spin.source,
				spin.payload.path,
				spin.payload.old_path,
				spin.payload.subspace_name,
			]
				.filter(Boolean)
				.join(" ")
				.toLowerCase();
			return haystack.includes(query);
		});
		if (this.newestFirst) rows = [...rows].reverse();

		if (rows.length === 0) {
			wrap.createEl("p", { text: "No spins match the current filters.", attr: { style: "padding: 16px; color: var(--text-muted);" } });
			return;
		}

		const table = wrap.createEl("table", { cls: "aetherweb-log-table" });
		const headRow = table.createEl("thead").createEl("tr");
		for (const col of ["seq", "when", "type", "source", "details", "hash", "prev"]) {
			headRow.createEl("th", { text: col });
		}

		const tbody = table.createEl("tbody");
		for (const spin of rows) {
			const row = tbody.createEl("tr", {
				cls: spin.seq === this.brokenAtSeq ? "is-broken-row" : "",
			});

			row.createEl("td", { text: String(spin.seq), cls: "aetherweb-seq-cell" });
			row.createEl("td", { text: formatRelativeTime(spin.ts), attr: { title: spin.ts } });

			const typeCell = row.createEl("td");
			const typePill = typeCell.createSpan({ cls: `aetherweb-type-pill type-${spin.spin_type}` });
			setIcon(typePill, TYPE_ICONS[spin.spin_type] ?? "circle");
			typePill.createSpan({ text: spin.spin_type });

			const sourceCell = row.createEl("td");
			sourceCell.createSpan({
				cls: `aetherweb-source-pill ${spin.source === "detected" ? "is-detected" : "is-observed"}`,
				text: spin.source,
			});

			row.createEl("td", { text: formatPayload(spin.payload), cls: "aetherweb-col-payload" });

			const hashCell = row.createEl("td", {
				text: `${spin.hash.slice(0, 10)}…`,
				cls: "aetherweb-hash-chip",
				attr: { title: `${spin.hash} (click to copy)` },
			});
			hashCell.addEventListener("click", (evt) => {
				evt.stopPropagation();
				void navigator.clipboard.writeText(spin.hash);
				new Notice("AethersWeb: hash copied");
			});

			if (spin.prev_hash) {
				const prevCell = row.createEl("td", {
					text: `${spin.prev_hash.slice(0, 10)}…`,
					cls: "aetherweb-hash-chip",
					attr: { title: `${spin.prev_hash} (click to copy)` },
				});
				prevCell.addEventListener("click", (evt) => {
					evt.stopPropagation();
					void navigator.clipboard.writeText(spin.prev_hash as string);
					new Notice("AethersWeb: hash copied");
				});
			} else {
				row.createEl("td", { text: "—" });
			}

			row.addEventListener("click", () => {
				if (this.expandedSeqs.has(spin.seq)) this.expandedSeqs.delete(spin.seq);
				else this.expandedSeqs.add(spin.seq);
				this.renderTable();
			});

			if (this.expandedSeqs.has(spin.seq)) {
				const detailRow = tbody.createEl("tr", { cls: "aetherweb-detail-row" });
				const cell = detailRow.createEl("td", { attr: { colspan: "7" } });
				cell.createEl("pre", { text: JSON.stringify(spin, null, 2) });
			}
		}
	}
}
