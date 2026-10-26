// Minimal Cordis-context double for Host plugin tests. It records every
// registration so a test can invoke the exact route, command, or listener the
// plugin installed, without mounting the harness.
export function makeContext(session, options = {}) {
  const routes = new Map()
  const commands = new Map()
  const listeners = new Map()
  const sections = []
  const shellContributors = []
  const disposers = []

  const optionalServices = {}
  if (options.workingDirectory !== undefined) {
    optionalServices.workingDirectory = options.workingDirectory
  }
  if (options.llm !== undefined) optionalServices.llm = options.llm

  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    effect(fn) {
      const disposer = fn()
      const run = typeof disposer === 'function' ? disposer : () => {}
      disposers.push(run)
      return run
    },
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => {}
    },
    /** Optional-service lookup, mirroring `ctx.get(name)`. */
    get(name) {
      if (name in optionalServices) return optionalServices[name]
      if (name === 'sessions') return ctx.sessions
      return undefined
    },
    sessions: {
      get(id) {
        return String(id) === String(session.id) ? session : undefined
      },
      list() {
        return [session]
      },
    },
    commands: {
      register(definition) {
        commands.set(definition.name, definition)
        return () => {}
      },
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return () => {}
        },
      },
    },
    inject(_deps, callback) {
      return callback(ctx) ?? { dispose: async () => {} }
    },
    shellEnv: {
      register(contributor) {
        shellContributors.push(contributor)
        return () => {}
      },
    },
    ...optionalServices,
  }

  return {
    ctx,
    routes,
    commands,
    listeners,
    sections,
    shellContributors,
    /** Run every disposer the plugin registered through `ctx.effect`. */
    async disposeAll() {
      for (const disposer of disposers.reverse()) await disposer()
      disposers.length = 0
    },
    /** Deliver one Host event to every listener registered for it. */
    emit(event, ...args) {
      for (const fn of listeners.get(event) ?? []) fn(...args)
    },
    /** Agent double whose scoped context captures system-prompt sections. */
    makeAgent(id) {
      return {
        id,
        ctx: {
          inject(_deps, callback) {
            callback({
              systemPrompt: {
                section(section) {
                  sections.push(section)
                  return () => {}
                },
              },
            })
            return { dispose: async () => {} }
          },
        },
      }
    },
  }
}

/** JSON response body helper for exact-route tests. */
export async function jsonOf(response) {
  return JSON.parse(await response.text())
}
