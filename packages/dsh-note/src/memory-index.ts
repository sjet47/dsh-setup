// Pure model for the `/memory` browser: turn MEMORY.md plus a listing of the
// memory dir into the topic rows the overlay renders. No fs, no pi imports —
// unit-testable in isolation, like paths.ts / prompt.ts.
//
// The index is the only thing the model ever sees, so it is the source of
// truth for order and titles; files on disk that the index does not mention
// ("orphans") are appended, because a memory file with no index line is
// invisible to every future session and showing it is the only way to notice.
import { MEMORY_INDEX_NAME } from "./paths.js";

/**
 * One entry of the memory dir listing: the file's name plus the two numbers the
 * browser shows in the right-hand meta column. Produced by memory-store.ts
 * (which owns fs) and consumed here, so the pure layer stays fs-free while
 * still deciding which entries count as memories.
 */
export interface MemoryFileInfo {
	/** File name, relative to the memory dir. */
	name: string;
	/** Bytes on disk. */
	size: number;
	/** Last modification time (epoch ms) — the "last maintained" signal. */
	mtimeMs: number;
}

export interface MemoryTopic {
	/** Link text from MEMORY.md; the file name for an unindexed file. */
	title: string;
	/** File name relative to the memory dir, e.g. `cli-preferences.md`. */
	file: string;
	/** One-line hook after the link; "" when the index line has none. */
	hook: string;
	/** false when the file exists but MEMORY.md has no line pointing at it. */
	indexed: boolean;
	/** false when the index points at a file that is not on disk. */
	exists: boolean;
	/** Bytes on disk; undefined when the file is missing or the listing is unavailable. */
	size?: number;
	/** Last modification time; undefined together with `size`. */
	mtimeMs?: number;
	/** `metadata.type` from the frontmatter; undefined when absent or unread. */
	type?: string;
	/** Frontmatter `description` — the line Claude Code recall matches on. */
	description?: string;
	/** `metadata.modified` when it parses, else the file mtime, in epoch ms. */
	modifiedMs?: number;
	/**
	 * Whether the file has a frontmatter block at all. A file without one cannot
	 * be recalled by Claude Code, so the browser says so instead of leaving the
	 * type cell blank — and `false` must stay distinguishable from "has a block
	 * but no `type` field".
	 */
	hasFrontmatter?: boolean;
}

/** `- [Title](file.md) — hook`; bullet or numbered list item. */
const INDEX_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\[([^\]]*)\]\(([^)]+)\)\s*(.*)$/;
/** Separator between the link and the hook text: `— hook`, `- hook`, `: hook`. */
const HOOK_SEPARATOR = /^\s*[—–\-:·|]+\s*/;
/** `scheme:` prefixes (http:, mailto:, …) and bare anchors are not memory files. */
const EXTERNAL_LINK = /^(?:[a-z][a-z0-9+.-]*:|#)/i;
/** Markdown link titles: `[t](file.md "Title")` — keep only the target. */
const LINK_TITLE = /^(\S+)\s+["']/;

/** Strip the separator that follows the link: `— hook` -> `hook`. */
export function stripHook(raw: string): string {
	return raw.replace(HOOK_SEPARATOR, "").trim();
}

/**
 * Normalize a markdown link target to a file name relative to the memory dir,
 * or undefined when it is not a memory file (`<file.md>`, `./file.md`,
 * `file.md "Title"` and percent-encoding are all accepted).
 */
export function normalizeLink(raw: string): string | undefined {
	let link = raw.trim();
	const angle = /^<(.*)>$/.exec(link);
	if (angle) link = angle[1].trim();
	const title = LINK_TITLE.exec(link);
	if (title) link = title[1];
	try {
		link = decodeURIComponent(link);
	} catch {
		// Malformed escapes: keep the raw target rather than dropping the line.
	}
	link = link.replace(/^\.\//, "");
	if (link === "" || EXTERNAL_LINK.test(link)) return undefined;
	return link;
}

/** Index lines in file order, deduplicated by target file. */
export function parseIndex(indexText: string): MemoryTopic[] {
	const topics: MemoryTopic[] = [];
	const seen = new Set<string>();
	for (const line of indexText.split("\n")) {
		const match = INDEX_LINE.exec(line);
		if (!match) continue;
		const file = normalizeLink(match[2]);
		if (file === undefined || seen.has(file)) continue;
		seen.add(file);
		topics.push({
			title: match[1].trim() || file,
			file,
			hook: stripHook(match[3]),
			indexed: true,
			exists: true,
		});
	}
	return topics;
}

/**
 * MEMORY.md with every index line pointing at `file` removed — the other lines
 * are kept byte for byte (order, formatting, trailing newline). Used when the
 * browser deletes a memory, so the index never keeps a line for a gone file.
 */
export function removeIndexEntry(indexText: string, file: string): string {
	return indexText
		.split("\n")
		.filter((line) => {
			const match = INDEX_LINE.exec(line);
			return match === null || normalizeLink(match[2]) !== file;
		})
		.join("\n");
}

/**
 * Topic rows for the browser: index entries (order preserved) followed by
 * memory files the index does not mention, sorted by name.
 *
 * `files` is the memory dir listing; pass undefined when it is unavailable, in
 * which case nothing is marked missing and no sizes/ages are shown. Only plain
 * names are looked up in the listing — a nested `sub/x.md` target is assumed
 * fine rather than reported missing, and gets no stats either.
 */
export function buildTopics(
	indexText: string,
	files?: MemoryFileInfo[],
	meta?: Map<string, MemoryFileMeta>,
): MemoryTopic[] {
	const indexed = parseIndex(indexText);
	const listed =
		files === undefined ? undefined : new Map(files.map((entry) => [entry.name, entry]));
	for (const topic of indexed) {
		if (listed === undefined || topic.file.includes("/")) continue;
		const info = listed.get(topic.file);
		topic.exists = info !== undefined;
		if (info !== undefined) {
			topic.size = info.size;
			topic.mtimeMs = info.mtimeMs;
			applyMeta(topic, meta?.get(topic.file), info.mtimeMs);
		}
	}
	const indexedFiles = new Set(indexed.map((topic) => topic.file));
	const orphans = (files ?? [])
		.filter(
			(entry) =>
				entry.name.toLowerCase().endsWith(".md") &&
				entry.name !== MEMORY_INDEX_NAME &&
				!indexedFiles.has(entry.name),
		)
		.sort((a, b) => a.name.localeCompare(b.name))
		.map<MemoryTopic>((entry) => {
			const topic: MemoryTopic = {
				title: entry.name,
				file: entry.name,
				hook: "",
				indexed: false,
				exists: true,
				size: entry.size,
				mtimeMs: entry.mtimeMs,
			};
			applyMeta(topic, meta?.get(entry.name), entry.mtimeMs);
			return topic;
		});
	return [...indexed, ...orphans];
}

/** Copy the recall fields of one file's frontmatter onto its topic row. */
function applyMeta(topic: MemoryTopic, meta: MemoryFileMeta | undefined, mtimeMs: number): void {
	topic.modifiedMs = meta?.modifiedMs ?? mtimeMs;
	topic.hasFrontmatter = meta?.frontmatter !== undefined;
	if (meta?.frontmatter === undefined) return;
	topic.type = meta.frontmatter.type;
	topic.description = meta.frontmatter.description;
}

/**
 * Text a topic is searched by: title, file name, hook, and — when the dir was
 * listed with metadata — the frontmatter `type` and `description`. The
 * description is included because it is the line Claude Code recall matches on,
 * so searching by the same words finds the same memories in both tools.
 */
export function topicMatchText(topic: MemoryTopic): string {
	const base = topic.indexed
		? `${topic.title} ${topic.file} ${topic.hook}`
		: topic.file;
	const extra = [topic.type, topic.description].filter(Boolean).join(" ");
	return extra === "" ? base : `${base} ${extra}`;
}

/** The frontmatter fields Claude Code selects memories by. */
export interface MemoryFrontmatter {
	/** Kebab-case slug; the file name without `.md`. */
	name?: string;
	/** One-line summary that recall matches on. */
	description?: string;
	/** `user` | `feedback` | `project` | `reference`. */
	type?: string;
	/** ISO timestamp of the last maintenance pass. */
	modified?: string;
}

/** What the memory dir listing learned from one file's frontmatter head. */
export interface MemoryFileMeta {
	/** Parsed fields; undefined when the file has no frontmatter block. */
	frontmatter?: MemoryFrontmatter;
	/** `metadata.modified` as epoch ms, when it parses. */
	modifiedMs?: number;
}

/** Parse a frontmatter timestamp; anything unparsable stays undefined. */
export function parseModified(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const parsed = Date.parse(value.trim());
	return Number.isNaN(parsed) ? undefined : parsed;
}

export interface MemoryDocument {
	/** Parsed fields, undefined when the file has no frontmatter block. */
	frontmatter?: MemoryFrontmatter;
	/** Everything after the frontmatter block, verbatim. */
	body: string;
}

/** Opening `---` on the first line; a leading blank line disqualifies the file. */
const FRONTMATTER_OPEN = /^---[ \t]*\r?\n/;
/** Closing `---` line, alone on a line. */
const FRONTMATTER_CLOSE = /\r?\n---[ \t]*(?:\r?\n|$)/;
/** One `key: value` line of the block. */
const FRONTMATTER_FIELD = /^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$/;

/** Strip one layer of matching quotes: `"a: b"` -> `a: b`. */
function unquote(value: string): string {
	const trimmed = value.trim();
	const quoted = /^(["'])([\s\S]*)\1$/.exec(trimmed);
	return quoted ? quoted[2] : trimmed;
}

/**
 * Split a memory file into its frontmatter fields and the body Claude Code (and
 * therefore pi-note) reads. Lenient on purpose: files written before the
 * frontmatter convention, or by an agent that only wrote some fields, still
 * have to open and render. `type` is accepted both nested
 * (`metadata:\n  type: feedback`, what Claude Code writes) and top level.
 */
export function splitFrontmatter(text: string): MemoryDocument {
	const open = FRONTMATTER_OPEN.exec(text);
	if (!open) return { body: text };
	const rest = text.slice(open[0].length);
	const close = FRONTMATTER_CLOSE.exec(rest);
	if (!close) return { body: text };
	const block = rest.slice(0, close.index);
	const body = rest.slice(close.index + close[0].length);
	const frontmatter: MemoryFrontmatter = {};
	let nested: "metadata" | undefined;
	for (const line of block.split(/\r?\n/)) {
		if (line.trim() === "") continue;
		const indented = /^[ \t]/.test(line);
		const field = FRONTMATTER_FIELD.exec(line.trim());
		if (field === null) continue;
		const key = field[1].toLowerCase();
		const value = unquote(field[2]);
		if (!indented) {
			nested = key === "metadata" && value === "" ? "metadata" : undefined;
			if (key === "name" && value !== "") frontmatter.name = value;
			else if (key === "description" && value !== "") frontmatter.description = value;
			else if (key === "type" && value !== "") frontmatter.type = value;
			else if (key === "modified" && value !== "") frontmatter.modified = value;
		} else if (nested === "metadata") {
			if (key === "type" && value !== "") frontmatter.type = value;
			else if (key === "modified" && value !== "") frontmatter.modified = value;
		}
	}
	return Object.keys(frontmatter).length === 0 ? { body } : { frontmatter, body };
}
