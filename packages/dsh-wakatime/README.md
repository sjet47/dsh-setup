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

File heartbeats read dsh's snake_case fs arguments (`file_path`, `content`, `old_string`/`new_string`). `write` and `edit` report estimated line changes; rejected calls produce none.

## Behaviour

1. Finds a global `wakatime-cli`, else installs one under `~/.wakatime/` and refreshes it periodically.
2. Respects WakaTime `proxy` and `no_ssl_verify` settings.
3. Throttles session heartbeats to one per 60 s per session and serializes CLI calls.
4. Logs to `~/.wakatime/pi-wakatime.log` and keeps throttle state per session.

## Differences from pi-wakatime

- The synthetic session entity is `<cwd>/.dsh-session` (pi uses `.pi-session`), so the two agents stay distinguishable in WakaTime.
- `PreCompact` has no dsh session event to hook; compaction is not reported.
- State files keep the existing `~/.wakatime/pi-wakatime-state/` layout, keyed by dsh session id.
