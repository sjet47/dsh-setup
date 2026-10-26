// System-prompt material for dsh-note. Byte-stable per session: the index
// snapshot is read once when the agent is created and held, so every turn of a
// session assembles the identical block and the prompt prefix stays cacheable.
//
// Difference from pi-note: the scratchpad directory is written as an absolute
// path, not `$PI_NOTE_SCRATCHPAD_DIR`. dsh cannot rewrite tool arguments, so a
// variable would only work in shell calls; an absolute path works in read,
// write, edit and bash alike.

/** Header of the injected snapshot section. */
export const MEMORY_INDEX_HEADER = '## Memory index'

/** Suffix appended to a snapshot that had to be cut for the prompt budget. */
export const SNAPSHOT_TRUNCATED = '(snapshot truncated; read MEMORY.md for the rest)'

/**
 * Build the byte-exact block appended to the system prompt for one session.
 * @param memoryDir - absolute project memory directory.
 * @param scratchDir - absolute session scratchpad directory.
 * @param snapshot - `MEMORY.md` content read at agent creation.
 * @param maxChars - longest snapshot accepted; the rest is replaced by a note.
 * @returns the block, always starting with a blank separator line.
 */
export function buildPromptAppend(memoryDir: string, scratchDir: string, snapshot: string, maxChars = Number.POSITIVE_INFINITY): string {
  const rules = RULES_TEXT.split('<MEMORY_DIR>').join(memoryDir).split('<SCRATCH_DIR>').join(scratchDir)
  if (snapshot === '') return '\n\n' + rules
  const bounded = snapshot.length > maxChars ? `${snapshot.slice(0, Math.max(0, maxChars))}\n\n${SNAPSHOT_TRUNCATED}\n` : snapshot
  return '\n\n' + rules + '\n\n' + MEMORY_INDEX_HEADER + '\n\n' + bounded
}

/**
 * Rules text aimed at the model. The memory directory is shared with pi: both
 * agents read and write `<pi agent dir>/pi-note/<project slug>/`.
 */
export const RULES_TEXT = `# Memory

You have a persistent file-based memory for this project at \`<MEMORY_DIR>\`. This directory already exists — write to it directly. Do not run mkdir and do not check whether it exists.

Each memory is one markdown file holding one topic that can be updated on its own, named \`<short-kebab-case-slug>.md\`, no frontmatter. Worth saving: who the user is (role, expertise, preferences); guidance the user has given on how you should work, with the why; durable project or cross-project decisions and constraints not derivable from the code or git history (convert relative dates to absolute); pointers to external resources (URLs, dashboards, tickets).

Memory is for what is still true in a future session — durable facts and decisions. Anything with a shorter life — in-progress state, drafts, intermediate results, throwaway scripts, command output, logs — belongs in the scratchpad, never in memory. If you are unsure whether something outlives the current task, write it to the scratchpad.

After writing the file, add a one-line pointer in \`<MEMORY_DIR>/MEMORY.md\`: \`- [Title](file.md) — hook\`. One line per memory, never put memory content there.

Writing a memory file and updating this index are one atomic step: never create, rename, or delete a memory file without adding, fixing, or removing its \`MEMORY.md\` line in the same turn. A memory file with no index line is invisible to future sessions — the index snapshot is the only recall path.

The index is included below as a snapshot taken at session start. When a line looks relevant to the task at hand, read that file before acting on the topic; do not guess at its contents from the hook. Memories you write during this session will not appear in the snapshot; read \`<MEMORY_DIR>/MEMORY.md\` directly when you need the authoritative current list, and after context compaction before acting on past agreements.

Before saving, check the index for an existing entry that already covers it. Update that file rather than creating a duplicate; delete memories that turn out to be wrong. Don't save what the repo already records (code structure, past fixes, git history, AGENTS.md) or what only matters to the current conversation; if asked to remember one of those, ask what was non-obvious about it and save that instead. Never save secrets or credentials. Memories reflect what was true when written — if one names a file, function, or flag, verify it still exists before recommending it.

# Scratchpad

\`<SCRATCH_DIR>\` is a scratch directory for this session. Use it for temporary files — intermediate results, throwaway scripts, command output that doesn't belong in the project — instead of \`/tmp\`, the working directory, or the memory directory. It already exists and is session-specific. It is also exported to shell calls as \`$DSH_NOTE_SCRATCHPAD_DIR\`; in other tools write the absolute path. Only use \`/tmp\` if the user explicitly asks.`
