import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 每份档案一个检索索引（`memory.sqlite`）。
 *
 * 索引只服务于检索：正文永远从 `MEMORY.md` / `memory/**` 读，索引丢了最多重建、
 * 不会丢记忆。中文没有词边界，FTS5 的 unicode61 切不出词，所以这里用确定性的
 * 单字 + 双字切分把中文摊平成可索引的 token，再配一层受限的短词回退。
 */

export class MemoryIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryIndexError";
  }
}

/** 索引自身坏了：先报出来，由上层决定是否重建，不静默返回空结果。 */
export class MemoryIndexCorruptError extends MemoryIndexError {
  constructor(agentId: string, detail: string) {
    super(`记忆索引损坏: ${agentId}（${detail}）`);
    this.name = "MemoryIndexCorruptError";
  }
}

export const MEMORY_INDEX_SCHEMA_VERSION = 1;

export interface MemoryIndexRecord {
  entryId: string;
  kind: "entry" | "long-term";
  date: string;
  revision: number;
  relativePath: string;
  body: string;
}

export interface MemoryIndexHit {
  entryId: string;
  kind: "entry" | "long-term";
  date: string;
  revision: number;
  snippet: string;
  score: number;
}

export interface MemoryIndexRow {
  entryId: string;
  kind: "entry" | "long-term";
  date: string;
  revision: number;
  relativePath: string;
}

const CJK = "\\u3400-\\u4dbf\\u4e00-\\u9fff\\u3040-\\u30ff\\uac00-\\ud7af";
const CJK_RUN = new RegExp(`[${CJK}]+`, "g");
const WORD_RUN = /[a-z0-9_]+/g;

/**
 * 确定性中文切分：拉丁词整词保留，中日韩连续段同时产出单字与相邻双字。
 * 双字让“守则”能命中“小贝的第一条守则”，单字保证单字查询仍能回退命中。
 */
export function memoryTokens(text: string): string {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  for (const match of lower.matchAll(WORD_RUN)) tokens.push(match[0]);
  for (const match of lower.matchAll(CJK_RUN)) {
    const run = match[0];
    for (let index = 0; index < run.length; index += 1) {
      tokens.push(run[index]!);
      if (index + 1 < run.length) tokens.push(run.slice(index, index + 2));
    }
  }
  return tokens.join(" ");
}

/**
 * 精确口径：拉丁整词 + 中文双字。只有在查询里根本没有双字可用时（例如单字查询）
 * 才退回单字口径——单字太松，一旦放开会把“小贝”命中到“小马”的正文上。
 */
export function memoryQueryTerms(query: string): { precise: string[]; broad: string[] } {
  const lower = query.toLowerCase();
  const words: string[] = [];
  for (const match of lower.matchAll(WORD_RUN)) words.push(match[0]);
  const bigrams: string[] = [];
  const unigrams: string[] = [];
  for (const match of lower.matchAll(CJK_RUN)) {
    const run = match[0];
    for (let index = 0; index < run.length; index += 1) {
      unigrams.push(run[index]!);
      if (index + 1 < run.length) bigrams.push(run.slice(index, index + 2));
    }
  }
  const precise = [...new Set([...words, ...bigrams])];
  const broad = bigrams.length === 0 ? [...new Set([...precise, ...unigrams])] : precise;
  return { precise, broad };
}

/**
 * token 只可能来自拉丁词与中日韩字符，且逐一加引号，因此拼出的 MATCH 表达式
 * 不可能带上 FTS5 的语法（列过滤、NEAR、前缀星号等）。查询值仍走参数绑定。
 */
export function memoryMatchExpression(terms: readonly string[]): string | undefined {
  const usable = terms.filter((term) => term.length > 0).map((term) => `"${term}"`);
  if (usable.length === 0) return undefined;
  return usable.join(" OR ");
}

export interface MemoryIndexOpenOptions {
  path: string;
  agentId: string;
}

export class MemoryIndexStore {
  readonly agentId: string;
  readonly path: string;
  private readonly database: Database.Database;
  private closed = false;
  private dirtyInMemory = false;

  private constructor(options: MemoryIndexOpenOptions) {
    this.agentId = options.agentId;
    this.path = options.path;
    const database = new Database(options.path);
    this.database = database;
    try {
      database.pragma("journal_mode = WAL");
      database.pragma("foreign_keys = ON");
      this.verifyIntegrity();
      this.createSchema();
    } catch (error) {
      // 打开失败必须把句柄还回去，否则调用方连损坏的索引文件都删不掉。
      this.closed = true;
      database.close();
      throw error;
    }
  }

  static open(options: MemoryIndexOpenOptions): MemoryIndexStore {
    if (typeof options.path !== "string" || options.path.trim().length === 0 || options.path === ":memory:") {
      throw new MemoryIndexError("记忆索引缺少持久路径，已拒绝以内存库启动");
    }
    // 记忆仓目录由调用方按需创建；索引库自己保证父目录存在，避免把
    // “目录还没建”误报成“索引损坏”。
    mkdirSync(dirname(options.path), { recursive: true });
    try {
      return new MemoryIndexStore(options);
    } catch (error) {
      if (error instanceof MemoryIndexError) throw error;
      throw new MemoryIndexCorruptError(options.agentId, describe(error));
    }
  }

  /** 索引代际：每次成功的事务提交自增，用来判断检索结果是否来自当前正文。 */
  get generation(): number {
    return Number(this.readMeta("generation") ?? "0");
  }

  get dirty(): boolean {
    return this.dirtyInMemory || this.readMeta("dirty") === "1";
  }

  get dirtyReason(): string | undefined {
    return this.readMeta("dirty_reason") ?? undefined;
  }

  beginMutation(): boolean {
    this.assertOpen();
    const wasDirty = this.dirty;
    this.writeMeta("dirty", "1");
    this.dirtyInMemory = true;
    return wasDirty;
  }

  finishMutation(wasDirty: boolean): void {
    if (wasDirty) return;
    try {
      this.clearDirty();
      this.dirtyInMemory = false;
    } catch (error) {
      this.markDirty(describe(error));
    }
  }

  size(): number {
    const row = this.database.prepare("SELECT COUNT(*) AS total FROM memory_entries").get() as { total: number };
    return row.total;
  }

  upsert(record: MemoryIndexRecord): void {
    this.assertOpen();
    try {
      const apply = this.database.transaction((input: MemoryIndexRecord) => {
        this.database
          .prepare(
            `INSERT INTO memory_entries (entry_id, kind, date, revision, relative_path, body, indexed_at)
             VALUES (@entryId, @kind, @date, @revision, @relativePath, @body, @indexedAt)
             ON CONFLICT(entry_id) DO UPDATE SET
               kind = excluded.kind,
               date = excluded.date,
               revision = excluded.revision,
               relative_path = excluded.relative_path,
               body = excluded.body,
               indexed_at = excluded.indexed_at`,
          )
          .run({ ...input, indexedAt: new Date().toISOString() });
        this.database.prepare("DELETE FROM memory_fts WHERE entry_id = ?").run(input.entryId);
        this.database
          .prepare("INSERT INTO memory_fts (entry_id, tokens) VALUES (?, ?)")
          .run(input.entryId, memoryTokens(`${input.entryId} ${input.date} ${input.body}`));
        this.bumpGeneration();
      });
      apply(record);
    } catch (error) {
      throw new MemoryIndexError(`记忆索引写入失败: ${describe(error)}`);
    }
  }

  remove(entryId: string): void {
    this.assertOpen();
    try {
      const apply = this.database.transaction((id: string) => {
        this.database.prepare("DELETE FROM memory_entries WHERE entry_id = ?").run(id);
        this.database.prepare("DELETE FROM memory_fts WHERE entry_id = ?").run(id);
        this.bumpGeneration();
      });
      apply(entryId);
    } catch (error) {
      throw new MemoryIndexError(`记忆索引删除失败: ${describe(error)}`);
    }
  }

  /** 索引写不进去时留下 dirty 代际，主流程照常返回“正文已保存、检索待同步”。 */
  markDirty(reason: string): void {
    this.dirtyInMemory = true;
    if (this.closed) return;
    try {
      this.writeMeta("dirty", "1");
      this.writeMeta("dirty_reason", reason);
    } catch {
      // 索引已经不可写时不再叠加错误，正文已经落盘才是主结果。
    }
  }

  search(query: string, k: number): MemoryIndexHit[] {
    this.assertOpen();
    if (this.dirty) throw new MemoryIndexError("记忆索引待同步，拒绝检索旧正文");
    const limit = normalizeLimit(k);
    const { precise, broad } = memoryQueryTerms(query);
    const attempts = [memoryMatchExpression(precise), memoryMatchExpression(broad)].filter(
      (expression): expression is string => expression !== undefined,
    );
    for (const expression of attempts) {
      const hits = this.searchExpression(expression, limit);
      if (hits.length > 0) return hits;
    }
    return this.searchSubstring(query, limit);
  }

  replaceAll(records: readonly MemoryIndexRecord[]): void {
    this.assertOpen();
    try {
      this.database.transaction(() => {
        this.database.prepare("DELETE FROM memory_fts").run();
        this.database.prepare("DELETE FROM memory_entries").run();
        const insertEntry = this.database.prepare(
          `INSERT INTO memory_entries (entry_id, kind, date, revision, relative_path, body, indexed_at)
           VALUES (@entryId, @kind, @date, @revision, @relativePath, @body, @indexedAt)`,
        );
        const insertTokens = this.database.prepare("INSERT INTO memory_fts (entry_id, tokens) VALUES (?, ?)");
        for (const record of records) {
          insertEntry.run({ ...record, indexedAt: new Date().toISOString() });
          insertTokens.run(record.entryId, memoryTokens(`${record.entryId} ${record.date} ${record.body}`));
        }
        this.bumpGeneration();
        this.clearDirty();
      })();
      this.dirtyInMemory = false;
    } catch (error) {
      this.markDirty(describe(error));
      throw new MemoryIndexError(`记忆索引重建失败: ${describe(error)}`);
    }
  }

  list(limit: number, offset: number): MemoryIndexRow[] {
    this.assertOpen();
    const rows = this.database
      .prepare(
        `SELECT entry_id AS entryId, kind, date, revision, relative_path AS relativePath
         FROM memory_entries ORDER BY date DESC, entry_id DESC LIMIT ? OFFSET ?`,
      )
      .all(normalizeLimit(limit), Math.max(0, Math.trunc(offset))) as MemoryIndexRow[];
    return rows;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private searchExpression(expression: string, limit: number): MemoryIndexHit[] {
    const rows = this.database
      .prepare(
        `SELECT e.entry_id AS entryId, e.kind AS kind, e.date AS date, e.revision AS revision,
                e.body AS body, bm25(memory_fts) AS rank
         FROM memory_fts JOIN memory_entries e ON e.entry_id = memory_fts.entry_id
         WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(expression, limit) as { entryId: string; kind: string; date: string; revision: number; body: string; rank: number }[];
    return rows.map((row) => ({
      entryId: row.entryId,
      kind: row.kind === "long-term" ? "long-term" : "entry",
      date: row.date,
      revision: row.revision,
      snippet: snippet(row.body),
      score: -row.rank,
    }));
  }

  /** 短词回退：中文单字查询在双字口径下常常落空，这里做一次有界的包含匹配。 */
  private searchSubstring(query: string, limit: number): MemoryIndexHit[] {
    const needle = query.trim();
    if (needle.length === 0) return [];
    const rows = this.database
      .prepare(
        `SELECT entry_id AS entryId, kind, date, revision, body
         FROM memory_entries WHERE body LIKE ? ESCAPE '\\'
         ORDER BY date DESC, entry_id DESC LIMIT ?`,
      )
      .all(`%${escapeLike(needle)}%`, limit) as {
      entryId: string;
      kind: string;
      date: string;
      revision: number;
      body: string;
    }[];
    return rows.map((row) => ({
      entryId: row.entryId,
      kind: row.kind === "long-term" ? "long-term" : "entry",
      date: row.date,
      revision: row.revision,
      snippet: snippet(row.body),
      score: 0,
    }));
  }

  private verifyIntegrity(): void {
    const result = this.database.pragma("integrity_check") as { integrity_check: string }[];
    const verdict = result[0]?.integrity_check ?? "unknown";
    if (verdict !== "ok") throw new MemoryIndexCorruptError(this.agentId, verdict);
  }

  private createSchema(): void {
    this.database.exec(
      `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS memory_entries (
         entry_id TEXT PRIMARY KEY,
         kind TEXT NOT NULL,
         date TEXT NOT NULL,
         revision INTEGER NOT NULL,
         relative_path TEXT NOT NULL,
         body TEXT NOT NULL,
         indexed_at TEXT NOT NULL
       );
       CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(entry_id UNINDEXED, tokens, tokenize='unicode61');`,
    );
    const version = this.readMeta("schema_version");
    if (version === undefined) {
      this.writeMeta("schema_version", String(MEMORY_INDEX_SCHEMA_VERSION));
      this.writeMeta("generation", "0");
      this.writeMeta("agent_id", this.agentId);
    } else if (Number(version) !== MEMORY_INDEX_SCHEMA_VERSION) {
      throw new MemoryIndexError(`记忆索引版本不匹配: ${version}`);
    }
    const owner = this.readMeta("agent_id");
    if (owner !== undefined && owner !== this.agentId) {
      throw new MemoryIndexError(`记忆索引归属不符: 期望 ${this.agentId}，实际 ${owner}`);
    }
  }

  private bumpGeneration(): void {
    this.writeMeta("generation", String(Number(this.readMeta("generation") ?? "0") + 1));
  }

  private clearDirty(): void {
    this.writeMeta("dirty", "0");
    this.database.prepare("DELETE FROM meta WHERE key = 'dirty_reason'").run();
  }

  private readMeta(key: string): string | undefined {
    const row = this.database.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  private writeMeta(key: string, value: string): void {
    this.database
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  private assertOpen(): void {
    if (this.closed) throw new MemoryIndexError("记忆索引已关闭");
  }
}

function normalizeLimit(k: number): number {
  if (!Number.isFinite(k)) return 5;
  const truncated = Math.trunc(k);
  if (truncated <= 0) return 5;
  return Math.min(truncated, 50);
}

function snippet(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
