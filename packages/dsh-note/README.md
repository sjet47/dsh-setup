# dsh-note

Project-level file-based memory **shared with pi-note**, plus a per-session scratchpad directory.

## Memory is shared with pi

Both agents use the same files, so a memory written in pi is visible in dsh and vice versa:

```
$PI_CODING_AGENT_DIR/pi-note/<project-slug>/
├── MEMORY.md        # one line per memory: - [Title](file.md) — hook
└── <topic>.md       # one durable topic per file
```

1. The agent directory is pi's: `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`.
2. The slug is pi's session-directory slug: `/home/sjet/repo/x` → `--home-sjet-repo-x--`.
3. The slug is keyed on the **git main worktree**, so every linked worktree of one repository shares one memory directory.
4. The directory is keyed on the Session's **effective** working directory (`ctx.workingDirectory`), falling back to the header's initial `cwd`, so `cd`-ing a Session moves its memory with it.

Nothing in dsh's own `$DSH_HOME` stores memories; deleting this plugin leaves them untouched.

## What the agent sees

At agent creation the plugin:

1. creates the memory directory and an empty `MEMORY.md` if missing;
2. creates the session scratchpad with mode `0700`;
3. registers an agent-scoped system-prompt section with the rules text plus a **frozen** `MEMORY.md` snapshot.

The snapshot is taken once per session, so the prompt prefix stays byte-stable and cacheable; memories written mid-session do not disturb it. It is capped at `snapshotMaxChars` (16 000 by default) with an explicit truncation note, so a pathological index cannot tax every request. The rules tell the agent to read `MEMORY.md` directly when it needs the current list.

Unloading the plugin disposes every agent-scoped prompt section it registered; it does not rely on the agent being disposed first.

The scratchpad is passed as an absolute path in that section and exported to shell calls as `$DSH_NOTE_SCRATCHPAD_DIR`. dsh cannot rewrite tool arguments, so unlike pi-note there is no `$PI_NOTE_SCRATCHPAD_DIR` expansion for read/write/edit — the absolute path works in every tool instead.

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
| `enabled` | `true` | Keep the plugin loaded but stop prompt injection, routes, and the panel |
| `snapshotMaxChars` | `16000` | Cap on the `MEMORY.md` snapshot placed in the system prompt |
| `maxBodyBytes` | `1048576` | Largest memory file the browser may read (413 above it) |

## Differences from pi-note

The rules text is kept in sync with pi-note's `prompt.ts`; only the scratchpad paragraph diverges, for the path mechanics below.

- The detail view has no "open in `$EDITOR`": a browser cannot hand a file to a terminal editor. Use **Copy path** and edit it in your own editor, or ask the agent.
- `$PI_NOTE_SCRATCHPAD_DIR` expansion in fs tool arguments is replaced by an absolute path plus `$DSH_NOTE_SCRATCHPAD_DIR` for shell calls.
