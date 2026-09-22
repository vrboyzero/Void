/**
 * 记忆的业务视图（§16.1 的「记忆详情」）：本人检索、列出、打开、改正文、撤回。
 *
 * 视图由 `void-memory` 自己登记，入口只当通用渲染器。这里只做三件事：把服务读到的事实
 * 排成行、把**允许改的那一个字段**交出去、把动作参数校验清楚。语义与边界都在
 * `memory-library.ts` 里，视图不自己读文件，也不自己造默认值。
 *
 * 操作范围按 14.1 的推荐矩阵走（M5 尚未定案，用的就是这份默认）：长期文字可读、可按修订
 * 整文改、清空要显式做；日记条目可新建、可列出、可按条目 id 改；撤回把原文移进不可检索的
 * 恢复区。`history/` 与恢复区都不在这个视图里直接遍历。
 *
 * @module @void/void-memory/src/detail-view
 */
import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { resolveVoidDataRoot } from "@void/void-soul";
import { JOURNAL_DIR, LONG_TERM_FILE, entryDateOf, type MemoryTarget } from "./documents.js";
import {
  LONG_TERM_ITEM,
  MEMORY_VIEW_ID,
  MemoryLibraryError,
  parseMemoryItemId,
  type MemoryIndexState,
  type MemoryItemDetail,
  type MemoryItemSummary,
  type MemoryLibraryList,
  type MemorySearchHit,
} from "./memory-library.js";

// 视图 id 跟着视图走：灵魂与军团都把 id 定义在各自的 detail-view 里，记忆这边 id 由数据层
// 先定（列表与视图共用同一个 id），这里再转出去，消费方不用记住它住在哪个模块。
export { MEMORY_VIEW_ID };

interface ViewTextSection {
  id: string;
  title: string;
  kind?: "lines" | "table" | "org";
  columns?: readonly string[];
  rows?: ReadonlyArray<readonly string[]>;
  lines?: readonly string[];
}

interface ViewField {
  key: string;
  label: string;
  value: string | number | null;
  readOnly?: boolean;
  kind?: "text" | "markdown";
  help?: string;
}

interface ViewAction {
  id: string;
  label: string;
  hint?: string;
  danger?: boolean;
  args?: readonly ViewField[];
}

interface ViewBody {
  title: string;
  markdown?: string;
  sections: readonly ViewTextSection[];
  revision?: number | string;
  fields?: readonly ViewField[];
  actions?: readonly ViewAction[];
}

interface ViewItem {
  id: string;
  title: string;
  summary?: string;
  meta?: string;
}

interface ViewList {
  items: readonly ViewItem[];
  note?: string;
}

interface ViewProfile {
  home: string;
  name: string;
}

/** 视图需要的那部分 `voidMemoryLibrary` 服务。测试里换成假的就能验全部语义。 */
export interface MemoryViewHost {
  dataRoot: string | undefined;
  listAgents(): Promise<string[]>;
  list(input: { limit?: number }): Promise<MemoryLibraryList>;
  search(input: { query: string; k?: number }): Promise<{ hits: MemorySearchHit[]; notes: readonly string[] }>;
  read(itemId: string): Promise<MemoryItemDetail>;
  save(input: { itemId: string; body: string; expectedRevision: number }): Promise<MemoryItemDetail>;
  retract(input: { itemId: string; expectedRevision?: number }): Promise<{ itemId: string; recoveredPath: string; revision: number; warning?: string }>;
}

interface ViewSource {
  id: string;
  title: string;
  search?: { label?: string; hint?: string };
  list(profile: ViewProfile & { query?: string }): Promise<readonly ViewItem[] | ViewList>;
  detail(profile: ViewProfile & { itemId: string }): Promise<ViewBody>;
  save?(input: ViewProfile & { itemId: string; expectedRevision: number | string; changes: Readonly<Record<string, unknown>> }): Promise<ViewBody>;
  act?(input: ViewProfile & { itemId: string; actionId: string; args: Readonly<Record<string, unknown>>; expectedRevision?: number | string }): Promise<ViewBody>;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new MemoryLibraryError(`${label}是必填`);
  return value.trim();
}

/** 正文是唯一允许改的字段；清空是合法改动（14.1：清空要显式做，不是悄悄没写）。 */
function readBody(value: unknown): string {
  if (typeof value !== "string") throw new MemoryLibraryError(`正文必须是文本: ${typeof value}`);
  return value;
}

/** 记忆的修订是整数序号（灵魂那边是内容哈希，别把两边弄混）。 */
function readRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new MemoryLibraryError(`修订号必须是非负整数: ${String(value)}`);
  }
  return value;
}

function requireChanges(changes: Readonly<Record<string, unknown>>, allowed: readonly string[], label: string): void {
  const keys = Object.keys(changes);
  if (keys.length === 0) throw new MemoryLibraryError("没有要保存的改动");
  const unknown = keys.filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new MemoryLibraryError(`${label}不接受这个改动: ${unknown.join("、")}`);
}

/** 请求的档案与这份数据根必须对得上：面板可以开两个 profile，视图不能被串着用。 */
function assertProfileMatches(host: MemoryViewHost, profile: ViewProfile): void {
  const root = host.dataRoot;
  if (root === undefined) throw new MemoryLibraryError("记忆没有数据根，业务视图不可用");
  const expected = resolveVoidDataRoot({ dshHome: profile.home, profile: profile.name });
  if (path.resolve(root) !== path.resolve(expected)) {
    throw new MemoryLibraryError(`业务视图的档案与记忆数据根不一致：请求 ${expected}（${profile.name}），实际 ${path.resolve(root)}`);
  }
}

function describeIndex(state: MemoryIndexState): string {
  if (state.kind === "ready") return `已同步（第 ${state.generation} 代）`;
  if (state.kind === "dirty") return `待同步：${state.reason}`;
  return "还没有 memory.sqlite：检索会跳过这一条（模型下次写记忆时会建）";
}

function itemTitle(agentId: string, target: MemoryTarget): string {
  return target.kind === "long-term" ? `${agentId} 的长期文字` : `${agentId} · ${target.entryId}`;
}

function itemMeta(revision: number, target: MemoryTarget): string {
  if (target.kind === "long-term") return `修订 ${revision}`;
  return `修订 ${revision} · ${entryDateOf(target.entryId) ?? "日期推不出来"}`;
}

function itemOf(summary: MemoryItemSummary): ViewItem {
  return {
    id: summary.itemId,
    title: itemTitle(summary.agentId, summary.target),
    summary: summary.preview,
    meta: itemMeta(summary.revision, summary.target),
  };
}

function hitOf(hit: MemorySearchHit): ViewItem {
  return {
    id: hit.itemId,
    title: itemTitle(hit.agentId, hit.target),
    summary: hit.snippet,
    meta: `命中 ${hit.score.toFixed(2)} · ${hit.date} · 修订 ${hit.revision}`,
  };
}

function joinNotes(notes: readonly string[]): string | undefined {
  return notes.length === 0 ? undefined : notes.join(" ");
}

function placeLines(detail: MemoryItemDetail): readonly string[] {
  const where = detail.target.kind === "long-term"
    ? `agents/${detail.agentId}/${LONG_TERM_FILE}`
    : `agents/${detail.agentId}/${JOURNAL_DIR}/${detail.date ?? "?"}/${detail.target.entryId}.md`;
  return [
    `位置：${where}`,
    `索引：${describeIndex(detail.index)}`,
    ...(detail.warning === undefined ? [] : [`最近一次写入：${detail.warning}`]),
  ];
}

async function itemBody(service: MemoryViewHost, itemId: string): Promise<ViewBody> {
  const detail = await service.read(itemId);
  const longTerm = detail.target.kind === "long-term";
  // 判别的收窄不会穿过别名进到嵌套的模板串里，所以这一句用内联判断。
  const confirmWord = detail.target.kind === "long-term" ? LONG_TERM_ITEM : detail.target.entryId;
  return {
    title: itemTitle(detail.agentId, detail.target),
    sections: [{ id: "place", title: "位置与索引", kind: "lines", lines: placeLines(detail) }],
    revision: detail.revision,
    fields: [
      {
        key: "body",
        label: "正文",
        value: detail.body,
        kind: "markdown",
        help: longTerm
          ? "改的是同一份 MEMORY.md：清空正文算一次显式改动，修订号加一；要留档就用下面的撤回。"
          : "改的是同一个条目文件：条目 id 与日期不动，修订号加一。",
      },
      { key: "agentId", label: "档案", value: detail.agentId, readOnly: true },
      { key: "kind", label: "类型", value: longTerm ? "长期文字" : "日记条目", readOnly: true },
      { key: "date", label: "日期", value: detail.date ?? "（长期文字没有日期）", readOnly: true },
      { key: "revision", label: "修订", value: detail.revision, readOnly: true, help: "保存时带回；别人先改过会被拒，草稿留着。" },
      { key: "updatedAt", label: "更新时间", value: detail.updatedAt === "" ? "（还没写过）" : detail.updatedAt, readOnly: true },
      { key: "source", label: "来源", value: detail.source ?? "（长期文字没有来源）", readOnly: true },
    ],
    actions: [
      {
        id: "retract",
        label: "撤回这一条",
        danger: true,
        hint: longTerm
          ? "长期文字撤回后 MEMORY.md 变成空文件、修订加一；原文进恢复区，不再参与检索。"
          : "条目撤回后文件搬进恢复区，不再出现在列表与检索里；要恢复只能人工搬回来。",
        args: [{ key: "confirm", label: `重敲 ${confirmWord} 以确认`, value: null }],
      },
    ],
  };
}

/**
 * 日记条目撤回后的终结说明。
 *
 * 条目被撤回后文件已经搬走，再读一次只会拿到「已撤回」，所以这里不回读：把恢复区位置、
 * 新修订与仓储给的索引警告原样交出去。长期文字不同（清空留文件），那条路照常回读。
 */
function retractedBody(service: MemoryViewHost, itemId: string, result: { recoveredPath: string; revision: number; warning?: string }): ViewBody {
  const root = service.dataRoot;
  const shown = root === undefined ? result.recoveredPath : path.relative(root, result.recoveredPath) || result.recoveredPath;
  return {
    title: `${itemId}（已撤回）`,
    sections: [
      {
        id: "retract",
        title: "撤回结果",
        kind: "lines",
        lines: [
          `原文已移到恢复区：${shown}`,
          `撤回后的修订：${result.revision}`,
          ...(result.warning === undefined ? [] : [`索引：${result.warning}`]),
          "这一条不再出现在列表与检索里；要恢复就人工把文件搬回原来的位置。",
        ],
      },
    ],
    revision: result.revision,
  };
}

export function createMemoryViews(host: () => MemoryViewHost | undefined): [ViewSource] {
  const requireHost = (): MemoryViewHost => {
    const service = host();
    if (!service) throw new MemoryLibraryError("记忆服务没装上，业务视图不可用");
    return service;
  };
  const checked = (profile: ViewProfile): MemoryViewHost => {
    const service = requireHost();
    assertProfileMatches(service, profile);
    return service;
  };

  const memory: ViewSource = {
    id: MEMORY_VIEW_ID,
    title: "人格记忆",
    search: {
      label: "检索记忆",
      hint: "检索只查已建好的索引（memory.sqlite），不全量扫描；还没有索引的档案会被跳过，原因写在列表上方。",
    },
    async list(input) {
      const service = checked(input);
      const query = (input.query ?? "").trim();
      if (query !== "") {
        const { hits, notes } = await service.search({ query });
        return { items: hits.map(hitOf), note: joinNotes(notes) };
      }
      const { items, notes } = await service.list({});
      return { items: items.map(itemOf), note: joinNotes(notes) };
    },
    async detail(input) {
      return itemBody(checked(input), input.itemId);
    },
    async save(input) {
      const service = checked(input);
      requireChanges(input.changes, ["body"], "记忆详情");
      const body = readBody(input.changes.body);
      const revision = readRevision(input.expectedRevision);
      await service.save({ itemId: input.itemId, body, expectedRevision: revision });
      return itemBody(service, input.itemId);
    },
    async act(input) {
      const service = checked(input);
      if (input.actionId !== "retract") throw new MemoryLibraryError(`记忆详情不认识这个动作: ${input.actionId}`);
      const parsed = parseMemoryItemId(input.itemId);
      const expected = parsed.target.kind === "long-term" ? LONG_TERM_ITEM : parsed.target.entryId;
      const confirm = readString(input.args.confirm, "确认词");
      // 面板的危险动作没有二次确认框（只有红框），所以撤回必须重敲 id：误点一下就没了的东西
      // 不该只靠一个按钮。
      if (confirm !== expected) throw new MemoryLibraryError(`撤回要重敲 ${expected} 才算确认：收到 ${confirm}`);
      const result = await service.retract({ itemId: input.itemId });
      if (parsed.target.kind === "long-term") return itemBody(service, input.itemId);
      return retractedBody(service, input.itemId, result);
    },
  };

  return [memory];
}

/** 入口 `VoidSuite.registerDetail` 的结构契约（重述，避免跨包类型依赖）。 */
export interface DetailHost {
  registerDetail(source: ViewSource): () => void;
}

export const name = "void-memory-detail";
export const inject = ["voidSuite", "voidMemoryLibrary"];

/**
 * 把记忆视图登记进入口。
 *
 * 只在 web 组合里生效：headless 组合没有 `voidSuite`，这个回调就永不执行，记忆本身照常
 * 工作（模型工具、索引、隔离都不依赖面板）。
 */
export function apply(ctx: Context): void {
  ctx.inject(["voidSuite", "voidMemoryLibrary"], (viewCtx) => {
    const suite = viewCtx.get("voidSuite") as DetailHost | undefined;
    if (suite === undefined || typeof suite.registerDetail !== "function") return;
    const host = (): MemoryViewHost | undefined => viewCtx.get("voidMemoryLibrary") as MemoryViewHost | undefined;
    for (const source of createMemoryViews(host)) {
      viewCtx.effect(() => suite.registerDetail(source), `void-memory: detail view ${source.id}`);
    }
  });
}

export default apply;
