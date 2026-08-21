# AethersWeb — Design Statement

_A self-contained specification. Usable as a project brief or as a prompt handed to a model with no prior context._

**Status:** describes what is built as of 2026-08-21, and says so explicitly where something is not.
Sections marked **Not built** are design intent, not description.

> **Why this file lives in the repo.** It used to live at the vault root, and was lost twice in two
> days — deleted 2026-08-20T16:00 and again at 22:49, recovered from the desktop trash both times.
> The vault root is not a space, so nothing logged either deletion; the file's disappearance left no
> trace anywhere in the system built to notice exactly that. It belongs in git, which is watching.

---

## What AethersWeb is for

AethersWeb represents **a person's world as a self-describing filesystem** — places, people,
projects, circumstances — with an integrity guarantee underneath it. It is built on an Obsidian
vault. The first build target is single-player: one person's own user-space, working for them alone.

The deliverable is **the structure**: what contains what, what sits beside what. The log exists to
keep that structure honest, and the AI statement exists to say, in plain terms, what a space is and
where it sits. A tool that models containment perfectly but cannot tell you what it holds has
failed; so has one that describes beautifully but lets the structure drift from the filesystem.

Multi-user features are deliberately deferred. See **Deferred** below.

## Core structure

**Every folder is a space.**

A **space** contains files and subspaces. That is the whole containment model — one parent, always,
no exceptions.

A **user-space** is the grounded centre of a person's world. A user represents a universe; the
user-space is the one natural, grounded space within it. Aspects of the exterior environment —
location, context, circumstance — are contained *inside* the user-space rather than existing
alongside it.

The **vault** is the meta-container. It has no central dogma except this: **AethersWeb contains only
users. Users hold everything else.** The vault root is never itself a space.

"Every folder is a space" describes the containment model. A folder becomes a *managed* space once
it has been claimed — scaffolded with its own `.aether/log.jsonl`. Claiming happens automatically
for folders created inside an existing space, and reconciliation claims any that were created some
other way (see **Claiming**).

## The two maintained aspects

Every space maintains two artifacts. They are not peers.

### 1. The log — authoritative

- Append-only. Never rewritten, except by an audited chain repair (see **Repair**).
- Hash-chained, so order and tampering are detectable.
- Records **only events at that level**. A change inside a subspace produces no entry in the
  parent's log.
- **Carries real content**, not only hashes. `file_created` holds the file's full content;
  `file_modified` holds a unified diff from the previously recorded content (or a full snapshot for
  binary files, which are not diffable); `content_hash` sits alongside for cheap verification.
  Replaying a path's content/diff sequence reconstructs what that file said at any point.
- **The log is the truth.**

> **Changed from the original spec.** The log was originally specified to hold "hashes and metadata,
> never content copies", with storage cost given as the reason. That was reversed deliberately: a
> log of hashes can prove that something changed but can never say what happened, and for a record
> that is the only trace some of this will ever have, that is not worth the bytes saved. The cost is
> real — logs grow faster than a hash-only design — and **checkpointing** (still unbuilt) is the
> planned bound.

The content rule is enforced, not assumed: `verifyContentReplay` (`src/verify-content.ts`) replays
every path's recorded content and confirms it hashes to the `content_hash` the log itself recorded.
The one known gap: spins written before this discipline existed have no baseline, so history from
before it shipped is unrecoverable. Those paths are reported as `unverifiable` — distinct from a
mismatch, which is corruption.

### 2. The context — derived

- A materialized view, reconstructible from the log and the filesystem.
- Never authoritative. Can be deleted at any time and regenerated on demand.
- Two clearly separated halves:
  - **Objective content list** (frontmatter): files, hashes, sizes, subspace names and their current
    tip hashes, counts, dates. Cheap, machine-readable, Dataview-queryable.
  - **AI state statement** (body, between sentinel markers): a written account of what this space is
    and where it sits. See **The statement**.

Regeneration rebuilds the frontmatter wholly from current filesystem truth and carries the statement
body forward verbatim. It never writes statement text.

## Independent chains

**A space's tip hash does not commit to its children's tips.** Each chain is fully independent and
portable. Verifying a subtree is a walk, not a single comparison — the accepted cost. In exchange, a
space can be moved, copied, or handed off intact, carrying its own verifiable history, and no deep
change forces writes up the whole spine.

Identity is the folder. `.aether/` is ignored by Obsidian, travels in a zip, and moves with its
folder when a space is dragged. A space carries its own history, which handles identity across moves
and renames with no ID infrastructure.

A corollary that is easy to get wrong: **moving a space must not touch its own log.** Its chain
records what happened inside it, never where it sits. Only the parents on either side record the
change in containment, because that is theirs to record.

## Staleness

Each subspace's current tip hash is recorded in the **parent's context**, never in the parent's log.
A parent's context is stale if and only if a listed child tip no longer matches. This is the entire
staleness mechanism — there is **no central registry**. The head index is distributed into the
context files themselves, so there is nothing to drift out of sync with the filesystem.

The context also carries `source_tip` (the head its frontmatter was built from) and `statement_tip`
(the head its statement was written against). When either differs from the space's current head, the
corresponding half is known-stale without reading anything more.

This is why parent contexts are **not** auto-refreshed when a child's log advances. The recorded
child tip going out of date *is* the signal that the parent's statement no longer describes its
composition. Refreshing it eagerly would destroy the only mechanism that reports it.

## The statement

`write_statement` is the one moment per regeneration where something with intelligence looks at what
a space's log and files actually hold and says back, in plain terms, two things together — never one
without the other:

- **What** the space is: its character, read from its own files and history, grounded strictly in
  what the data supports. Nothing invented to fill a gap.
- **Where** it is: its position among its parent, siblings, and subspaces. A space is never
  described as if it stood alone.

The statement's job is not to sound finished. Where the data is thin, silent, or has drifted from
what a sibling space already records, it says so plainly rather than smoothing over it with good
prose — the same discipline that keeps the hash chain honest, extended outward. The goal is to hand
the person back **verified clarity** about their own world: what the log and files actually
establish, kept visibly separate from what is still open and worth going to confirm. A statement
that resolves every gap instead of naming it has failed, however well it reads.

This is why statement generation is agent-driven rather than templated, and why **no LLM call
happens inside the MCP server**. The intelligence doing this has to actually look, each time.

### Containment, signature, verification

**Every piece of AI-generated content is contained, attributed, and verifiable.** This holds for
statements in context notes and for any file an agent authors.

A vault meant to hand someone back verified clarity about their own world has to keep visible which
words are theirs and which a machine supplied. Once that is ambiguous it cannot be recovered by
inspection — nothing in a file says who wrote what. Containment alone answers only *where* the AI
content is; the signature answers *who, when, against what*, and verification answers *has a person
actually stood behind this*.

**Containment.** AI text is written inside an `AETHERSWEB:STATEMENT` block, and writes are scoped to
that block rather than to the file: content outside it is preserved untouched, so an agent rewriting
a note cannot clobber a paragraph the person added beneath it. A file with no block yet gets one
appended rather than taken over — existing text is presumed human until something marks it
otherwise. Text containing a marker verbatim is **refused**, because writers locate a block by
finding the first END marker: an injected one terminates the block early, and the remainder then
sits physically inside the block while reading, to every consumer, as the person's own writing.
Rejecting beats silently escaping, which would keep the write working while quietly altering what
was said.

**Signature.** Each block carries a machine-readable signature — agent, timestamp, the log tip it
was written against, and a SHA-256 of the prose — plus a visible line beneath it saying the same
thing in plain language. The visible half is not decoration: a signature nobody encounters while
reading the note is provenance in name only.

**Verification.** A person confirms content, and the confirmation records *the hash of what they
read*. If the prose is edited afterward the hashes stop matching and the status reverts to
`stale_verification` on its own — approval cannot be quietly inherited by words nobody signed off
on. Re-writing byte-identical prose is a no-op that preserves both signature and verification, since
nothing the person approved has changed.

Status is always recomputed from hashes, never read off the visible line: `unsigned`, `unverified`,
`verified`, `stale_signature` (edited after signing), `stale_verification` (edited after approval).

**Confirmation is asked for outside the context note only.** An authored file is not derived from
anything — nothing regenerates it, nothing else in the vault says what it should contain, and the
person will read it back later as part of their own notes. A machine wrote that into their world,
and it stays pending until they say they stand behind it. A statement is the opposite case on every
count: the context note is derived and disposable, rebuilt from the log whenever the space moves on,
and a statement that drifts is corrected by regenerating it rather than by someone having certified
an earlier version. It is still contained, still signed, still visibly attributed — it is simply not
held for approval, and `unverified` is where it normally sits rather than a task waiting on anyone.
Spending a person's attention on the one artifact the system rewrites on its own is attention not
spent on the file where their confirmation is the only record there will ever be. Not required is
not forbidden: a person can still verify a statement, and it is recorded like any other. Nothing
asks them to.

**Verification is plugin-only, and that is the substance of the feature rather than a restriction
around it.** An agent confirming its own output produces a record indistinguishable from a person's
and worth nothing. The MCP server can read every field and write none of them — the same reasoning
that keeps chain repair plugin-only, applied to a different kind of trust.

**Formats that cannot carry an inert marker** — JSON, CSV, anything binary — are written as-is and
attributed in the log instead, via the spin's `authored_by`. Inline where the format permits, in the
log where it does not, never nowhere. This is also why `source` (observed vs detected) is not enough
on its own: it records how a change was *witnessed*, not who made it, and an agent writing a file is
`observed` exactly like a person typing in Obsidian.

**Not built:** nothing generates statements on a schedule or a trigger. `write_statement` works and
has written real text against the real vault, driven manually from an MCP client session.

## Layout

```
UserSpace/
├── UserSpace.md          ← context note (visible, folder-note convention)
├── notes.md
├── Location/
│   ├── Location.md       ← its own context
│   └── .aether/
│       ├── log.jsonl
│       └── head
└── .aether/
    ├── log.jsonl         ← this level's events only
    ├── head              ← tip hash
    └── .lock             ← transient; cross-process write lock
```

## Hard requirement

**The vault must remain transferable and openable as a normal Obsidian vault.**

Everything is plain text inside the vault directory. No external database, no out-of-vault state.
Strip away every piece of tooling and what remains is a working vault of markdown files. Any design
decision that fails this test is rejected.

## Control surface

Two processes may write to a vault, and both are first-class.

### The Obsidian plugin

The primary surface: GUI commands, ribbon actions, folder context menus, per-space enable/disable,
settings, a log table view, and the chain-repair UI. Plugin plus files is the entire system, and it
zips and moves.

It translates live vault events into `observed` spins. Three things about that translation are
load-bearing, each learned from a real failure:

- **Resolve the owning space from the path string, never from `file.parent`.** Obsidian detaches a
  file from its parent before firing `delete`, so `parent` is null exactly where a delete handler
  needs it. That single fact meant the folder branch of the delete handler had never once fired
  successfully.
- **Never walk upward past a container that no longer exists.** For the departed side of an event, a
  missing container means its log went with it. Walking further up writes the removal into a
  grandparent's log, inventing a containment relationship that never existed.
- **A folder move emits a `rename` for every descendant.** Those describe no change in containment
  and must be recognized and dropped, or each one re-announces children the parent already recorded.

### The MCP server

A separate Node process, run with `--vault <path>` or `AETHERSWEB_VAULT_PATH`, outside the vault. It
is not a read-only mirror: it creates spaces, writes files, moves things, and reconciles, because in
the headless case — a VPS, a phone, an agent working while Obsidian is closed — there is no plugin
to do any of it. A vault handed to someone without the server degrades to plain markdown rather than
breaking.

Its authoring tools perform the change and record it **from the bytes they actually wrote**, so a
space's history cannot disagree with its filesystem regardless of what the caller believes.

Chain repair is deliberately **not** exposed here. Only the plugin's own GUI repairs a chain, where
a person sees what would be quarantined before confirming.

### Concurrency

Both writers acquire the same `.aether/.lock` before their read-tail / append / write-head sequence.
This is a genuine two-party lock, not a one-sided gesture — necessary once the server became a real
writer. It remains advisory in the strict sense: a process killed mid-hold leaves the file behind
(hence a staleness break), and the plugin's vault adapter has no exclusive-create primitive, so its
acquire is exists-then-write with a narrow residual window. Chain repair's `fork_reconciled`
strategy is the backstop for that remainder.

## Out-of-band edits

Files are frequently edited outside Obsidian — vim, a sync client, an agent. **Reconciliation** is
the catch-up pass: walk spaces, compare against what each log last recorded, and write entries for
anything that drifted. Entries are marked distinctly:

- `observed` — witnessed live by a running writer
- `detected` — inferred afterward by comparison

**This distinction is never papered over.** `detected` means nobody saw it happen.

Reconciliation is also deliberately **not** clever: it never infers renames. A file vanishing from
one path while another appears with the same bytes is equally consistent with a copy and a delete,
so it reconciles honestly as a delete plus a create. Only a witnessed rename is ever recorded as
one.

The plugin reconciles on vault open, on window focus (throttled), and on a timer. The server
reconciles on demand via `reconcile_space`. Running only at vault open was not enough: a vault left
open for days recorded nothing that happened while it was in the background.

## Claiming

An unclaimed folder inside a space is invisible to *both* passes — it is not a subspace, so no
parent records it; it is not a space, so nothing walks into it. Everything beneath it goes
unrecorded permanently, with nothing anywhere indicating something is missing.

So reconciliation claims them: any folder inside an already-claimed space is scaffolded. Top-level
folders are never auto-claimed — promoting one to a user-space is a decision about someone's world,
not a caught-up observation.

## Repair

A broken chain is diagnosed and fixed cooperatively, never silently. Two strategies:

1. **`fork_reconciled`** — the shape a concurrent-append race leaves: two spins computed from the
   same stale tail. `head` always points into the live branch, so walking back from it reconstructs
   that branch losslessly. The dead leaf is quarantined whole. No reseq, no rehash, no lost history.
2. **`truncated`** — fallback for anything else. Keeps the longest prefix that verifies clean and
   quarantines from the first break onward.

Quarantined spins are preserved verbatim in a timestamped file beside the log, and the repair itself
is appended as a `chain_repaired` spin. The repair becomes part of the chain rather than a silent
rewrite of history.

## MCP tool surface

Addressing is by vault-relative folder path — no ID system. The vault root comes from server config,
never from a tool call.

**Read**
- `list_spaces` — every claimed space, each with parent, depth, head and counts, so the tree reads
  straight off the response.
- `describe_space` — the primary read: a space's files, head and statement *together with* its
  parent, siblings and subspaces. Both halves a statement needs, in one call.
- `read_file` — what a file actually says.
- `read_log` — what actually happened. Metadata by default; content and diffs on request.
- `read_context` — the raw context note.

**Integrity** (report, never fix)
- `verify_chain`, `check_staleness`, `plan_regeneration`

**Authoring** (perform the change, then record it from what was written)
- `create_space`, `move_space`, `write_file`, `delete_file`, `move_file`

**Derived and catch-up**
- `regenerate_context`, `write_statement`, `reconcile_space`, `append_spin`

`write_file` takes the AI-written *portion* of a file, not the whole file, and both it and
`write_statement` require an `agent` identity for the signature — see **Containment, signature,
verification**. Neither can mark anything verified.

`append_spin` is a narrow escape hatch. It writes what it is told, so anything it records is a claim
rather than a verified fact; it accepts only spin types that describe the log itself.

## Storage discipline

- The log is the costed storage, and it now carries real content — so it grows faster than a
  hash-only design would. This is the accepted trade (see above).
- Every context is disposable. Cold spaces can have theirs evicted and regenerated on demand.
- The objective content list regenerates on every change — nearly free.
- The AI statement is debounced: on demand or past a threshold, never on every keystroke, or deep
  edits cascade model calls up the tree.
- **Not built:** log growth is meant to be bounded by periodic **checkpoints** — a snapshot hash plus
  the range it covers, letting older entries be pruned or cold-stored while the chain stays
  verifiable. The `checkpoint` spin type is reserved and never emitted.

## Deferred

Multi-user and matching are later phases. When they arrive the approach is **reference, not
containment**: containment stays single-parent via folders, while participation is many-to-many ID
references. A shared project has no home folder — it is the emergent join over every entry
referencing the same project ID, with each user's space holding only their own thread. This
preserves the root dogma and means nobody stores anyone else's content.

Also deferred: encryption and publicity tiers, an external always-on daemon, and any social surface.

## Terminology

- **spin** — a log entry (verb and noun)
- **thread** — a person's full hash-chained history
- **loom** — a project
- **resonance** — a derived match

Other concepts (person, tier, membership, surface) stay in plain language rather than themed
vocabulary.
