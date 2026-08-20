# AethersWeb (plugin source)

Source for the AethersWeb Obsidian plugin. Deploys into the sibling vault at
`../AethersWeb/.obsidian/plugins/aethersweb/`. See `../AethersWeb/Spec.md` for the design this
implements, and `~/.claude/plans/this-folder-is-the-wise-parnas.md` for the v0.1 implementation plan.

## Build

```sh
npm install
npm run build   # one-shot build, deployed into the vault's plugins folder
npm run dev      # esbuild watch mode — edits land live in a running Obsidian instance
```

After the first build, enable the plugin in Obsidian: Settings → Community plugins (it's already
listed in `community-plugins.json`, just needs Obsidian reloaded once the build output exists).

## Layout

- `src/hash.ts` — canonical spin serialization/hashing, chain build + verify.
- `src/types.ts`, `src/constants.ts` — shared shapes and constants.
- `src/space.ts` — space detection, tree walking, file hashing.
- `src/log.ts` — `.aether/log.jsonl` + `head` I/O (via the raw vault adapter, never the indexed file API — Obsidian doesn't track dotfolders).
- `src/context.ts` — context note (`<Space>.md`) regeneration: full frontmatter rebuild + sentinel-marker-preserved AI statement body. `writeStatement()` is the intended drop-in point for the future MCP server.
- `src/reconcile.ts` — fold-log-then-diff-against-filesystem, emits `detected` spins for out-of-band edits.
- `src/events.ts` — live vault event → `observed` spin translation, debounced per file.
- `src/bootstrap.ts` — space/subspace scaffolding (`scaffoldSpace`), used for both the first user-space and every later one.
- `src/commands.ts`, `src/settings.ts` — command palette + settings tab UI.
- `src/main.ts` — plugin entry; lifecycle ordering (reconcile fully before attaching live listeners) is load-bearing.

## Explicitly out of scope for v0.1

MCP server, external daemon, real AI statement generation, checkpoint/log-pruning (the
`checkpoint` spin type is reserved but never emitted), multi-user/reference containment.
