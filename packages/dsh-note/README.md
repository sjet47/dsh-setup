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

Nothing in dsh's own `$DSH_HOME` stores memories; deleting this plugin leaves them untouched.

## What the agent sees

At agent creation the plugin:

1. creates the memory directory and an empty `MEMORY.md` if missing;
2. creates the session scratchpad with mode `0700`;
3. registers an agent-scoped system-prompt section with the rules text plus a **frozen** `MEMORY.md` snapshot.

The snapshot is taken once per session, so the prompt prefix stays byte-stable and cacheable; memories written mid-session do not disturb it. The rules tell the agent to read `MEMORY.md` directly when it needs the current list.

The scratchpad is passed as an absolute path in that section and exported to shell calls as `$DSH_NOTE_SCRATCHPAD_DIR`. dsh cannot rewrite tool arguments, so unlike pi-note there is no `$PI_NOTE_SCRATCHPAD_DIR` expansion for read/write/edit — the absolute path works in every tool instead.

## UI

1. **Memory button** in the session header (shared with pi's topic count).
2. Click it to browse the project's memories: search, read, and two-step delete. Delete removes the file **and** its `MEMORY.md` line in one Host-side step.

Reading and deleting go through authenticated `/api/dsh-note/*` routes; only the owner browser reaches them.

## Commands

| Command | Result |
|---------|--------|
| `/memory` | List this project's topics (including missing and unindexed files) |
| `/memory path` | Print the memory and scratchpad directories |

## Differences from pi-note

- The detail view has no "open in `$EDITOR`": a browser cannot hand a file to a terminal editor. Copy the path (shown under the title) and edit it in your own editor, or ask the agent.
- `$PI_NOTE_SCRATCHPAD_DIR` expansion in fs tool arguments is replaced by an absolute path plus `$DSH_NOTE_SCRATCHPAD_DIR` for shell calls.
