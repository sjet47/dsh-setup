// Filesystem/env half of the memory location: read Claude Code's own config so
// dsh-note lands on the exact directory Claude Code (and pi-note) use. Kept out
// of paths.ts so that module stays fs-free.
//
// Mirrored: `$CLAUDE_CONFIG_DIR` (else `~/.claude`), and `autoMemoryDirectory`
// from `<config>/settings.json`. Deliberately NOT mirrored:
// `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`, `CLAUDE_CODE_REMOTE_MEMORY_DIR`
// (cowork/cloud-session modes dsh does not run in) and `autoMemoryEnabled`
// (a Claude Code toggle must not silently switch dsh's memory off).
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ClaudeMemoryConfig } from './paths.js'

/** Env var Claude Code resolves its config dir from. */
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR'

/**
 * Claude Code's config dir: `$CLAUDE_CONFIG_DIR`, else `<home>/.claude`.
 * @param env - environment to read.
 * @param home - home directory.
 * @returns absolute config dir.
 */
export function claudeConfigDir(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const configured = env[CLAUDE_CONFIG_DIR_ENV]?.trim()
  if (configured !== undefined && configured !== '') return expandHome(configured, home)
  return join(home, '.claude')
}

/**
 * Expand a leading `~/` (the only expansion Claude Code performs on it).
 * @param path - configured path.
 * @param home - home directory.
 * @returns absolute path.
 */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === '~') return resolve(home)
  if (path.startsWith('~/')) return resolve(join(home, path.slice(2)))
  return resolve(path)
}

/**
 * Normalize a parsed Claude Code settings object (or anything a failed read
 * produced) into the memory config dsh-note needs. A mistyped or relative
 * `autoMemoryDirectory` is ignored rather than guessed at.
 * @param raw - parsed settings, or anything.
 * @param configDir - already-resolved config dir.
 * @param home - home directory.
 * @returns the memory config.
 */
export function normalizeClaudeMemoryConfig(
  raw: unknown,
  configDir: string,
  home: string = homedir(),
): ClaudeMemoryConfig {
  if (typeof raw !== 'object' || raw === null) return { configDir }
  const value = (raw as { autoMemoryDirectory?: unknown }).autoMemoryDirectory
  if (typeof value !== 'string' || value.trim() === '') return { configDir }
  return { configDir, autoMemoryDirectory: expandHome(value.trim(), home) }
}

/**
 * Read `<configDir>/settings.json`; unreadable or malformed means "defaults".
 * @param env - environment to read.
 * @param home - home directory.
 * @returns the memory config.
 */
export function resolveClaudeMemoryConfig(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): ClaudeMemoryConfig {
  const configDir = claudeConfigDir(env, home)
  try {
    const raw: unknown = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))
    return normalizeClaudeMemoryConfig(raw, configDir, home)
  } catch {
    return { configDir }
  }
}
