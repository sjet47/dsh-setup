# dsh-mr

Show the current branch's merge request (GitLab) or pull request (GitHub) in the dsh Web session header.

```
⬤ !31681 ✓CI feat(oa-web): 顶部导航、工作台与移动端骨架…
```

## What each part means

| # | Token | Meaning |
|---|-------|---------|
| 1 | `⬤` / `◌` / `✔` / `✕` | open · draft · merged · closed |
| 2 | `!31681` / `#42` | request ref; the chip links to the request |
| 3 | `✓CI` / `✗CI` / `⋯CI` | head pipeline success · failed/cancelled · queued/running (omitted when unknown) |
| 4 | `⚠` | open request whose branch conflicts with the target (GitLab only) |
| 5 | title | request title, truncated by the header |

Nothing is shown when the directory is not a git repo, HEAD is detached, the branch has no request, or the CLI fails.

## Behaviour

1. The chip reads the authenticated `/api/dsh-mr/status` route, re-polling at the configured `refreshMs` (minimum 15 s) and pausing while the page is hidden; becoming visible again re-reads immediately.
2. The chip shrinks to `min(360px, 40vw)`, uses the theme's secondary content font size, exposes the full state as its accessible name, and only renders a link for an `http:`/`https:` URL.
3. Signed-in state and diagnostics are announced through the Client locale service (`zh`/`en`), so the chip follows Settings → Language.
4. A failed forge lookup keeps the previous chip instead of blanking the header.

## Commands

| Command | Result |
|---------|--------|
| `/mr` | Refresh and print state, title, URL and forge |
| `/mr status` | Same, served from the cache when still fresh |

## How data is fetched

1. The working directory is the Session's effective directory from `ctx.workingDirectory`, falling back to the Session header's initial `cwd`, so a Session that moved with the `working_directory` tool is looked up where it now works.
2. `git rev-parse --abbrev-ref HEAD` per request (5 s timeout).
3. The forge is resolved from remote URLs once per working directory and re-checked every 10 minutes: any non-GitHub host means `glab`, only an all-GitHub set means `gh`. Concurrent first readers await one shared lookup.
4. The request is queried when the cache is stale (20 s CLI timeout). GitLab falls back to the head commit's `last_pipeline` when the request carries no `head_pipeline`.
5. Both CLIs reuse their own authentication; no tokens are stored here.

## Configuration

| Field | Default | Meaning |
|-------|---------|---------|
| `refreshMs` | `60000` | How long a fetched request stays fresh; also drives the chip's poll interval |
| `enabled` | `true` | Set false to keep the plugin loaded but stop lookups — both the chip and `/mr` |

Set values in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-mr
  name: dsh-mr
  config:
    refreshMs: 120000
```

## Requirements

`git` plus `glab` (GitLab, self-hosted included) or `gh` (GitHub).
