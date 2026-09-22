import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LEGION_NOTIFICATION_FILE,
  LegionNotificationError,
  LegionNotificationStore,
  notificationEventId,
  runFinishedEvent,
  type LegionRunFinished,
} from "../src/notifications.js";
import { createRunNotifications, apply, RUN_NOTIFICATION_SOURCE_ID } from "../src/notification-source.js";
import { RunCoordinator } from "../src/run-coordinator.js";
import { RunStore, createRunRecord, type RunRecord, type RunTaskRecord } from "../src/run-store.js";
import type { ScheduleWorker } from "../src/scheduler.js";
import type { DelegationTeamMetadata } from "../src/team.js";

const roots: string[] = [];
const workers: Array<{ releaseAll(): void }> = [];
const dispatched: Array<{ runs: RunCoordinator; runId: string }> = [];

afterEach(async () => {
  for (const worker of workers) worker.releaseAll();
  for (const entry of dispatched) {
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

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "void-legion-notifications-"));
  roots.push(root);
  return root;
}

const TEAM: DelegationTeamMetadata = {
  id: "legion-demo",
  mode: "plan_execute_verify",
  sharedGoal: "prove the notification outbox",
  memberRoster: [
    { laneId: "lane_plan", role: "researcher", authorityRelationToManager: "peer" },
    { laneId: "lane_code", role: "coder", authorityRelationToManager: "subordinate", dependsOn: ["lane_plan"] },
    { laneId: "lane_verify", role: "verifier", authorityRelationToManager: "peer", dependsOn: ["lane_code"] },
  ],
};

const AT = new Date("2026-09-22T08:00:00.000Z");

/** 造一条带指定任务状态的运行记录（不跑调度，只造形状）。 */
function recordWith(runId: string, statuses: RunRecord["tasks"][number]["status"][]): RunRecord {
  const base = createRunRecord({
    runId,
    teamId: "legion-demo",
    schedule: "sequential",
    roster: TEAM.memberRoster,
    memberLimit: 8,
    at: AT,
  });
  const tasks: RunTaskRecord[] = base.tasks.map((task, index) => ({ ...task, status: statuses[index] ?? "completed" }));
  return { ...base, tasks, status: "completed", endedAt: AT.toISOString() };
}

function instantWorker(outputs: Record<string, unknown> = {}): ScheduleWorker {
  return async ({ laneId }) => outputs[laneId] ?? { laneId };
}

function controllableWorker() {
  const releases = new Map<string, () => void>();
  const worker: ScheduleWorker = async ({ laneId }) => {
    await new Promise<void>((resolve) => {
      releases.set(laneId, resolve);
    });
    return { laneId, ok: true };
  };
  const control = {
    worker,
    releaseAll() {
      for (const resolve of releases.values()) resolve();
    },
  };
  workers.push(control);
  return control;
}

async function dispatchTracked(
  runs: RunCoordinator,
  request: Parameters<RunCoordinator["dispatch"]>[0],
): Promise<RunRecord> {
  const record = await runs.dispatch(request);
  dispatched.push({ runs, runId: record.runId });
  return record;
}

describe("运行终态事件", () => {
  it("还在跑就不编事件出来", () => {
    const base = createRunRecord({
      runId: "legion-demo-20260922080000-01",
      teamId: "legion-demo",
      schedule: "sequential",
      roster: TEAM.memberRoster,
      memberLimit: 8,
      at: AT,
    });
    expect(base.status).toBe("running");
    expect(runFinishedEvent(base)).toBeUndefined();
  });

  it("终态事件的形状：一次终态一个 eventId，计数与相对结果路径都在", () => {
    const record: RunRecord = {
      ...recordWith("legion-demo-20260922080000-01", ["completed", "failed", "blocked"]),
      status: "failed",
    };
    const event = runFinishedEvent(record)!;

    expect(event.eventId).toBe("legion-demo-20260922080000-01#1");
    expect(event.eventId).toBe(notificationEventId(record.runId, 1));
    expect(event.runId).toBe(record.runId);
    expect(event.teamId).toBe("legion-demo");
    expect(event.status).toBe("failed");
    expect(event.finishedAt).toBe(AT.toISOString());
    expect(event.counts).toEqual({
      total: 3,
      completed: 1,
      failed: 1,
      blocked: 1,
      cancelled: 0,
      interrupted: 0,
    });
    // 结果给的是相对数据根的路径：通知会走出这个进程，不该带上本机目录结构。
    expect(event.resultRef).toBe("legion/runs/legion-demo-20260922080000-01.json");
    expect(event.resultRef.startsWith("/")).toBe(false);
  });
});

describe("通知仓库", () => {
  it("记一条就能列出来，未读在前；标记已读跨实例可见", async () => {
    const root = await makeRoot();
    const store = new LegionNotificationStore({ dataDir: root, now: () => AT });
    const event = runFinishedEvent(recordWith("legion-demo-20260922080000-01", ["completed", "completed", "completed"]))!;

    const outcome = await store.record(event);
    expect(outcome.recorded).toBe(true);
    expect(outcome.record.recordedAt).toBe(AT.toISOString());

    expect((await store.list()).map((item) => item.eventId)).toEqual([event.eventId]);
    expect(await store.unread()).toHaveLength(1);

    expect(await store.markRead([event.eventId])).toBe(1);
    expect(await store.unread()).toEqual([]);
    expect(await store.markRead([event.eventId])).toBe(0);

    // 新实例读同一个数据根：已读状态是落盘的，不是内存里的。
    const reopened = new LegionNotificationStore({ dataDir: root });
    expect((await reopened.list())[0]!.readAt).toBe(AT.toISOString());
  });

  it("同一终态重复记录只留一条，已读也不会被重复记录冲掉", async () => {
    const root = await makeRoot();
    const store = new LegionNotificationStore({ dataDir: root, now: () => AT });
    const event = runFinishedEvent(recordWith("legion-demo-20260922080000-01", ["completed", "completed", "completed"]))!;

    await store.record(event);
    await store.markRead([event.eventId]);
    const again = await store.record(event);

    expect(again.recorded).toBe(false);
    expect(again.record.readAt).toBe(AT.toISOString());
    expect(await store.list()).toHaveLength(1);
  });

  it("最新在前，且文件里带版本号", async () => {
    const root = await makeRoot();
    const store = new LegionNotificationStore({ dataDir: root });
    const first = runFinishedEvent(recordWith("legion-demo-20260922080000-01", ["completed"]))!;
    const second = runFinishedEvent(recordWith("legion-demo-20260922080000-02", ["completed"]))!;
    await store.record(first);
    await store.record(second);

    expect((await store.list()).map((item) => item.eventId)).toEqual([second.eventId, first.eventId]);

    const raw = JSON.parse(await readFile(join(root, "legion", LEGION_NOTIFICATION_FILE), "utf8")) as {
      version: number;
      events: unknown[];
    };
    expect(raw.version).toBe(1);
    expect(raw.events).toHaveLength(2);
  });

  it("超过上限先丢最老的已读，未读留着", async () => {
    const root = await makeRoot();
    const store = new LegionNotificationStore({ dataDir: root, limit: 2 });
    const events = [1, 2, 3].map(
      (index) => runFinishedEvent(recordWith(`legion-demo-2026092208000${index}-01`, ["completed"]))!,
    );

    await store.record(events[0]!);
    await store.record(events[1]!);
    await store.markRead([events[0]!.eventId]);
    await store.record(events[2]!);

    // 丢的是最老的**已读**那条，两条未读一条不少。
    expect((await store.list()).map((item) => item.eventId)).toEqual([events[2]!.eventId, events[1]!.eventId]);
  });

  it("文件坏了、版本不认识就如实报错，不假装没有通知", async () => {
    const root = await makeRoot();
    const store = new LegionNotificationStore({ dataDir: root });
    const file = join(root, "legion", LEGION_NOTIFICATION_FILE);

    // 还没写过文件：没有通知，不是错误。
    expect(await store.list()).toEqual([]);

    await mkdir(join(root, "legion"), { recursive: true });
    await writeFile(file, "{ 这不是 JSON", "utf8");
    await expect(store.list()).rejects.toBeInstanceOf(LegionNotificationError);
    await expect(store.list()).rejects.toThrow(/军团通知文件损坏/);

    await writeFile(file, JSON.stringify({ version: 99, events: [] }), "utf8");
    await expect(store.list()).rejects.toThrow("不支持的军团通知版本: 99（本版本只认 1）");
  });

  it("数据根必须是绝对路径", () => {
    expect(() => new LegionNotificationStore({ dataDir: "legion-data" })).toThrow("军团通知数据根必须是绝对路径");
  });
});

describe("通知接入运行", () => {
  it("跑完落一条通知，状态、计数与结果路径对得上", async () => {
    const root = await makeRoot();
    const notifications = new LegionNotificationStore({ dataDir: root });
    const runs = new RunCoordinator({ store: new RunStore({ dataDir: root }), notifications });
    expect(runs.notifying).toBe(true);

    const record = await dispatchTracked(runs, { teamId: "legion-demo", team: TEAM, worker: instantWorker() });
    await runs.waitFor(record.runId);

    const listed = await notifications.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.runId).toBe(record.runId);
    expect(listed[0]!.status).toBe("completed");
    expect(listed[0]!.counts.completed).toBe(3);
    expect(listed[0]!.resultRef).toBe(`legion/runs/${record.runId}.json`);
    // 落盘的位置就在队伍、运行记录旁边。
    expect(notifications.path).toBe(join(root, "legion", LEGION_NOTIFICATION_FILE));
  });

  it("取消也是终态，一样有通知", async () => {
    const root = await makeRoot();
    const notifications = new LegionNotificationStore({ dataDir: root });
    const runs = new RunCoordinator({ store: new RunStore({ dataDir: root }), notifications });
    const control = controllableWorker();
    const record = await dispatchTracked(runs, { teamId: "legion-demo", team: TEAM, worker: control.worker });

    await runs.cancelRun(record.runId, "用户叫停");
    for (let tick = 0; tick < 50 && runs.activeRunIds().includes(record.runId); tick += 1) {
      control.releaseAll();
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await runs.waitFor(record.runId);

    const listed = await notifications.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.status).toBe("cancelled");
    expect(listed[0]!.counts.cancelled + listed[0]!.counts.blocked).toBeGreaterThan(0);
  });

  it("宿主重启结算出来的中断也是终态，补一条通知且只补一条", async () => {
    const root = await makeRoot();
    const notifications = new LegionNotificationStore({ dataDir: root });
    const store = new RunStore({ dataDir: root });
    const runs = new RunCoordinator({ store, notifications });
    const control = controllableWorker();
    const record = await dispatchTracked(runs, { teamId: "legion-demo", team: TEAM, worker: control.worker });
    control.releaseAll();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 模拟宿主重启：新 coordinator 读同一份磁盘，连通知仓库一起换新实例。
    const restarted = new RunCoordinator({
      store: new RunStore({ dataDir: root }),
      notifications: new LegionNotificationStore({ dataDir: root }),
    });
    const settled = await restarted.settleInterrupted();
    expect(settled.map((item) => item.runId)).toEqual([record.runId]);

    const listed = await notifications.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.status).toBe("interrupted");
    expect(listed[0]!.counts.interrupted).toBeGreaterThan(0);

    // 再结算一次没有新东西，也不会多出第二条通知。
    expect(await restarted.settleInterrupted()).toEqual([]);
    expect(await notifications.list()).toHaveLength(1);
  });

  it("通知落盘失败只记一条事件，运行结果一个字不改", async () => {
    const root = await makeRoot();
    const broken = {
      record: async (): Promise<never> => {
        throw new Error("通知盘满了");
      },
    } as unknown as LegionNotificationStore;
    const runs = new RunCoordinator({ store: new RunStore({ dataDir: root }), notifications: broken });

    const record = await dispatchTracked(runs, { teamId: "legion-demo", team: TEAM, worker: instantWorker() });
    const settled = await runs.waitFor(record.runId);

    expect(settled.status).toBe("completed");
    expect(settled.tasks.every((task) => task.status === "completed")).toBe(true);
    expect(settled.events.some((event) => event.kind === "run_notify_failed" && event.detail === "通知盘满了")).toBe(true);
    // 运行记录照旧落盘：通知出问题不能连带把运行记录也丢了。
    expect((await runs.require(record.runId)).status).toBe("completed");
  });

  it("没有数据根就没有通知，也不假装有", async () => {
    const runs = new RunCoordinator({});
    expect(runs.notifying).toBe(false);
    const record = await dispatchTracked(runs, { teamId: "legion-demo", team: TEAM, worker: instantWorker() });
    await runs.waitFor(record.runId);
    expect(runs.notificationStore).toBeUndefined();
    expect(record.status).toBe("completed");
  });
});

describe("军团运行通知来源", () => {
  it("没有数据根时说明白：通知没地方落，运行记录还在任务视图里", async () => {
    const [source] = createRunNotifications(() => undefined);
    const listed = await source!.list();
    expect(listed.items).toEqual([]);
    expect(listed.note).toContain("终态通知没地方落盘");
    expect(listed.note).toContain("任务视图");
    // 没有仓库时标记已读直接回 undefined（入口按「来源不支持」如实拒），不抛错。
    await expect(source!.markRead!(["x#1"])).resolves.toBeUndefined();
  });

  it("把落盘记录翻成通知：标题、摘要、级别、元信息都在", async () => {
    const root = await makeRoot();
    const store = new LegionNotificationStore({ dataDir: root });
    const record = { ...recordWith("legion-demo-20260922080000-01", ["completed", "failed", "blocked"]), status: "failed" as const };
    await store.record(runFinishedEvent(record)!);

    const [source] = createRunNotifications(() => ({ notifications: store }));
    const listed = await source!.list();

    expect(listed.note).toBeUndefined();
    expect(listed.items).toHaveLength(1);
    const item = listed.items[0]!;
    expect(item.id).toBe("legion-demo-20260922080000-01#1");
    expect(item.title).toBe("运行 legion-demo-20260922080000-01 有任务失败");
    expect(item.summary).toBe("完成 1/3，失败 1，未轮到 1");
    expect(item.level).toBe("danger");
    expect(item.at).toBe(AT.toISOString());
    expect(item.read).toBe(false);
    expect(item.meta).toEqual({
      队伍: "legion-demo",
      运行: "legion-demo-20260922080000-01",
      结果: "legion/runs/legion-demo-20260922080000-01.json",
    });

    await source!.markRead!([item.id]);
    expect((await source!.list()).items[0]!.read).toBe(true);
  });

  it("一条都没跑完时给一句为什么空，而不是空列表了事", async () => {
    const root = await makeRoot();
    const [source] = createRunNotifications(() => ({ notifications: new LegionNotificationStore({ dataDir: root }) }));
    const listed = await source!.list();
    expect(listed.items).toEqual([]);
    expect(listed.note).toContain("还没有跑完的运行");
  });
});

describe("军团运行通知来源的宿主取值", () => {
  it("军团后挂上来自动生效：每次读都重新取宿主", async () => {
    const root = await makeRoot();
    const store = new LegionNotificationStore({ dataDir: root });
    const event: LegionRunFinished = runFinishedEvent(recordWith("legion-demo-20260922080000-01", ["completed"]))!;
    await store.record(event);

    let host: { notifications?: LegionNotificationStore } | undefined;
    const [source] = createRunNotifications(() => host);
    expect((await source!.list()).items).toEqual([]);

    host = { notifications: store };
    expect((await source!.list()).items.map((item) => item.id)).toEqual([event.eventId]);
  });

  it("注册进入口，卸载时收回来", () => {
    const registered: string[] = [];
    const suite = {
      registerNotificationSource(source: { id: string }) {
        registered.push(source.id);
        return () => {
          registered.splice(registered.indexOf(source.id), 1);
        };
      },
    };
    const disposers: Array<() => void> = [];
    const fakeCtx = {
      inject: (_deps: string[], callback: (ctx: unknown) => void) =>
        callback({
          get: (name: string) => (name === "voidSuite" ? suite : undefined),
          effect: (factory: () => () => void) => {
            disposers.push(factory());
          },
        }),
    };

    apply(fakeCtx as never);
    expect(registered).toEqual([RUN_NOTIFICATION_SOURCE_ID]);
    for (const dispose of disposers) dispose();
    expect(registered).toEqual([]);
  });

  it("入口还不认通知来源时安静退出，军团照常工作", () => {
    const fakeCtx = {
      inject: (_deps: string[], callback: (ctx: unknown) => void) =>
        callback({
          get: () => ({}),
          effect: () => {
            throw new Error("不该注册任何东西");
          },
        }),
    };
    expect(() => apply(fakeCtx as never)).not.toThrow();
  });
});
