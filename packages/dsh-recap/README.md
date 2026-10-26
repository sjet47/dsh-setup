# dsh-recap

Re-enter a session without rereading the transcript: one line that starts with why you opened the session, then the current state and the likely next action.

## When a recap appears

| # | Trigger | Behaviour |
|---|---------|-----------|
| 1 | `/recap` | Generate a fresh recap now |
| 2 | Resume | Restore the saved recap — visible when it is current, and also when it is stale unless `showStale` is off |
| 3 | Idle | After a turn ends, wait `idleMs` (five minutes by default); if nothing else happens, generate one automatically |
| 4 | New human message | Hide the previous recap and cancel a pending automatic one |
| 5 | Plugin unload | Every pending timer and in-flight request is cancelled |

A recap is stored outside model context, so it never enters the conversation or its token cost.

A generation that finishes after the log moved on (an event landed, or a human typed while it streamed) is anchored at the log length it started from: it reads as **stale** instead of claiming to include what it never saw. An automatic recap that moved on stays hidden; an explicitly requested one is shown and marked stale.

## Commands

| Command | Result |
|---------|--------|
| `/recap` | Generate and show a fresh recap |
| `/recap status` | Model, current text, freshness, and the automatic window |
| `/recap config` | Show the pinned or inherited model and the registered providers |
| `/recap config <provider>/<model>` | Pin the recap model (the provider must be registered) |
| `/recap config reset` | Follow the session's own route again |
| `/recap clear` | Forget the current recap **on disk too**, and cancel a pending automatic one |

## UI

1. **`/recap`** opens a panel: the full recap, the model that produced it, whether it is current or stale, and **Regenerate** / **Dismiss**. The bare invocation is a client-side command decoration, so nothing goes to the model; `/recap status|config|clear|help` still run on the Host and answer as text.
2. **A recap card directly above the composer** (`conversation.input.dock`): a `✦ Recap` label, the first two lines of the recap, a `stale` marker, and `↻` / `×`. Clicking the text opens the same panel. It only appears while a recap exists, is visible, and the Session is not running, so sending a message hides it immediately instead of waiting for the next poll.
3. The panel lives in the frame-wide `shell.overlay` slot (not a portal into `document.body`), so the shell owns its stacking order and mask. It targets the Session in the centre column and closes when that Session changes.
4. Both the line and the panel use `--dsw-alias-*` tokens and scale from `--dsh-content-font-size`. The panel is a real modal: `aria-modal`, initial focus, a Tab trap, Escape to close, and focus returning to the opener. Copy comes from the Client locale service (`zh`/`en`).

The composer line hides on the next human message and reappears when a new recap is generated.

## Storage

| Path | Contents |
|------|----------|
| `$DSH_HOME/dsh-recap/<session-id>.json` | `{ version, text, seq, hidden? }` — the recap, the session log length it reflects, and whether the user dismissed it |
| `$DSH_HOME/dsh-recap.json` | Optional pinned `{ provider, model }` |

Records are written atomically through a temp file and rename, with mode `0600` in a `0700` directory: a recap names files and decisions, so it must not be world-readable. Records untouched for `retentionDays` are pruned at activation.

A recap is current while the session log length is unchanged; any new event makes it stale. Dismissing persists, so a reload does not resurrect it. File storage is deliberate: a third-party bundle resolves its own copy of `@deepseek-ai/dsh-session`, so the private-brand `appendPluginRecord` entry point cannot write to the runtime's Session.

## Configuration

| Field | Default | Meaning |
|-------|---------|---------|
| `enabled` | `true` | Generate recaps; commands still report state when false |
| `idleMs` | `300000` | Idle delay after a turn; `0` disables automatic recaps |
| `maxTokens` | `2048` | Output token budget for one recap request |
| `timeoutMs` | `30000` | Abort one recap request after this long |
| `showStale` | `true` | Keep a restored but stale recap visible on resume |
| `subagents` | `false` | Also recap child subagent Sessions automatically |
| `retentionDays` | `30` | Delete recap files untouched for this long; `0` keeps them |

## Generation

The system prompt and the 320-character sanitizer are pi-recap's. The request uses dsh's `ctx.llm.stream` with the session's current route (or the pinned one), `maxTokens` output tokens and a `timeoutMs` timeout. Failures on automatic recaps stay silent; manual failures report the reason, and the panel shows the Host's error text instead of a generic message.
