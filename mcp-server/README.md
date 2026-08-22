# AethersWeb MCP server

Exposes an AethersWeb vault to an MCP client (Claude Code, Claude Desktop, …). Runs **outside** the
vault as its own Node process, never bundled into the Obsidian plugin. Without it the vault degrades
to plain markdown rather than breaking.

It is **not a read-only mirror.** It creates spaces, writes files, moves things, and reconciles,
because in the headless case — a VPS, a phone, an agent working while Obsidian is closed — there is
no plugin to do any of it. Its authoring tools perform the change and then record it from the bytes
they actually wrote, so a space's history cannot disagree with its filesystem whatever the caller
believes.

No LLM call happens inside this server. It is a pure tool surface; the MCP *client* is the agent.
See `../Spec.md` for the model and `../CLAUDE.md` for the statement doctrine `write_statement`
operationalizes.

## Build & run

```sh
npm install
npm run build                      # bundles to dist/server.js
node dist/server.js --vault /path/to/vault
# or: AETHERSWEB_VAULT_PATH=/path/to/vault node dist/server.js
```

`npm run dev` watches; `npm test` runs vitest; `npm run typecheck` runs `tsc --noEmit`.
Interactive poking: `npx @modelcontextprotocol/inspector node dist/server.js --vault <path>`.

## Running as a remote/always-on server

By default this server only speaks stdio: one process per local client (e.g. Claude Code on the
same machine), exiting when that client disconnects. To also accept remote MCP connections — a
phone over Tailscale, for instance — pass `--http <port>` or set `AETHERSWEB_HTTP_PORT`, plus
`AETHERSWEB_HTTP_TOKEN` (a bearer secret; the server refuses to start on `--http` without one):

```sh
AETHERSWEB_HTTP_TOKEN=$(openssl rand -hex 32) node dist/server.js --vault /path/to/vault --http 8420
```

Every request must send `Authorization: Bearer <token>`; anything else gets 401. This is a static
shared secret, not OAuth 2.1 — a deliberate simplification, adequate only because the port is
meant to be reachable exclusively via `tailscale serve` inside a private tailnet (Tailscale's own
network-layer auth is the first factor; the token is a second, scoped one), never the public
internet. **Do not use `tailscale funnel`** with this — that exposes it publicly, which this auth
model isn't built for.

In HTTP mode the server also runs a periodic reconciliation sweep across the whole vault (every
`AETHERSWEB_RECONCILE_INTERVAL_MINUTES` minutes, default 5; `0` disables it) — the headless
equivalent of the Obsidian plugin's own `reconcile()` timer, needed because a long-running HTTP
process has no plugin open to notice a file a sync client (e.g. Syncthing) dropped in from
another device.

To run this persistently on a single always-on machine: a `systemd --user` unit
(`~/.config/systemd/user/aethersweb-mcp.service`) with `ExecStart` pointing at `dist/server.js
--vault <path> --http <port>`, an `EnvironmentFile=` pointing at a `chmod 600` file holding
`AETHERSWEB_HTTP_TOKEN` (kept outside the repo, never committed), `Restart=on-failure`, and
`WantedBy=default.target` — then `tailscale serve --bg <port>` to publish it at
`https://<machine>.<tailnet>.ts.net/mcp` for tailnet peers only, with TLS auto-terminated via
Tailscale's own MagicDNS cert.

## Tools

Addressing is by vault-relative folder path (e.g. `"UserSpace/Location"`) — no ID system. The vault
root comes from server config, never from a tool call.

### Read

- **`list_spaces`** — every claimed space, optionally scoped `under` a subtree. Each entry carries
  its parent, depth, head and counts, so the tree reads straight off the response.
- **`list_tree`** — the raw filesystem tree under a path, no space semantics or hashing: folders and
  files as they actually sit on disk, each folder marked `is_space`. For orienting in an unfamiliar
  vault or checking what a bulk drop-in contains before deciding what to `create_space` over.
  Dotted paths are omitted by default (`include_ignored: true` to see them).
- **`describe_space`** — the primary read. A space's files, head and current statement *together
  with* its parent, siblings and subspaces, plus staleness. This is where a statement's two required
  halves — what a space is, and where it sits — are read from in one call.
- **`read_file`** — what a file actually says. A file listing tells you a space has notes, not what
  it is.
- **`read_log`** — what actually happened. Metadata by default; `include_content` adds the recorded
  content and diffs, which is what lets you reconstruct a file at any point.
- **`read_context`** — the raw context note, frontmatter and statement split.

### Integrity — report, never fix

- **`verify_chain`** — walks a log confirming the chain is unbroken.
- **`check_staleness`** — compares each context's recorded tips against actual heads.
- **`plan_regeneration`** — the same check, filtered to what is stale and sorted deepest-first so
  every subspace is planned before its parent. Depth-descending is valid because containment is
  strictly single-parent. Read-only: it tells the calling agent what to do, in what order.

Chain **repair** is intentionally not exposed. Only the plugin's own GUI repairs a chain, where a
person sees exactly what would be quarantined before confirming.

### Authoring

- **`create_space`** — folder, log seeded with `space_created`, context note, and the parent told it
  has a new child. The parent must already be a claimed space. Creating a *top-level user-space*
  additionally requires `require_user_space: true` — that is the centre of someone's world, not a
  folder.
- **`move_space`** — moves or renames a space, carrying its `.aether/` and so its whole history. The
  moved space's own log is untouched: its chain records what happened inside it, not where it sits.
  Both parents record the change in containment.
- **`delete_space`** — permanently deletes a space's folder, `.aether/` log included: unlike
  `delete_file`, nothing anywhere preserves what it held afterward, since a parent's log never
  carries a child's hash. Refuses a space with live subspaces unless `recursive: true`, and a
  top-level user-space unless `require_user_space: true`. No repair, no undo.
- **`write_file`** / **`delete_file`** / **`move_file`** — change and record in one step.
  `write_file` writes **inside an `AETHERSWEB:STATEMENT` block**, so `content` is the AI-written
  *portion* of the file rather than the whole file: anything outside the block is left exactly as it
  was, and a file with no block yet gets one appended rather than taken over. Text containing a
  marker verbatim is refused, and only markdown/plain text may be authored — see **Containment**.
  Returns `spin: null` when the resulting file is byte-identical to what the log already holds.
  `move_file` records a `file_renamed` within one space, or a removal plus an arrival when it
  crosses a boundary, since no single log can speak for both.

### Derived and catch-up

- **`regenerate_context`** — rebuilds objective frontmatter from filesystem truth; never touches the
  statement body.
- **`write_statement`** — writes statement text and stamps `statement_tip`. Bypasses the log
  entirely: a statement is non-authoritative. Pass `expect_tip` with the head you read before
  generating, and the write is refused if the space moved on meanwhile — otherwise a slow generation
  stamps as current a statement that never saw the changes it now claims to cover.
- **`reconcile_space`** — the server's own catch-up pass, since the plugin's only runs inside
  Obsidian. Emits `detected` spins for anything that drifted. Never infers renames.
- **`append_spin`** — a narrow escape hatch. It writes what it is told, so anything it records is a
  claim rather than a verified fact; it accepts only spin types that describe the log itself. Use
  the authoring tools to change the vault and `reconcile_space` to record what something else did.

## Containment, signature, verification

**Every tool that writes AI-generated content contains it, signs it, and leaves it unverified.**
`write_statement` and `write_file` both require an `agent` identity and route through
`../src/core/statement.ts` and `../src/core/signature.ts`.

- **Contained** in an `AETHERSWEB:STATEMENT` block, with the write scoped to the block so a person's
  own writing in the same file is never clobbered. Text carrying a marker verbatim is refused: an
  injected END marker terminates the block early, and the remainder then reads as the person's own
  writing to every consumer that locates a block with `indexOf`.
- **Signed** with your agent id, a timestamp, the tip, and a hash of the prose — plus a visible line
  in the note saying so. Formats that cannot carry an HTML comment (JSON, CSV, binary) are written
  as-is and attributed in the log via the spin's `authored_by`. Never nowhere.
- **Unverified** until a person confirms it in Obsidian. **You cannot verify your own output**, and
  there is no tool here that can — an agent's confirmation of its own work looks identical to a
  person's and is worth nothing. `describe_space` and `read_context` report `statement_status`
  (`unsigned` / `unverified` / `verified` / `stale_signature` / `stale_verification`); treat
  anything other than `verified` as not settled, and say so rather than relying on it.

Only a file you author through `write_file` is actually **held** for the person's confirmation. A
statement is derived from the log and regenerated with it, so `unverified` is its ordinary state —
report it, but never hand the user "go verify this statement" as a task. `stale_signature` on a
statement means they edited the prose by hand: those words are theirs.

Verification records the hash the person actually read, so editing the prose afterward lapses it
automatically. Re-writing byte-identical prose is a no-op that preserves both signature and
verification.

## Shared logic, not a reimplementation

`space-fs.ts`, `vault-io.ts`, `context-fs.ts`, `write-fs.ts`, `reconcile-fs.ts` are Node-`fs`-backed
mirrors of the plugin's `space.ts` / `log.ts` / `context.ts` / `content-record.ts` / `reconcile.ts`.
The parts that must never drift — chain building and verification, the guard predicates, ignore
rules, frontmatter serialization — are imported directly from `../src/core/`, the same files the
plugin bundles. A rule enforced on only one side is not a rule.

## Concurrency

`src/lock.ts` serializes per space: exactly, in-process, via a promise queue; and across processes
via `.aether/.lock`. **The plugin honors the same file** (`src/log.ts`), so this is a genuine
two-party lock — necessary once this server became a real writer.

It stays advisory in the strict sense: a process killed mid-hold leaves the file behind (hence the
staleness break), and the plugin's vault adapter has no exclusive-create primitive, so its acquire
is exists-then-write with a narrow residual window. `repair.ts`'s `fork_reconciled` strategy is the
backstop for that remainder.
