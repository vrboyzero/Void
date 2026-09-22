import { mkdir, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { FACET_DIRECTORY_NAME, isFacetDirectoryName } from "@void/void-soul";
import {
  LONG_TERM_FILE,
  MemoryConflictError,
  MemoryDocumentError,
  assertEntryId,
  assertMemoryDate,
  decodeUtf8Text,
  entryDateOf,
  isTemporaryMemoryFile,
  journalRoot,
  memoryDateOf,
  nextEntryId,
  parseEntryDocument,
  parseLongTermDocument,
  resolveEntryPath,
  resolveLongTermPath,
  resolveRetractedPath,
  serializeEntryDocument,
  serializeLongTermDocument,
  writeFileAtomic,
  type MemoryEntryDocument,
  type MemoryTarget,
} from "./documents.js";
import type { MemoryIndexStore } from "./index-store.js";
import { assertMemoryEntryNotLink, assertMemoryPathInside } from "./paths.js";
import { assertNoSensitiveContent } from "./sensitive-content.js";

export type { MemoryTarget } from "./documents.js";

/**
 * 一份档案的记忆仓：正文文件 + 该档案自己的索引。
 *
 * 身份隔离是结构性的——每份档案一个根目录，条目 id 只能在自己的根里解析，
 * 因此不存在“查到别人记忆”的路径。写入按档案串行化：同目录 tmp 刷盘、
 * 原子替换、再更新索引；索引失败只降级检索，不回滚已经落盘的正文。
 */

const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const MEMORY_LIST_DEFAULT_LIMIT = 20;
export const MEMORY_LIST_MAX_LIMIT = 50;

export class AgentMemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentMemoryError";
  }
}

export interface AgentMemoryOptions {
  root: string;
  /**
   * 数据根：`root` 与它下面所有读写路径都必须落在里面（含看穿链接）。
   *
   * 字符串级 `contain` 拦不住「先把 `memory/` 换成指向数据根外的 junction、再照常读写」，
   * 所以这里必须知道边界在哪，才能在真正落盘前再解析一次真实位置。
   */
  dataRoot: string;
  agentId: string;
  index?: MemoryIndexStore | undefined;
  now?: (() => Date) | undefined;
  /** 默认写入来源（actor/source），可被单次写入覆盖。 */
  source?: string | undefined;
}

export interface MemoryDocumentView {
  target: MemoryTarget;
  revision: number;
  updatedAt: string;
  body: string;
}

export interface MemoryWriteResult {
  target: MemoryTarget;
  /**
   * 条目 id（长期文字没有）。方案文档 §14.2 要求写成功必须回 entryId + revision：
   * 模型要能接着用同一个 id 去 update / retract，而不是先 list 一次再猜。
   */
  entryId?: string;
  revision: number;
  date: string;
  indexSynced: boolean;
  warning?: string;
}

export interface MemoryRetractResult {
  target: MemoryTarget;
  entryId?: string;
  recoveredPath: string;
  revision: number;
  indexSynced: boolean;
  warning?: string;
}

export interface MemoryEntrySummary {
  entryId: string;
  date: string;
  revision: number;
  updatedAt: string;
  preview: string;
}

export interface MemoryListResult {
  entries: MemoryEntrySummary[];
  nextCursor?: string;
  total: number;
}

export interface MemorySearchResult {
  entryId: string;
  kind: "entry" | "long-term";
  date: string;
  revision: number;
  snippet: string;
  score: number;
}

export function assertAgentId(agentId: string): void {
  if (typeof agentId !== "string" || !AGENT_ID_PATTERN.test(agentId)) {
    throw new AgentMemoryError(`记忆档案 id 不合法: ${String(agentId)}`);
  }
  // `agents/facets` 那一层归灵魂的共用模组库。放行的话，一份叫 `facets`（或 Windows 上
  // 等价的 `Facets`）的档案会把记忆文件写进模组库目录，面板上也会多出一份「档案」。
  if (isFacetDirectoryName(agentId)) {
    throw new AgentMemoryError(
      `记忆档案 id 撞上共用模组库的保留目录名: ${agentId}（agents/${FACET_DIRECTORY_NAME} 那层归灵魂的模组库，不能当档案的记忆根）`,
    );
  }
}

/** 每份档案一个记忆根，位于数据目录之外不可由模型指定。 */
export function agentMemoryRoot(dataDir: string, agentId: string): string {
  assertAgentId(agentId);
  return path.resolve(dataDir, "agents", agentId);
}

export class AgentMemoryStore {
  readonly agentId: string;
  readonly root: string;
  private readonly dataRoot: string;
  private readonly index: MemoryIndexStore | undefined;
  private readonly now: () => Date;
  private readonly defaultSource: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: AgentMemoryOptions) {
    assertAgentId(options.agentId);
    this.agentId = options.agentId;
    this.dataRoot = path.resolve(options.dataRoot);
    // 档案根自己也要过守卫：整层被换成链接时，后面的每次读写都已经在根外了。
    this.root = this.guard(path.resolve(options.root), "记忆档案根");
    this.index = options.index;
    this.now = options.now ?? (() => new Date());
    this.defaultSource = options.source ?? "agent";
  }

  get indexPath(): string {
    return this.guard(path.resolve(this.root, "memory.sqlite"), "记忆索引");
  }

  /**
   * 所有读写点都要过这里：先字符串比，再看穿链接比。
   *
   * 返回规范化后的路径，调用方必须用它（而不是原始字符串）去读写。注意守卫**不能**
   * 被 `readFile(...).catch(...)` 那类兜底吞掉——守卫在参数求值时就已经抛了。
   */
  private guard(target: string, label = "记忆路径"): string {
    return assertMemoryPathInside(this.dataRoot, target, label);
  }

  /** 长期文字。缺文件时返回空正文、修订 0，不算错误。 */
  async readLongTerm(): Promise<MemoryDocumentView> {
    const bytes = await readFile(this.guard(resolveLongTermPath(this.root), "长期记忆")).catch(() => undefined);
    const text = bytes === undefined ? undefined : decodeUtf8Text(bytes, "长期记忆正文", LONG_TERM_FILE);
    const document = parseLongTermDocument(text ?? "");
    return { target: { kind: "long-term" }, revision: document.revision, updatedAt: document.updatedAt, body: document.body };
  }

  async readEntry(entryId: string): Promise<MemoryEntryDocument> {
    assertEntryId(entryId);
    const date = entryDateOf(entryId);
    if (date === undefined) throw new AgentMemoryError(`记忆条目 id 不合法: ${entryId}`);
    const entryFile = resolveEntryPath(this.root, date, entryId);
    const bytes = await readFile(this.guard(entryFile, "记忆条目")).catch(() => undefined);
    if (bytes === undefined) {
      const retractedBytes = await readFile(this.guard(resolveRetractedPath(this.root, entryId), "撤回区")).catch(() => undefined);
      if (retractedBytes !== undefined) throw new AgentMemoryError(`记忆条目已撤回: ${entryId}`);
      throw new AgentMemoryError(`记忆条目不存在: ${entryId}`);
    }
    return parseEntryDocument(decodeUtf8Text(bytes, "记忆条目正文", entryFile), entryId);
  }

  async read(target: MemoryTarget): Promise<MemoryDocumentView> {
    if (target.kind === "long-term") return this.readLongTerm();
    const entry = await this.readEntry(target.entryId);
    return { target: { kind: "entry", entryId: entry.entryId }, revision: entry.revision, updatedAt: entry.updatedAt, body: entry.body };
  }

  /** 新条目写入日记，或向长期文字追加一段。正文先过敏感闸门，再排队落盘。 */
  async write(input: { body: string; target?: "entry" | "long-term"; date?: string; source?: string; session?: string }): Promise<MemoryWriteResult> {
    assertNoSensitiveContent(input.body);
    return this.enqueue(() =>
      input.target === "long-term" ? this.appendLongTerm(input.body) : this.createEntry(input.body, input.date, input.source, input.session),
    );
  }

  async update(input: { target: MemoryTarget; body: string; expectedRevision: number }): Promise<MemoryWriteResult> {
    assertNoSensitiveContent(input.body);
    return this.enqueue(() => this.replace(input.target, input.body, input.expectedRevision));
  }

  /** 撤回：正文移入不可检索的恢复区，索引同步删除。原文始终可恢复。 */
  async retract(input: { target: MemoryTarget; expectedRevision?: number }): Promise<MemoryRetractResult> {
    return this.enqueue(() => this.retractTarget(input.target, input.expectedRevision));
  }

  async list(input: { limit?: number; cursor?: string } = {}): Promise<MemoryListResult> {
    const limit = normalizeListLimit(input.limit);
    const summaries = await this.collectEntries();
    const start = input.cursor === undefined ? 0 : summaries.findIndex((entry) => entry.entryId === input.cursor) + 1;
    const page = summaries.slice(start, start + limit);
    const nextIndex = start + page.length;
    const result: MemoryListResult = { entries: page, total: summaries.length };
    if (nextIndex < summaries.length && page.length > 0) result.nextCursor = page[page.length - 1]!.entryId;
    return result;
  }

  /** 检索只经索引；没有索引时明确报错，不悄悄退化成全量扫描。 */
  async search(input: { query: string; k?: number }): Promise<MemorySearchResult[]> {
    if (this.index === undefined) throw new AgentMemoryError("记忆检索缺少索引，已拒绝执行");
    const k = normalizeSearchLimit(input.k);
    return this.index.search(input.query, k).map((hit) => ({ ...hit }));
  }

  /** 从正文重建索引，用于索引损坏或 dirty 之后的修复。 */
  async rebuildIndexFromBodies(): Promise<number> {
    if (this.index === undefined) throw new AgentMemoryError("记忆检索缺少索引，已拒绝执行");
    const longTermBytes = await readFile(this.guard(resolveLongTermPath(this.root), "长期记忆")).catch(() => undefined);
    const longTerm = parseLongTermDocument(
      longTermBytes === undefined ? "" : decodeUtf8Text(longTermBytes, "长期记忆正文", LONG_TERM_FILE),
    );
    if (longTerm.body.trim().length > 0) {
      this.index.upsert({
        entryId: "long-term",
        kind: "long-term",
        date: memoryDateOf(this.now()),
        revision: longTerm.revision,
        relativePath: LONG_TERM_FILE,
        body: longTerm.body,
      });
    }
    const summaries = await this.collectEntries();
    for (const summary of summaries) {
      const entry = await this.readEntry(summary.entryId);
      this.index.upsert({
        entryId: entry.entryId,
        kind: "entry",
        date: entry.date,
        revision: entry.revision,
        relativePath: `${path.posix.join("memory", entry.date, `${entry.entryId}.md`)}`,
        body: entry.body,
      });
    }
    return summaries.length;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async createEntry(body: string, date: string | undefined, source: string | undefined, session: string | undefined): Promise<MemoryWriteResult> {
    const now = this.now();
    const day = date ?? memoryDateOf(now);
    assertMemoryDate(day);
    const entryId = await this.allocateEntryId(day);
    const timestamp = now.toISOString();
    const document: MemoryEntryDocument = {
      entryId,
      date: day,
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 1,
      source: source ?? this.defaultSource,
      ...(session === undefined || session.length === 0 ? {} : { session }),
      body: `${body.replace(/\s+$/, "")}\n`,
    };
    await writeFileAtomic(this.guard(resolveEntryPath(this.root, day, entryId), "记忆条目"), serializeEntryDocument(document));
    return this.indexEntry(document, `${path.posix.join("memory", day, `${entryId}.md`)}`);
  }

  private async appendLongTerm(body: string): Promise<MemoryWriteResult> {
    const current = await this.readLongTerm();
    const addition = body.replace(/\s+$/, "");
    const merged = current.body.trim().length === 0 ? addition : `${current.body.replace(/\s+$/, "")}\n\n${addition}`;
    return this.writeLongTerm(merged, current.revision + 1);
  }

  private async replace(target: MemoryTarget, body: string, expectedRevision: number): Promise<MemoryWriteResult> {
    if (target.kind === "long-term") {
      const current = await this.readLongTerm();
      assertRevision(expectedRevision, current.revision);
      return this.writeLongTerm(body.replace(/\s+$/, ""), current.revision + 1);
    }
    const entry = await this.readEntry(target.entryId);
    assertRevision(expectedRevision, entry.revision);
    const next: MemoryEntryDocument = {
      ...entry,
      revision: entry.revision + 1,
      updatedAt: this.now().toISOString(),
      body: `${body.replace(/\s+$/, "")}\n`,
    };
    await writeFileAtomic(this.guard(resolveEntryPath(this.root, entry.date, entry.entryId), "记忆条目"), serializeEntryDocument(next));
    return this.indexEntry(next, path.posix.join("memory", entry.date, `${entry.entryId}.md`));
  }

  private async writeLongTerm(body: string, revision: number): Promise<MemoryWriteResult> {
    const document = { revision, updatedAt: this.now().toISOString(), body: body.length > 0 ? `${body}\n` : "" };
    await writeFileAtomic(this.guard(resolveLongTermPath(this.root), "长期记忆"), serializeLongTermDocument(document));
    const result: MemoryWriteResult = {
      target: { kind: "long-term" },
      revision,
      date: memoryDateOf(this.now()),
      indexSynced: false,
    };
    const index = this.index;
    if (index === undefined) return { ...result, indexSynced: false, warning: "没有索引，本次只保存正文" };
    try {
      if (document.body.trim().length === 0) index.remove("long-term");
      else {
        index.upsert({
          entryId: "long-term",
          kind: "long-term",
          date: memoryDateOf(this.now()),
          revision,
          relativePath: LONG_TERM_FILE,
          body: document.body,
        });
      }
      return { ...result, indexSynced: true };
    } catch (error) {
      index.markDirty(describe(error));
      return { ...result, indexSynced: false, warning: "正文已保存、检索待同步" };
    }
  }

  private async retractTarget(target: MemoryTarget, expectedRevision: number | undefined): Promise<MemoryRetractResult> {
    if (target.kind === "entry") {
      const entry = await this.readEntry(target.entryId);
      if (expectedRevision !== undefined) assertRevision(expectedRevision, entry.revision);
      const source = this.guard(resolveEntryPath(this.root, entry.date, entry.entryId), "记忆条目");
      const recovered = this.guard(resolveRetractedPath(this.root, entry.entryId), "撤回区");
      await mkdir(path.dirname(recovered), { recursive: true });
      await rename(source, recovered);
      const result: MemoryRetractResult = {
        target: { kind: "entry", entryId: entry.entryId },
        entryId: entry.entryId,
        recoveredPath: recovered,
        revision: entry.revision,
        indexSynced: false,
      };
      return this.finishRetract(result, entry.entryId);
    }
    const current = await this.readLongTerm();
    if (expectedRevision !== undefined) assertRevision(expectedRevision, current.revision);
    const recovered = this.guard(path.resolve(this.root, "retracted", LONG_TERM_FILE), "撤回区");
    await mkdir(path.dirname(recovered), { recursive: true });
    await rename(this.guard(resolveLongTermPath(this.root), "长期记忆"), recovered).catch(() => undefined);
    const cleared = await this.writeLongTerm("", current.revision + 1);
    return {
      target: { kind: "long-term" },
      recoveredPath: recovered,
      revision: cleared.revision,
      indexSynced: cleared.indexSynced,
      ...(cleared.warning === undefined ? {} : { warning: cleared.warning }),
    };
  }

  private finishRetract(result: MemoryRetractResult, entryId: string): MemoryRetractResult {
    const index = this.index;
    if (index === undefined) return { ...result, indexSynced: false, warning: "没有索引，本次只处理正文" };
    try {
      index.remove(entryId);
      return { ...result, indexSynced: true };
    } catch (error) {
      index.markDirty(describe(error));
      return { ...result, indexSynced: false, warning: "正文已撤回、检索待同步" };
    }
  }

  private indexEntry(document: MemoryEntryDocument, relativePath: string): MemoryWriteResult {
    const result: MemoryWriteResult = {
      target: { kind: "entry", entryId: document.entryId },
      entryId: document.entryId,
      revision: document.revision,
      date: document.date,
      indexSynced: false,
    };
    const index = this.index;
    if (index === undefined) return { ...result, warning: "没有索引，本次只保存正文" };
    try {
      index.upsert({
        entryId: document.entryId,
        kind: "entry",
        date: document.date,
        revision: document.revision,
        relativePath,
        body: document.body,
      });
      return { ...result, indexSynced: true };
    } catch (error) {
      index.markDirty(describe(error));
      return { ...result, warning: "正文已保存、检索待同步" };
    }
  }

  /** 当天序号在日记目录与撤回区一起取最大值，避免撤回后 id 被复用。 */
  private async allocateEntryId(date: string): Promise<string> {
    const prefix = date.replace(/-/g, "");
    const used = new Set<string>();
    for (const directory of [this.guard(path.resolve(journalRoot(this.root), date), "记忆日记目录"), this.guard(path.resolve(this.root, "retracted"), "撤回区")]) {
      const names = await readdir(directory).catch(() => [] as string[]);
      for (const name of names) {
        if (isTemporaryMemoryFile(name)) continue;
        if (name.startsWith(prefix)) used.add(name.replace(/\.md$/, ""));
      }
    }
    let sequence = used.size;
    for (;;) {
      sequence += 1;
      const candidate = nextEntryId(new Date(`${date}T00:00:00`), sequence);
      if (!used.has(candidate)) return candidate;
    }
  }

  private async collectEntries(): Promise<MemoryEntrySummary[]> {
    const root = this.guard(journalRoot(this.root), "记忆日记目录");
    const dirents = await readdir(root, { withFileTypes: true }).catch(() => []);
    const dates: string[] = [];
    for (const dirent of dirents) {
      // Windows 上 junction 的 isDirectory() 是 false，只按目录过滤会静默跳过它，
      // 看起来就像记忆凭空丢了；宁可当场报错，也不让人对着空列表猜。
      assertMemoryEntryNotLink(dirent, root);
      if (dirent.isDirectory()) dates.push(dirent.name);
    }
    const summaries: MemoryEntrySummary[] = [];
    for (const date of dates) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const directory = this.guard(path.resolve(root, date), "记忆条目目录");
      const names = await readdir(directory).catch(() => [] as string[]);
      for (const name of names) {
        if (!name.endsWith(".md") || isTemporaryMemoryFile(name)) continue;
        const entryId = name.slice(0, -3);
        const bytes = await readFile(this.guard(path.resolve(directory, name), "记忆条目")).catch(() => undefined);
        if (bytes === undefined) continue;
        let document: MemoryEntryDocument;
        try {
          document = parseEntryDocument(decodeUtf8Text(bytes, "记忆条目正文", `${date}/${name}`), entryId);
        } catch (error) {
          if (error instanceof MemoryDocumentError) throw new AgentMemoryError(`记忆条目损坏: ${entryId}（${error.message}）`);
          throw error;
        }
        summaries.push({
          entryId: document.entryId,
          date: document.date,
          revision: document.revision,
          updatedAt: document.updatedAt,
          preview: previewOf(document.body),
        });
      }
    }
    summaries.sort((left, right) => (left.entryId < right.entryId ? 1 : left.entryId > right.entryId ? -1 : 0));
    return summaries;
  }
}

function assertRevision(expected: number, actual: number): void {
  if (!Number.isInteger(expected) || expected < 0) throw new AgentMemoryError(`期望修订号不合法: ${String(expected)}`);
  if (expected !== actual) throw new MemoryConflictError(expected, actual);
}

function normalizeListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return MEMORY_LIST_DEFAULT_LIMIT;
  const truncated = Math.trunc(limit);
  if (truncated <= 0) return MEMORY_LIST_DEFAULT_LIMIT;
  return Math.min(truncated, MEMORY_LIST_MAX_LIMIT);
}

function normalizeSearchLimit(k: number | undefined): number {
  if (k === undefined || !Number.isFinite(k)) return 5;
  const truncated = Math.trunc(k);
  if (truncated <= 0) return 5;
  return Math.min(truncated, 50);
}

function previewOf(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
