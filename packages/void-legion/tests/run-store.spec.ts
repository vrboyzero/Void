import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DelegationTeamMember } from "../src/team.js";
import {
  createRunRecord,
  LegionRunError,
  LegionRunNotFoundError,
  LegionRunSchemaError,
  MAX_RUN_OUTPUT_BYTES,
  nextRunId,
  normalizeRunOutput,
  parseRunRecord,
  RUN_SCHEMA_VERSION,
  RunStore,
  serializeRunRecord,
  summarizeRun,
  type RunRecord,
} from "../src/run-store.js";

const directories: string[] = [];

async function makeStore(now?: () => Date): Promise<{ store: RunStore; dataDir: string }> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "void-run-"));
  directories.push(dataDir);
  return { store: new RunStore({ dataDir, ...(now === undefined ? {} : { now }) }), dataDir };
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function member(laneId: string, extra: Partial<DelegationTeamMember> = {}): DelegationTeamMember {
  return { laneId, ...extra };
}

function record(roster: DelegationTeamMember[], overrides: Partial<RunRecord> = {}): RunRecord {
  const created = createRunRecord({
    runId: "legion-demo-20260922120000-01",
    teamId: "legion-demo",
    schedule: "parallel",
    roster,
    memberLimit: 8,
    at: new Date("2026-09-22T12:00:00Z"),
  });
  return Object.assign(created, overrides);
}

describe("run id", () => {
  it("按队伍 + 时间戳 + 序号生成，同秒两次派活不撞", () => {
    const at = new Date("2026-09-22T12:00:00Z");
    expect(nextRunId("legion-demo", at, 1)).toBe("legion-demo-20260922120000-01");
    expect(nextRunId("legion-demo", at, 2)).toBe("legion-demo-20260922120000-02");
    expect(nextRunId("legion-demo", at, 1)).not.toBe(nextRunId("legion-demo", at, 2));
  });

  it("拒绝带路径分隔符或大写的 id", () => {
    expect(() => createRunRecord({
      runId: "../escape",
      teamId: "legion-demo",
      schedule: "parallel",
      roster: [],
      memberLimit: 8,
      at: new Date(),
    })).toThrow(LegionRunError);
    expect(() => createRunRecord({
      runId: "BadCase",
      teamId: "legion-demo",
      schedule: "parallel",
      roster: [],
      memberLimit: 8,
      at: new Date(),
    })).toThrow(/运行 id 不合法/);
  });
});

describe("运行记录落盘", () => {
  it("建 run 时逐任务记下 laneId / agentId / stage / 模型路由 / 依赖", () => {
    const created = record([
      member("lane_plan", { agentId: "xiaobei", stage: 1, modelRef: "fast" }),
      member("lane_code", { agentId: "xiaoma", stage: 2, dependsOn: ["lane_plan"], modelRef: "strong" }),
    ]);
    expect(created.schemaVersion).toBe(RUN_SCHEMA_VERSION);
    expect(created.status).toBe("running");
    expect(created.tasks.map((task) => task.laneId)).toEqual(["lane_plan", "lane_code"]);
    expect(created.tasks[0]).toMatchObject({ agentId: "xiaobei", stage: 1, modelRef: "fast", status: "pending", attempts: 1 });
    expect(created.tasks[1]!.dependsOn).toEqual(["lane_plan"]);
    expect(created.frozenRoster).toHaveLength(2);
  });

  it("冻结的名单是快照：之后改队伍配置不影响这次 run", () => {
    const roster = [member("lane_a", { agentId: "xiaobei" })];
    const created = record(roster);
    roster[0]!.agentId = "xiaoma";
    roster.push(member("lane_b"));
    expect(created.frozenRoster.map((item) => item.agentId)).toEqual(["xiaobei"]);
    expect(created.frozenRoster).toHaveLength(1);
  });

  it("save / load 往返一致，同队两次派活各自留档不覆盖", async () => {
    const { store } = await makeStore();
    await store.save(record([member("lane_a")], { runId: "legion-demo-20260922120000-01" }));
    await store.save(record([member("lane_a"), member("lane_b")], { runId: "legion-demo-20260922120000-02" }));
    expect(await store.load("legion-demo-20260922120000-01")).toMatchObject({ tasks: [{ laneId: "lane_a" }] });
    expect((await store.load("legion-demo-20260922120000-02"))!.tasks).toHaveLength(2);
    expect((await store.listByTeam("legion-demo")).map((item) => item.runId)).toEqual([
      "legion-demo-20260922120000-02",
      "legion-demo-20260922120000-01",
    ]);
  });

  it("落盘目录是 <数据根>/legion/runs，与队伍配置并列", async () => {
    const { store, dataDir } = await makeStore();
    expect(store.root).toBe(path.join(dataDir, "legion", "runs"));
    await store.save(record([member("lane_a")]));
    const text = await readFile(path.join(dataDir, "legion", "runs", "legion-demo-20260922120000-01.json"), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text).schemaVersion).toBe(RUN_SCHEMA_VERSION);
  });

  it("读不到的 run 报不存在，而不是给个空壳", async () => {
    const { store } = await makeStore();
    expect(await store.load("legion-demo-20260922120000-09")).toBeUndefined();
    await expect(store.require("legion-demo-20260922120000-09")).rejects.toBeInstanceOf(LegionRunNotFoundError);
  });
});

describe("版本与损坏", () => {
  it("版本不认识就明确报错，不兼容解析", () => {
    const text = JSON.stringify({ schemaVersion: 99, runId: "legion-demo-20260922120000-01", teamId: "legion-demo", status: "running", tasks: [] });
    expect(() => parseRunRecord(text, "x.json")).toThrow(/不支持的运行记录版本: 99（本版本只认 1）/);
  });

  it("结构缺件 / 状态不认识都报路径", () => {
    expect(() => parseRunRecord("{", "runs/a.json")).toThrow(/运行记录损坏: runs\/a.json/);
    expect(() => parseRunRecord(JSON.stringify({ schemaVersion: 1, runId: "r", teamId: "t", status: "running" }), "runs/a.json")).toThrow(/缺少 tasks/);
    expect(() => parseRunRecord(
      JSON.stringify({ schemaVersion: 1, runId: "r", teamId: "t", status: "正在跑", tasks: [] }),
      "runs/a.json",
    )).toThrow(/运行状态不认识/);
    expect(() => parseRunRecord(
      JSON.stringify({ schemaVersion: 1, runId: "r", teamId: "t", status: "running", tasks: [{ laneId: "lane_a", status: "做梦" }] }),
      "runs/a.json",
    )).toThrow(/任务 lane_a 的状态不认识: 做梦/);
  });

  it("list 跳过非 json 文件", async () => {
    const { store } = await makeStore();
    await store.save(record([member("lane_a")]));
    await writeFile(path.join(store.root, "README.txt"), "不是运行记录", "utf8");
    expect(await store.list()).toHaveLength(1);
  });

  // 宿主在产出落盘那一刻被硬杀，可能留下半截临时文件（`atomic-file.ts` 的
  // `.<目标名>.<进程号>.<序号>.tmp`）。它**绝不能**被人当成一次运行读进来：把「跑到哪了」
  // 判断错，比丢一条记录更坏。内容故意写成一份合法的运行记录——名字不对就不该被认。
  it("list 不把落盘中途留下的临时文件当成一次运行", async () => {
    const { store } = await makeStore();
    const created = record([member("lane_a")]);
    await store.save(created);
    const text = serializeRunRecord(created);
    await writeFile(path.join(store.root, `.${created.runId}.json.4512.7.tmp`), text, "utf8");
    await writeFile(path.join(store.root, `${created.runId}.json.4512.7.tmp`), text, "utf8");

    expect((await store.list()).map((item) => item.runId)).toEqual([created.runId]);
    expect(await store.listByTeam("legion-demo")).toHaveLength(1);
    // 真正那份记录没被动过：临时文件里的同名内容不会被拿来顶替它。
    expect((await store.require(created.runId)).runId).toBe(created.runId);
  });
});

describe("重启结算", () => {
  it("把 running 的 run 和未结束任务标成 interrupted，不自动重跑", async () => {
    const { store } = await makeStore(() => new Date("2026-09-22T13:00:00Z"));
    const created = record([member("lane_a"), member("lane_b")]);
    created.tasks[0]!.status = "completed";
    created.tasks[0]!.output = { done: true };
    created.tasks[1]!.status = "running";
    await store.save(created);

    const settled = await store.settleInterrupted();
    expect(settled).toHaveLength(1);
    expect(settled[0]!.status).toBe("interrupted");
    expect(settled[0]!.endedAt).toBe("2026-09-22T13:00:00.000Z");
    expect(settled[0]!.tasks[0]!.status).toBe("completed");
    expect(settled[0]!.tasks[0]!.output).toEqual({ done: true });
    expect(settled[0]!.tasks[1]!.status).toBe("interrupted");
    expect(settled[0]!.tasks[1]!.error).toMatch(/宿主重启/);
    expect(settled[0]!.events.at(-1)!.kind).toBe("run_settled");

    // 再结算一次不重复记账，也不会把已结束的 run 改回去。
    expect(await store.settleInterrupted()).toEqual([]);
    const reloaded = await store.require(created.runId);
    expect(reloaded.events.filter((event) => event.kind === "run_settled")).toHaveLength(1);
  });

  it("已完成 / 已取消的 run 不动", async () => {
    const { store } = await makeStore();
    await store.save(record([member("lane_a")], { runId: "legion-demo-20260922120000-01", status: "completed" }));
    await store.save(record([member("lane_a")], { runId: "legion-demo-20260922120000-02", status: "cancelled" }));
    expect(await store.settleInterrupted()).toEqual([]);
  });
});

describe("产出与摘要", () => {
  it("产出原样留存，不丢不改写", () => {
    expect(normalizeRunOutput({ files: ["a.ts"], text: "改好了" })).toEqual({
      value: { files: ["a.ts"], text: "改好了" },
      truncated: false,
      bytes: expect.any(Number),
    });
    expect(normalizeRunOutput(undefined).value).toBeNull();
  });

  it("存不下时换成显式标记，不静默丢", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = normalizeRunOutput(circular);
    expect(result.truncated).toBe(true);
    expect(result.value).toMatchObject({ unserializable: true });

    const huge = { text: "x".repeat(MAX_RUN_OUTPUT_BYTES + 1) };
    const oversized = normalizeRunOutput(huge);
    expect(oversized.truncated).toBe(true);
    expect(oversized.bytes).toBeGreaterThan(MAX_RUN_OUTPUT_BYTES);
    expect(oversized.value).toMatchObject({ truncated: true });
  });

  it("摘要只数数字，不给假百分比", () => {
    const created = record([member("lane_a"), member("lane_b"), member("lane_c"), member("lane_d")]);
    created.tasks[0]!.status = "completed";
    created.tasks[1]!.status = "failed";
    created.tasks[2]!.status = "blocked";
    created.tasks[3]!.status = "running";
    expect(summarizeRun(created)).toEqual({
      runId: "legion-demo-20260922120000-01",
      teamId: "legion-demo",
      status: "running",
      schedule: "parallel",
      total: 4,
      completed: 1,
      failed: 1,
      blocked: 1,
      cancelled: 0,
      running: 1,
      pending: 0,
    });
  });

  it("序列化出来的就是 parse 能吃回去的", () => {
    const created = record([member("lane_a", { agentId: "xiaobei", modelRef: "fast" })]);
    expect(parseRunRecord(serializeRunRecord(created), "x")).toMatchObject({ runId: created.runId, tasks: [{ modelRef: "fast" }] });
  });
});
