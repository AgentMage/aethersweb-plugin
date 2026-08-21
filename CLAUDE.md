# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

This is the **plugin source code** for AethersWeb — a TypeScript/esbuild Obsidian plugin project (`src/`, `package.json`, `manifest.json`, `esbuild.config.mjs`). It is *not* itself an openable Obsidian vault.

The core model below (spaces, logs, contexts, spins) is already implemented, not just a target: `src/bootstrap.ts` (space/subspace scaffolding), `src/log.ts` (hash-chained log I/O), `src/context.ts` (context-note regeneration), `src/reconcile.ts` (out-of-band edit detection), `src/events.ts` (live vault event capture), `src/commands.ts` / `src/settings.ts` (command palette, ribbon, folder context-menu, settings UI). See `README.md` for the file-by-file layout and what's explicitly out of scope for v0.1 (MCP server, real AI statement generation, checkpoint/log-pruning, multi-user).

The real, openable test vault this plugin deploys into is the **sibling directory** `../AethersWeb` (`/home/lilly/AethersWeb`) — `npm run build` builds here and writes straight to `../AethersWeb/.obsidian/plugins/aethersweb/`. The plugin needs a manual reload in that vault (Settings → Community plugins → toggle off/on) after every build; building alone doesn't hot-reload it.

**Known gap, not yet resolved:** both this repo and `../AethersWeb` are missing a `Spec.md` — the design spec this CLAUDE.md's "Core model" section below was originally derived from, and that `README.md` still points to at `../AethersWeb/Spec.md`. It isn't at that path or anywhere else found in either tree. Until it's re-created or the reference is corrected, treat the sections below (and the actual `src/` implementation) as the working source of truth, and flag this explicitly again if a future change seems to require the missing spec.

## Core model (from Spec.md)

- **Every folder is a space.** Single-parent containment, no exceptions. A `user-space` is the grounded center of a person's world; the `vault` is the meta-container holding only user-spaces.
- Every space maintains two artifacts, which are **not peers**:
  1. **The log** (`.aether/log.jsonl`) — append-only, hash-chained, authoritative. Records only events at that space's own level (a subspace's changes never produce a parent log entry). Is a record of *what happened*, not just *that* something happened: `file_created` carries the file's full content, `file_modified` carries a unified diff from the previously recorded content (or a full snapshot for binary files, which aren't diffable), and `content_hash` is kept alongside for cheap verification/dedup. Replaying a path's `content`/`diff` sequence reconstructs its content at any point — this is a strict, checked rule (`verifyContentReplay` in `verify-content.ts`), not an aspiration. The one gap: spins written before this discipline existed have no baseline, so pre-existing history from before it shipped is unrecoverable going forward.
  2. **The context** (a visible `<SpaceName>.md` folder note) — derived, disposable, regenerable by replaying the log. Has two halves: an objective frontmatter content list (files, hashes, subspace tip hashes, counts — Dataview-queryable) and an AI-written state statement in the body.
- **Chains are independent per space** — a space's tip hash does not commit to its children's tips. This makes spaces portable (movable/copyable with intact history) at the cost of subtree verification being a walk rather than one comparison.
- **Staleness** is tracked only via each subspace's tip hash recorded in the *parent's context* (not its log) — no central head registry. A context's `source_tip` frontmatter vs. the space's actual head tells you if the AI statement is stale without reading further.
- `.aether/` is Obsidian-ignored, per-space, and travels with the folder on move/copy/zip — this is how identity survives moves/renames without an ID system.

## Hard constraint

**The vault must remain a normal, openable Obsidian vault at all times.** Everything lives in plain text inside the vault directory — no external database, no out-of-vault state. Any design or implementation choice that breaks "strip the tooling and you still have a working plain-markdown vault" is invalid.

## Control surface (planned)

- Primary: an **Obsidian plugin** (GUI commands, ribbon actions, per-space enable/disable, settings) — this is what makes the vault self-contained (plugin + files = whole system).
- Secondary/optional: a headless external daemon for VPS operation — never the primary path.
- Reconciliation: on vault open, the plugin walks spaces, diffs file hashes against each context's last-recorded state, and writes catch-up log entries for out-of-band edits (e.g. vim). Entries are tagged `observed` (seen in real time) vs. `detected` (found on reconciliation) — this distinction must never be collapsed.
- An **MCP server** (separate process, outside the vault) exposes the minimum tool surface: `list_spaces`, `read_context`, `append_spin`, `verify_chain`, `regenerate_context`. AI state statements are written *through* this server so generation and consumption share one interface. Without the server running, the vault degrades to plain markdown rather than breaking.

## Storage/regeneration discipline

- The log is the costed storage — it now carries real content (full snapshots on create/binary-change, diffs on text-change), not just hashes/metadata, so logs grow faster than a hash-only design would. Contexts remain fully disposable/regenerable and carry no content of their own.
- The frontmatter content list regenerates cheaply on every change; the AI state statement is debounced (on-demand or past a threshold) so deep edits don't cascade model calls up the whole tree.
- Log growth is bounded by periodic checkpoints (snapshot hash + covered range), allowing older entries to be pruned/cold-stored while the chain stays verifiable.

## Terminology

- **spin** — a log entry (verb and noun)
- **thread** — a person's full hash-chained history
- **loom** — a project
- **resonance** — a derived match
- Everything else (person, tier, membership, surface) stays in plain language.

## Deferred (do not build yet)

Multi-user/matching features are explicitly out of scope for the current single-player build. When they do arrive, the design is **reference, not containment**: folders stay single-parent, and cross-user participation is many-to-many ID references, with shared projects emerging as a join over per-user entries rather than a shared home folder.
