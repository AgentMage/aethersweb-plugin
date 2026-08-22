import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BINARY_EXTENSIONS } from "../../src/core/constants";
import { foldLogToLastKnownContent } from "../../src/core/content-fold";
import { computeDiff } from "../../src/core/diff";
import { shouldRecordFileContent } from "../../src/core/guards";
import { isIgnoredPath } from "../../src/core/ignore";
import { isStatementWritable, writeSignedStatement } from "../../src/core/statement";
import type { Spin, SpinPayload, SpinSource } from "../../src/core/types";
import { buildSpaceRefFs, hashFileFs, isSpaceFs } from "./space-fs";
import type { SpaceRefFs } from "./space-fs";
import { appendSpinGuardedFs } from "./vault-io";

/**
 * The authoring layer: everything that changes the vault rather than reporting on it.
 *
 * The plugin cannot cover these. Its event handlers only fire while Obsidian is running, which is
 * exactly not the case this layer exists for — an agent working the vault headlessly, on a VPS or
 * from a phone, with no Obsidian process anywhere. So each function here does what the plugin's
 * event handler would have done: perform the change, then record it in the owning space's log
 * through the same guarded append and the same `core/guards.ts` predicates, so a write made by
 * this server and a write made by the plugin are indistinguishable in the resulting history.
 *
 * Everything is written as `observed`, and that is accurate rather than convenient: this process
 * performed the change itself and watched it happen. `detected` remains reserved for
 * reconciliation inferring, after the fact, something nobody witnessed.
 */

export class WriteError extends Error {}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Rejects a relative path that would escape its space, reach into a subspace's contents, or name
 * something the log is defined never to mention. A space's log records its *own* level only — a
 * write that lands inside a subspace has to be logged by that subspace, so it is refused here
 * rather than silently mis-filed.
 */
export async function resolveWritablePath(
	vaultRoot: string,
	ref: SpaceRefFs,
	relPath: string,
): Promise<string> {
	if (relPath.length === 0) throw new WriteError("path is empty");
	if (relPath.startsWith("/") || relPath.includes("\\")) {
		throw new WriteError(`path must be relative and /-separated: "${relPath}"`);
	}
	const segments = relPath.split("/");
	if (segments.some((s) => s === "" || s === "." || s === "..")) {
		throw new WriteError(`path must not contain empty or traversal segments: "${relPath}"`);
	}
	if (isIgnoredPath(relPath)) {
		throw new WriteError(`"${relPath}" is an ignored path (dotted, temp, or conflict-copy name)`);
	}
	if (join(ref.path, relPath) === `${ref.path}/${ref.path.split("/").pop()}.md`) {
		throw new WriteError("the context note is derived — write its statement via write_statement");
	}

	// Every intermediate folder inside a space is itself a space (single-parent containment), so a
	// nested write belongs to the deepest one. Refuse rather than guess.
	for (let i = 1; i < segments.length; i++) {
		const candidate = `${ref.path}/${segments.slice(0, i).join("/")}`;
		if (await isSpaceFs(vaultRoot, candidate)) {
			throw new WriteError(
				`"${relPath}" lies inside subspace "${candidate}" — address that space directly so its own log records the change`,
			);
		}
	}
	return join(ref.absPath, relPath);
}

/**
 * Writes AI-authored content into a file — always inside an AETHERSWEB:STATEMENT block — and
 * records it.
 *
 * Containment is not optional here, and the write is scoped to the block rather than to the file.
 * Two consequences, both intended:
 *
 * - **Content outside the block is never touched.** An agent rewriting a note it authored cannot
 *   clobber a paragraph the person added underneath it. A file that has no block yet gets one
 *   appended rather than being taken over — existing text is presumed human until something marks
 *   it otherwise.
 * - **`content` means "the AI-written portion of this file", not "the file".** Reading the file
 *   back returns more than was passed in whenever a person has written alongside it.
 *
 * Formats that cannot carry an inert marker — JSON, CSV, anything binary — are written as-is, and
 * attributed in the log instead via the spin's `authored_by`. Inline where the format permits, in
 * the log where it does not, never nowhere.
 */
export async function writeFileFs(
	vaultRoot: string,
	ref: SpaceRefFs,
	relPath: string,
	content: string,
	agent: string,
	encoding: "utf8" | "base64" = "utf8",
	source: SpinSource = "observed",
): Promise<{ spin: Spin | null; created: boolean; signed_inline: boolean }> {
	const absPath = await resolveWritablePath(vaultRoot, ref, relPath);
	const created = !(await exists(absPath));
	const inline = encoding === "utf8" && isStatementWritable(relPath);

	await mkdir(dirname(absPath), { recursive: true });
	if (inline) {
		const existing = created ? "" : await readFile(absPath, "utf8");
		const vaultPath = `${ref.path}/${relPath}`;
		await writeFile(absPath, writeSignedStatement(existing, content, agent, null, vaultPath), "utf8");
	} else {
		await writeFile(absPath, encoding === "base64" ? Buffer.from(content, "base64") : content);
	}

	const spin = await recordWrittenFile(
		ref,
		relPath,
		absPath,
		created ? "file_created" : "file_modified",
		source,
		agent,
	);
	return { spin, created, signed_inline: inline };
}

/** Builds and appends the create/modify spin for a file already on disk. */
export async function recordWrittenFile(
	ref: SpaceRefFs,
	relPath: string,
	absPath: string,
	spin_type: "file_created" | "file_modified",
	source: SpinSource = "observed",
	authored_by?: string,
): Promise<Spin | null> {
	const contentHash = await hashFileFs(absPath);
	const size = (await stat(absPath)).size;
	const ext = (relPath.split("/").pop() ?? "").split(".").pop()?.toLowerCase() ?? "";
	const binary = BINARY_EXTENSIONS.has(ext);

	return appendSpinGuardedFs(ref, async (log) => {
		if (!shouldRecordFileContent(log, relPath, contentHash)) return null;

		// Attribution goes into the log for every AI-originated write, whatever the format. For a
		// binary or JSON file this is the only place it can live at all.
		const payload: SpinPayload = { path: relPath, content_hash: contentHash, size };
		if (authored_by) payload.authored_by = authored_by;
		if (binary) {
			payload.content = (await readFile(absPath)).toString("base64");
			payload.encoding = "base64";
		} else {
			const newText = await readFile(absPath, "utf8");
			payload.encoding = "utf8";
			if (spin_type === "file_created") {
				payload.content = newText;
			} else {
				const prior = foldLogToLastKnownContent(log)[relPath];
				const baseline = prior?.content != null && prior.encoding === "utf8" ? prior.content : "";
				payload.diff = computeDiff(baseline, newText);
			}
		}
		return { spin_type, source, payload };
	});
}

/** Removes a file from disk. The caller records the removal (see appendFileDeletedFs). */
export async function removeFileFs(vaultRoot: string, ref: SpaceRefFs, relPath: string): Promise<string> {
	const absPath = await resolveWritablePath(vaultRoot, ref, relPath);
	if (!(await exists(absPath))) throw new WriteError(`no file at "${relPath}" in ${ref.path}`);
	await rm(absPath);
	return absPath;
}

/**
 * Moves a space's folder, carrying its `.aether/` — and therefore its whole history — with it.
 * This is what makes spaces portable without an ID system: identity is the folder, so a move is
 * a move, not a delete and a re-creation.
 *
 * The moved space's own log is deliberately untouched. Its chain is keyed to what happened
 * *inside* it, not to where it sits; only the parents on either side record the change in
 * containment, which is theirs to record.
 */
export async function moveSpaceFs(
	vaultRoot: string,
	fromPath: string,
	toPath: string,
): Promise<{ from: SpaceRefFs; to: SpaceRefFs; oldName: string; newName: string }> {
	const from = buildSpaceRefFs(vaultRoot, fromPath);
	const to = buildSpaceRefFs(vaultRoot, toPath);

	if (toPath === fromPath) throw new WriteError("source and destination are the same");
	if (`${toPath}/`.startsWith(`${fromPath}/`)) {
		throw new WriteError(`cannot move "${fromPath}" into itself ("${toPath}")`);
	}
	if (await exists(to.absPath)) throw new WriteError(`"${toPath}" already exists`);
	if (isIgnoredPath(toPath)) throw new WriteError(`"${toPath}" is an ignored path`);

	await mkdir(dirname(to.absPath), { recursive: true });
	await rename(from.absPath, to.absPath);

	// The context note is a folder note: its filename is the folder's name, so a rename leaves it
	// stranded under the old one. Obsidian's own rename handler does the same repair (events.ts).
	const oldName = fromPath.split("/").pop() ?? fromPath;
	const newName = toPath.split("/").pop() ?? toPath;
	if (oldName !== newName) {
		const stranded = join(to.absPath, `${oldName}.md`);
		if (await exists(stranded)) await rename(stranded, to.contextPath);
	}
	return { from, to, oldName, newName };
}

/**
 * Permanently deletes a space's whole folder, `.aether/` log included — so its entire
 * hash-chained history goes with it. There is no move-then-recreate to undo this with: unlike
 * `removeFileFs`, whose content survives in the log via `file_deleted`, a space's own log is the
 * thing being destroyed, and a parent's log never carries a child's hash in the first place (see
 * SpinPayload's doc comment on subspace_created/subspace_removed) — so once this runs, nothing
 * anywhere records what the space actually held, only that something by this name once existed.
 *
 * Deliberately low-level: whether the caller is allowed to take a subtree with it (recursive) or
 * remove a top-level user-space at all (require_user_space) is a decision about someone's world,
 * not a filesystem operation — that judgment stays in the tool layer, same split as move_space's
 * "destination parent must already be a claimed space" living in move-space.ts rather than here.
 */
export async function deleteSpaceFs(vaultRoot: string, spacePath: string): Promise<SpaceRefFs> {
	const ref = buildSpaceRefFs(vaultRoot, spacePath);
	if (!(await isSpaceFs(vaultRoot, spacePath))) {
		throw new WriteError(`"${spacePath}" is not a claimed space`);
	}
	await rm(ref.absPath, { recursive: true, force: true });
	return ref;
}
