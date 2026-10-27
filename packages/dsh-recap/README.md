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
| `/recap status` | Model, detected language, current text, freshness, and the automatic window |
| `/recap config` | Show the pinned or inherited model and the registered providers |
| `/recap config <provider>/<model>` | Pin the recap model (the provider must be registered) |
| `/recap config reset` | Follow the session's own route again |
| `/recap clear` | Forget the current recap **on disk too**, and cancel a pending automatic one |

The same pin is editable from the **Plugins** page: the bundle's page carries a
**Recap model** section with provider and model selectors, **Save**, **Follow the
session route**, and a refresh control for the provider catalog. Both entry
points read and write one store, so a change from either shows up in `/recap
status` immediately.

## UI

1. **`/recap`** opens a panel: the full recap, the model that produced it, whether it is current or stale, and **Regenerate** / **Dismiss**. The bare invocation is a client-side command decoration, so nothing goes to the model; `/recap status|config|clear|help` still run on the Host and answer as text.
2. **A recap card directly above the composer** (`conversation.input.dock`): a `✦ Recap` label, the first two lines of the recap, a `stale` marker, and `↻` / `×`. Clicking the text opens the same panel. It only appears while a recap exists, is visible, and the Session is not running, so sending a message hides it immediately instead of waiting for the next poll.
3. The panel lives in the frame-wide `shell.overlay` slot (not a portal into `document.body`), so the shell owns its stacking order and mask. It targets the Session in the centre column and closes when that Session changes.
4. The line is not full-bleed: the dock allocates the whole conversation column, so the card constrains itself with the host's own geometry (`--dsh-composer-card-max-width`, `--dsh-composer-side-clearance`, `--dsh-composer-dock-inset`) and ends up the same width as the transcript text, centred over the composer.
5. The card is opaque: it floats over the scrolling transcript, so it paints the host's menu tint over the base layer instead of a translucent fill. Otherwise text scrolling underneath reads through the recap copy.
6. **Plugins page** (`plugins.bundle.config`, keyed `dsh-recap`): the **Recap model** section described under Model selection, so the pin is configurable without typing a command.
7. Both the line, the panel, and the configuration section use `--dsw-alias-*` tokens and scale from `--dsh-content-font-size`. The panel is a real modal: `aria-modal`, initial focus, a Tab trap, Escape to close, and focus returning to the opener. Copy comes from the Client locale service (`zh`/`en`).

The composer line hides on the next human message and reappears when a new recap is generated.

## Storage

| Path | Contents |
|------|----------|
| `$DSH_HOME/dsh-recap/<session-id>.json` | `{ version, text, seq, hidden? }` — the recap, the session log length it reflects, and whether the user dismissed it |
| `$DSH_HOME/dsh-recap.json` | Optional pinned `{ provider, model }` |

Records are written atomically through a temp file and rename, with mode `0600` in a `0700` directory: a recap names files and decisions, so it must not be world-readable. Records untouched for `retentionDays` are pruned at activation.

A recap is current while the session log length is unchanged; any new event makes it stale. Dismissing persists, so a reload does not resurrect it. File storage is deliberate: a third-party bundle resolves its own copy of `@deepseek-ai/dsh-session`, so the private-brand `appendPluginRecord` entry point cannot write to the runtime's Session.

## Model selection

The pin is global — one `$DSH_HOME/dsh-recap.json` for every Session — and
cleared by `reset`, which makes each Session recap with its own current route.
The Plugins page reads the catalog through `GET /api/dsh-recap/models`
(`ctx.llm.listProviders()` plus each adapter's `listModels()`, cached for 60 s,
5 s per provider) and writes the pin through `POST /api/dsh-recap/config`. A
provider whose catalog fails still appears, with its error, so the page can
explain an empty model list. Only a registered provider is accepted; the model
id is free-form because catalog membership does not constrain routing.

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

A recap takes two requests on the session's route (or the pinned one), both through dsh's `ctx.llm.stream`:

1. **Language detection** (`src/language.ts`). It sees *only* the user's own messages — never the assistant's replies — and answers one code (`en`, `zh-Hans`, `zh-Hant`, `ja`, `ko`, …, `unknown`). This exists because one request cannot do both jobs: the recap request carries User *and* Assistant turns, so a short Chinese question followed by a long English answer reads as English and produced English recaps. The probe asks for the cheapest reasoning level the route advertises (`off` where offered), reads at most 512 output tokens, and gives up after 8 s.
2. **The recap itself**, with the detected language appended as a hard `## Output language` instruction. The system prompt keeps a soft rule for the case where nothing was detected, so the model judges from the user's messages instead.

The 512-token probe budget is not padding. Measured on `deepseek-flash` through the local provider, a one-word answer still spends 13–135 tokens thinking first, and the route ignores `reasoning.effort` / `reasoning.enabled: false` entirely — a 32-token budget returned an empty string on roughly one call in six. So the detector degrades in two steps: if the model answer is empty, truncated, unparsable, or times out, the **script heuristic** (`heuristicLanguage`: Han/kana/Hangul/Cyrillic/Arabic counts over the user prose, with code fences, inline code, URLs, and paths stripped first) decides; only when that is inconclusive does the recap prompt's soft rule apply. Twelve live probes landed 12/12 correct answers in 0.5–1.5 s, and a two-request recap took 1.9–2.5 s end to end.

The sanitizer is pi-recap's. Length guidance is per language: ~160 characters for a Latin script, ~80 for CJK. A detection result is cached per Session against the exact user text, so regenerating without a new human turn does not re-detect, and `/recap status` reports both the code and whether the model or the heuristic decided it. `maxTokens` and `timeoutMs` govern the recap request; the probe has its own budget. Failures on automatic recaps stay silent; manual failures report the reason, and the panel shows the Host's error text instead of a generic message.
