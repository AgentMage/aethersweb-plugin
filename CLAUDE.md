# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

Two packages: the **Obsidian plugin source** (`src/`, `package.json`, `manifest.json`,
`esbuild.config.mjs`) and a standalone **`mcp-server/`** package that runs outside Obsidian as its
own process. Neither is itself an openable Obsidian vault.

`Spec.md` (repo root) is the design statement. It is the authority on the model; this file covers
working in the code. Read it before changing anything about how spaces, logs, or contexts behave.
It lived at the vault root until it was deleted from there twice in two days — the vault root is not
a space, so nothing logged either deletion. It is in git now.

The real, openable test vault is the **sibling directory** `../AethersWeb` (`/home/lilly/AethersWeb`).
`npm run build` builds here and writes straight to `../AethersWeb/.obsidian/plugins/aethersweb/`.
**The plugin needs a manual reload in that vault** (Settings → Community plugins → toggle off/on)
after every build; building alone does not hot-reload it.

That vault also has `folder-notes` and `quick-explorer` enabled. `folder-notes` manages
`<Folder>/<Folder>.md` — the same file AethersWeb uses for a space's folder note. That is no longer
a collision to work around: the folder note *is* an ordinary note the person writes in, and both
plugins treating it as one is the intended arrangement.

## What is built

The core model is implemented, not aspirational: `src/bootstrap.ts` (scaffolding), `src/log.ts`
(hash-chained log I/O), `src/context.ts` (context regeneration), `src/reconcile.ts` (catch-up),
`src/events.ts` (live capture), `src/repair.ts` (chain repair), `src/commands.ts` / `src/settings.ts`
/ `src/aether-view.ts` (UI). The MCP server exposes a full read + authoring surface.

Obsidian-free logic shared between both packages lives in `src/core/` — see README.md for the
file-by-file layout. **Nothing in `src/core/` may import `obsidian`.** That is what lets the server
reuse the plugin's chain and serialization logic rather than reimplementing it, which is the only
thing keeping the two from silently drifting.

Not built: automated statement generation (nothing calls `write_statement` on a schedule or
trigger), checkpoint/log-pruning (the spin type is reserved, never emitted), multi-user.

## Core model — the short version

Read `Spec.md` for the real thing. The parts most often got wrong in code:

- **Every folder is a space**, single-parent, no exceptions. The vault root is never a space.
- **The log is authoritative; the index is derived and disposable.** A space's log records only
  its own level — a subspace's changes never produce a parent log entry.
- **Two files, two natures.** `.aether/index.md` is the machine index (files, hashes, subspace
  tips, counts, `source_tip`, `generated_at`) — rewritten on every spin and **never logged**, for
  the same reason `.aether/head` isn't: it is a cache of what the log already says, not content.
  Its `source_tip`/`generated_at` change purely as a side effect of writing, so an index that were
  itself logged could never settle. `<Folder>/<Folder>.md` is the **folder note**: an ordinary note
  the person writes in, logged like any other file, which also holds the AI statement inside its
  marked block. Regeneration only ever creates that note or strips a pre-split note's leftover
  frontmatter — everything else in it is theirs.
- **The log carries real content**, not just hashes: full content on create, unified diffs on text
  change, full snapshots for binary. `verifyContentReplay` enforces that replay reproduces the
  recorded hash. (The original spec said hashes-only; that was deliberately reversed.)
- **Chains are independent per space.** A space's tip never commits to its children's tips. This is
  what makes spaces portable — so **moving a space must not touch its own log.**
- **Staleness lives in the parent's index, never its log.** Do not auto-refresh a parent's index
  when a child's log advances: the stale child tip *is* the staleness signal.
- **Statement staleness comes from the signature's `at_tip`**, measured over spins that are *not*
  the folder note's own (`spinsSinceStatement`). Counting the note's own spins would leave every
  statement stale against its own creation, and would make a person's writing in that file read as
  AI drift. There is no `statement_tip` field — the signature carries it, with the prose.
- `.aether/` is Obsidian-ignored, travels with the folder, and is how identity survives moves
  without an ID system.
- **`observed` vs `detected` is never collapsed.** `detected` means nobody witnessed it.

## Hard constraint

**The vault must remain a normal, openable Obsidian vault at all times.** Everything lives in plain
text inside the vault directory — no external database, no out-of-vault state. Any choice that
breaks "strip the tooling and you still have a working plain-markdown vault" is invalid.

## What a space is

Every claimed space is not a record *about* someone's life — for as long as this vault is theirs, it
is a piece of it. `write_statement` is the one moment per regeneration where something with
intelligence looks at what a person's log and files actually hold and says back two things together,
never one without the other: **what** the space is, grounded strictly in what the data supports, and
**where** it sits among its parent, siblings and subspaces.

Where the data is thin, silent, or has drifted from what a sibling already records, the statement
says so plainly rather than smoothing over it with good prose. The goal is **verified clarity**:
what the log and files actually establish, kept visibly separate from what is still open. A
statement that resolves every gap instead of naming it has failed, however well it reads.

This is why statement generation is agent-driven and why no LLM call happens inside the MCP server.

**AI-generated content is contained, signed, and verifiable** — statements and authored files
alike. `core/statement.ts` constructs/locates/replaces blocks; `core/signature.ts` owns attribution
and verification. Route every AI write through them.

- Text carrying a statement or signature marker verbatim is refused — it would terminate its own
  block early or forge its own verification.
- Authored writes are scoped to the block, never the file: content outside is preserved, and a file
  with no block gets one appended rather than taken over.
- Every AI write is signed with a self-declared `agent`, a timestamp, the tip, and a hash of the
  prose — plus a visible line, because provenance nobody sees while reading is provenance in name
  only. Formats that cannot carry a marker (JSON, binary) are attributed in the log via the spin's
  `authored_by` instead. Never nowhere.
- **Verification is plugin-only.** An agent confirming its own output produces a record that looks
  identical to a person's and means nothing. The MCP server reads these fields and writes none of
  them — same reasoning as chain repair. Verification records the hash the person read, so editing
  the prose lapses it automatically.
- **Confirmation is only asked for outside the folder note.** `requiresVerification` (`core/
  statement.ts`) is the one place that decides it. An authored file is derived from nothing and
  stays pending until a person stands behind it; a statement is rebuilt from the log whenever the
  space moves on, so `unverified` is its normal state, not a task. Signed and attributed either way
  — only the ask differs. Never prompt, list, or nag on a folder note's statement.
- Re-writing byte-identical prose is a no-op preserving signature and verification. Do not
  reintroduce a fresh timestamp per write: it defeats no-op suppression and silently discards
  approval.
- `renderBody`/`wrapPreservedBlockBody` is the carry-forward path for regeneration and deliberately
  does **not** validate — a signed body legitimately contains markers.

## Writing event-handling code

Every rule below is here because breaking it produced a corrupted history in the real vault.

- **Resolve the owning space from a path string, never `file.parent`.** Obsidian detaches a file
  from its parent before firing `delete`. Use `findOwningSpaceByPath`; for the *departed* side of a
  delete or rename use `findExistingOwningSpaceByPath`, which refuses to walk up past a container
  that no longer exists.
- **Decide under the lock.** Anything conditional on the log's state must decide inside
  `appendSpinGuarded`, using `core/guards.ts`. A decision made against a log read outside the lock
  is already stale by the time it writes — that is how every space ended up with `space_created` at
  both seq 0 and seq 1.
- **A folder move emits a `rename` per descendant.** `RenameEchoTracker` recognizes and drops them.
- **New ignore rules go in `core/ignore.ts`**, used by both packages. An entry one side records and
  the other ignores is how a log and its filesystem drift apart.

## Control surface

- **Obsidian plugin** — primary. Live capture, reconciliation, repair UI, settings.
- **MCP server** (`mcp-server/`) — a real writer, not a read-only mirror: it creates spaces, writes
  files, moves things, and reconciles, because headless there is no plugin to do it. See
  `mcp-server/README.md` for the tool-by-tool surface. Repair stays plugin-only.
- **Cross-process writes** are serialized by `.aether/.lock`, honored by both sides
  (`src/log.ts`, `mcp-server/src/lock.ts`). Advisory in the strict sense — see those files.

## Commands

```sh
npm run build              # plugin → ../AethersWeb/.obsidian/plugins/aethersweb/ (needs manual reload)
npm run dev                # esbuild watch
npx tsc --noEmit           # plugin typecheck

cd mcp-server
npm run build && npm test  # server bundle + vitest (covers src/core/ too)
npx @modelcontextprotocol/inspector node dist/server.js --vault /home/lilly/AethersWeb
```

## Terminology

- **spin** — a log entry (verb and noun)
- **thread** — a person's full hash-chained history
- **loom** — a project
- **resonance** — a derived match

Everything else (person, tier, membership, surface) stays in plain language.

## Deferred (do not build yet)

Multi-user/matching is out of scope for the single-player build. When it arrives the design is
**reference, not containment**: folders stay single-parent, cross-user participation is many-to-many
ID references, and shared projects emerge as a join over per-user entries rather than a shared home
folder.
