# dsh-setup

Personal [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin collection — the dsh counterpart of [pi-setup](../pi-setup). Each package is an independently installable dsh bundle.

## Plugins

| # | Package | What it does | Ported from |
|---|---------|--------------|-------------|
| 1 | [`dsh-mr`](packages/dsh-mr/README.md) | Current branch's GitLab MR / GitHub PR in the session header, plus `/mr` | `pi-mr` |
| 2 | [`dsh-wakatime`](packages/dsh-wakatime/README.md) | WakaTime heartbeats for sessions, tools and AI line changes | `pi-wakatime` |
| 3 | [`dsh-note`](packages/dsh-note/README.md) | Project memory **shared with pi-note** + per-session scratchpad + memory browser | `pi-note` |
| 4 | [`dsh-recap`](packages/dsh-recap/README.md) | One-line session recap on demand, on resume, or after five idle minutes | `pi-recap` |

Every package ships the display resources the Plugins page reads without activating the plugin — `locale/en.json` + `locale/zh.json` (`meta.title`, `meta.description`) and `icon.svg` — and exports `Config` for its tunables, plus client copy registered through `@deepseek-ai/dsh-client-locale` so the UI follows Settings → Language.

## What changed in the DSH-fitting pass

1. **Effective working directory.** dsh-mr and dsh-note read `ctx.workingDirectory`, falling back to the Session header, so a Session moved with the `working_directory` tool is looked up where it now works.
2. **Frame-owned overlays.** Both panels render in the `shell.overlay` slot instead of `createPortal(document.body)`, once per Session, with `aria-modal`, initial focus, a Tab trap, and Escape handling.
3. **Host config.** Every plugin exposes `Config` for its tunables (refresh window, idle delay, retention, disable switch) so a profile patch survives upgrades.
4. **State hygiene.** Recap records are written atomically with `0600` in a `0700` directory and pruned by age; `/recap clear` also deletes the file, and dismiss persists. WakaTime uses its own state directory and log and prunes them.
5. **Correct teardown.** Pending recap timers, in-flight requests, and agent-scoped prompt sections are disposed when the plugin unloads.

## Build

```bash
pnpm install
pnpm run build       # tsc host entries + client bundles
pnpm test            # node:test against built output
pnpm run smoke       # render each client bundle's slots in Node
```

A package with a browser half compiles `src/client.tsx` to CommonJS and wraps it in the dsh module-loader frame at `lib/client.js`; `package.json`'s `dsh.client` then makes the Host serve it. A client-only slot that a standalone bundle cannot depend on (such as `shell.overlay`, declared by `dsh-client-ui-layout`) is mirrored in `types/*.d.ts` as a module augmentation for the client build.

## Install

From the Web **Plugins** page:

1. **Add plugin** → **Install a third-party plugin**
2. Enter an absolute local path (`link:/home/sjet/repo/dsh-setup/packages/dsh-note`), a Git address, or a published package name
3. Install, then switch the new bundle **On**
4. Restart dsh: client bundles reload through HMR, host rows (including a newly added `Config`) do not

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
5. **A frame-wide panel belongs in `shell.overlay`.** Do not append to `document.body`: the shell owns z-order, the click-through layer, the mask, and the `--dsh-frame-*` chrome insets.
6. **Client copy goes through the locale service.** Register a namespace in `apply` and bind it (or declare `locale: '<ns>'` on the slot registration); the shipped `locale/*.json` files are only for the Plugins page, which never activates the plugin.
