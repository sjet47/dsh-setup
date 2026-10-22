// Prefix expansion of $PI_NOTE_SCRATCHPAD_DIR inside non-shell tool arguments
// (SPEC §6 F3). Pure string function, unit-testable in isolation.
import { SCRATCH_ENV_VAR } from "./paths.js";

/** `$PI_NOTE_SCRATCHPAD_DIR` — the variable without braces. */
export const SCRATCH_VAR = `$${SCRATCH_ENV_VAR}`;
/** `${PI_NOTE_SCRATCHPAD_DIR}` — the braced form. */
export const SCRATCH_VAR_BRACED = "${" + SCRATCH_ENV_VAR + "}";

const FORMS = [SCRATCH_VAR, SCRATCH_VAR_BRACED];

/**
 * Expand a scratchpad variable that is the whole value, or at its very start
 * followed by `/` or end-of-string:
 * - `$PI_NOTE_SCRATCHPAD_DIR`        -> <dir>
 * - `$PI_NOTE_SCRATCHPAD_DIR/x`      -> <dir>/x
 * - `${PI_NOTE_SCRATCHPAD_DIR}/x`    -> <dir>/x
 * Everything else is returned unchanged:
 * - `$PI_NOTE_SCRATCHPAD_DIR_BACKUP` (next char after the name is not `/`)
 * - the variable in the middle of a value (e.g. file content)
 * - values with no variable at all
 */
export function expandScratchVar(value: string, dir: string): string {
	for (const form of FORMS) {
		if (value === form) return dir;
		if (value.startsWith(form) && value[form.length] === "/") {
			return dir + value.slice(form.length);
		}
	}
	return value;
}

/**
 * Apply the expansion to every top-level string value of a tool input, leaving
 * non-strings (arrays, nested objects) untouched — SPEC §6 F3: scan only the
 * top level, never recurse. The bash tool is skipped by the caller (its
 * command relies on the real env var); this function only patches strings.
 */
export function expandInputStrings(input: Record<string, unknown>, dir: string): void {
	for (const key of Object.keys(input)) {
		const value = input[key];
		if (typeof value !== "string") continue;
		input[key] = expandScratchVar(value, dir);
	}
}
