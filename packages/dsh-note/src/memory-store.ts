// Filesystem side of the `/memory` browser. Reads are fresh on every call, so
// the panel is never stale against the session snapshot. The only write is
// `deleteTopic` (the panel's confirmed delete): it removes the memory file and
// its MEMORY.md line, and nothing else — editing a memory is still the agent's
// or the external editor's job, and the index itself is never deletable.
import { closeSync, openSync, readFileSync, readdirSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { MEMORY_INDEX_NAME } from "./paths.js";
import {
	buildTopics,
	parseModified,
	removeIndexEntry,
	splitFrontmatter,
	type MemoryFileInfo,
	type MemoryFileMeta,
	type MemoryTopic,
} from "./memory-index.js";

/**
 * Every regular file in the memory dir, with the size and mtime the browser
 * shows. Returns undefined when the dir cannot be listed (nothing is then
 * reported missing).
 *
 * `statSync` (not `lstatSync`) deliberately follows symlinks, so a memory that
 * is a symlink to a real file counts as present; a broken symlink or a file
 * that vanishes mid-walk is skipped, which reads as "missing" downstream — the
 * accurate answer for a line you cannot open. Subdirectories are not walked.
 */
export function listMemoryFiles(memoryDir: string): MemoryFileInfo[] | undefined {
	let names: string[];
	try {
		names = readdirSync(memoryDir);
	} catch {
		return undefined;
	}
	const files: MemoryFileInfo[] = [];
	for (const name of names) {
		try {
			const info = statSync(join(memoryDir, name));
			if (!info.isFile()) continue;
			files.push({ name, size: info.size, mtimeMs: info.mtimeMs });
		} catch {
			// Vanished or unreadable: leave it out rather than invent stats.
		}
	}
	return files;
}

/** Read the memory dir into topic rows. Never throws; missing dir = no topics. */
export function loadTopics(memoryDir: string): MemoryTopic[] {
	let indexText = "";
	try {
		indexText = readFileSync(join(memoryDir, MEMORY_INDEX_NAME), "utf8");
	} catch {
		// No MEMORY.md yet: every file in the dir becomes an orphan row.
		indexText = "";
	}
	const files = listMemoryFiles(memoryDir);
	return buildTopics(indexText, files, loadMeta(memoryDir, files));
}

/** Bytes read from the head of a memory file to reach its frontmatter block. */
const FRONTMATTER_HEAD_BYTES = 4_096;

/**
 * Frontmatter of every memory file, read from the head of each one. The block is
 * always at the top and capped in practice at a few hundred bytes, so one 4 KB
 * read per file wins over reading whole files to render a list. Files without a
 * block (or that vanish mid-walk) simply have no entry.
 */
export function loadMeta(
	memoryDir: string,
	files: MemoryFileInfo[] | undefined,
): Map<string, MemoryFileMeta> | undefined {
	if (files === undefined) return undefined;
	const meta = new Map<string, MemoryFileMeta>();
	for (const entry of files) {
		if (!entry.name.toLowerCase().endsWith(".md") || entry.name === MEMORY_INDEX_NAME) continue;
		const head = readHead(join(memoryDir, entry.name));
		if (head === undefined) continue;
		const doc = splitFrontmatter(head);
		meta.set(entry.name, {
			frontmatter: doc.frontmatter,
			modifiedMs: parseModified(doc.frontmatter?.modified),
		});
	}
	return meta;
}

/** First `FRONTMATTER_HEAD_BYTES` of a file, or undefined when it cannot be read. */
function readHead(path: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.allocUnsafe(FRONTMATTER_HEAD_BYTES);
		const bytes = readSync(fd, buffer, 0, FRONTMATTER_HEAD_BYTES, 0);
		return buffer.toString("utf8", 0, bytes);
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// Best-effort close; a leaked descriptor is not worth failing the list.
			}
		}
	}
}

export type MemoryBody =
	| { ok: true; text: string }
	| { ok: false; error: string };

/** Read one memory file. A failed read is data, not an exception. */
export function readTopicBody(memoryDir: string, file: string): MemoryBody {
	const target = resolveInside(memoryDir, file);
	if (target === undefined) return { ok: false, error: "unsafe path in MEMORY.md" };
	try {
		return { ok: true, text: readFileSync(target, "utf8") };
	} catch {
		return { ok: false, error: "file is missing" };
	}
}

/**
 * Resolve `file` inside `dir`, or undefined when it escapes the dir (absolute
 * paths and `..` traversal). Memory files are written by the agent, so the
 * index is trusted content — but a bad line must not read `/etc/shadow`.
 */
export function resolveInside(dir: string, file: string): string | undefined {
	if (file === "" || isAbsolute(file)) return undefined;
	const root = resolve(dir);
	const target = resolve(root, file);
	const rel = relative(root, target);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
	return target;
}

export type MemoryMutationResult = { ok: true } | { ok: false; error: string };

/**
 * Delete one memory: unlink the file, then drop every MEMORY.md line that points
 * at it. A missing file still gets its (stale) index line removed — that is how
 * a `missing` row is cleaned up. The index is written via a temp file and a
 * rename, so a crash mid-write leaves the old MEMORY.md intact.
 */
export function deleteTopic(memoryDir: string, topic: MemoryTopic): MemoryMutationResult {
	// The index lists memories; deleting the index itself is never a memory
	// edit, and a stray `- [Index](MEMORY.md)` line must not take the whole
	// project's index with it.
	if (topic.file === MEMORY_INDEX_NAME) {
		return { ok: false, error: "refusing to delete the memory index" };
	}
	const target = resolveInside(memoryDir, topic.file);
	if (target === undefined) return { ok: false, error: "unsafe path in MEMORY.md" };
	try {
		unlinkSync(target);
	} catch (err) {
		// Already gone: the index line (if any) is still worth cleaning up.
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			return { ok: false, error: describeError(err) };
		}
	}
	if (!topic.indexed) return { ok: true };

	const indexPath = join(memoryDir, MEMORY_INDEX_NAME);
	let indexText: string;
	try {
		indexText = readFileSync(indexPath, "utf8");
	} catch {
		// No index on disk: the file was the whole memory.
		return { ok: true };
	}
	const updated = removeIndexEntry(indexText, topic.file);
	if (updated === indexText) return { ok: true };
	try {
		writeFileAtomic(indexPath, updated);
	} catch (err) {
		return { ok: false, error: `file deleted, but MEMORY.md was not updated: ${describeError(err)}` };
	}
	return { ok: true };
}

function writeFileAtomic(path: string, text: string): void {
	const temp = `${path}.tmp-${process.pid}`;
	// Keep the index's mode: a 0600 MEMORY.md must not turn into 0644.
	let mode: number | undefined;
	try {
		mode = statSync(path).mode;
	} catch {
		mode = undefined;
	}
	try {
		writeFileSync(temp, text, mode === undefined ? "utf8" : { encoding: "utf8", mode });
		renameSync(temp, path);
	} catch (err) {
		try {
			unlinkSync(temp);
		} catch {
			// Best-effort cleanup; the real error is the one below.
		}
		throw err;
	}
}

function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** UTF-8 size of a memory file, for the detail header. */
export function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** `623 B` / `1.2 KB` / `3.4 MB` — for the detail header. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
	return `${(kb / 1024).toFixed(1)} MB`;
}
