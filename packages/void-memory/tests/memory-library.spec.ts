import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentMemoryStore, agentMemoryRoot } from "../src/agent-store.js";
import { MemoryIndexStore } from "../src/index-store.js";
import {
  MemoryLibrary,
  MemoryLibraryError,
  formatMemoryItemId,
  parseMemoryItemId,
} from "../src/memory-library.js";

const FIXED_DAY = new Date(2026, 8, 22, 10, 0, 0);

let dataDir: string;
const panels: MemoryLibrary[] = [];
const opened: MemoryIndexStore[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "void-memory-library-"));
});

afterEach(async () => {
  // 一个用例里可能开好几个面板，全都得关：漏一个，它的 sqlite 句柄就一直占着数据根，
  // 下面这句 rm 在 Windows 上删不掉目录，只能反复重试（实测能拖到 8.5 秒）。
  for (const item of panels.splice(0)) item.close();
  for (const index of opened.splice(0)) index.close();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function openAgent(agentId: string, withIndex = true): AgentMemoryStore {
  const root = agentMemoryRoot(dataDir, agentId);
  const index = withIndex ? MemoryIndexStore.open({ path: path.join(root, "memory.sqlite"), agentId }) : undefined;
  if (index) opened.push(index);
  return new AgentMemoryStore({ root, dataRoot: dataDir, agentId, index, now: () => FIXED_DAY });
}

function panel(): MemoryLibrary {
  const created = new MemoryLibrary({ dataDir, now: () => FIXED_DAY });
  panels.push(created);
  return created;
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

describe("面板的条目 id", () => {
  it("长期文字与日记条目各有稳定写法，来回转换不掉信息", () => {
    expect(parseMemoryItemId("xiaobei/long-term")).toEqual({ agentId: "xiaobei", target: { kind: "long-term" } });
    expect(parseMemoryItemId("xiaobei/20260922-0001")).toEqual({
      agentId: "xiaobei",
      target: { kind: "entry", entryId: "20260922-0001" },
    });
    expect(formatMemoryItemId("xiaobei", { kind: "long-term" })).toBe("xiaobei/long-term");
    expect(formatMemoryItemId("xiaobei", { kind: "entry", entryId: "20260922-0001" })).toBe("xiaobei/20260922-0001");
  });

  it("不像条目 id 的东西一律拒绝，不去猜", () => {
    for (const forged of ["nope", "/long-term", "xiaobei/", "xiaobei/2026-09-22", "xiaobei/AB"]) {
      expect(() => parseMemoryItemId(forged)).toThrow(MemoryLibraryError);
    }
    expect(() => parseMemoryItemId("nope")).toThrow(/要写成 <档案 id>\/<条目 id>/);
    expect(() => parseMemoryItemId("小贝/long-term")).toThrow(/记忆档案 id 不合法: 小贝/);
    expect(() => parseMemoryItemId("xiaobei/2026-09-22")).toThrow(/日记条目要写成 YYYYMMDD-NNNN/);
  });
});

describe("列出与打开", () => {
  it("列出数据根里像档案的目录，坏名字不算档案", async () => {
    for (const name of ["xiaoma", "xiaobei", "Bad Name", ".tmp"]) {
      await mkdir(path.join(dataDir, "agents", name), { recursive: true });
    }
    expect(await panel().listAgents()).toEqual(["xiaobei", "xiaoma"]);
  });

  it("共用模组库那一层不算档案，也不出现在列表里", async () => {
    await mkdir(path.join(dataDir, "agents", "facets"), { recursive: true });
    await writeFile(path.join(dataDir, "agents", "facets", "dev.md"), "---\nid: dev\nname: 开发专家\n---\n# 开发\n", "utf8");
    await mkdir(path.join(dataDir, "agents", "xiaobei"), { recursive: true });
    await writeFile(path.join(dataDir, "agents", "xiaobei", "MEMORY.md"), "# 长期\n", "utf8");

    const board = panel();
    expect(await board.listAgents()).toEqual(["xiaobei"]);
    const listed = await board.list();
    expect(listed.items.map((item) => item.agentId)).toEqual(["xiaobei"]);
    // 模组库里的文件不是任何人的记忆：没有被读成条目，也没被当成档案的长期文字。
    expect(listed.items.some((item) => item.itemId.startsWith("facets") || item.preview.includes("开发专家"))).toBe(false);
    // 只是不看它，不去动它。
    expect(await exists(path.join(dataDir, "agents", "facets", "dev.md"))).toBe(true);
    expect(await exists(path.join(dataDir, "agents", "facets", "memory.sqlite"))).toBe(false);
  });

  it("一个档案都没有时说清为什么是空的", async () => {
    const listed = await panel().list();
    expect(listed.items).toEqual([]);
    expect(listed.notes.join(" ")).toContain("数据根里还没有任何档案的记忆");
  });

  it("每份档案都列长期文字，条目按 id 倒序", async () => {
    const store = openAgent("xiaobei");
    await store.write({ target: "long-term", body: "小贝的长期文字：慢慢来。" });
    await store.write({ body: "第一条：先看清再动手。" });
    await store.write({ body: "第二条：动手前先备份。" });

    const listed = await panel().list();
    expect(listed.items.map((item) => item.itemId)).toEqual([
      "xiaobei/long-term",
      "xiaobei/20260922-0002",
      "xiaobei/20260922-0001",
    ]);
    expect(listed.items[0]!.preview).toContain("慢慢来");
    expect(listed.items[0]!.revision).toBe(1);
    expect(listed.notes).toEqual([]);
  });

  it("列不下的时候说清还有多少条，并给出检索这条出路", async () => {
    const store = openAgent("xiaobei");
    for (const body of ["第一条", "第二条", "第三条"]) await store.write({ body });
    const listed = await panel().list({ limit: 2 });
    expect(listed.items.filter((item) => item.target.kind === "entry")).toHaveLength(2);
    expect(listed.notes.join(" ")).toContain("还有 1 条更早的记忆没有列出来");
    await expect(panel().list({ limit: 0 })).rejects.toThrow(/列表条数必须是正整数/);
  });

  it("打开长期文字与条目：正文、日期、来源、索引状态都在", async () => {
    const store = openAgent("xiaobei");
    await store.write({ target: "long-term", body: "长期文字：今天只做一件小事。" });
    const written = await store.write({ body: "条目正文：先看清再动手。", source: "session" });
    const entryId = (written.target as { entryId: string }).entryId;

    const service = panel();
    const longTerm = await service.read("xiaobei/long-term");
    expect(longTerm.body).toContain("今天只做一件小事");
    expect(longTerm.date).toBeUndefined();
    expect(longTerm.index.kind).toBe("ready");

    const entry = await service.read(`xiaobei/${entryId}`);
    expect(entry.body).toContain("先看清再动手");
    expect(entry.date).toBe("2026-09-22");
    expect(entry.source).toBe("session");
    expect(entry.revision).toBe(1);
    expect(entry.index.kind).toBe("ready");
  });

  it("没有索引时列表照样能看，只是索引状态写着「还没有」", async () => {
    const store = openAgent("xiaobei", false);
    await store.write({ body: "没有索引也写得进去。" });
    const detail = await panel().read("xiaobei/20260922-0001");
    expect(detail.index).toEqual({ kind: "none" });
    expect(detail.body).toContain("没有索引也写得进去");
  });
});

describe("改与撤回", () => {
  it("按修订整文替换：修订加一，拿旧修订再来一次会被拒", async () => {
    const store = openAgent("xiaobei");
    await store.write({ body: "原始正文。" });
    const service = panel();
    const saved = await service.save({ itemId: "xiaobei/20260922-0001", body: "改过的正文。", expectedRevision: 1 });
    expect(saved.revision).toBe(2);
    expect(saved.body).toContain("改过的正文");
    await expect(service.save({ itemId: "xiaobei/20260922-0001", body: "又改一次。", expectedRevision: 1 })).rejects.toThrow(
      /记忆已被其他写入更新（期望修订 1，实际 2）/,
    );
  });

  it("长期文字也能整文改，清空算一次显式改动", async () => {
    const store = openAgent("xiaobei");
    await store.write({ target: "long-term", body: "原来的长期文字。" });
    const service = panel();
    const cleared = await service.save({ itemId: "xiaobei/long-term", body: "", expectedRevision: 1 });
    expect(cleared.body).toBe("");
    expect(cleared.revision).toBe(2);
    expect(await exists(path.join(agentMemoryRoot(dataDir, "xiaobei"), "MEMORY.md"))).toBe(true);
    expect((await service.read("xiaobei/long-term")).body).toBe("");
  });

  it("撤回条目：原文进恢复区，列表与检索都不再提它", async () => {
    const store = openAgent("xiaobei");
    const written = await store.write({ body: "这条待会儿要撤回，关键词 蓝鲸。" });
    const entryId = (written.target as { entryId: string }).entryId;
    const service = panel();
    expect((await service.search({ query: "蓝鲸" })).hits).toHaveLength(1);

    const result = await service.retract({ itemId: `xiaobei/${entryId}` });
    expect(result.recoveredPath).toBe(path.join(agentMemoryRoot(dataDir, "xiaobei"), "retracted", `${entryId}.md`));
    expect(await readFile(result.recoveredPath, "utf8")).toContain("蓝鲸");
    expect((await service.search({ query: "蓝鲸" })).hits).toEqual([]);
    await expect(service.read(`xiaobei/${entryId}`)).rejects.toThrow(/已撤回/);
    expect((await service.list()).items.map((item) => item.itemId)).toEqual(["xiaobei/long-term"]);
  });

  it("撤回长期文字：原文进恢复区，文件清空但留在原处", async () => {
    const store = openAgent("xiaobei");
    await store.write({ target: "long-term", body: "要被撤回的长期文字，关键词 灰鲸。" });
    const service = panel();
    const result = await service.retract({ itemId: "xiaobei/long-term" });
    expect(result.recoveredPath).toBe(path.join(agentMemoryRoot(dataDir, "xiaobei"), "retracted", "MEMORY.md"));
    expect(await readFile(result.recoveredPath, "utf8")).toContain("灰鲸");
    expect(result.revision).toBe(2);
    const detail = await service.read("xiaobei/long-term");
    expect(detail.body).toBe("");
    expect(detail.revision).toBe(2);
  });
});

describe("检索", () => {
  it("只查已建好的索引，命中按分数排", async () => {
    const xiaobei = openAgent("xiaobei");
    const xiaoma = openAgent("xiaoma");
    await xiaobei.write({ body: "小贝的守则：先看清再动手。" });
    await xiaobei.write({ body: "小贝的杂事：今天买了海豚玩偶。" });
    await xiaoma.write({ body: "小马的守则：先问再动手。" });

    const found = await panel().search({ query: "守则" });
    expect(found.hits.map((hit) => hit.itemId).sort()).toEqual(["xiaobei/20260922-0001", "xiaoma/20260922-0001"]);
    expect(found.hits[0]!.score).toBeGreaterThan(0);
    expect(found.hits[0]!.snippet).toContain("守则");
    expect(found.notes).toEqual([]);
  });

  it("空检索词直接拒绝：那不是在找东西", async () => {
    await expect(panel().search({ query: "   " })).rejects.toThrow(/检索词不能为空/);
  });

  it("没有索引的档案被跳过并说明原因，不会退化成全量扫描", async () => {
    const store = openAgent("xiaobei", false);
    await store.write({ body: "没有索引的档案，关键词 蓝鲸。" });
    const service = panel();
    const found = await service.search({ query: "蓝鲸" });
    expect(found.hits).toEqual([]);
    expect(found.notes.join(" ")).toContain("档案 xiaobei 还没有索引，检索跳过它");
    expect(found.notes.join(" ")).toContain("没有任何档案建过索引");
  });

  it("看一眼列表或搜一次不会顺手给档案建库", async () => {
    const store = openAgent("xiaobei", false);
    await store.write({ body: "只有正文，没有索引。" });
    const service = panel();
    await service.list();
    await service.search({ query: "正文" });
    expect(await exists(path.join(agentMemoryRoot(dataDir, "xiaobei"), "memory.sqlite"))).toBe(false);
  });

  it("索引坏了就让检索明确报出来，不假装没有结果", async () => {
    const store = openAgent("xiaobei", false);
    await store.write({ body: "索引坏掉之前的正文。" });
    await writeFile(path.join(agentMemoryRoot(dataDir, "xiaobei"), "memory.sqlite"), "这不是一个数据库", "utf8");
    const found = await panel().search({ query: "正文" });
    expect(found.hits).toEqual([]);
    expect(found.notes.join(" ")).toContain("档案 xiaobei 的索引打不开");
  });
});
