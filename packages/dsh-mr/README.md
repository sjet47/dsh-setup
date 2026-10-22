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

## Commands

| Command | Result |
|---------|--------|
| `/mr` | Refresh and print state, title, URL and forge |
| `/mr status` | Same, served from the cache when still fresh |

## How data is fetched

1. `git rev-parse --abbrev-ref HEAD` per request (5 s timeout).
2. The forge is resolved from remote URLs once per working directory: any non-GitHub host means `glab`, only an all-GitHub set means `gh`.
3. The request is queried when the 60 s cache is stale (20 s CLI timeout). GitLab falls back to the head commit's `last_pipeline` when the request carries no `head_pipeline`.
4. Both CLIs reuse their own authentication; no tokens are stored here.

## Configuration

| Field | Default | Meaning |
|-------|---------|---------|
| `refreshMs` | `60000` | How long a fetched request stays fresh |
| `enabled` | `true` | Set false to keep the plugin loaded but stop lookups |

## Requirements

`git` plus `glab` (GitLab, self-hosted included) or `gh` (GitHub).
