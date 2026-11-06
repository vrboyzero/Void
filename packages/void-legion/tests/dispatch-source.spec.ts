import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DispatchSourceRepository,
  MAX_SOURCE_ENTRIES,
  dispatchSourceSnapshotOf,
  emptyDispatchSourceSnapshot,
  parseDispatchSourceDocument,
  serializeDispatchSourceDocument,
  sourceStateReason,
  taskPreviewOf,
  type DispatchSourceDocument,
} from "../src/dispatch-source.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "void-legion-source-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

const NOW = new Date("2026-11-06T10:00:00.000Z");

function document(overrides: Partial<DispatchSourceDocument> = {}): DispatchSourceDocument {
  return {
    schemaVersion: 1,
    revision: 2,
    updatedAt: NOW.toISOString(),
    updatedBy: "owner",
    enabled: true,
    mode: "observe",
    counts: { "2026-11-06": { observed: 1, dispatched: 2, filtered: 3 } },
    entries: [
      { at: NOW.toISOString(), outcome: "observed", teamId: "demo", actorId: "xiaobei", lanes: ["lane_a"] },
    ],
    ...overrides,
  };
}

describe("派活来源的落盘格式", () => {
  it("序列化再解析原样回来", () => {
    const source = document();
    expect(parseDispatchSourceDocument(serializeDispatchSourceDocument(source))).toEqual(source);
  });

  it("版本、mode、outcome、计数与账本形状都严格校验", () => {
    const parse = (value: unknown) => parseDispatchSourceDocument(JSON.stringify(value));
    expect(() => parse({ ...document(), schemaVersion: 2 })).toThrow(/不支持的派活来源版本/);
    expect(() => parse({ ...document(), mode: "paused" })).toThrow(/mode 不认识/);
    expect(() => parse({ ...document(), enabled: "yes" })).toThrow(/必须是布尔值/);
    expect(() => parse({ ...document(), entries: [{ at: NOW.toISOString(), outcome: "deleted" }] }))
      .toThrow(/outcome 不认识/);
    expect(() => parse({ ...document(), counts: { "2026-11-06": { observed: -1, dispatched: 0, filtered: 0 } } }))
      .toThrow(/非负整数/);
    expect(() => parse({ ...document(), counts: { "not-a-day": { observed: 0, dispatched: 0, filtered: 0 } } }))
      .toThrow(/日期不合法/);
  });
});

describe("来源状态机", () => {
  it("没配置 = 默认 live（沿用既有行为），不是偷偷 observe", () => {
    const snapshot = emptyDispatchSourceSnapshot(NOW);
    expect(snapshot).toMatchObject({ configured: false, state: "ready", mode: "live", enabled: true });
  });

  it("off / observe / live 三档与状态文案一一对应", () => {
    expect(dispatchSourceSnapshotOf(document({ enabled: false }), NOW).state).toBe("off");
    expect(dispatchSourceSnapshotOf(document({ mode: "observe" }), NOW).state).toBe("paused");
    expect(dispatchSourceSnapshotOf(document({ mode: "live" }), NOW).state).toBe("ready");
    for (const state of ["missing", "off", "error", "setup", "starting", "paused", "ready"] as const) {
      expect(sourceStateReason(state)).not.toBe("");
    }
  });
});

describe("来源仓库", () => {
  it("首次 setMode 创建文件；observe 是显式动作，revision 只随配置变", async () => {
    const root = await tempRoot();
    const repo = new DispatchSourceRepository({ dataDir: root, now: () => NOW });
    await expect(repo.snapshot()).resolves.toMatchObject({ configured: false, state: "ready" });

    const observing = await repo.setMode({ mode: "observe", expectedRevision: 0 });
    expect(observing).toMatchObject({ configured: true, revision: 1, mode: "observe", state: "paused" });
    const record = await repo.record({ outcome: "observed", teamId: "demo", lanes: ["lane_a"] });
    // 记账不动配置修订号：面板切模式不会因为账本写过一次就 409。
    expect(record.revision).toBe(1);
    expect(record.today).toEqual({ observed: 1, dispatched: 0, filtered: 0 });

    const live = await repo.setMode({ mode: "live", expectedRevision: 1 });
    expect(live).toMatchObject({ revision: 2, mode: "live", state: "ready" });
    await expect(repo.setMode({ mode: "observe", expectedRevision: 1 })).rejects.toThrow(/期望修订 1，实际 2/);
  });

  it("停用/启用与三种账本结果都落盘，重启后读得回", async () => {
    const root = await tempRoot();
    const repo = new DispatchSourceRepository({ dataDir: root, now: () => NOW });
    await repo.setMode({ mode: "live", expectedRevision: 0 });
    await repo.record({ outcome: "dispatched", teamId: "demo", runId: "demo-1" });
    await repo.record({ outcome: "filtered", teamId: "demo", reason: "派活名单里没有 dagon" });
    await repo.record({ outcome: "observed", teamId: "demo", lanes: ["lane_a", "lane_b"] });
    const off = await repo.setEnabled({ enabled: false, expectedRevision: 1 });
    expect(off).toMatchObject({ enabled: false, state: "off", revision: 2 });
    expect(off.today).toEqual({ observed: 1, dispatched: 1, filtered: 1 });

    const restarted = new DispatchSourceRepository({ dataDir: root, now: () => NOW });
    const snapshot = await restarted.snapshot();
    expect(snapshot).toMatchObject({ configured: true, enabled: false, state: "off", revision: 2 });
    expect(snapshot.entries.map((entry) => entry.outcome)).toEqual(["dispatched", "filtered", "observed"]);
  });

  it("损坏的文件：面板视图给 state:error，严格读取拒绝", async () => {
    const root = await tempRoot();
    const file = path.join(root, "legion", "dispatch-source.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{ 坏掉的 JSON", "utf8");
    const repo = new DispatchSourceRepository({ dataDir: root, now: () => NOW });
    const view = await repo.trySnapshot();
    expect(view.state).toBe("error");
    expect(view.reason).toContain("派活来源损坏");
    await expect(repo.snapshot()).rejects.toThrow(/派活来源损坏/);
  });

  it("账本只留最近 MAX_SOURCE_ENTRIES 条，计数仍在", async () => {
    const root = await tempRoot();
    const repo = new DispatchSourceRepository({ dataDir: root, now: () => NOW });
    await repo.setMode({ mode: "live", expectedRevision: 0 });
    for (let index = 0; index < MAX_SOURCE_ENTRIES + 5; index += 1) {
      await repo.record({ outcome: "filtered", teamId: "demo", reason: `r${index}` });
    }
    const snapshot = await repo.snapshot();
    expect(snapshot.entries).toHaveLength(MAX_SOURCE_ENTRIES);
    expect(snapshot.entries[0]!.reason).toBe("r5");
    expect(snapshot.today.filtered).toBe(MAX_SOURCE_ENTRIES + 5);
  });
});

describe("任务预览", () => {
  it("只留前 160 字，空任务不写预览", () => {
    expect(taskPreviewOf("  ")).toBeUndefined();
    expect(taskPreviewOf("x".repeat(200))).toHaveLength(161);
    expect(taskPreviewOf("x".repeat(200))!.endsWith("…")).toBe(true);
  });
});
