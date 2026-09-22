import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryIndexCorruptError,
  MemoryIndexError,
  MemoryIndexStore,
  memoryMatchExpression,
  memoryQueryTerms,
  memoryTokens,
} from "../src/index-store.js";

let root: string;
let store: MemoryIndexStore | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "void-memory-index-"));
});

afterEach(async () => {
  store?.close();
  store = undefined;
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function indexPath(name = "memory.sqlite"): string {
  return path.join(root, name);
}

describe("中文切分", () => {
  it("中文连续段产出单字与双字", () => {
    const tokens = memoryTokens("守则").split(" ");
    expect(tokens).toContain("守");
    expect(tokens).toContain("则");
    expect(tokens).toContain("守则");
  });

  it("查询表达式只由引号包裹的 token 拼成，带不进 FTS 语法", () => {
    const { precise } = memoryQueryTerms('守则" OR body MATCH');
    const expression = memoryMatchExpression(precise)!;
    expect(expression).not.toContain("MATCH");
    expect(expression.split(" OR ").every((term) => /^"[^"]+"$/.test(term))).toBe(true);
    expect(memoryMatchExpression([])).toBeUndefined();
  });
});

describe("每档案索引", () => {
  it("中文正文可以被中文查询命中", () => {
    store = MemoryIndexStore.open({ path: indexPath(), agentId: "xiaobei" });
    store.upsert({
      entryId: "20260922-0001",
      kind: "entry",
      date: "2026-09-22",
      revision: 1,
      relativePath: "memory/2026-09-22/20260922-0001.md",
      body: "小贝的第一条守则：先看清再动手。",
    });

    const hits = store.search("守则", 5);
    expect(hits.length).toBe(1);
    expect(hits[0]!.entryId).toBe("20260922-0001");
    expect(hits[0]!.snippet).toContain("先看清再动手");
    expect(hits[0]!.score).toBeGreaterThan(0);

    // 单字查询走双字落空后的单字口径，仍然命中。
    expect(store.search("则", 5).length).toBe(1);
  });

  it("拉丁整词与中文混排都能命中", () => {
    store = MemoryIndexStore.open({ path: indexPath(), agentId: "xiaobei" });
    store.upsert({
      entryId: "20260922-0002",
      kind: "entry",
      date: "2026-09-22",
      revision: 1,
      relativePath: "memory/2026-09-22/20260922-0002.md",
      body: "今天和小马把 void-memory 的索引拆开了。",
    });
    expect(store.search("小马", 5).length).toBe(1);
    expect(store.search("void", 5).length).toBe(1);
    expect(store.search("memory", 5).length).toBe(1);
  });

  it("查不到就是空结果，不带 token 的查询也不报错", () => {
    store = MemoryIndexStore.open({ path: indexPath(), agentId: "xiaobei" });
    store.upsert({
      entryId: "20260922-0002",
      kind: "entry",
      date: "2026-09-22",
      revision: 1,
      relativePath: "memory/2026-09-22/20260922-0002.md",
      body: "今天认识了小马。",
    });
    expect(store.search("完全不存在的词组", 5)).toEqual([]);
    expect(store.search("!!!", 5)).toEqual([]);
    expect(store.search("", 5)).toEqual([]);
  });

  it("写入推进代际，删除后不再命中", () => {
    store = MemoryIndexStore.open({ path: indexPath(), agentId: "xiaobei" });
    const before = store.generation;
    store.upsert({
      entryId: "20260922-0001",
      kind: "entry",
      date: "2026-09-22",
      revision: 1,
      relativePath: "memory/2026-09-22/20260922-0001.md",
      body: "撤回前的正文。",
    });
    expect(store.generation).toBe(before + 1);
    expect(store.size()).toBe(1);

    store.remove("20260922-0001");
    expect(store.size()).toBe(0);
    expect(store.search("撤回前", 5)).toEqual([]);
  });

  it("列表只给元信息，按日期与 id 倒序", () => {
    store = MemoryIndexStore.open({ path: indexPath(), agentId: "xiaobei" });
    for (const [entryId, date] of [
      ["20260921-0001", "2026-09-21"],
      ["20260922-0001", "2026-09-22"],
    ] as const) {
      store.upsert({
        entryId,
        kind: "entry",
        date,
        revision: 1,
        relativePath: `memory/${date}/${entryId}.md`,
        body: `内容 ${entryId}`,
      });
    }
    const rows = store.list(10, 0);
    expect(rows.map((row) => row.entryId)).toEqual(["20260922-0001", "20260921-0001"]);
    expect(Object.keys(rows[0]!)).not.toContain("body");
  });

  it("持久索引必须有真实路径", () => {
    expect(() => MemoryIndexStore.open({ path: ":memory:", agentId: "xiaobei" })).toThrow(MemoryIndexError);
    expect(() => MemoryIndexStore.open({ path: "  ", agentId: "xiaobei" })).toThrow(MemoryIndexError);
  });

  it("索引损坏时明确报错，不静默返回空结果", async () => {
    await writeFile(indexPath("broken.sqlite"), "这不是一个 sqlite 文件".repeat(64));
    expect(() => MemoryIndexStore.open({ path: indexPath("broken.sqlite"), agentId: "xiaobei" })).toThrow(MemoryIndexCorruptError);
  });

  it("归属不符时拒绝打开", () => {
    store = MemoryIndexStore.open({ path: indexPath(), agentId: "xiaobei" });
    store.close();
    expect(() => MemoryIndexStore.open({ path: indexPath(), agentId: "xiaoma" })).toThrow(/记忆索引归属不符/);
  });

  it("索引写不进去时留 dirty 代际", () => {
    store = MemoryIndexStore.open({ path: indexPath(), agentId: "xiaobei" });
    expect(store.dirty).toBe(false);
    store.markDirty("disk full");
    expect(store.dirty).toBe(true);
    expect(store.dirtyReason).toBe("disk full");
  });
});
