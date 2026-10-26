# dsh-wakatime

Track dsh usage, tool activity and AI line changes with [WakaTime](https://wakatime.com/).

Put your API key in `~/.wakatime.cfg`:

```ini
[settings]
api_key = your_wakatime_api_key
```

## Event mapping

dsh's event-sourced session log replaces pi's extension hooks; the heartbeat semantics are unchanged.

| # | dsh event | WakaTime concept |
|---|-----------|------------------|
| 1 | `user/message` with `source.kind === 'user'` | `UserPromptSubmit` session heartbeat |
| 2 | `tool/call` | `PreToolUse` session heartbeat |
| 3 | `tool/result` | `PostToolUse` session heartbeat, then a file heartbeat for `read`/`read_image`/`write`/`edit` |
| 4 | `session/disposed` | `SessionEnd` |

File heartbeats read dsh's snake_case fs arguments (`file_path`, `content`, `old_string`/`new_string`). `write` and `edit` report estimated line changes; rejected calls produce none. Child subagent Sessions are skipped unless `trackSubagents` is on.

## Behaviour

1. Finds a global `wakatime-cli`, else installs one under `~/.wakatime/` and refreshes it periodically.
2. Verifies the release archive against the published `checksums_sha256.txt` when it is reachable, extracts only the expected binary, and bounds every GitHub request by a 30 s timeout, a 2 MiB JSON cap, and a 64 MiB archive cap.
3. Respects WakaTime `proxy` and `no_ssl_verify` settings.
4. Throttles session heartbeats to one per `sessionHeartbeatIntervalMs` per Session, serializes CLI calls, coalesces a queued session heartbeat with a newer one for the same Session, and caps the pending queue at 100.
5. Keeps throttle state in `~/.wakatime/dsh-wakatime-state/` and prunes records untouched for `retentionDays` at activation.
6. Logs to `~/.wakatime/dsh-wakatime.log` (dsh's own file, separate from pi's). A failed CLI install only disables heartbeats; it never rejects an unobserved promise or fails plugin activation.

## Configuration

| Field | Default | Meaning |
|-------|---------|---------|
| `enabled` | `true` | Send heartbeats at all |
| `sessionHeartbeatIntervalMs` | `60000` | Throttle window for one Session's heartbeats |
| `retentionDays` | `30` | Delete throttle records older than this; `0` keeps them |
| `stateDir` | `""` | Override the state directory (empty uses `~/.wakatime/dsh-wakatime-state`) |
| `trackSubagents` | `false` | Also report child subagent Sessions |
| `debug` | `false` | Force debug logging |

Setting `debug = true` in `~/.wakatime.cfg` under `[settings]` still works as before.

## Differences from pi-wakatime

- The synthetic session entity is `<cwd>/.dsh-session` (pi uses `.pi-session`), so the two agents stay distinguishable in WakaTime.
- `PreCompact` has no dsh session event to hook; compaction is not reported.
- Throttle state and the diagnostic log are dsh-specific paths, so enabling this plugin never rewrites pi-wakatime's files.
