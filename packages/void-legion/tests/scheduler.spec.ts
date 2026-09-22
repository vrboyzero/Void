import { afterEach, describe, expect, it } from "vitest";
import { createRunRecord, type RunRecord, type RunTaskRecord } from "../src/run-store.js";
import {
  DispatchGate,
  ScheduleCancelledError,
  startSchedule,
  workspaceOf,
  writesWorkspace,
  type TaskRunContext,
} from "../src/scheduler.js";
import type { DelegationTeamMember, TeamSchedule } from "../src/team.js";

/** 一个能手动放行的 worker 调用。 */
interface Pending {
  context: TaskRunContext;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

function recorder(): {
  calls: TaskRunContext[];
  pending: Pending[];
  worker: (context: TaskRunContext) => Promise<unknown>;
  laneIds: () => string[];
} {
  const calls: TaskRunContext[] = [];
  const pending: Pending[] = [];
  return {
    calls,
    pending,
    laneIds: () => calls.map((call) => call.laneId),
    worker: (context) => {
      calls.push(context);
      return new Promise<unknown>((resolve, reject) => {
        pending.push({ context, resolve, reject });
      });
    },
  };
}

/** 让调度循环把该跑的微任务跑完。 */
async function flush(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function member(laneId: string, extra: Partial<DelegationTeamMember> = {}): DelegationTeamMember {
  return { laneId, writes: false, ...extra };
}

function makeRecord(
  roster: DelegationTeamMember[],
  schedule: TeamSchedule = "parallel",
  maxConcurrentTasks = 4,
): RunRecord {
  return createRunRecord({
    runId: "legion-demo-20260922120000-01",
    teamId: "legion-demo",
    schedule,
    roster,
    memberLimit: 8,
    maxConcurrentTasks,
    at: new Date("2026-09-22T12:00:00Z"),
  });
}

const gates: DispatchGate[] = [];
function makeGate(capacity = 4): DispatchGate {
  const gate = new DispatchGate({ maxConcurrentTasks: capacity });
  gates.push(gate);
  return gate;
}

afterEach(() => {
  gates.splice(0);
});

function statusOf(record: RunRecord, laneId: string): RunTaskRecord["status"] {
  const task = record.tasks.find((item) => item.laneId === laneId);
  if (task === undefined) throw new Error(`没有这个 lane: ${laneId}`);
  return task.status;
}

describe("工作区判定", () => {
  it("不声明 writes 就当写任务，声明 false 才是只读", () => {
    expect(writesWorkspace({ laneId: "lane_a" })).toBe(true);
    expect(writesWorkspace({ laneId: "lane_a", writes: false })).toBe(false);
  });

  it("工作区空着用默认键", () => {
    expect(workspaceOf({ laneId: "lane_a" })).toBe("default");
    expect(workspaceOf({ laneId: "lane_a", workspace: "  " })).toBe("default");
    expect(workspaceOf({ laneId: "lane_a", workspace: "wt-1" })).toBe("wt-1");
  });
});

describe("三种调度", () => {
  it("parallel：只读任务同时开跑", async () => {
    const { worker, laneIds, pending } = recorder();
    const record = makeRecord([member("lane_a"), member("lane_b"), member("lane_c")]);
    const handle = startSchedule({ record, worker, gate: makeGate(4) });
    await flush();
    expect(laneIds().sort()).toEqual(["lane_a", "lane_b", "lane_c"]);
    for (const item of pending) item.resolve(item.context.laneId);
    const finished = await handle.done;
    expect(finished.status).toBe("completed");
    expect(finished.tasks.every((task) => task.status === "completed")).toBe(true);
  });

  it("sequential：任何时刻只跑一个，按拓扑顺序", async () => {
    const { worker, laneIds, pending } = recorder();
    const record = makeRecord(
      [
        member("lane_b", { dependsOn: ["lane_a"] }),
        member("lane_a"),
        member("lane_c", { dependsOn: ["lane_b"] }),
      ],
      "sequential",
    );
    const handle = startSchedule({ record, worker, gate: makeGate(4) });
    await flush();
    expect(laneIds()).toEqual(["lane_a"]);
    pending[0]!.resolve("a");
    await flush();
    expect(laneIds()).toEqual(["lane_a", "lane_b"]);
    pending[1]!.resolve("b");
    await flush();
    expect(laneIds()).toEqual(["lane_a", "lane_b", "lane_c"]);
    pending[2]!.resolve("c");
    expect((await handle.done).status).toBe("completed");
  });

  it("staged：上一阶段全落定才开下一阶段", async () => {
    const { worker, laneIds, pending } = recorder();
    const record = makeRecord(
      [
        member("lane_plan", { stage: 1 }),
        member("lane_survey", { stage: 1 }),
        member("lane_code", { stage: 2 }),
      ],
      "staged",
    );
    const handle = startSchedule({ record, worker, gate: makeGate(4) });
    await flush();
    expect(laneIds().sort()).toEqual(["lane_plan", "lane_survey"]);
    pending[0]!.resolve("plan");
    await flush();
    // 阶段 1 还剩一个没落定，阶段 2 不能开始。
    expect(laneIds()).not.toContain("lane_code");
    pending[1]!.resolve("survey");
    await flush();
    expect(laneIds()).toContain("lane_code");
    pending[2]!.resolve("code");
    expect((await handle.done).status).toBe("completed");
  });

  it("staged：上一阶段有人没干成，后续阶段不派发", async () => {
    const { worker, laneIds, pending } = recorder();
    const record = makeRecord(
      [member("lane_plan", { stage: 1 }), member("lane_code", { stage: 2 })],
      "staged",
    );
    const handle = startSchedule({ record, worker, gate: makeGate(4) });
    await flush();
    pending[0]!.reject(new Error("规划失败"));
    const finished = await handle.done;
    expect(statusOf(finished, "lane_plan")).toBe("failed");
    expect(statusOf(finished, "lane_code")).toBe("blocked");
    expect(finished.tasks[1]!.blockedBy).toBe("lane_plan");
    expect(laneIds()).toEqual(["lane_plan"]);
    expect(finished.status).toBe("failed");
  });
});

describe("工作区写锁", () => {
  it("同一工作区的写任务串行", async () => {
    const { worker, laneIds, pending } = recorder();
    const record = makeRecord([{ laneId: "lane_a" }, { laneId: "lane_b" }]);
    const handle = startSchedule({ record, worker, gate: makeGate(4) });
    await flush();
    expect(laneIds()).toEqual(["lane_a"]);
    pending[0]!.resolve("a");
    await flush();
    expect(laneIds()).toEqual(["lane_a", "lane_b"]);
    pending[1]!.resolve("b");
    expect((await handle.done).status).toBe("completed");
  });

  it("显式分了不同工作区就并发", async () => {
    const { worker, laneIds, pending } = recorder();
    const record = makeRecord([
      { laneId: "lane_a", workspace: "wt-1" },
      { laneId: "lane_b", workspace: "wt-2" },
    ]);
    const handle = startSchedule({ record, worker, gate: makeGate(4) });
    await flush();
    expect(laneIds().sort()).toEqual(["lane_a", "lane_b"]);
    for (const item of pending) item.resolve(item.context.laneId);
    expect((await handle.done).status).toBe("completed");
  });

  it("只读任务不受写锁限制", async () => {
    const { worker, laneIds, pending } = recorder();
    const record = makeRecord([member("lane_a"), member("lane_b")]);
    const handle = startSchedule({ record, worker, gate: makeGate(4) });
    await flush();
    expect(laneIds().sort()).toEqual(["lane_a", "lane_b"]);
    for (const item of pending) item.resolve("ok");
    await handle.done;
  });
});

describe("并发上限", () => {
  it("本 run 的上限决定同时开几个", async () => {
    const { worker, laneIds, pending } = recorder();
    const record = makeRecord([member("lane_a"), member("lane_b"), member("lane_c")], "parallel", 2);
    const handle = startSchedule({ record, worker, gate: makeGate(8) });
    await flush();
    expect(laneIds()).toHaveLength(2);
    pending[0]!.resolve("a");
    await flush();
    expect(laneIds()).toHaveLength(3);
    pending[1]!.resolve("b");
    pending[2]!.resolve("c");
    await handle.done;
  });

  it("不同 run 共享闸门容量，不会各开一份", async () => {
    const gate = makeGate(1);
    const first = recorder();
    const second = recorder();
    const handleA = startSchedule({ record: makeRecord([member("lane_a")]), worker: first.worker, gate });
    const handleB = startSchedule({
      record: makeRecord([member("lane_b")]),
      worker: second.worker,
      gate,
    });
    await flush();
    expect(first.laneIds().length + second.laneIds().length).toBe(1);
    if (first.pending.length > 0) first.pending[0]!.resolve("a");
    else second.pending[0]!.resolve("b");
    await flush();
    expect(first.laneIds().length + second.laneIds().length).toBe(2);
    first.pending[0]?.resolve("a");
    second.pending[0]?.resolve("b");
    expect((await handleA.done).status).toBe("completed");
    expect((await handleB.done).status).toBe("completed");
  });

  it("降低上限不强杀在跑的成员", async () => {
    const gate = makeGate(2);
    const { worker, laneIds, pending } = recorder();
    const handle = startSchedule({ record: makeRecord([member("lane_a"), member("lane_b")]), worker, gate });
    await flush();
    expect(laneIds()).toHaveLength(2);
    gate.setCapacity(1);
    expect(gate.activeCount).toBe(2);
    for (const item of pending) item.resolve("ok");
    expect((await handle.done).status).toBe("completed");
  });
});

describe("失败与阻塞", () => {
  it("上游失败，下游记 blocked 并指明是谁拖的，独立的照跑", async () => {
    const { worker, laneIds, pending } = recorder();
    const record = makeRecord([
      member("lane_a"),
      member("lane_b", { dependsOn: ["lane_a"] }),
      member("lane_c", { dependsOn: ["lane_b"] }),
      member("lane_d"),
    ]);
    const handle = startSchedule({ record, worker, gate: makeGate(4) });
    await flush();
    const a = pending.find((item) => item.context.laneId === "lane_a")!;
    a.reject(new Error("跑挂了"));
    await flush();
    const d = pending.find((item) => item.context.laneId === "lane_d")!;
    d.resolve("d 干完了");
    const finished = await handle.done;
    expect(statusOf(finished, "lane_a")).toBe("failed");
    expect(statusOf(finished, "lane_b")).toBe("blocked");
    expect(statusOf(finished, "lane_c")).toBe("blocked");
    expect(statusOf(finished, "lane_d")).toBe("completed");
    expect(finished.tasks.find((task) => task.laneId === "lane_b")!.blockedBy).toBe("lane_a");
    expect(finished.tasks.find((task) => task.laneId === "lane_c")!.blockedBy).toBe("lane_b");
    expect(laneIds()).not.toContain("lane_b");
    expect(finished.status).toBe("failed");
  });

  it("失败不自动返工：每个任务只调一次 worker", async () => {
    const { worker, calls, pending } = recorder();
    const handle = startSchedule({ record: makeRecord([member("lane_a")]), worker, gate: makeGate(2) });
    await flush();
    pending[0]!.reject(new Error("挂"));
    const finished = await handle.done;
    expect(calls).toHaveLength(1);
    expect(finished.tasks[0]!.attempts).toBe(1);
    expect(finished.tasks[0]!.error).toBe("挂");
  });

  it("上游产出交给下游，不丢不改", async () => {
    const { worker, pending, calls } = recorder();
    const record = makeRecord([member("lane_a"), member("lane_b", { dependsOn: ["lane_a"] })], "sequential");
    const handle = startSchedule({ record, worker, gate: makeGate(2) });
    await flush();
    pending[0]!.resolve({ files: ["a.ts"] });
    await flush();
    expect(calls[1]!.upstream).toEqual({ lane_a: { files: ["a.ts"] } });
    pending[1]!.resolve("done");
    const finished = await handle.done;
    expect(finished.tasks[0]!.output).toEqual({ files: ["a.ts"] });
  });

  it("逐任务模型路由真的传到 worker 上", async () => {
    const { worker, calls, pending } = recorder();
    const record = makeRecord([
      member("lane_a", { modelRef: "fast" }),
      member("lane_b", { modelRef: "strong" }),
    ]);
    const handle = startSchedule({ record, worker, gate: makeGate(4) });
    await flush();
    expect(calls.map((call) => call.modelRef).sort()).toEqual(["fast", "strong"]);
    for (const item of pending) item.resolve("ok");
    const finished = await handle.done;
    expect(finished.tasks.map((task) => task.modelRef)).toEqual(["fast", "strong"]);
  });

  it("运行名单里没有的 lane 直接记失败，不静默跳过", async () => {
    const { worker } = recorder();
    const record = makeRecord([member("lane_a")]);
    record.frozenRoster = [];
    const handle = startSchedule({ record, worker, gate: makeGate(2) });
    const finished = await handle.done;
    expect(finished.tasks[0]!.status).toBe("failed");
    expect(finished.tasks[0]!.error).toBe("运行名单里没有 lane_a");
  });
});

describe("取消", () => {
  it("取消单个成员：还没派的不再派，别人照跑", async () => {
    const { worker, laneIds, pending } = recorder();
    const record = makeRecord([member("lane_a"), member("lane_b")], "sequential");
    const handle = startSchedule({ record, worker, gate: makeGate(2) });
    await flush();
    handle.cancelLane("lane_b", "不需要它了");
    pending[0]!.resolve("a");
    const finished = await handle.done;
    expect(statusOf(finished, "lane_a")).toBe("completed");
    expect(statusOf(finished, "lane_b")).toBe("cancelled");
    expect(finished.tasks[1]!.error).toBe("成员被单独取消，未派发");
    expect(laneIds()).toEqual(["lane_a"]);
  });

  it("全队取消：在跑的 abort，没派的记 cancelled，run 记 cancelled", async () => {
    const { worker, laneIds, pending } = recorder();
    const record = makeRecord([member("lane_a"), member("lane_b"), member("lane_c")], "parallel", 1);
    const handle = startSchedule({ record, worker, gate: makeGate(4) });
    await flush();
    expect(laneIds()).toEqual(["lane_a"]);
    handle.cancelRun("用户叫停");
    await flush();
    expect(pending[0]!.context.signal.aborted).toBe(true);
    pending[0]!.reject(new ScheduleCancelledError());
    const finished = await handle.done;
    expect(statusOf(finished, "lane_a")).toBe("cancelled");
    expect(statusOf(finished, "lane_b")).toBe("cancelled");
    expect(statusOf(finished, "lane_c")).toBe("cancelled");
    expect(finished.status).toBe("cancelled");
    expect(finished.tasks[1]!.error).toBe("用户叫停");
    expect(finished.events.at(-1)!.kind).toBe("run_cancelled");
  });

  it("底层停不下来时不假称已停止：结果照收但记 cancelled 并留诊断", async () => {
    const { worker, pending } = recorder();
    const handle = startSchedule({ record: makeRecord([member("lane_a")]), worker, gate: makeGate(2) });
    await flush();
    handle.cancelRun("叫停");
    await flush();
    // worker 无视 abort，照样返回结果。
    pending[0]!.resolve("其实我跑完了");
    const finished = await handle.done;
    expect(finished.tasks[0]!.status).toBe("cancelled");
    expect(finished.tasks[0]!.error).toMatch(/底层没停下来/);
    expect(finished.tasks[0]!.output).toBeUndefined();
    expect(finished.status).toBe("cancelled");
  });

  it("取消立刻生效：不用等在跑的任务落定，没派的当场记 cancelled", async () => {
    const { worker, laneIds } = recorder();
    const record = makeRecord([member("lane_a"), member("lane_b")], "parallel", 1);
    const handle = startSchedule({ record, worker, gate: makeGate(4) });
    await flush();
    expect(laneIds()).toEqual(["lane_a"]);

    handle.cancelRun("用户叫停");
    // 只让微任务跑一拍：lane_a 还挂在 worker 上没落定。
    await flush(1);
    expect(statusOf(handle.record, "lane_b")).toBe("cancelled");
  });

  it("被取消带走的『阻塞』记 cancelled，不是 blocked", async () => {
    const { worker, pending } = recorder();
    const record = makeRecord([
      member("lane_a"),
      member("lane_b", { dependsOn: ["lane_a"] }),
      member("lane_c", { dependsOn: ["lane_b"] }),
    ]);
    const handle = startSchedule({ record, worker, gate: makeGate(4) });
    await flush();
    expect(pending).toHaveLength(1);

    handle.cancelRun("用户叫停");
    await flush();
    // lane_a 无视 abort，照样返回结果（底层停不下来的情形）。
    pending[0]!.resolve("我跑完了");
    const finished = await handle.done;

    // 上游是被取消带走的，下游不该被写成「上游没干成」——那不是真话。
    expect(statusOf(finished, "lane_a")).toBe("cancelled");
    expect(statusOf(finished, "lane_b")).toBe("cancelled");
    expect(statusOf(finished, "lane_c")).toBe("cancelled");
    expect(finished.tasks[1]!.blockedBy).toBeUndefined();
    // 不能写成「上游任务 lane_a 没干成」——那是取消的账，不是失败的账。
    expect(finished.tasks[1]!.error).not.toMatch(/没干成/);
  });

  it("上游自己跑挂造成的阻塞仍然是 blocked，取消盖不掉这个真话", async () => {
    const { worker, pending } = recorder();
    const record = makeRecord([
      member("lane_a"),
      member("lane_b", { dependsOn: ["lane_a"] }),
      member("lane_hold"),
    ]);
    const handle = startSchedule({ record, worker, gate: makeGate(4) });
    await flush();
    // lane_a 自己失败，lane_b 因此被阻塞。
    pending[0]!.reject(new Error("编译不过"));
    await flush();
    expect(statusOf(handle.record, "lane_b")).toBe("blocked");
    expect(pending).toHaveLength(2);

    handle.cancelRun("顺手叫停");
    await flush();
    // lane_hold 无视 abort，照样返回结果。
    pending[1]!.resolve("我跑完了");
    const finished = await handle.done;
    expect(statusOf(finished, "lane_a")).toBe("failed");
    expect(statusOf(finished, "lane_b")).toBe("blocked");
    expect(finished.tasks[1]!.blockedBy).toBe("lane_a");
  });

  it("取消排队中的任务：一次都没执行也照实记 cancelled", async () => {
    const gate = makeGate(1);
    const blocker = recorder();
    const blockedRun = startSchedule({ record: makeRecord([member("lane_hold")]), worker: blocker.worker, gate });
    await flush();
    const { worker, calls } = recorder();
    const handle = startSchedule({ record: makeRecord([member("lane_a")]), worker, gate });
    await flush();
    expect(calls).toHaveLength(0);
    handle.cancelRun("不等了");
    const finished = await handle.done;
    expect(finished.tasks[0]!.status).toBe("cancelled");
    expect(calls).toHaveLength(0);
    blocker.pending[0]!.resolve("放行");
    await blockedRun.done;
  });

  it("外部 signal 取消整队", async () => {
    const controller = new AbortController();
    const { worker, pending } = recorder();
    const handle = startSchedule({
      record: makeRecord([member("lane_a")]),
      worker,
      gate: makeGate(2),
      signal: controller.signal,
    });
    await flush();
    controller.abort();
    await flush();
    pending[0]!.reject(new ScheduleCancelledError());
    expect((await handle.done).status).toBe("cancelled");
  });
});

describe("进度回调", () => {
  it("每次状态变化都回调，runId 立刻可用", async () => {
    const snapshots: string[] = [];
    const { worker, pending } = recorder();
    const handle = startSchedule({
      record: makeRecord([member("lane_a")]),
      worker,
      gate: makeGate(2),
      onUpdate: (record) => {
        snapshots.push(record.tasks[0]!.status);
      },
    });
    expect(handle.runId).toBe("legion-demo-20260922120000-01");
    await flush();
    pending[0]!.resolve("ok");
    await handle.done;
    expect(snapshots).toContain("running");
    expect(snapshots.at(-1)).toBe("completed");
  });
});
