import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LegionRunInactiveError, RunCoordinator } from "../src/run-coordinator.js";
import {
  RunStore,
  createRunRecord,
  type RunRecord,
} from "../src/run-store.js";
import type { TaskPlan } from "../src/planner.js";
import type { ScheduleWorker } from "../src/scheduler.js";
import type { DelegationTeamMember, DelegationTeamMetadata } from "../src/team.js";

const roots: string[] = [];
/** 每个测试用过的 worker 与派出去的 run，收尾时统一放行、等落定，别把在跑的 run 漏到下一个测试。 */
const workers: Array<{ releaseAll(): void }> = [];
const dispatched: Array<{ runs: RunCoordinator; runId: string }> = [];

afterEach(async () => {
  for (const worker of workers) worker.releaseAll();
  for (const entry of dispatched) {
    // 依赖链是一拍一拍放行的：放一轮醒一个，所以循环到没有在跑的为止。
    for (let tick = 0; tick < 20 && entry.runs.activeRunIds().includes(entry.runId); tick += 1) {
      for (const worker of workers) worker.releaseAll();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await entry.runs.waitFor(entry.runId).catch(() => undefined);
  }
  workers.length = 0;
  dispatched.length = 0;
  while (roots.length > 0) {
    const root = roots.pop()!;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

/** 派活并把这次 run 登记进收尾清单。 */
async function dispatchTracked(
  runs: RunCoordinator,
  request: Parameters<RunCoordinator["dispatch"]>[0],
): Promise<RunRecord> {
  const record = await runs.dispatch(request);
  dispatched.push({ runs, runId: record.runId });
  return record;
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "void-run-coordinator-"));
  roots.push(root);
  return root;
}

const TEAM: DelegationTeamMetadata = {
  id: "legion-demo",
  mode: "plan_execute_verify",
  sharedGoal: "prove the coordinator seam",
  memberRoster: [
    { laneId: "lane_plan", role: "researcher", authorityRelationToManager: "peer" },
    { laneId: "lane_code", role: "coder", authorityRelationToManager: "subordinate", dependsOn: ["lane_plan"] },
    { laneId: "lane_verify", role: "verifier", authorityRelationToManager: "peer", dependsOn: ["lane_code"] },
  ],
};

/** 一个能被测试逐拍放行的 worker。 */
function controllableWorker() {
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const worker: ScheduleWorker = async ({ laneId }) => {
    started.push(laneId);
    await new Promise<void>((resolve) => {
      releases.set(laneId, resolve);
    });
    return { laneId, ok: true };
  };
  const control = {
    worker,
    started,
    release(laneId: string) {
      releases.get(laneId)?.();
    },
    releaseAll() {
      for (const resolve of releases.values()) resolve();
    },
  };
  workers.push(control);
  return control;
}

/**
 * 逐拍放行直到落定。
 *
 * 依赖链上的任务要等上游跑完才会开始，所以「一次性放行」只醒得了第一拍；
 * 想跑完整条链就得放一轮、等一拍、再放一轮。
 */
async function settle(runs: RunCoordinator, runId: string, control: { releaseAll(): void }): Promise<RunRecord> {
  for (let tick = 0; tick < 50 && runs.activeRunIds().includes(runId); tick += 1) {
    control.releaseAll();
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return runs.waitFor(runId);
}

/** 立刻完成的 worker。 */
function instantWorker(outputs: Record<string, unknown> = {}): ScheduleWorker {
  return async ({ laneId }) => outputs[laneId] ?? { laneId };
}

describe("RunCoordinator 派活", () => {
  it("派活立刻返回 runId，执行在后台继续", async () => {
    const control = controllableWorker();
    const runs = new RunCoordinator({});
    const record = await dispatchTracked(runs, { teamId: "legion-demo", team: TEAM, worker: control.worker });

    expect(record.runId).toMatch(/^legion-demo-\d{14}-\d{2}$/);
    expect(record.status).toBe("running");
    expect(runs.activeRunIds()).toEqual([record.runId]);

    const progress = await runs.progress(record.runId);
    expect(progress.status).toBe("running");
    expect(progress.summary.total).toBe(3);
    expect(progress.conclusion).toContain("还在跑");
    // 不编百分比：只报已结算/总数与在跑/还没轮到。
    expect(progress.conclusion).not.toMatch(/%/);

    const settled = await settle(runs, record.runId, control);
    expect(settled.status).toBe("completed");
    expect(runs.activeRunIds()).toEqual([]);
  });

  it("没有数据根时如实报告「不落盘」，不假装存下来了", async () => {
    const runs = new RunCoordinator({});
    expect(runs.persistent).toBe(false);
    expect(runs.runStore).toBeUndefined();

    const record = await dispatchTracked(runs, { teamId: "legion-demo", team: TEAM, worker: instantWorker() });
    await runs.waitFor(record.runId);

    // 内存里查得到。
    expect((await runs.require(record.runId)).status).toBe("completed");
    expect(await runs.list()).toHaveLength(1);
    // 没有记录留下来，所以重启结算返回空——不是「结算过了」。
    expect(await runs.settleInterrupted()).toEqual([]);
  });

  it("有数据根时每次落定都落盘，重启能结算", async () => {
    const root = await makeRoot();
    const store = new RunStore({ dataDir: root });
    const runs = new RunCoordinator({ store });
    expect(runs.persistent).toBe(true);

    const control = controllableWorker();
    const record = await dispatchTracked(runs, { teamId: "legion-demo", team: TEAM, worker: control.worker });
    control.release("lane_plan");
    // 派发出去那一刻磁盘上就有记录（不然重启后什么都看不到）。
    expect((await store.require(record.runId)).status).toBe("running");
    // 这一跑故意留着不跑完（收尾时统一放行），好让下面这次「重启」有东西可结算。

    // 模拟宿主重启：新开一个 coordinator 读同一份磁盘。
    const restarted = new RunCoordinator({ store: new RunStore({ dataDir: root }) });
    expect(restarted.activeRunIds()).toEqual([]);
    const settled = await restarted.settleInterrupted();
    expect(settled.map((item) => item.runId)).toEqual([record.runId]);
    expect(settled[0]!.status).toBe("interrupted");
    expect((await restarted.require(record.runId)).status).toBe("interrupted");
    // 结算不动已经终态的。
    expect(await restarted.settleInterrupted()).toEqual([]);
  });

  it("同队多 run 不覆盖，listByTeam 最新在前", async () => {
    const root = await makeRoot();
    const runs = new RunCoordinator({ store: new RunStore({ dataDir: root }) });
    // 固定同一个时刻，逼出「同一秒内两次派活」这条路径。
    const fixed = new Date("2026-09-22T08:00:00.000Z");
    const sameSecond = new RunCoordinator({
      store: new RunStore({ dataDir: root }),
      now: () => fixed,
    });

    const first = await sameSecond.dispatch({ teamId: "legion-demo", team: TEAM, worker: instantWorker() });
    const second = await sameSecond.dispatch({ teamId: "legion-demo", team: TEAM, worker: instantWorker() });
    await sameSecond.waitFor(first.runId);
    await sameSecond.waitFor(second.runId);

    expect(first.runId).not.toBe(second.runId);
    expect(first.runId.endsWith("-01")).toBe(true);
    expect(second.runId.endsWith("-02")).toBe(true);

    const listed = await sameSecond.listByTeam("legion-demo");
    expect(listed.map((item) => item.runId)).toEqual([second.runId, first.runId]);
    // 两条都在磁盘上，谁也没盖掉谁。
    const onDisk = await runs.list();
    expect(onDisk.map((item) => item.runId).sort()).toEqual([first.runId, second.runId].sort());
  });

  it("权限门禁在派出任何任务之前跑，拒绝就一个都不派、也不留运行记录", async () => {
    const control = controllableWorker();
    const runs = new RunCoordinator({});

    await expect(
      runs.dispatch({
        teamId: "legion-demo",
        team: TEAM,
        worker: control.worker,
        authorize: () => {
          throw new Error("队伍没有授权 xiaoma 指挥 xiaobei");
        },
      }),
    ).rejects.toThrow("队伍没有授权 xiaoma 指挥 xiaobei");

    expect(control.started).toEqual([]);
    expect(await runs.list()).toEqual([]);
  });

  it("手动计划先过计划校验，坏计划不留运行记录", async () => {
    const runs = new RunCoordinator({});
    const cyclic: TaskPlan = {
      goal: "成环",
      tasks: [
        { laneId: "lane_a", title: "a", dependsOn: ["lane_b"] },
        { laneId: "lane_b", title: "b", dependsOn: ["lane_a"] },
      ],
    };

    await expect(
      runs.dispatch({ teamId: "legion-demo", team: TEAM, plan: cyclic, worker: instantWorker() }),
    ).rejects.toThrow(/成环/);
    expect(await runs.list()).toEqual([]);
  });

  it("运行配置在启动那一刻冻结：之后改队伍不影响这一跑", async () => {
    const control = controllableWorker();
    const runs = new RunCoordinator({});
    const mutable: DelegationTeamMetadata = { ...TEAM, memberRoster: [...TEAM.memberRoster] };
    const record = await dispatchTracked(runs, { teamId: "legion-demo", team: mutable, worker: control.worker });

    mutable.memberRoster.push({ laneId: "lane_extra", role: "default", authorityRelationToManager: "peer" });

    expect(record.frozenRoster.map((member) => member.laneId)).toEqual(["lane_plan", "lane_code", "lane_verify"]);
    const settled = await settle(runs, record.runId, control);
    expect(settled.frozenRoster.map((member) => member.laneId)).toEqual(["lane_plan", "lane_code", "lane_verify"]);
    expect(settled.tasks).toHaveLength(3);
  });

  it("临时成员只进这一次的名单，固定名单一个字不动", async () => {
    const temporary: DelegationTeamMember[] = [
      { laneId: "lane_temp", role: "default", authorityRelationToManager: "peer", dependsOn: ["lane_plan"] },
    ];
    const runs = new RunCoordinator({});
    const record = await dispatchTracked(runs, {
      teamId: "legion-demo",
      team: TEAM,
      temporaryMembers: temporary,
      worker: instantWorker(),
    });

    expect(record.frozenRoster.map((member) => member.laneId)).toEqual([
      "lane_plan",
      "lane_code",
      "lane_verify",
      "lane_temp",
    ]);
    expect(TEAM.memberRoster.map((member) => member.laneId)).toEqual(["lane_plan", "lane_code", "lane_verify"]);
  });
});

describe("RunCoordinator 取消", () => {
  it("全队取消：没轮到的直接不派", async () => {
    const control = controllableWorker();
    const runs = new RunCoordinator({});
    const record = await dispatchTracked(runs, { teamId: "legion-demo", team: TEAM, worker: control.worker });

    await runs.cancelRun(record.runId, "用户叫停");
    const settled = await settle(runs, record.runId, control);

    expect(settled.status).toBe("cancelled");
    expect(settled.tasks.filter((task) => task.status === "cancelled").length).toBeGreaterThan(0);
    // lane_code / lane_verify 从没被派出去过。
    expect(control.started).not.toContain("lane_code");
    expect(control.started).not.toContain("lane_verify");
  });

  it("单人取消：只停那一个，别的照跑", async () => {
    const control = controllableWorker();
    const runs = new RunCoordinator({});
    const record = await dispatchTracked(runs, { teamId: "legion-demo", team: TEAM, worker: control.worker });

    await runs.cancelLane(record.runId, "lane_plan", "这个成员不用了");
    const settled = await settle(runs, record.runId, control);

    const plan = settled.tasks.find((task) => task.laneId === "lane_plan")!;
    expect(plan.status).toBe("cancelled");
    expect(settled.events.some((event) => event.kind === "task_cancelled" && event.laneId === "lane_plan")).toBe(true);
  });

  it("取消不在本进程里跑的 run 会如实报错，不假装停下来了", async () => {
    const root = await makeRoot();
    const runs = new RunCoordinator({ store: new RunStore({ dataDir: root }) });
    await expect(runs.cancelRun("legion-demo-20260922080000-01")).rejects.toBeInstanceOf(LegionRunInactiveError);
    await expect(runs.cancelRun("legion-demo-20260922080000-01")).rejects.toThrow(
      /这次运行不在本进程里跑（宿主重启过，或已经结束），无法取消: legion-demo-20260922080000-01/,
    );
  });
});

describe("RunCoordinator 查询", () => {
  it("查不到的运行 id 如实报不存在", async () => {
    const runs = new RunCoordinator({});
    await expect(runs.require("legion-demo-20260922080000-01")).rejects.toThrow(
      "运行记录不存在: legion-demo-20260922080000-01",
    );
  });

  it("进度里带原生子会话 id 与逐任务状态", async () => {
    const runs = new RunCoordinator({});
    const worker: ScheduleWorker = async ({ laneId }) => ({ laneId });
    const record = await dispatchTracked(runs, { teamId: "legion-demo", team: TEAM, worker });
    await runs.waitFor(record.runId);

    const progress = await runs.progress(record.runId);
    expect(progress.runId).toBe(record.runId);
    expect(progress.teamId).toBe("legion-demo");
    expect(progress.summary.completed).toBe(3);
    expect(progress.conclusion).toBe("全部干完：3/3");
    expect(progress.events.some((event) => event.kind === "run_finished")).toBe(true);
    expect(progress.lastActivityAt).toBe((await runs.require(record.runId)).updatedAt);
  });

  it("失败阻塞在进度里说得清楚，且不自动返工", async () => {
    const runs = new RunCoordinator({});
    const worker: ScheduleWorker = async ({ laneId }) => {
      if (laneId === "lane_plan") throw new Error("plan boom");
      return { laneId };
    };
    const record = await dispatchTracked(runs, { teamId: "legion-demo", team: TEAM, worker });
    const settled = await runs.waitFor(record.runId);

    expect(settled.status).toBe("failed");
    const code = settled.tasks.find((task) => task.laneId === "lane_code")!;
    expect(code.status).toBe("blocked");
    expect(code.blockedBy).toBe("lane_plan");
    expect(code.attempts).toBe(1);

    const progress = await runs.progress(record.runId);
    expect(progress.conclusion).toContain("被阻塞 2");
    expect(progress.pending.map((item) => item.laneId)).toContain("lane_code");
  });

  it("并发上限只影响之后取槽位的任务，不强杀在跑的", async () => {
    const control = controllableWorker();
    const runs = new RunCoordinator({});
    const record = await dispatchTracked(runs, {
      teamId: "legion-demo",
      team: { ...TEAM, schedule: "parallel" },
      maxConcurrentTasks: 1,
      worker: control.worker,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    // 上限 1：只有 lane_plan 拿到槽位。
    expect(control.started).toEqual(["lane_plan"]);

    runs.setCapacity(3);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 放宽之后没跑过的才开始，已经在跑的那个没被动过。
    expect(control.started[0]).toBe("lane_plan");

    const settled = await settle(runs, record.runId, control);
    expect(settled.maxConcurrentTasks).toBe(1);
  });
});

describe("RunCoordinator 合并磁盘与内存", () => {
  it("list 按发生顺序合并，磁盘上已终态的不被内存里的旧副本盖掉", async () => {
    const root = await makeRoot();
    const store = new RunStore({ dataDir: root });
    // 先造一条「上一轮留下的」终态记录。
    const at = new Date("2026-09-22T07:00:00.000Z");
    const older = createRunRecord({
      runId: "legion-demo-20260922070000-01",
      teamId: "legion-demo",
      schedule: "parallel",
      roster: TEAM.memberRoster,
      memberLimit: 8,
      at,
    });
    const finished: RunRecord = { ...older, status: "completed", endedAt: at.toISOString() };
    await store.save(finished);

    const runs = new RunCoordinator({ store, now: () => new Date("2026-09-22T08:00:00.000Z") });
    const fresh = await dispatchTracked(runs, { teamId: "legion-demo", team: TEAM, worker: instantWorker() });
    await runs.waitFor(fresh.runId);

    const listed = await runs.list();
    expect(listed.map((item) => item.runId)).toEqual([finished.runId, fresh.runId]);
    expect(listed[0]!.status).toBe("completed");
  });
});
