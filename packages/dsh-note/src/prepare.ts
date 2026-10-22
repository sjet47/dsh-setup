// Filesystem side of session setup, factored out of the hook so it can be
// exercised against throwaway directories. Throws on failure; the caller (the
// session_start hook) owns the degradation policy (SPEC §6 F1 step 5).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_INDEX_NAME } from "./paths.js";

export interface PreparedSession {
	/** MEMORY.md content at session start; "" means there is no index yet. */
	snapshot: string;
}

/**
 * Create the project memory dir and an empty MEMORY.md if missing, create the
 * session scratchpad dir with mode 0700, then read MEMORY.md back as the
 * session snapshot. Idempotent: re-running on fork/reload is safe — existing
 * dirs are left untouched and the snapshot is re-read from disk.
 *
 * Both dirs MUST be pre-created here: the rules text tells the agent the dirs
 * already exist so it skips mkdir / existence checks on every write.
 */
export function prepareSession(memoryDir: string, scratchDir: string): PreparedSession {
	mkdirSync(memoryDir, { recursive: true });
	const memoryIndex = join(memoryDir, MEMORY_INDEX_NAME);
	if (!existsSync(memoryIndex)) writeFileSync(memoryIndex, "", "utf8");
	mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
	chmodSync(scratchDir, 0o700); // pin 0700 regardless of the process umask
	return { snapshot: readFileSync(memoryIndex, "utf8") };
}
