import { isUtf8 } from "node:buffer";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

/**
 * 人格记忆的正文层：只有这里知道记忆到底存成什么文件。
 *
 * 记忆体只有两种（见文档 14.1）：
 * - `MEMORY.md`：长期文字，整文按修订编辑。
 * - `memory/<日期>/<条目 id>.md`：日记条目，条目 id 稳定，撤回后移入不可检索的恢复区。
 * 索引（memory.sqlite）不在这里，它只是检索用的派生数据，正文永远以文件为准。
 */

export class MemoryDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryDocumentError";
  }
}

/** 并发写入时的修订冲突。调用方拿到后应重读正文再决定是否重试。 */
export class MemoryConflictError extends MemoryDocumentError {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(`记忆已被其他写入更新（期望修订 ${expectedRevision}，实际 ${actualRevision}），请重读后再改`);
    this.name = "MemoryConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export const LONG_TERM_FILE = "MEMORY.md";
export const JOURNAL_DIR = "memory";
export const RETRACTED_DIR = "retracted";
export const MEMORY_INDEX_FILE = "memory.sqlite";

const ENTRY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type MemoryTarget = { kind: "long-term" } | { kind: "entry"; entryId: string };

export interface MemoryEntryDocument {
  entryId: string;
  date: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  source: string;
  /** 写下这条记忆的会话（审计元数据，与正文分开）。 */
  session?: string | undefined;
  body: string;
}

export interface LongTermDocument {
  revision: number;
  updatedAt: string;
  body: string;
}

/** 条目 id 是模型唯一能引用的句柄，必须是路径安全且稳定的。 */
export function assertEntryId(entryId: string): void {
  if (typeof entryId !== "string" || !ENTRY_ID_PATTERN.test(entryId)) {
    throw new MemoryDocumentError(`记忆条目 id 不合法: ${String(entryId)}`);
  }
}

export function assertMemoryDate(date: string): void {
  if (typeof date !== "string" || !DATE_PATTERN.test(date)) {
    throw new MemoryDocumentError(`记忆日期不合法: ${String(date)}`);
  }
  const [year, month, day] = date.split("-").map((part) => Number(part));
  const probe = new Date(Date.UTC(year!, month! - 1, day!));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month! - 1 || probe.getUTCDate() !== day) {
    throw new MemoryDocumentError(`记忆日期不合法: ${date}`);
  }
}

export function memoryDateOf(now: Date): string {
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 形如 `20260922-0001`：按天分段、当天内递增，肉眼可读也便于排序。 */
export function nextEntryId(now: Date, sequence: number): string {
  const compact = memoryDateOf(now).replace(/-/g, "");
  return `${compact}-${String(sequence).padStart(4, "0")}`;
}

export function entryDirectoryName(date: string): string {
  assertMemoryDate(date);
  return date;
}

/** 只有 `YYYYMMDD-NNNN` 形态的 id 能从日期反推出所属目录，其余一律拒绝。 */
export function entryDateOf(entryId: string): string | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})-\d{4}$/.exec(entryId);
  if (!match) return undefined;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  try {
    assertMemoryDate(date);
  } catch {
    return undefined;
  }
  return date;
}

export function journalRoot(root: string): string {
  return path.resolve(root, JOURNAL_DIR);
}

export function resolveLongTermPath(root: string): string {
  return path.resolve(root, LONG_TERM_FILE);
}

export function resolveEntryPath(root: string, date: string, entryId: string): string {
  assertMemoryDate(date);
  assertEntryId(entryId);
  return contain(journalRoot(root), path.resolve(journalRoot(root), entryDirectoryName(date), `${entryId}.md`), "记忆条目路径越界");
}

/** 撤回区不参与检索，只保证原文可恢复。 */
export function resolveRetractedPath(root: string, entryId: string): string {
  assertEntryId(entryId);
  const retractedRoot = path.resolve(root, RETRACTED_DIR);
  return contain(retractedRoot, path.resolve(retractedRoot, `${entryId}.md`), "撤回区路径越界");
}

export function resolveIndexPath(root: string): string {
  return path.resolve(root, MEMORY_INDEX_FILE);
}

/** 临时文件（同目录 tmp）不能被列出、不能被索引。 */
export function isTemporaryMemoryFile(name: string): boolean {
  return name.startsWith(".") || name.endsWith(".tmp");
}

export function parseEntryDocument(text: string, fallbackEntryId?: string): MemoryEntryDocument {
  const { frontMatter, body, hasFrontMatter } = splitFrontMatter(text);
  if (!hasFrontMatter) {
    throw new MemoryDocumentError(`记忆条目缺少前置信息: ${fallbackEntryId ?? "未知条目"}`);
  }
  const entryId = frontMatter.get("id") ?? fallbackEntryId;
  if (entryId === undefined) throw new MemoryDocumentError("记忆条目缺少前置信息: id");
  assertEntryId(entryId);
  const date = frontMatter.get("date") ?? entryDateOf(entryId);
  if (date === undefined) throw new MemoryDocumentError(`记忆条目缺少前置信息: date（${entryId}）`);
  assertMemoryDate(date);
  const revision = readRevision(frontMatter.get("revision"), entryId);
  return {
    entryId,
    date,
    createdAt: frontMatter.get("createdAt") ?? "",
    updatedAt: frontMatter.get("updatedAt") ?? "",
    revision,
    source: frontMatter.get("source") ?? "",
    session: frontMatter.get("session"),
    body,
  };
}

export function serializeEntryDocument(document: MemoryEntryDocument): string {
  assertEntryId(document.entryId);
  assertMemoryDate(document.date);
  const lines = [
    "---",
    `id: ${document.entryId}`,
    `date: ${document.date}`,
    `createdAt: ${document.createdAt}`,
    `updatedAt: ${document.updatedAt}`,
    `revision: ${document.revision}`,
    `source: ${document.source}`,
  ];
  if (document.session !== undefined && document.session.length > 0) lines.push(`session: ${document.session}`);
  lines.push("---", "");
  return `${lines.join("\n")}${document.body}`;
}

/**
 * 长期文字允许手工编辑，所以缺前置信息时按修订 0、整文为正文处理，
 * 不把人工改过的文件判成损坏。
 */
export function parseLongTermDocument(text: string): LongTermDocument {
  const { frontMatter, body, hasFrontMatter } = splitFrontMatter(text);
  if (!hasFrontMatter) return { revision: 0, updatedAt: "", body: text };
  return {
    revision: readRevision(frontMatter.get("revision"), LONG_TERM_FILE),
    updatedAt: frontMatter.get("updatedAt") ?? "",
    body,
  };
}

export function serializeLongTermDocument(document: LongTermDocument): string {
  const lines = ["---", `revision: ${document.revision}`, `updatedAt: ${document.updatedAt}`, "---", ""];
  return `${lines.join("\n")}${document.body}`;
}

/**
 * 一份记忆正文最多读多大。
 *
 * 长期文字与日记条目都是给人看、给模型读的正文，几 MB 已经离谱；这里挡的是「有人把
 * 一个几百 MB 的文件塞进 `memory/` 之后，列表与读取把宿主读爆」。上限之外一律拒绝，
 * 不做截断——截断过的记忆比读不出来更危险（见 14.1 的正文口径）。
 */
export const MAX_MEMORY_TEXT_BYTES = 8 * 1024 * 1024;

/**
 * 把一段字节按 UTF-8 解成正文；不是合法 UTF-8（或太大）就抛可读的中文错误。
 *
 * `readFile(..., "utf8")` 遇到坏字节不报错，它把坏字节换成 U+FFFD——那样坏文件会以乱码
 * 进索引、进模型，人只看到一串问号。这里 fail-closed，与「记忆条目损坏」同一类处理。
 */
export function decodeUtf8Text(
  bytes: Uint8Array,
  label: string,
  where?: string,
  maxBytes: number = MAX_MEMORY_TEXT_BYTES,
): string {
  const at = where === undefined ? "" : `: ${where}`;
  if (bytes.byteLength > maxBytes) {
    throw new MemoryDocumentError(`${label} 太大，拒绝读入${at}（${bytes.byteLength} 字节，上限 ${maxBytes} 字节）。`);
  }
  const text = Buffer.from(bytes).toString("utf8");
  if (!isUtf8(bytes)) {
    const bad = text.indexOf("\uFFFD");
    const position = bad < 0 ? "" : `，第 ${bad + 1} 个字符处`;
    throw new MemoryDocumentError(
      `${label} 不是有效的 UTF-8 文本${at}（共 ${bytes.byteLength} 字节${position}出现非法字节）。请把文件另存为 UTF-8 再试。`,
    );
  }
  return text;
}

/** 读一份必须是 UTF-8 的正文文件（先按字节读，再验编码与大小）。 */
export async function readUtf8TextFile(file: string, label: string, maxBytes?: number): Promise<string> {
  return decodeUtf8Text(await readFile(file), label, file, maxBytes);
}

/**
 * 同目录临时文件写盘刷盘后再原子替换，读方永远看不到半截正文。
 * 临时文件名以点开头、以 .tmp 结尾，列目录与索引都会跳过。
 *
 * `rename` 在 Windows 上会被杀毒/索引器短暂按住而报 `EPERM`/`EBUSY`/`EACCES`——这类
 * 失败是暂时的，重试几次就过去了；军团侧全量回归里真的因此红过一次（见
 * `@void/void-legion/atomic-file` 的同名处理）。只重试这三种 errno，别的错误照旧直抛。
 */
export async function writeFileAtomic(target: string, content: string): Promise<void> {
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true });
  const tmp = path.join(directory, `.${path.basename(target)}.${process.pid}.${nextTmpSeq()}.tmp`);
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await renameWithRetry(tmp, target);
  } catch (error) {
    // 换不上去就把自己的临时文件收掉：留着只会越积越多（列目录会跳过它们，但磁盘不会）。
    await rm(tmp, { force: true });
    throw error;
  }
}

/** rename 的尝试次数与退避步长（只作用于失败路径，成功路径不加延迟）。 */
const RENAME_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 20;

/** 值得重试的 errno：都是「别人暂时占着」，不是「这次写入本身不合法」。 */
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (attempt >= RENAME_ATTEMPTS || code === undefined || !TRANSIENT_RENAME_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_BACKOFF_MS * attempt));
    }
  }
}

let tmpSequence = 0;

function nextTmpSeq(): number {
  tmpSequence += 1;
  return tmpSequence;
}

function contain(root: string, target: string, message: string): string {
  const relative = path.relative(root, target);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new MemoryDocumentError(`${message}: ${target}`);
  }
  return target;
}

function readRevision(raw: string | undefined, label: string): number {
  if (raw === undefined) return 0;
  const revision = Number(raw);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new MemoryDocumentError(`记忆修订号不合法: ${label}`);
  }
  return revision;
}

interface FrontMatterSplit {
  frontMatter: Map<string, string>;
  body: string;
  hasFrontMatter: boolean;
}

function splitFrontMatter(text: string): FrontMatterSplit {
  const normalized = text.startsWith("\uFEFF") ? text.slice(1) : text;
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) {
    return { frontMatter: new Map(), body: normalized, hasFrontMatter: false };
  }
  const lines = normalized.split(/\r?\n/);
  const frontMatter = new Map<string, string>();
  let closing = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "---") {
      closing = index;
      break;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    frontMatter.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  if (closing < 0) throw new MemoryDocumentError("记忆前置信息没有结束标记");
  const rest = lines.slice(closing + 1);
  while (rest.length > 0 && rest[0]!.trim() === "") rest.shift();
  return { frontMatter, body: rest.join("\n"), hasFrontMatter: true };
}
