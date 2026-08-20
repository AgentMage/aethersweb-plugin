# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

This is an **Obsidian vault**, not a conventional software project — there is currently no build system, package manifest, linter, or test suite. The entire technical content right now is:

- `Spec.md` — the complete design specification for **AethersWeb**. Read it in full before making any structural change; it is written to be self-contained and is the single source of truth for how the system should behave.
- `.aether/` — the vault-root maintainer state (`config.json`, `state.json`, `log.jsonl`), currently just scaffolding (empty log, null tip/statement).
- `.obsidian/` — standard Obsidian vault config, with the third-party `folder-notes` community plugin installed (used for the folder-note convention referenced in the spec's layout).

No AethersWeb plugin code or MCP server exists in this repo yet — the implementation described below is a target, not (yet) a reality. When asked to build it, treat `Spec.md` as the spec to implement against, and update it if a design decision changes during implementation.

## Core model (from Spec.md)

- **Every folder is a space.** Single-parent containment, no exceptions. A `user-space` is the grounded center of a person's world; the `vault` is the meta-container holding only user-spaces.
- Every space maintains two artifacts, which are **not peers**:
  1. **The log** (`.aether/log.jsonl`) — append-only, hash-chained, authoritative. Records only events at that space's own level (a subspace's changes never produce a parent log entry). Stores hashes/metadata only, never content copies.
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

- Only the log is costed storage (hashes + metadata, never content). Contexts are fully disposable/regenerable.
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
