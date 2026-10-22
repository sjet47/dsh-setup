// Git-aware project identity. Separate from paths.ts, which stays pure path
// math (no fs, no process) so it can be unit-tested in isolation.
//
// Why this exists: `git worktree add` gives one repository several working
// directories. A cwd-keyed slug would give each of them its own memory dir and
// split one project's facts across N dirs, invisible to each other. Keying the
// memory dir on the git root instead makes every worktree of a repo share the
// main checkout's dir — and keeps the main checkout's dir name unchanged.
import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";

/** Give up on git rather than stall a session start on a hung or huge repo. */
const GIT_TIMEOUT_MS = 5_000;

/**
 * The working directory a session's memory dir should be keyed on: the main
 * worktree of the enclosing git repository, or `cwd` unchanged when there is no
 * repository to key on.
 *
 * Never throws. A missing `git`, a cwd outside any repo, a bare repo, a
 * submodule, an unusable git layout or a git older than 2.31 (no
 * `--path-format=absolute`) all fall back to `cwd` — exactly the pre-git
 * behavior, i.e. one memory dir per directory.
 */
export function memoryRootFor(cwd: string): string {
	const resolved = resolve(cwd);
	try {
		// Absolute is required: from a subdirectory git prints a path relative
		// to the repo root (a bare ".git"), which we cannot resolve against cwd.
		const commonDir = execFileSync(
			"git",
			["rev-parse", "--path-format=absolute", "--git-common-dir"],
			{ cwd: resolved, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: GIT_TIMEOUT_MS },
		).trim();
		// The main worktree's `<root>/.git` is the one directory every linked
		// worktree shares. Any other shape (submodule gitdir, `--separate-git-dir`
		// or a bare repo) has no root we can derive safely, so leave it unmerged
		// rather than merge unrelated projects by accident.
		return basename(commonDir) === ".git" ? dirname(commonDir) : resolved;
	} catch {
		return resolved;
	}
}
