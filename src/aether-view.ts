import { ItemView, WorkspaceLeaf } from "obsidian";
import { readHead, readLog } from "./log";
import { walkSpaces } from "./space";
import type AethersWebPlugin from "./main";

export const AETHER_VIEW_TYPE = "aethersweb-aether-view";

/**
 * Read-only inspector panel listing every space's `.aether/` folder and its contents. Exists
 * because `.aether/` is Obsidian-ignored (dotfolders are never indexed into the vault tree — see
 * log.ts), so there is nothing for a CSS visibility toggle to reveal: the File Explorer literally
 * has no DOM nodes for `.aether/` content. This view instead reads it directly via the raw
 * adapter (the same path all of .aether/'s own I/O already goes through) and renders it itself.
 */
export class AetherFolderView extends ItemView {
	private plugin: AethersWebPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: AethersWebPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return AETHER_VIEW_TYPE;
	}

	getDisplayText(): string {
		return ".aether folders";
	}

	getIcon(): string {
		return "eye";
	}

	async onOpen(): Promise<void> {
		this.addAction("refresh-cw", "Refresh", () => this.render());
		await this.render();
	}

	private async render(): Promise<void> {
		const { app, contentEl } = this;
		contentEl.empty();
		contentEl.addClass("aetherweb-aether-view");
		contentEl.createEl("h4", { text: ".aether folders" });

		const refs = [];
		for await (const ref of walkSpaces(app)) refs.push(ref);

		if (refs.length === 0) {
			contentEl.createEl("p", { text: "No claimed spaces found." });
			return;
		}

		for (const ref of refs) {
			const section = contentEl.createDiv({ attr: { style: "margin-bottom: 14px;" } });
			section.createEl("div", { text: ref.path || "/", attr: { style: "font-weight: 600;" } });

			const log = await readLog(ref, app);
			const head = await readHead(ref, app);
			section.createEl("div", {
				text: `${log.length} spin(s) — head ${head ? head.slice(0, 12) : "(none)"}`,
				attr: { style: "font-size: 0.85em; color: var(--text-muted);" },
			});

			const listing = await app.vault.adapter.list(ref.aetherDir);
			const list = section.createEl("ul", { attr: { style: "margin: 4px 0 0 0; padding-left: 18px;" } });
			for (const folderPath of listing.folders) {
				list.createEl("li", { text: `${folderPath.split("/").pop()}/` });
			}
			for (const filePath of listing.files) {
				list.createEl("li", { text: filePath.split("/").pop() ?? filePath });
			}
		}
	}
}
