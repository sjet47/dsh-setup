# dsh-recap

Re-enter a session without rereading the transcript: one line that starts with why you opened the session, then the current state and the likely next action.

## When a recap appears

| # | Trigger | Behaviour |
|---|---------|-----------|
| 1 | `/recap` | Generate a fresh recap now |
| 2 | Resume | Restore the saved recap when it is still current |
| 3 | Idle | After a turn ends, wait five minutes; if nothing else happens, generate one automatically |
| 4 | New human message | Hide the previous recap and cancel a pending automatic one |

A recap is stored outside model context, so it never enters the conversation or its token cost.

## Commands

| Command | Result |
|---------|--------|
| `/recap` | Generate and show a fresh recap |
| `/recap status` | Model, current text, and whether it is current or stale |
| `/recap config` | Show the pinned or inherited model and the registered providers |
| `/recap config <provider>/<model>` | Pin the recap model |
| `/recap config reset` | Follow the session's own route again |
| `/recap clear` | Forget the current recap |

## UI

1. **`/recap`** opens a panel: the full recap, the model that produced it, whether it is current or stale, and **Regenerate** / **Dismiss**. The bare invocation is a client-side command decoration, so nothing goes to the model; `/recap status|config|clear|help` still run on the Host and answer as text.
2. **A recap card directly above the composer** (`conversation.input.dock`): a `✦ Recap` label, the first two lines of the recap, a `stale` marker, and `Open` / `↻` / `×`. Clicking the text opens the same panel. It only appears while a recap exists and is visible, so an unused session keeps a clean composer.
3. Both the line and the panel scale with the theme's conversation font size and use an opaque surface (the theme's `bg-layer-2`), not the translucent menu surface, and the panel portals to `document.body` so the composer's clipping never cuts it off.

The line hides on the next human message and reappears when a new recap is generated.

## Storage

| Path | Contents |
|------|----------|
| `$DSH_HOME/dsh-recap/<session-id>.json` | `{ version, text, seq }` — the recap and the session log length it reflects |
| `$DSH_HOME/dsh-recap.json` | Optional pinned `{ provider, model }` |

A recap is current while the session log length is unchanged; any new event makes it stale. File storage is deliberate: a third-party bundle resolves its own copy of `@deepseek-ai/dsh-session`, so the private-brand `appendPluginRecord` entry point cannot write to the runtime's Session.

## Generation

The system prompt and the 320-character sanitizer are pi-recap's. The request uses dsh's `ctx.llm.stream` with the session's current route (or the pinned one), 2048 output tokens and a 30-second timeout. Failures on automatic recaps stay silent; manual failures report the reason.
