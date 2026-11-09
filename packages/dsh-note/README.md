# dsh-note

Project-level file-based memory **shared with Claude Code and pi**, plus a per-session scratchpad directory.

## Memory is shared with Claude Code and pi

All three agents use the same files, so a memory written in any of them is visible in the others:

```
$CLAUDE_CONFIG_DIR or ~/.claude/projects/<claude-slug>/memory/
├── MEMORY.md        # one line per memory: - [Title](file.md) — hook
└── <topic>.md       # one durable topic per file, Claude Code's frontmatter format
```

1. The directory is Claude Code's auto-memory directory: `<config>/projects/<slug>/memory`, where `<config>` is `$CLAUDE_CONFIG_DIR` or `~/.claude`.
2. The slug is Claude Code's: every character outside `[A-Za-z0-9]` becomes `-` (case kept), e.g. `/home/sjet/repo/x` → `-home-sjet-repo-x`. Past 200 characters a `-<base36>` suffix is appended, exactly as Claude Code does.
3. The slug is keyed on the **git main worktree**, so every linked worktree of one repository shares one memory directory — the same key Claude Code uses.
4. The directory is keyed on the Session's **effective** working directory (`ctx.workingDirectory`), falling back to the header's initial `cwd`, so `cd`-ing a Session moves its memory with it.
5. Claude Code's `autoMemoryDirectory` user setting (`<config>/settings.json`) is mirrored: once set, it applies to every project in Claude Code too. Cowork/remote memory env vars and `autoMemoryEnabled` are deliberately not mirrored — they would silently split the two tools.

Files use Claude Code's format, since Claude Code selects memories by it: frontmatter `name` / `description` / `metadata.type` (`user` / `feedback` / `project` / `reference`), optional `metadata.modified`, `[[name]]` links, and `**Why:**` / `**How to apply:**` bodies for `feedback` and `project`. The browser route strips the frontmatter block before shipping the body; the absolute path stays available for the editor.

Nothing in dsh's own `$DSH_HOME` stores memories; deleting this plugin leaves them untouched.

## What the agent sees

At agent creation the plugin:

1. creates the memory directory and an empty `MEMORY.md` if missing;
2. creates the session scratchpad with mode `0700`;
3. registers an agent-scoped system-prompt section with the rules text plus a **frozen** `MEMORY.md` snapshot.

The snapshot is taken once per session, so the prompt prefix stays byte-stable and cacheable; memories written mid-session do not disturb it. It is capped at `snapshotMaxChars` (16 000 by default) with an explicit truncation note, so a pathological index cannot tax every request. The rules tell the agent to read `MEMORY.md` directly when it needs the current list.

Unloading the plugin disposes every agent-scoped prompt section it registered; it does not rely on the agent being disposed first.

The scratchpad is passed as an absolute path in that section and exported to shell calls as `$DSH_NOTE_SCRATCHPAD_DIR`. dsh cannot rewrite tool arguments, so unlike pi-note there is no `$PI_NOTE_SCRATCHPAD_DIR` expansion for read/write/edit — the absolute path works in every tool instead.

## MEMORY.md refresh

The frozen snapshot has one consequence: a memory another agent (pi, a sibling dsh session, your editor) writes while this session is idle stays invisible. The plugin closes that gap without giving up the stable prompt prefix.

The window it watches is **the end of the previous turn to the start of the next one**. When a turn ends it takes a baseline of `MEMORY.md`; at the first step of the next turn it probes the file again:

1. `stat` first — an unchanged mtime/size means no read at all, so the common case is one syscall;
2. once the metadata moved, the content digest decides whether anything really changed: a `touch`, or a byte-identical save by an editor, announces nothing;
3. a real change enters the turn as one logged `user/message` right after the user's input — a `<system-reminder>` naming the file, listing the index lines that appeared or disappeared, and carrying the new index (capped at `memoryRefreshMaxChars`).

Everything this session writes during its own turn is therefore part of the next baseline by construction, whatever tool or shell command produced it — there is no write hook and no per-tool bookkeeping. Only writes that land in the idle window are reported.

The injected message is silent by design: its source carries only `kind: dsh-note`, no presentation form and no change list, so Chat shows the plain injected-context row it shows for any opaque context instead of a file card. The announcement is for the model, not for the reader.

Because it is an ordinary message, it replays and resumes with the rest of the history and it never touches the system prompt. Compaction may drop it like any other message; the rules text already tells the agent to read `MEMORY.md` directly after compaction.

The baseline only moves when the announcement actually reached the session log: if a turn is cancelled between pre-step and the append, that turn's baseline update is skipped and the next turn announces the change again. A first step with no claimed input is left alone — injecting there would make the agent answer unprompted.

Known delays and blind spots:

1. only `MEMORY.md` is watched: editing a topic file without an index line announces nothing;
2. the fast path hides a rewrite that preserves both mtime and size (`cp -p`, `git checkout` of an identical stat), so a same-length hook can stay unnoticed until the next mtime change;
3. a change is announced one turn late if the turn that first saw it was empty (no claimed input).

## UI

There are two ways in, and both open the same panel:

1. **`/memory`** — a client-side command decoration consumes the bare invocation and opens the browser in place. Nothing is sent to the model, and the composer draft is untouched.
2. **Memory button** in the session header (shows pi's topic count, refreshed after a delete).

The panel is registered in the frame-wide `shell.overlay` slot rather than portalled into `document.body`: the shell owns the stacking order, the click-through layer, and the mask, so the panel cannot cover a host dialog or be clipped by the composer. It is rendered once, targets the Session in the centre column, and closes when that Session changes.

What it does:

1. lists the project's memories with an age/size column, search, and refresh;
2. reads one topic at a time, keeping the newest selection when responses arrive out of order;
3. copies the topic's absolute path for an editor;
4. deletes with an explicit confirm step that names the file, removing the file **and** its `MEMORY.md` line in one Host step (the index itself is never deletable).

Accessibility and theming follow the host: `role="dialog"` with `aria-modal`, initial focus on search, a Tab trap, Escape closing the confirm step first, focus returning to the opener, `--dsw-alias-*` tokens only, and text scaled from `--dsh-content-font-size`. Narrow windows stack the list above the reader instead of squeezing a fixed sidebar.

Reading and deleting go through authenticated `/api/dsh-note/*` routes; only the owner browser reaches them. A client without the browser bundle (TUI, ACP) still gets the text listing from the Host command handler.

## Commands

| Command | Result |
|---------|--------|
| `/memory` | List this project's topics (including missing and unindexed files) |
| `/memory path` | Print the memory and scratchpad directories |

## Configuration

| Field | Default | Meaning |
|-------|---------|---------|
| `enabled` | `true` | Keep the plugin loaded but stop prompt injection, routes, the refresh probe, and the panel |
| `snapshotMaxChars` | `16000` | Cap on the `MEMORY.md` snapshot placed in the system prompt |
| `maxBodyBytes` | `1048576` | Largest memory file the browser may read (413 above it) |
| `memoryRefresh` | `true` | Announce external `MEMORY.md` changes at the start of the next turn |
| `memoryRefreshMaxChars` | `16000` | Cap on the `MEMORY.md` content copied into one refresh message |

## Differences from pi-note

The rules text is kept in sync with pi-note's `prompt.ts`; two paragraphs diverge: the scratchpad one, for the path mechanics below, and the one describing the `MEMORY.md` refresh, which pi-note does not have.

- The detail view has no "open in `$EDITOR`": a browser cannot hand a file to a terminal editor. Use **Copy path** and edit it in your own editor, or ask the agent.
- `$PI_NOTE_SCRATCHPAD_DIR` expansion in fs tool arguments is replaced by an absolute path plus `$DSH_NOTE_SCRATCHPAD_DIR` for shell calls.
