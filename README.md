# dsh-setup

Personal [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin collection — the dsh counterpart of [pi-setup](../pi-setup). Each package is an independently installable dsh bundle.

## Plugins

| # | Package | What it does | Ported from |
|---|---------|--------------|-------------|
| 1 | [`dsh-mr`](packages/dsh-mr/README.md) | Current branch's GitLab MR / GitHub PR in the session header, plus `/mr` | `pi-mr` |
| 2 | [`dsh-wakatime`](packages/dsh-wakatime/README.md) | WakaTime heartbeats for sessions, tools and AI line changes | `pi-wakatime` |
| 3 | [`dsh-note`](packages/dsh-note/README.md) | Project memory **shared with pi-note** + per-session scratchpad + memory browser | `pi-note` |
| 4 | [`dsh-recap`](packages/dsh-recap/README.md) | One-line session recap on demand, on resume, or after five idle minutes | `pi-recap` |

## Build

```bash
pnpm install
pnpm run build       # tsc host entries + client bundles
pnpm test            # node:test against built output
```

A package with a browser half compiles `src/client.tsx` to CommonJS and wraps it in the dsh module-loader frame at `lib/client.js`; `package.json`'s `dsh.client` then makes the Host serve it.

## Install

From the Web **Plugins** page:

1. **Add plugin** → **Install a third-party plugin**
2. Enter an absolute local path (`link:/home/sjet/repo/dsh-setup/packages/dsh-note`), a Git address, or a published package name
3. Install, then switch the new bundle **On**
4. Restart dsh (no HMR in the shipped Desktop profile), or rely on HMR where enabled

For a scratch profile during development:

```bash
dsh --profile dev --from-default-profile web --dump-config   # create it
dsh plugin --profile dev add link:/home/sjet/repo/dsh-setup/packages/dsh-note
# append "dsh-note" to dsh.profile.bundles in ~/.dsh/profiles/dev/package.json
dsh dev --port 33999 --no-open
```

The CLI's `dsh plugin add` installs the dependency; selecting the bundle is the Plugins page's job (or a manual `dsh.profile.bundles` entry as above).

## Notes for porting more plugins

1. **Third-party bundles resolve their own copy of `@deepseek-ai/*`.** Brand-sensitive entry points (for example `appendPluginRecord`, which calls a private Session method) therefore fail against runtime instances. Prefer public Session methods plus your own storage.
2. **`@deepseek-ai/*` imports that are type-only must stay type-only** (`import type`), so the bundle has no runtime dependency on the duplicated package.
3. **Client-host traffic uses the authenticated exact-Fetch registry**, `ctx.connection.fetch.register({ path: '/api/<plugin>/...' })`. The path must include the `/api/` prefix; only the owner Peer reaches it, so no token handling is needed.
4. **The browser half is a `window.__ModuleLoader__.load({ id, factory })` bundle** that may `require` only the platform baseline: `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `zod`, `@tanstack/react-virtual`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit`.
