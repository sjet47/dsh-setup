// Pure path math for dsh-note. No fs, no dsh imports — unit-testable in isolation.
//
// Memory is NOT dsh-note's own directory: it is Claude Code's auto-memory
// directory, so one project's memories are the same files whichever agent wrote
// them (Claude Code, pi, dsh). Claude Code's rules, as of 2.1.319:
//
// 1. the dir is `<config>/projects/<slug>/memory`, where `<config>` is
//    `$CLAUDE_CONFIG_DIR` or `~/.claude` (claude-memory.ts owns the env +
//    settings half);
// 2. `<slug>` is the working directory with every character outside
//    `[A-Za-z0-9]` replaced by `-` (case kept, runs NOT collapsed), truncated
//    to 200 characters plus `-<base36 of a Java-style hash>` when longer;
// 3. the directory it keys on is the repository's main worktree, so every
//    linked worktree of one repo shares one memory dir — the same input
//    git-root.ts produces.
//
// Scratchpad stays dsh-note's own, session-scoped thing.
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

export const MEMORY_INDEX_NAME = 'MEMORY.md'
/** subdirectory of Claude Code's config dir that holds per-project dirs */
export const CLAUDE_PROJECTS_DIR = 'projects'
/** Claude Code's name for the auto-memory dir inside a project dir */
export const CLAUDE_MEMORY_DIR_NAME = 'memory'
/** prefix of the per-user scratchpad root under the tmpdir */
export const SCRATCHPAD_ROOT_PREFIX = 'pi-note'

/**
 * Claude Code's project key for a directory: `/home/sjet/repo/pi-setup` ->
 * `-home-sjet-repo-pi-setup`. Mirrors `fL()` in Claude Code: sanitize every
 * non-alphanumeric to `-`, and only when that is longer than 200 characters
 * append `-<hash>` computed over the unsanitized path (Java `hashCode`, base36,
 * absolute value) — matching it exactly matters: a mismatch silently splits one
 * project's memories across two dirs.
 * @param dir - directory to key on (the git main worktree, see git-root.ts).
 * @returns the project dir name Claude Code uses.
 */
export function claudeSlugFor(dir: string): string {
  const base = resolve(dir)
  const sanitized = base.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= 200) return sanitized
  return `${sanitized.slice(0, 200)}-${Math.abs(javaHash(base)).toString(36)}`
}

/**
 * Java's `String.hashCode`, which Claude Code uses for the truncation suffix.
 * @param text - path to hash.
 * @returns the 32-bit signed hash.
 */
function javaHash(text: string): number {
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(index)) | 0
  }
  return hash
}

/**
 * Short label for a memory root, used as the memory browser header:
 * `/home/sjet/repo/pi-setup` -> `~/repo/pi-setup`. Deliberately derived from the
 * real path, not from the slug — the slug is lossy, so reversing it would turn
 * `pi-setup` into `pi/setup`.
 * @param memoryRoot - directory the memory dir is keyed on.
 * @param home - home directory used for the `~` shortening.
 * @returns the label.
 */
export function memoryRootLabel(memoryRoot: string, home: string = homedir()): string {
  const resolved = resolve(memoryRoot)
  if (home === '') return resolved
  const root = resolve(home)
  if (resolved === root) return '~'
  return resolved.startsWith(root + sep) ? `~${resolved.slice(root.length)}` : resolved
}

/** The Claude Code side of the memory location, resolved from env + settings. */
export interface ClaudeMemoryConfig {
  /** `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
  configDir: string
  /** `autoMemoryDirectory` from Claude Code's user settings, absolute. */
  autoMemoryDirectory?: string
}

/**
 * Where Claude Code keeps one project's memories. `autoMemoryDirectory` wins
 * when set: Claude Code then ignores the project keying entirely and uses that
 * one dir for every project, so mirroring it is the only way to stay on the
 * same files.
 * @param config - resolved Claude Code config.
 * @param memoryRoot - the git main worktree.
 * @returns absolute memory dir.
 */
export function memoryDirFor(config: ClaudeMemoryConfig, memoryRoot: string): string {
  if (config.autoMemoryDirectory !== undefined) return config.autoMemoryDirectory
  return join(config.configDir, CLAUDE_PROJECTS_DIR, claudeSlugFor(memoryRoot), CLAUDE_MEMORY_DIR_NAME)
}

/** Numeric OS user id; 0 when the runtime does not expose it (non-POSIX). */
export function currentUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : 0
}

/**
 * Scratchpad root under the shared tmpdir. Layout is `/tmp/pi-note-<uid>/`
 * where `<uid>` is the numeric OS user id (process.getuid): the scratchpad
 * lives in the world-writable /tmp, so per-user isolation keeps different users
 * of one machine from colliding.
 * @param tmpDir - tmp root, defaults to the OS tmpdir.
 * @param uid - numeric user id, defaults to the process's.
 * @returns absolute scratchpad root.
 */
export function scratchpadRoot(
  tmpDir: string = tmpdir(),
  uid: number = currentUid(),
): string {
  return join(tmpDir, `${SCRATCHPAD_ROOT_PREFIX}-${uid}`)
}

/**
 * Session scratchpad dir: <root>/<session-id>. Session ids are global UUIDs.
 * @param sessionId - owning session.
 * @param root - scratchpad root, defaults to scratchpadRoot().
 * @returns absolute scratchpad dir.
 */
export function scratchpadDirFor(sessionId: string, root?: string): string {
  return join(root ?? scratchpadRoot(), sessionId)
}
