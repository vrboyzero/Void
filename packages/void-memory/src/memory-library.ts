/**
 * 人格记忆的人工管理面（§16.1 的「记忆详情」）。
 *
 * 面板与模型工具读的是同一批文件（`MEMORY.md` + `memory/<日期>/<id>.md`），所以每条规则
 * 都直接落在 `AgentMemoryStore` 上：修订号当栅、写入过敏感闸门、撤回移入恢复区、检索只走
 * 索引。本模块只补三件面板需要、而仓储本身不管的事：
 *
 * 1. **扁平的条目 id**：`<档案 id>/<条目 id>`，长期文字是 `<档案 id>/long-term`。
 *    面板契约只有 list→detail 一级，扁平 id 让「列出 / 打开 / 改 / 撤回 / 检索」都能直接
 *    落在现有契约上，不必给入口加二级导航。
 * 2. **不建库的读**：`memory.sqlite` 不存在时就不打开索引——列个表不该顺手给每个档案造一个
 *    索引文件。没有索引时写入只落正文，并把仓储给的 `warning` 原样带出去（不假装同步过）。
 * 3. **一份档案坏了不拖垮整个列表**：读不出来的档案跳过，把原因写进列表说明；列表被截断
 *    也说出来，否则会被当成「就这些」。
 *
 * 范围按方案文档 §14.1 的推荐默认（M5 尚未定案）：长期文字可读、可按修订整文编辑、撤回要
 * 显式动作；日记条目可读、可改、可撤回。`history/` 不遍历——那是给人翻的，不是给面板列的。
 *
 * @module @void/void-memory/src/memory-library
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  AgentMemoryStore,
  MEMORY_LIST_DEFAULT_LIMIT,
  MEMORY_LIST_MAX_LIMIT,
  agentMemoryRoot,
  assertAgentId,
  type MemorySearchResult,
  type MemoryTarget,
} from "./agent-store.js";
import { assertEntryId, entryDateOf, resolveIndexPath } from "./documents.js";
import { MemoryIndexStore } from "./index-store.js";
import { assertMemoryPathInside } from "./paths.js";

/** 视图 id：面板上叫「人格记忆」。 */
export const MEMORY_VIEW_ID = "void-memory:memory";

/** 长期文字在条目 id 里的那一段。 */
export const LONG_TERM_ITEM = "long-term";

export class MemoryLibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryLibraryError";
  }
}

/** 索引现在是什么状态：没有、能用（第几代）、还是坏了待同步。 */
export type MemoryIndexState = { kind: "none" } | { kind: "ready"; generation: number } | { kind: "dirty"; reason: string };

export interface MemoryItemSummary {
  /** `<档案 id>/<条目 id>` 或 `<档案 id>/long-term`。 */
  itemId: string;
  agentId: string;
  target: MemoryTarget;
  revision: number;
  updatedAt: string;
  preview: string;
}

export interface MemoryItemDetail extends MemoryItemSummary {
  body: string;
  /** 日记条目才有日期；长期文字没有。 */
  date?: string;
  /** 日记条目才有来源；长期文字没有。 */
  source?: string;
  index: MemoryIndexState;
  /** 索引没同步上时仓储给的说明（「没有索引，本次只保存正文」等）。 */
  warning?: string;
}

export interface MemoryLibraryList {
  items: MemoryItemSummary[];
  /** 列表级说明：截断、读不出来的档案、数据根里一个人都没有。 */
  notes: readonly string[];
}

export interface MemorySearchHit {
  itemId: string;
  agentId: string;
  target: MemoryTarget;
  date: string;
  revision: number;
  snippet: string;
  score: number;
}

export interface MemoryLibraryOptions {
  dataDir: string;
  now?: (() => Date) | undefined;
}

/** 面板里的条目 id → 档案 + 目标。不合法就直接拒绝，不去猜。 */
export function parseMemoryItemId(itemId: string): { agentId: string; target: MemoryTarget } {
  const slash = itemId.indexOf("/");
  if (slash <= 0 || slash === itemId.length - 1) {
    throw new MemoryLibraryError(`记忆条目 id 不合法: ${itemId}（要写成 <档案 id>/<条目 id>）`);
  }
  const agentId = itemId.slice(0, slash);
  const entryId = itemId.slice(slash + 1);
  try {
    assertAgentId(agentId);
  } catch {
    throw new MemoryLibraryError(`记忆档案 id 不合法: ${agentId}`);
  }
  if (entryId === LONG_TERM_ITEM) return { agentId, target: { kind: "long-term" } };
  try {
    assertEntryId(entryId);
  } catch {
    throw new MemoryLibraryError(`记忆条目 id 不合法: ${entryId}`);
  }
  // 目录名由 id 推出来（`YYYYMMDD-NNNN`），推不出来就说明这个 id 不是记忆条目。
  if (entryDateOf(entryId) === undefined) {
    throw new MemoryLibraryError(`记忆条目 id 不合法: ${entryId}（日记条目要写成 YYYYMMDD-NNNN）`);
  }
  return { agentId, target: { kind: "entry", entryId } };
}

/** 档案 + 目标 → 面板里的条目 id。 */
export function formatMemoryItemId(agentId: string, target: MemoryTarget): string {
  return target.kind === "long-term" ? `${agentId}/${LONG_TERM_ITEM}` : `${agentId}/${target.entryId}`;
}

/**
 * 一份档案记忆仓的管理面。
 *
 * 每次操作现造一个 `AgentMemoryStore`（构造不读盘，索引句柄按档案缓存）：面板的写入是
 * 人手速度的，不值得为它维护一层跨调用队列；真正的并发保护是修订号当栅加同目录原子替换。
 */
export class MemoryLibrary {
  private readonly dataDir: string;
  private readonly now: (() => Date) | undefined;
  private readonly indexes = new Map<string, MemoryIndexStore>();

  constructor(options: MemoryLibraryOptions) {
    this.dataDir = options.dataDir;
    this.now = options.now;
  }

  get dataRoot(): string {
    return this.dataDir;
  }

  /** 数据根里已经有记忆的档案（按 id 排序）。目录名不合法的直接不算档案。 */
  async listAgents(): Promise<string[]> {
    const root = path.resolve(this.dataDir, "agents");
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        try {
          assertAgentId(name);
          return true;
        } catch {
          return false;
        }
      })
      .sort();
  }

  /** 列出每份档案的长期文字与最近条目。 */
  async list(input: { limit?: number } = {}): Promise<MemoryLibraryList> {
    const limit = normalizeListLimit(input.limit);
    const agents = await this.listAgents();
    const items: MemoryItemSummary[] = [];
    const notes: string[] = [];
    if (agents.length === 0) {
      notes.push("数据根里还没有任何档案的记忆：先让一个会话写过记忆，或者确认数据根是不是当前 profile。");
    }
    for (const agentId of agents) {
      let store: AgentMemoryStore;
      try {
        store = await this.storeFor(agentId);
      } catch (error) {
        notes.push(`档案 ${agentId} 的记忆读不出来：${describe(error)}`);
        continue;
      }
      // 长期文字永远列一条：它可能是空的，但「现在还没有」本身就是要看的信息。
      try {
        const longTerm = await store.readLongTerm();
        items.push({
          itemId: formatMemoryItemId(agentId, { kind: "long-term" }),
          agentId,
          target: { kind: "long-term" },
          revision: longTerm.revision,
          updatedAt: longTerm.updatedAt,
          preview: previewOf(longTerm.body, "（还没有长期文字）"),
        });
      } catch (error) {
        notes.push(`档案 ${agentId} 的长期文字读不出来：${describe(error)}`);
      }
      try {
        const listed = await store.list({ limit });
        for (const entry of listed.entries) {
          items.push({
            itemId: `${agentId}/${entry.entryId}`,
            agentId,
            target: { kind: "entry", entryId: entry.entryId },
            revision: entry.revision,
            updatedAt: entry.updatedAt,
            preview: previewOf(entry.preview, "（空条目）"),
          });
        }
        const hidden = listed.total - listed.entries.length;
        if (hidden > 0) notes.push(`档案 ${agentId} 还有 ${hidden} 条更早的记忆没有列出来，用检索找。`);
      } catch (error) {
        notes.push(`档案 ${agentId} 的日记读不出来：${describe(error)}`);
      }
    }
    return { items, notes };
  }

  /** 检索。只查已存在的索引，不建库、不全量扫描。 */
  async search(input: { query: string; k?: number }): Promise<{ hits: MemorySearchHit[]; notes: readonly string[] }> {
    const query = input.query.trim();
    if (query === "") throw new MemoryLibraryError("检索词不能为空");
    const agents = await this.listAgents();
    const hits: MemorySearchHit[] = [];
    const notes: string[] = [];
    let searched = 0;
    for (const agentId of agents) {
      let index: MemoryIndexStore | undefined;
      try {
        index = await this.indexFor(agentId);
      } catch (error) {
        notes.push(`档案 ${agentId} 的索引打不开，这次跳过：${describe(error)}`);
        continue;
      }
      // 没有索引就明确跳过：仓储在缺索引时是直接报错的（不退化全量扫描），
      // 但列表级检索没必要为一份没建过索引的档案整体失败。
      if (index === undefined) {
        notes.push(`档案 ${agentId} 还没有索引，检索跳过它。`);
        continue;
      }
      let found: MemorySearchResult[];
      try {
        found = await (await this.storeFor(agentId)).search({ query, ...(input.k === undefined ? {} : { k: input.k }) });
      } catch (error) {
        notes.push(`档案 ${agentId} 检索失败：${describe(error)}`);
        continue;
      }
      searched += 1;
      for (const hit of found) {
        const target: MemoryTarget = hit.kind === "long-term" ? { kind: "long-term" } : { kind: "entry", entryId: hit.entryId };
        hits.push({
          itemId: formatMemoryItemId(agentId, target),
          agentId,
          target,
          date: hit.date,
          revision: hit.revision,
          snippet: hit.snippet,
          score: hit.score,
        });
      }
    }
    hits.sort((left, right) => right.score - left.score || left.itemId.localeCompare(right.itemId));
    if (searched === 0 && agents.length > 0) notes.push("没有任何档案建过索引，这次检索没有结果。");
    return { hits, notes };
  }

  /** 打开一条：长期文字或日记条目。 */
  async read(itemId: string): Promise<MemoryItemDetail> {
    const ref = parseMemoryItemId(itemId);
    const store = await this.storeFor(ref.agentId);
    const index = await this.indexState(ref.agentId);
    if (ref.target.kind === "long-term") {
      const view = await store.readLongTerm();
      return {
        itemId,
        agentId: ref.agentId,
        target: ref.target,
        revision: view.revision,
        updatedAt: view.updatedAt,
        body: view.body,
        preview: previewOf(view.body, "（还没有长期文字）"),
        index,
      };
    }
    const entry = await store.readEntry(ref.target.entryId);
    return {
      itemId,
      agentId: ref.agentId,
      target: ref.target,
      revision: entry.revision,
      updatedAt: entry.updatedAt,
      body: entry.body,
      date: entry.date,
      source: entry.source,
      preview: previewOf(entry.body, "（空条目）"),
      index,
    };
  }

  /** 按修订整文替换正文。改的是同一份文件，条目 id 与日期都不动。 */
  async save(input: { itemId: string; body: string; expectedRevision: number }): Promise<MemoryItemDetail> {
    const ref = parseMemoryItemId(input.itemId);
    const store = await this.storeFor(ref.agentId);
    const result = await store.update({ target: ref.target, body: input.body, expectedRevision: input.expectedRevision });
    const detail = await this.read(input.itemId);
    return result.warning === undefined ? detail : { ...detail, warning: result.warning };
  }

  /** 撤回：正文移入不可检索的恢复区，索引里也删掉。 */
  async retract(input: { itemId: string; expectedRevision?: number }): Promise<{ itemId: string; recoveredPath: string; revision: number; warning?: string }> {
    const ref = parseMemoryItemId(input.itemId);
    const store = await this.storeFor(ref.agentId);
    const result = await store.retract({
      target: ref.target,
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    });
    return {
      itemId: input.itemId,
      recoveredPath: result.recoveredPath,
      revision: result.revision,
      ...(result.warning === undefined ? {} : { warning: result.warning }),
    };
  }

  /** 关闭已打开的索引句柄。重复调用安全。 */
  close(): void {
    for (const index of this.indexes.values()) {
      try {
        index.close();
      } catch {
        // 关不上不掩盖调用方的流程；句柄由进程退出兜底回收。
      }
    }
    this.indexes.clear();
  }

  private async storeFor(agentId: string): Promise<AgentMemoryStore> {
    const index = await this.indexFor(agentId);
    return new AgentMemoryStore({
      root: agentMemoryRoot(this.dataDir, agentId),
      dataRoot: this.dataDir,
      agentId,
      ...(index === undefined ? {} : { index }),
      ...(this.now === undefined ? {} : { now: this.now }),
    });
  }

  /**
   * 索引句柄按档案缓存，但**只在 `memory.sqlite` 已经存在时**才打开。
   *
   * `MemoryIndexStore.open` 会创建文件，所以「看一眼列表」不该顺手给每个档案建库；
   * 索引真的坏了（`记忆索引损坏`）就让它抛出去，检索宁可拒绝也不假装没有结果。
   */
  private async indexFor(agentId: string): Promise<MemoryIndexStore | undefined> {
    const cached = this.indexes.get(agentId);
    if (cached !== undefined) return cached;
    const file = assertMemoryPathInside(this.dataDir, resolveIndexPath(agentMemoryRoot(this.dataDir, agentId)), "记忆索引");
    if (!(await fileExists(file))) return undefined;
    const index = MemoryIndexStore.open({ path: file, agentId });
    this.indexes.set(agentId, index);
    return index;
  }

  private async indexState(agentId: string): Promise<MemoryIndexState> {
    const index = await this.indexFor(agentId);
    if (index === undefined) return { kind: "none" };
    return index.dirty ? { kind: "dirty", reason: index.dirtyReason ?? "原因未知" } : { kind: "ready", generation: index.generation };
  }
}

function normalizeListLimit(limit: number | undefined): number {
  if (limit === undefined) return MEMORY_LIST_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) throw new MemoryLibraryError(`列表条数必须是正整数: ${String(limit)}`);
  return Math.min(limit, MEMORY_LIST_MAX_LIMIT);
}

/** 列表里的一行预览：第一段非空文字，长了自己截断并说明截了多少。 */
function previewOf(body: string, empty: string): string {
  const line = body
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part !== "");
  if (line === undefined) return empty;
  return line.length <= 120 ? line : `${line.slice(0, 120)}…（共 ${line.length} 字符）`;
}

async function fileExists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
