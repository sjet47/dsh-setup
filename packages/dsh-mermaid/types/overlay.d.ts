/**
 * `shell.overlay` is declared by `@deepseek-ai/dsh-client-ui-layout`, which a
 * standalone bundle does not depend on. Mirror its declaration so the client
 * build type-checks this additive registration; the live slot catalog
 * (`Slots.listSubTree`) confirms a root-scoped, click-through list slot.
 */

// Keep this file a module so the block above AUGMENTS the package instead of
// declaring an ambient module that would shadow its real exports.
export {}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'shell.overlay': {
      kind: 'list'
      scope: 'root'
    }
  }
}
