/**
 * Slot declarations this standalone bundle registers into but cannot import
 * from their owners: a third-party package does not depend on
 * `@deepseek-ai/dsh-client-ui-layout` or `-ui-plugin-manager`, yet both slots
 * are live in the shipped Web composition. Mirroring the entries here keeps the
 * client build type-checked against the same contract; the live catalog
 * (`Slots.listSubTree`) is the runtime authority.
 *
 * Keep this file a module so the blocks below AUGMENT the package instead of
 * declaring an ambient module that would shadow its real exports.
 */
export {}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Frame-wide floating layer declared by `dsh-client-ui-layout`. */
    'shell.overlay': {
      kind: 'list'
      scope: 'root'
    }
    /**
     * A bundle's own configuration on its Plugins page, declared by
     * `dsh-client-ui-plugin-manager` and keyed by the bundle's package name.
     */
    'plugins.bundle.config': {
      kind: 'keyed'
      scope: 'root'
      owner: {
        /** `summary` renders the one-liner; `page` renders the form. */
        view: 'summary' | 'page'
      }
    }
  }
}
