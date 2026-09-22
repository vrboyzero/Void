import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveVoidDataRoot } from "@void/void-soul";
import {
  MEMORY_VIEW_ID,
  createMemoryViews,
  apply,
  type MemoryViewHost,
} from "../src/detail-view.js";
import type {
  MemoryItemDetail,
  MemoryItemSummary,
  MemoryLibraryList,
  MemorySearchHit,
} from "../src/memory-library.js";

const PROFILE = { home: "E:/isolated", name: "web" };
const DATA_ROOT = resolveVoidDataRoot({ dshHome: PROFILE.home, profile: PROFILE.name });

const ENTRY_ID = "20260922-0001";
const ENTRY_ITEM = `xiaobei/${ENTRY_ID}`;
const LONG_TERM_ITEM = "xiaobei/long-term";

const LONG_TERM: MemoryItemDetail = {
  itemId: LONG_TERM_ITEM,
  agentId: "xiaobei",
  target: { kind: "long-term" },
  revision: 2,
  updatedAt: "2026-09-22T10:00:00.000Z",
  preview: "长期文字：慢慢来。",
  body: "长期文字：慢慢来。\n",
  index: { kind: "ready", generation: 3 },
};

const ENTRY: MemoryItemDetail = {
  itemId: ENTRY_ITEM,
  agentId: "xiaobei",
  target: { kind: "entry", entryId: ENTRY_ID },
  revision: 1,
  updatedAt: "2026-09-22T10:05:00.000Z",
  preview: "条目正文：先看清再动手。",
  body: "条目正文：先看清再动手。\n",
  date: "2026-09-22",
  source: "session",
  index: { kind: "dirty", reason: "正文已保存、检索待同步" },
};

const HIT: MemorySearchHit = {
  itemId: ENTRY_ITEM,
  agentId: "xiaobei",
  target: { kind: "entry", entryId: ENTRY_ID },
  date: "2026-09-22",
  revision: 1,
  snippet: "…先看清再动手…",
  score: 1.5,
};

function fakeHost(overrides: Partial<MemoryViewHost> = {}) {
  const calls: Array<{ method: string; input: unknown }> = [];
  const items = new Map<string, MemoryItemDetail>([
    [LONG_TERM_ITEM, { ...LONG_TERM }],
    [ENTRY_ITEM, { ...ENTRY }],
  ]);
  const retracted = new Set<string>();
  const host: MemoryViewHost = {
    dataRoot: DATA_ROOT,
    async listAgents() {
      calls.push({ method: "listAgents", input: undefined });
      return ["xiaobei"];
    },
    async list(input) {
      calls.push({ method: "list", input });
      const listed: MemoryLibraryList = {
        items: [items.get(LONG_TERM_ITEM)!, items.get(ENTRY_ITEM)!].map(
          (item): MemoryItemSummary => ({
            itemId: item.itemId,
            agentId: item.agentId,
            target: item.target,
            revision: item.revision,
            updatedAt: item.updatedAt,
            preview: item.preview,
          }),
        ),
        notes: ["档案 xiaobei 还有 1 条更早的记忆没有列出来，用检索找。"],
      };
      return listed;
    },
    async search(input) {
      calls.push({ method: "search", input });
      return { hits: [HIT], notes: [] };
    },
    async read(itemId) {
      calls.push({ method: "read", input: itemId });
      if (retracted.has(itemId)) throw new Error(`记忆条目已撤回: ${itemId}`);
      const found = items.get(itemId);
      if (found === undefined) throw new Error(`记忆条目不存在: ${itemId}`);
      return { ...found };
    },
    async save(input) {
      calls.push({ method: "save", input });
      const found = items.get(input.itemId);
      if (found === undefined) throw new Error(`记忆条目不存在: ${input.itemId}`);
      const saved: MemoryItemDetail = { ...found, body: input.body, revision: input.expectedRevision + 1, preview: input.body };
      items.set(input.itemId, saved);
      return { ...saved };
    },
    async retract(input) {
      calls.push({ method: "retract", input });
      // 长期文字撤回只是清空正文、修订加一，文件还在；条目才是搬进恢复区。
      if (input.itemId === LONG_TERM_ITEM) {
        const found = items.get(LONG_TERM_ITEM)!;
        items.set(LONG_TERM_ITEM, { ...found, body: "", revision: found.revision + 1, preview: "（还没有长期文字）" });
      } else {
        retracted.add(input.itemId);
      }
      return {
        itemId: input.itemId,
        recoveredPath: path.resolve(DATA_ROOT, "agents", "xiaobei", "retracted", `${ENTRY_ID}.md`),
        revision: 1,
        warning: "正文已撤回、检索待同步",
      };
    },
    ...overrides,
  };
  return { host, calls };
}

function views(overrides: Partial<MemoryViewHost> = {}) {
  const fake = fakeHost(overrides);
  const [memory] = createMemoryViews(() => fake.host);
  return { memory, ...fake };
}

/** 保存/动作之后视图会重读一遍卡片，所以 `calls.at(-1)` 未必是那次写入。 */
function lastCall(calls: ReadonlyArray<{ method: string; input: unknown }>, method: string) {
  return calls.filter((call) => call.method === method).at(-1);
}

describe("void-memory 业务视图", () => {
  it("列出每份档案的长期文字与条目，列表级的话原样带出来", async () => {
    const { memory, calls } = views();
    expect(await memory.list(PROFILE)).toEqual({
      items: [
        { id: LONG_TERM_ITEM, title: "xiaobei 的长期文字", summary: "长期文字：慢慢来。", meta: "修订 2" },
        { id: ENTRY_ITEM, title: "xiaobei · 20260922-0001", summary: "条目正文：先看清再动手。", meta: "修订 1 · 2026-09-22" },
      ],
      note: "档案 xiaobei 还有 1 条更早的记忆没有列出来，用检索找。",
    });
    expect(lastCall(calls, "list")).toEqual({ method: "list", input: {} });
    expect(memory.search).toEqual({
      label: "检索记忆",
      hint: "检索只查已建好的索引（memory.sqlite），不全量扫描；还没有索引的档案会被跳过，原因写在列表上方。",
    });
  });

  it("带检索词时走检索，命中带分数与日期，不落回列表", async () => {
    const { memory, calls } = views();
    expect(await memory.list({ ...PROFILE, query: "  先看清  " })).toEqual({
      items: [{ id: ENTRY_ITEM, title: "xiaobei · 20260922-0001", summary: "…先看清再动手…", meta: "命中 1.50 · 2026-09-22 · 修订 1" }],
      note: undefined,
    });
    expect(lastCall(calls, "search")).toEqual({ method: "search", input: { query: "先看清" } });
    expect(calls.some((call) => call.method === "list")).toBe(false);
  });

  it("空检索词当没检索：那不是在找东西", async () => {
    const { memory, calls } = views();
    const listed = await memory.list({ ...PROFILE, query: "   " });
    expect(listed).toMatchObject({ note: expect.stringContaining("还有 1 条更早的记忆") });
    expect(calls.some((call) => call.method === "search")).toBe(false);
    expect(lastCall(calls, "list")).toEqual({ method: "list", input: {} });
  });

  it("条目的详情：正文可改，位置与索引写清楚，撤回要重敲条目 id", async () => {
    const { memory } = views();
    const body = await memory.detail({ ...PROFILE, itemId: ENTRY_ITEM });
    expect(body.title).toBe("xiaobei · 20260922-0001");
    expect(body.revision).toBe(1);
    expect(body.sections).toEqual([
      {
        id: "place",
        title: "位置与索引",
        kind: "lines",
        lines: ["位置：agents/xiaobei/memory/2026-09-22/20260922-0001.md", "索引：待同步：正文已保存、检索待同步"],
      },
    ]);
    const fields = body.fields!;
    expect(fields.map((field) => field.key)).toEqual(["body", "agentId", "kind", "date", "revision", "updatedAt", "source"]);
    expect(fields[0]).toMatchObject({ value: "条目正文：先看清再动手。\n", kind: "markdown" });
    expect(fields[0]!.readOnly).toBeUndefined();
    expect(fields[0]!.help).toContain("条目 id 与日期不动");
    for (const field of fields.slice(1)) expect(field.readOnly).toBe(true);
    expect(fields[2]!.value).toBe("日记条目");
    expect(fields[3]!.value).toBe("2026-09-22");
    expect(fields[6]!.value).toBe("session");
    expect(body.actions).toEqual([
      {
        id: "retract",
        label: "撤回这一条",
        danger: true,
        hint: "条目撤回后文件搬进恢复区，不再出现在列表与检索里；要恢复只能人工搬回来。",
        args: [{ key: "confirm", label: `重敲 ${ENTRY_ID} 以确认`, value: null }],
      },
    ]);
    // 记忆视图没有整体动作（新建记忆是模型的事，不是人类面板的事）。
    expect(memory.actView).toBeUndefined();
    expect(memory.viewActions).toBeUndefined();
  });

  it("长期文字的详情：没有日期与来源，索引状态是「已同步」", async () => {
    const { memory } = views();
    const body = await memory.detail({ ...PROFILE, itemId: LONG_TERM_ITEM });
    expect(body.sections![0]!.lines).toEqual(["位置：agents/xiaobei/MEMORY.md", "索引：已同步（第 3 代）"]);
    const fields = body.fields!;
    expect(fields[2]!.value).toBe("长期文字");
    expect(fields[3]!.value).toBe("（长期文字没有日期）");
    expect(fields[6]!.value).toBe("（长期文字没有来源）");
    expect(body.actions![0]!.args![0]!.label).toBe("重敲 long-term 以确认");
  });

  it("保存只认正文，清空也算一次显式改动", async () => {
    const { memory, calls } = views();
    const saved = await memory.save!({ ...PROFILE, itemId: ENTRY_ITEM, expectedRevision: 1, changes: { body: "改过的正文。" } });
    expect(lastCall(calls, "save")).toEqual({
      method: "save",
      input: { itemId: ENTRY_ITEM, body: "改过的正文。", expectedRevision: 1 },
    });
    // 保存后回读：面板拿到的修订必须是新的那个。
    expect(saved.revision).toBe(2);
    expect(saved.fields!.find((field) => field.key === "body")!.value).toBe("改过的正文。");

    await memory.save!({ ...PROFILE, itemId: LONG_TERM_ITEM, expectedRevision: 2, changes: { body: "" } });
    expect(lastCall(calls, "save")).toEqual({
      method: "save",
      input: { itemId: LONG_TERM_ITEM, body: "", expectedRevision: 2 },
    });
  });

  it("保存的边界：不认的键、空改动、非文本正文、坏修订号都明确拒绝", async () => {
    const { memory, calls } = views();
    const save = (changes: Record<string, unknown>, expectedRevision: unknown = 1) =>
      memory.save!({ ...PROFILE, itemId: ENTRY_ITEM, expectedRevision: expectedRevision as number, changes });
    await expect(save({ revision: 2 })).rejects.toThrow("记忆详情不接受这个改动: revision");
    await expect(save({})).rejects.toThrow("没有要保存的改动");
    await expect(save({ body: 5 })).rejects.toThrow("正文必须是文本: number");
    await expect(save({ body: "x" }, 1.5)).rejects.toThrow("修订号必须是非负整数: 1.5");
    await expect(save({ body: "x" }, -1)).rejects.toThrow("修订号必须是非负整数: -1");
    await expect(save({ body: "x" }, "1")).rejects.toThrow("修订号必须是非负整数: 1");
    expect(calls.some((call) => call.method === "save")).toBe(false);
  });

  it("撤回条目：确认词不对就拒绝，撤回后回终结说明而不是再读一次", async () => {
    const { memory, calls } = views();
    await expect(memory.act!({ ...PROFILE, itemId: ENTRY_ITEM, actionId: "retract", args: { confirm: "nope" } })).rejects.toThrow(
      `撤回要重敲 ${ENTRY_ID} 才算确认：收到 nope`,
    );
    await expect(memory.act!({ ...PROFILE, itemId: ENTRY_ITEM, actionId: "retract", args: {} })).rejects.toThrow("确认词是必填");
    expect(calls.some((call) => call.method === "retract")).toBe(false);

    const body = await memory.act!({ ...PROFILE, itemId: ENTRY_ITEM, actionId: "retract", args: { confirm: ENTRY_ID } });
    expect(lastCall(calls, "retract")).toEqual({ method: "retract", input: { itemId: ENTRY_ITEM } });
    expect(body.title).toBe(`${ENTRY_ITEM}（已撤回）`);
    expect(body.revision).toBe(1);
    const lines = body.sections![0]!.lines!;
    expect(lines[0]).toContain("原文已移到恢复区：");
    expect(lines[0]).toContain("retracted");
    expect(lines[0]).toContain(`${ENTRY_ID}.md`);
    expect(lines[1]).toBe("撤回后的修订：1");
    expect(lines[2]).toBe("索引：正文已撤回、检索待同步");
    // 条目撤回后再读只会拿到「已撤回」：视图不该回读，读了这里就会抛。
    expect(calls.filter((call) => call.method === "read").length).toBe(0);
  });

  it("撤回长期文字：文件还在，照常回读详情", async () => {
    const { memory, calls } = views();
    const body = await memory.act!({ ...PROFILE, itemId: LONG_TERM_ITEM, actionId: "retract", args: { confirm: "long-term" } });
    expect(lastCall(calls, "retract")).toEqual({ method: "retract", input: { itemId: LONG_TERM_ITEM } });
    expect(body.title).toBe("xiaobei 的长期文字");
    expect(lastCall(calls, "read")).toEqual({ method: "read", input: LONG_TERM_ITEM });
    // 回读的是清空后的那一份：正文空了、修订加一，条目还在列表里。
    expect(body.fields!.find((field) => field.key === "body")!.value).toBe("");
    expect(body.revision).toBe(3);
  });

  it("不认识的动作不猜", async () => {
    const { memory, calls } = views();
    await expect(memory.act!({ ...PROFILE, itemId: ENTRY_ITEM, actionId: "wipe", args: {} })).rejects.toThrow(
      "记忆详情不认识这个动作: wipe",
    );
    expect(calls.some((call) => call.method === "retract")).toBe(false);
  });

  it("每个操作都核对档案：换一个 profile 就不许串着用", async () => {
    const { memory } = views();
    const other = { home: "E:/isolated", name: "headless" };
    const mismatch = /业务视图的档案与记忆数据根不一致/;
    await expect(memory.list(other)).rejects.toThrow(mismatch);
    await expect(memory.detail({ ...other, itemId: ENTRY_ITEM })).rejects.toThrow(mismatch);
    await expect(memory.save!({ ...other, itemId: ENTRY_ITEM, expectedRevision: 1, changes: { body: "x" } })).rejects.toThrow(mismatch);
    await expect(memory.act!({ ...other, itemId: ENTRY_ITEM, actionId: "retract", args: { confirm: ENTRY_ID } })).rejects.toThrow(mismatch);
  });

  it("服务没装上或没有数据根时说清楚，不假装能用", async () => {
    const [missing] = createMemoryViews(() => undefined);
    await expect(missing!.list(PROFILE)).rejects.toThrow("记忆服务没装上，业务视图不可用");
    const { memory } = views({ dataRoot: undefined });
    await expect(memory.list(PROFILE)).rejects.toThrow("记忆没有数据根，业务视图不可用");
  });

  it("registers the view into the suite and takes it back on dispose", () => {
    const registered: string[] = [];
    const suite = {
      registerDetail(source: { id: string }) {
        registered.push(source.id);
        return () => {
          registered.splice(registered.indexOf(source.id), 1);
        };
      },
    };
    const { host } = fakeHost();
    const disposers: Array<() => void> = [];
    const fakeCtx = {
      inject: (_deps: string[], callback: (ctx: unknown) => void) =>
        callback({
          get: (name: string) => (name === "voidSuite" ? suite : host),
          effect: (factory: () => () => void) => {
            disposers.push(factory());
          },
        }),
    };

    apply(fakeCtx as never);
    expect(registered).toEqual([MEMORY_VIEW_ID]);
    for (const dispose of disposers) dispose();
    expect(registered).toEqual([]);
  });
});
