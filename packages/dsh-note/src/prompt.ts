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
 * Rules text aimed at the model. The memory directory is Claude Code's
 * auto-memory directory: pi, dsh and Claude Code all read and write it, in
 * Claude Code's file format. Keep the "# Memory" half byte-identical to
 * pi-note's rules text (extensions/pi-note/prompt.ts); only the scratchpad
 * section differs.
 */
export const RULES_TEXT = `# Memory

You have a persistent file-based memory for this project at \`<MEMORY_DIR>\`. This directory already exists — write to it directly. Do not run mkdir and do not check whether it exists.

Claude Code reads and writes the same directory in the same format, and so do other pi and dsh sessions on this machine: another agent may have created, edited or deleted a memory since you last looked. Re-read a file before rewriting it, and never rewrite \`MEMORY.md\` from memory — read it, change your line, and write the whole file back.

Memory is what a future session on this project needs so it does not repeat a mistake, redo work, or work out again what has already been found. Each memory is one markdown file holding one topic that can be updated on its own, named after its frontmatter \`name\`: a kebab-case slug, so \`ask-behavior-not-tech.md\`.

Every memory file starts with frontmatter — recall selects on these fields, so do not skip them:

\`\`\`
---
name: ask-behavior-not-tech
description: Ask frontend decisions as visible behavior, never as implementation choices
metadata:
  type: feedback
---
\`\`\`

1. \`name\` — the kebab-case slug, identical to the file name without \`.md\`.
2. \`description\` — one specific line (well under 150 characters) saying what question this file answers. Recall matches on it: a missing or vague description makes the memory unfindable.
3. \`metadata.type\` — exactly one of:
   1. \`user\` — who the user is: role, expertise, preferences.
   2. \`feedback\` — guidance about how to work, both corrections and approaches the user confirmed. Body: the rule or fact first, then \`**Why:**\` (the reason or the incident behind it) and \`**How to apply:**\` (when it kicks in).
   3. \`project\` — ongoing work, goals, constraints, decisions that neither the code nor git history shows. Same \`**Why:**\` / \`**How to apply:**\` body. Convert relative dates ("last Thursday") to absolute ones.
   4. \`reference\` — pointers to external resources: URLs, dashboards, tickets.
4. \`metadata.modified\` — an ISO timestamp, only when you have one; recall falls back to the file's mtime.

Link related memories in the body with \`[[name]]\`; a link to a \`name\` that does not exist yet is fine, it marks something worth writing later. Keep each memory file well under 4 KB including frontmatter — recall reads only the head of a file, so split or summarize a memory that outgrows that rather than letting it grow.

After writing the file, add a one-line pointer in \`<MEMORY_DIR>/MEMORY.md\`: \`- [Title](file.md) — hook\`, where the hook is a short phrase (under ~150 characters) saying when the memory is relevant. One line per memory, never put memory content there, and no frontmatter in the index.

Writing a memory file and updating this index are one atomic step: never create, rename, or delete a memory file without adding, fixing, or removing its \`MEMORY.md\` line in the same turn. A memory file with no index line is invisible to future sessions — the index snapshot is the only recall path.

Write a memory as the conclusion — what is true, what to do or avoid, and why — not as a record of what happened. Memory is not a log: no running records, per-run results, progress notes or timelines. When a topic changes, rewrite its conclusion in place instead of appending entries. Work state that a later session has to pick up (progress, next steps) belongs in the project's own files, such as a handoff or plan document, not in memory; this session's artifacts belong in the scratchpad.

The index is included below as a snapshot taken at session start. When a line looks relevant to the task at hand, read that file before acting on the topic; do not guess at its contents from the hook. Memories you write during this session will not appear in the snapshot; read \`<MEMORY_DIR>/MEMORY.md\` directly when you need the authoritative current list, and after context compaction before acting on past agreements.

Changes to \`<MEMORY_DIR>/MEMORY.md\` made while this session is idle are announced at the start of your next turn, with the file's new content. Writes this session makes itself are not announced. Treat an announced change as a fresh read of the index: it supersedes the snapshot above.

Before saving, check the index for an existing entry that already covers it. Update that file rather than creating a duplicate; delete memories that turn out to be wrong. Don't save what the repo already records (code structure, past fixes, git history, AGENTS.md) or what only matters to the current conversation; if asked to remember one of those, ask what was non-obvious about it and save that instead. Never save secrets or credentials. Memories reflect what was true when written — if one names a file, function, or flag, verify it still exists before recommending it.

# Scratchpad

\`<SCRATCH_DIR>\` is this session's workspace for the artifacts it produces and reuses but that do not belong in the project — scripts, temporary files, intermediate results, debug output. Put any script longer than a one-liner, or one you may run more than once, in a file there instead of inline (heredoc, \`python -c\`, long command lines): when it needs a tweak, edit the file and run it again rather than rewriting it from scratch. Use it instead of \`/tmp\`, the working directory, or the memory directory. It already exists and is session-specific; it does not carry over to later sessions. It is also exported to shell calls as \`$DSH_NOTE_SCRATCHPAD_DIR\`; in other tools write the absolute path. Only use \`/tmp\` if the user explicitly asks.`
