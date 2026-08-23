# AethersWeb

A structure for representing a person's world as a self-describing, hash-verified filesystem, built
on an Obsidian vault. Every folder is a space; every space keeps an append-only hash-chained log of
what happened in it and a derived, regenerable context note describing what it is and where it sits.

Read **[`Spec.md`](Spec.md)** for the design. `CLAUDE.md` covers working in the code.

This repo holds two packages:

- the **Obsidian plugin** (`src/`) — the primary surface: live event capture, reconciliation, chain
  repair, and the GUI.
- **[`mcp-server/`](mcp-server/README.md)** — a standalone Node process exposing the vault to an MCP
  client, with a full read and authoring surface for working the vault headlessly.

## Build

```sh
npm install
npm run build   # one-shot build, deployed into the vault's plugins folder
npm run dev     # esbuild watch mode
```

The build writes to `../AethersWeb/.obsidian/plugins/aethersweb/`. **Obsidian does not hot-reload
it** — after a build, toggle the plugin off and on in Settings → Community plugins.

```sh
npx tsc --noEmit                          # plugin typecheck
cd mcp-server && npm run build && npm test # server bundle + vitest suite
```

The vitest suite lives in `mcp-server/` but covers `src/core/` too, since that code is shared.
Obsidian's `App` is not meaningfully mockable, so the plugin's own I/O paths are not unit-tested —
which is exactly why the logic worth testing keeps getting pushed down into `src/core/`.

## Layout

### Shared, Obsidian-free — `src/core/`

Nothing here imports `obsidian`; `mcp-server/` bundles the same files. This is what keeps the two
writers from silently drifting apart.

- `hash.ts` — canonical spin serialization, chain building and verification.
- `types.ts` — spin and context shapes.
- `constants.ts` — paths, markers, ignore patterns, tunables.
- `guards.ts` — the "does the log already know this?" predicates. Every conditional append on either
  side decides through these, under that space's lock.
- `ignore.ts` — the single decision point for what a log may never mention (dotted paths, temp
  files, sync conflict copies), plus path helpers.
- `rename-echo.ts` — recognizes the descendant rename events a folder move emits.
- `diff.ts`, `content-fold.ts`, `fold-files.ts` — diffing, and replaying a log into last-known
  content and last-known file state.
- `statement.ts` — the containment boundary: AI-generated content is always inside a marked block,
  marker injection is refused, and authored writes are scoped to the block so human writing in the
  same file is never clobbered. Every AI write routes through here. Two kinds of block, one
  implementation parameterized by `BlockKind`: the **statement** block, AI-only and regenerated
  from the log, and the **shared** block, which the person and an agent both write in and nothing
  regenerates. Everything outside both is the person's and unreachable from here.
- `signature.ts` — who wrote AI content, when, against what, and whether a person has confirmed it.
  Verification records the hash actually read, so editing the prose lapses approval automatically.
  Writing a verification is plugin-only: an agent confirming its own output means nothing. Only
  content outside a space's folder note is held for confirmation — `requiresVerification` in
  `statement.ts` decides that, since a statement is derived from the log and regenerated with it,
  and a shared block is as much the person's to write as the agent's. A shared block's visible line
  says who wrote there *last*, never that the text is AI-written.
- `context-format.ts` — deterministic context-note serialization and its exact inverse.

### Plugin — `src/`

- `main.ts` — entry point and lifecycle. The ordering is load-bearing: reconcile fully, *then*
  attach live listeners, so catch-up writes are never mislabelled as observed.
- `events.ts` — live vault events → `observed` spins. See CLAUDE.md's rules before editing.
- `reconcile.ts` — filesystem-vs-log diff → `detected` spins; also claims unmanaged folders.
- `log.ts` — `.aether/` I/O, the per-space lock, and the only write path into a chain.
- `context.ts` — context regeneration, statement writing, and shared-block writing.
- `content-record.ts` — builds the content payload for create/modify spins.
- `space.ts` — space detection, tree walking, owner resolution, file hashing.
- `bootstrap.ts` — space scaffolding.
- `repair.ts` / `verify-content.ts` — chain repair planning, and the content-replay check.
- `commands.ts`, `settings.ts`, `aether-view.ts` — command palette, settings tab, log table view.

All `.aether/*` I/O goes through the raw vault adapter, never the indexed file API — Obsidian does
not track dotfolders, so those files never appear as `TFile`s.

## Not built yet

Automated statement generation (`write_statement` works; nothing calls it on a schedule),
checkpoint/log-pruning (the `checkpoint` spin type is reserved and never emitted), an always-on
external daemon, and multi-user/matching. See `Spec.md`'s **Deferred**.
