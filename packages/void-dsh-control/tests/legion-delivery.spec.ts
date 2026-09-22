import { describe, expect, it } from "vitest";
import {
  LEGION_RUN_TERMINAL_EVENT,
  LegionRunDelivery,
  legionCallbackPayload,
  type LegionDeliveryState,
  type LegionNotificationHost,
  type LegionRunEvent,
} from "../src/legion-delivery.js";
import { signCallbackBody, type CallbackTarget } from "../src/callback.js";

/**
 * P6g 的验收面（计划 §16.2 L9）：军团运行终态走控制面**已有的** webhook——同一个地址、
 * 同一份密钥、同一份白名单、同一份超时与重试预算。这里验四件事：
 *
 * 1. 负载里只有状态与受控结果链接，**不伪造 TaskRecord**，也不带成员产出；
 * 2. `deliveryId` 就是军团的 `eventId`，所以接收端能按 eventId 幂等；
 * 3. 投递结果回写到军团自己的通知文件（`delivery` 字段），控制面账本一个字都不动；
 * 4. 重启后补投：已投递的跳过，未投递的按时间正序重排。
 */

const EVENT_ID = "run-7#1";

function runEvent(overrides: Partial<LegionRunEvent> = {}): LegionRunEvent {
  return {
    eventId: EVENT_ID,
    runId: "run-7",
    teamId: "team-a",
    status: "completed",
    finishedAt: "2026-03-01T00:00:00.000Z",
    counts: { total: 3, completed: 3, failed: 0 },
    resultRef: "legion/runs/run-7.json",
    ...overrides,
  };
}

function target(overrides: Partial<CallbackTarget> = {}): CallbackTarget {
  return {
    enabled: true,
    url: "https://hooks.example.test/void",
    secretEnv: "VOID_TEST_SECRET",
    events: ["completed", "failed", "cancelled", "interrupted"],
    timeoutMs: 1_000,
    maxAttempts: 2,
    ...overrides,
  };
}

interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

class FakeHost implements LegionNotificationHost {
  readonly patches: Array<{ eventId: string; patch: LegionDeliveryState }> = [];
  readonly records: LegionRunEvent[] = [];
  listFails = false;

  async list(): Promise<readonly LegionRunEvent[]> {
    if (this.listFails) throw new Error("军团通知文件损坏: E:/data/legion/notifications.json");
    return this.records;
  }

  async markDelivery(eventId: string, patch: LegionDeliveryState): Promise<boolean> {
    this.patches.push({ eventId, patch });
    return this.records.some((record) => record.eventId === eventId);
  }
}

function recordingSend(outcomes: readonly (boolean | Error)[]): {
  send: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;
  calls: Sent[];
} {
  const calls: Sent[] = [];
  let index = 0;
  const send = async (url: string, init: RequestInit): Promise<{ ok: boolean; status: number }> => {
    calls.push({
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: String(init.body),
    });
    const outcome = outcomes[Math.min(index, outcomes.length - 1)];
    index += 1;
    if (outcome instanceof Error) throw outcome;
    return outcome === true ? { ok: true, status: 200 } : { ok: false, status: 500 };
  };
  return { send, calls };
}

function build(
  host: FakeHost,
  options: {
    readonly outcomes?: readonly (boolean | Error)[];
    readonly target?: Partial<CallbackTarget>;
    readonly log?: { warn(message: string): void };
  } = {},
): { delivery: LegionRunDelivery; calls: Sent[]; delays: number[] } {
  const { send, calls } = recordingSend(options.outcomes ?? [true]);
  const delays: number[] = [];
  const delivery = new LegionRunDelivery({
    target: target(options.target),
    host,
    secret: "s3cret",
    send,
    sleep: async (ms) => {
      delays.push(ms);
    },
    now: () => Date.parse("2026-03-01T00:00:00.000Z"),
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  return { delivery, calls, delays };
}

describe("legion delivery: payload contract", () => {
  it("keys the delivery by the legion eventId and carries no control-plane task", () => {
    const payload = legionCallbackPayload(runEvent());
    expect(payload.deliveryId).toBe(EVENT_ID);
    expect(payload.eventId).toBe(EVENT_ID);
    // 接收端按 eventId 幂等：网络侧只能做到「至少一次」，重复投递必须能被认出来。
    expect(Object.keys(payload).sort()).toEqual([
      "counts",
      "deliveryId",
      "eventId",
      "finishedAt",
      "resultRef",
      "runId",
      "status",
      "teamId",
    ]);
    // 军团事件不是控制面任务，负载里不许出现任何 TaskRecord 字段。
    expect(payload).not.toHaveProperty("taskId");
    expect(payload).not.toHaveProperty("callerId");
    expect(payload).not.toHaveProperty("requestId");
  });

  it("sends only the status and the controlled result link", async () => {
    const host = new FakeHost();
    const { delivery, calls } = build(host);
    expect(delivery.onTerminal(runEvent())).toBe(true);
    await delivery.settle();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://hooks.example.test/void");
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body.status).toBe("completed");
    expect(body.resultRef).toBe("legion/runs/run-7.json");
    // 成员产出、SOUL、会话正文一律不出现。
    expect(JSON.stringify(body)).not.toContain("assistantSummary");
    expect(JSON.stringify(body)).not.toContain("sessionId");
  });

  it("signs the body so the receiver can verify it", async () => {
    const host = new FakeHost();
    const { delivery, calls } = build(host);
    delivery.onTerminal(runEvent());
    await delivery.settle();

    const sent = calls[0]!;
    expect(sent.headers["x-dsh-control-delivery"]).toBe(EVENT_ID);
    expect(sent.headers["x-dsh-control-event"]).toBe("completed");
    expect(sent.headers["x-dsh-control-signature"]).toBe(
      signCallbackBody("s3cret", Number(sent.headers["x-dsh-control-timestamp"]), sent.body),
    );
  });

  it("exposes the terminal event name legion emits", () => {
    expect(LEGION_RUN_TERMINAL_EVENT).toBe("legion/run-terminal");
  });
});

describe("legion delivery: gating", () => {
  it("stays silent while the webhook is disabled", async () => {
    const host = new FakeHost();
    const { delivery, calls } = build(host, { target: { enabled: false } });
    expect(delivery.onTerminal(runEvent())).toBe(false);
    await delivery.settle();
    expect(calls).toHaveLength(0);
    expect(host.patches).toHaveLength(0);
    expect(delivery.active).toBe(false);
  });

  it("honours the shared event filter", async () => {
    const host = new FakeHost();
    const { delivery, calls } = build(host, { target: { events: ["failed"] } });
    expect(delivery.onTerminal(runEvent({ status: "completed" }))).toBe(false);
    await delivery.settle();
    expect(calls).toHaveLength(0);
  });

  it("refuses further deliveries after drain", async () => {
    const host = new FakeHost();
    const { delivery } = build(host);
    await delivery.drain();
    expect(delivery.onTerminal(runEvent())).toBe(false);
  });

  it("reads its own switch per event, not at mount", async () => {
    const host = new FakeHost();
    let on = false;
    const { send, calls } = recordingSend([true]);
    const delivery = new LegionRunDelivery({
      target: target(),
      host,
      secret: "s3cret",
      send,
      sleep: async () => undefined,
      enabled: () => on,
    });

    expect(delivery.onTerminal(runEvent())).toBe(false);
    await delivery.settle();
    expect(calls).toHaveLength(0);

    // 面板里打开开关后，下一次终态就发得出去，不用重启。
    on = true;
    expect(delivery.onTerminal(runEvent())).toBe(true);
    await delivery.settle();
    expect(calls).toHaveLength(1);
  });
});

describe("legion delivery: attempt accounting", () => {
  it("records the delivered state on the legion notification itself", async () => {
    const host = new FakeHost();
    host.records.push(runEvent());
    const { delivery } = build(host);
    delivery.onTerminal(runEvent());
    await delivery.settle();

    expect(host.patches).toEqual([
      { eventId: EVENT_ID, patch: { attempts: 1, deliveredAt: "2026-03-01T00:00:00.000Z" } },
    ]);
  });

  it("retries with backoff and remembers the failure without the URL", async () => {
    const host = new FakeHost();
    host.records.push(runEvent());
    const { delivery, calls, delays } = build(host, { outcomes: [false, false], target: { maxAttempts: 3 } });
    delivery.onTerminal(runEvent());
    await delivery.settle();

    expect(calls).toHaveLength(3);
    expect(delays).toEqual([1_000, 2_000]);
    expect(host.patches.map((entry) => entry.patch)).toEqual([
      { attempts: 1, lastError: "HTTP 500" },
      { attempts: 2, lastError: "HTTP 500" },
      { attempts: 3, lastError: "HTTP 500" },
    ]);
    // 失败时不留 deliveredAt：下一次进程启动时这条还会被补投。
    expect(host.patches.at(-1)!.patch.deliveredAt).toBeUndefined();
  });

  it("keeps the transport error name only, never a message that may embed the URL", async () => {
    const host = new FakeHost();
    const failure = new TypeError("fetch failed for https://hooks.example.test/void");
    const { delivery } = build(host, { outcomes: [failure], target: { maxAttempts: 1 } });
    delivery.onTerminal(runEvent());
    await delivery.settle();

    expect(host.patches.at(-1)!.patch.lastError).toBe("TypeError");
  });

  it("counts attempts across processes, not per run of this plugin", async () => {
    const host = new FakeHost();
    // 上一次进程已经试了 4 次，仍然没投出去。
    host.records.push(runEvent({ delivery: { attempts: 4, lastError: "HTTP 500" } }));
    const { delivery } = build(host, { outcomes: [false], target: { maxAttempts: 2 } });

    const scheduled = await delivery.start();
    await delivery.settle();

    expect(scheduled).toBe(1);
    // 跨进程累计：6 = 之前 4 次 + 这次把 2 次重试预算用完。
    expect(host.patches.at(-1)!.patch.attempts).toBe(6);
  });

  it("does not deliver the same event twice", async () => {
    const host = new FakeHost();
    host.records.push(runEvent());
    const { delivery, calls } = build(host);
    expect(delivery.onTerminal(runEvent())).toBe(true);
    await delivery.settle();
    expect(delivery.onTerminal(runEvent())).toBe(false);
    await delivery.settle();
    expect(calls).toHaveLength(1);
  });
});

describe("legion delivery: restart catch-up", () => {
  it("re-schedules undelivered terminal states in time order and skips delivered ones", async () => {
    const host = new FakeHost();
    // list() 最新在前：c、b、a。
    host.records.push(
      runEvent({ eventId: "run-9#1", runId: "run-9", status: "failed" }),
      runEvent({ eventId: "run-8#1", runId: "run-8", delivery: { attempts: 1, deliveredAt: "2026-02-28T00:00:00.000Z" } }),
      runEvent({ eventId: "run-7#1", runId: "run-7" }),
    );
    const { delivery, calls } = build(host);

    const scheduled = await delivery.start();
    await delivery.settle();

    expect(scheduled).toBe(2);
    expect(calls.map((call) => call.headers["x-dsh-control-delivery"])).toEqual(["run-7#1", "run-9#1"]);
  });

  it("stays quiet when the legion service has no data root", async () => {
    const host = new FakeHost();
    const { delivery } = build(host);
    expect(await delivery.start()).toBe(0);
  });

  it("warns instead of failing the plugin when the notification file is unreadable", async () => {
    const host = new FakeHost();
    host.listFails = true;
    const warnings: string[] = [];
    const { delivery } = build(host, { log: { warn: (message) => warnings.push(message) } });

    expect(await delivery.start()).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("legion notification backlog unreadable");
  });
});
