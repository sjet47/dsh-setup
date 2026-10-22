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
export function buildTopics(indexText: string, files?: MemoryFileInfo[]): MemoryTopic[] {
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
		.map<MemoryTopic>((entry) => ({
			title: entry.name,
			file: entry.name,
			hook: "",
			indexed: false,
			exists: true,
			size: entry.size,
			mtimeMs: entry.mtimeMs,
		}));
	return [...indexed, ...orphans];
}

/** Text a topic is searched by (title, file name and hook). */
export function topicMatchText(topic: MemoryTopic): string {
	return topic.indexed
		? `${topic.title} ${topic.file} ${topic.hook}`
		: topic.file;
}
