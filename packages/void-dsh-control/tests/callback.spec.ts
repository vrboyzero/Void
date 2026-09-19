import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CALLBACK_BASE_BACKOFF_MS,
  CALLBACK_MAX_BACKOFF_MS,
  WebhookCallbackDispatcher,
  backoffDelayMs,
  callbackPayload,
  resolveCallbackUrl,
  signCallbackBody,
  type CallbackTarget,
} from "../src/callback.js";
import { MemoryControlLedger, type TaskEventRecord, type TaskRecord } from "../src/ledger.js";
import { ControlError, expandOperations } from "../src/protocol.js";
import { ControlOrchestrator } from "../src/orchestrator.js";
import { EMPTY_CALLER_POLICY, compilePolicy } from "../src/policy.js";
import { FakeHosts } from "./support/fake-hosts.js";

const SECRET = "callback-secret-value";

function target(overrides: Partial<CallbackTarget> = {}): CallbackTarget {
  return {
    enabled: true,
    url: "https://receiver.example/hook",
    secretEnv: "TEST_CALLBACK_SECRET",
    events: ["completed", "failed", "cancelled"],
    timeoutMs: 1_000,
    maxAttempts: 3,
    allowedHosts: [],
    includeAssistantSummary: false,
    ...overrides,
  };
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "task-1",
    callerId: "codex",
    requestId: "r1",
    status: "completed",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastCursor: 4,
    assistantSummary: "model produced this text",
    ...overrides,
  };
}

function event(overrides: Partial<TaskEventRecord> = {}): TaskEventRecord {
  return {
    taskId: "task-1",
    seq: 4,
    kind: "completed",
    status: "completed",
    time: "2026-01-01T00:00:01.000Z",
    summary: "task completed: agent reached idle",
    ...overrides,
  };
}

/** Recording transport with a scripted sequence of outcomes. */
function recordingSend(outcomes: (boolean | Error)[] = [true]) {
  const calls: { url: string; init: RequestInit; body: string; headers: Record<string, string> }[] = [];
  let index = 0;
  const send = async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: String(init.body), headers: init.headers as Record<string, string> });
    const outcome = outcomes[Math.min(index, outcomes.length - 1)];
    index += 1;
    if (outcome instanceof Error) throw outcome;
    return { ok: outcome === true, status: outcome === true ? 200 : 500 };
  };
  return { calls, send };
}

function build(overrides: Partial<CallbackTarget> = {}, outcomes: (boolean | Error)[] = [true]) {
  const ledger = new MemoryControlLedger();
  const { calls, send } = recordingSend(outcomes);
  const delays: number[] = [];
  const dispatcher = new WebhookCallbackDispatcher({
    target: target(overrides),
    ledger,
    secret: SECRET,
    send,
    sleep: async (ms) => {
      delays.push(ms);
    },
    now: () => Date.parse("2026-01-01T00:00:02.000Z"),
  });
  return { ledger, dispatcher, calls, delays };
}

describe("callback: configuration", () => {
  it("is inert when disabled", () => {
    expect(resolveCallbackUrl(target({ enabled: false }), "")).toBeUndefined();
  });

  it("requires a secret when enabled", () => {
    expect(() => resolveCallbackUrl(target(), "")).toThrowError(ControlError);
    expect(() => resolveCallbackUrl(target(), "")).toThrowError(/TEST_CALLBACK_SECRET is unset/);
  });

  it("rejects a non-absolute or non-http URL", () => {
    expect(() => resolveCallbackUrl(target({ url: "not a url" }), SECRET)).toThrowError(/not a valid absolute URL/);
    expect(() => resolveCallbackUrl(target({ url: "file:///etc/passwd" }), SECRET)).toThrowError(/must use http or https/);
  });

  it("enforces the host allowlist when one is configured", () => {
    expect(() => resolveCallbackUrl(target({ allowedHosts: ["other.example"] }), SECRET)).toThrowError(/not in callback.allowedHosts/);
    expect(resolveCallbackUrl(target({ allowedHosts: ["receiver.example"] }), SECRET)).toBe("https://receiver.example/hook");
  });

  it("rejects a zero attempt budget", () => {
    expect(() => resolveCallbackUrl(target({ maxAttempts: 0 }), SECRET)).toThrowError(/maxAttempts/);
  });

  it("treats an empty allowlist as no restriction", () => {
    expect(resolveCallbackUrl(target({ allowedHosts: [] }), SECRET)).toBe("https://receiver.example/hook");
  });
});

describe("callback: payload and signature", () => {
  it("sends only task facts by default", () => {
    const payload = callbackPayload(task(), event(), false);
    expect(payload["deliveryId"]).toBe("task-1:4");
    expect(payload["status"]).toBe("completed");
    expect(payload["eventCursor"]).toBe("4");
    expect(payload["workspaceId"]).toBe("workspace-1");
    expect(payload["sessionId"]).toBe("session-1");
    // Model-produced text is opt-in.
    expect(payload).not.toHaveProperty("assistantSummary");
  });

  it("includes the assistant summary only when asked", () => {
    expect(callbackPayload(task(), event(), true)["assistantSummary"]).toBe("model produced this text");
  });

  it("signs over timestamp.body so a replay with a fresh timestamp fails", () => {
    const body = JSON.stringify(callbackPayload(task(), event(), false));
    const first = signCallbackBody(SECRET, 1_700_000_000, body);
    const second = signCallbackBody(SECRET, 1_700_000_001, body);
    expect(first).not.toBe(second);
    expect(first).toBe(`sha256=${createHmac("sha256", SECRET).update(`1700000000.${body}`).digest("hex")}`);
  });

  it("backs off exponentially up to the cap", () => {
    expect(backoffDelayMs(0)).toBe(CALLBACK_BASE_BACKOFF_MS);
    expect(backoffDelayMs(1)).toBe(CALLBACK_BASE_BACKOFF_MS * 2);
    expect(backoffDelayMs(20)).toBe(CALLBACK_MAX_BACKOFF_MS);
  });
});

describe("callback: delivery", () => {
  it("delivers a subscribed status and records it in the ledger", async () => {
    const { ledger, dispatcher, calls } = build();
    dispatcher.onTaskEvent(task(), event());
    await dispatcher.drain();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://receiver.example/hook");
    expect(calls[0]!.headers["x-dsh-control-event"]).toBe("completed");
    expect(calls[0]!.headers["x-dsh-control-delivery"]).toBe("task-1:4");
    expect(calls[0]!.headers["x-dsh-control-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(ledger.findCallbackDelivery("task-1:4")).toMatchObject({ status: "delivered", attempts: 1 });
  });

  it("ignores a status the user did not subscribe to", async () => {
    const { dispatcher, calls } = build({ events: ["failed"] });
    dispatcher.onTaskEvent(task({ status: "running" }), event({ status: "running", kind: "running" }));
    await dispatcher.drain();
    expect(calls).toEqual([]);
  });

  it("does not re-deliver an already delivered event", async () => {
    const { ledger, dispatcher, calls } = build();
    dispatcher.onTaskEvent(task(), event());
    await dispatcher.drain();
    dispatcher.onTaskEvent(task(), event());
    await dispatcher.drain();
    expect(calls).toHaveLength(1);
    expect(ledger.findCallbackDelivery("task-1:4")!.attempts).toBe(1);
  });

  it("retries a failing receiver with backoff and then gives up", async () => {
    const { ledger, dispatcher, calls, delays } = build({}, [false, false, false]);
    dispatcher.onTaskEvent(task(), event());
    await dispatcher.settle();

    expect(calls).toHaveLength(3);
    expect(delays).toEqual([CALLBACK_BASE_BACKOFF_MS, CALLBACK_BASE_BACKOFF_MS * 2]);
    expect(ledger.findCallbackDelivery("task-1:4")).toMatchObject({ status: "failed", attempts: 3, lastError: "HTTP 500" });
  });

  it("succeeds on a later attempt and records the attempt count", async () => {
    const { ledger, dispatcher, calls } = build({}, [false, true]);
    dispatcher.onTaskEvent(task(), event());
    await dispatcher.settle();
    expect(calls).toHaveLength(2);
    expect(ledger.findCallbackDelivery("task-1:4")).toMatchObject({ status: "delivered", attempts: 2 });
  });

  it("summarizes a transport failure without leaking the URL", async () => {
    const { ledger, dispatcher } = build({ maxAttempts: 1 }, [new Error("connect ECONNREFUSED https://receiver.example/hook")]);
    dispatcher.onTaskEvent(task(), event());
    await dispatcher.settle();
    const record = ledger.findCallbackDelivery("task-1:4")!;
    expect(record.status).toBe("failed");
    expect(record.lastError).toBe("Error");
    expect(JSON.stringify(record)).not.toContain("ECONNREFUSED");
  });

  it("stays inert when disabled", async () => {
    const ledger = new MemoryControlLedger();
    const { calls, send } = recordingSend();
    const dispatcher = new WebhookCallbackDispatcher({ target: target({ enabled: false }), ledger, secret: "", send });
    expect(dispatcher.active).toBe(false);
    dispatcher.onTaskEvent(task(), event());
    await dispatcher.drain();
    expect(calls).toEqual([]);
  });

  it("returns before the receiver answers", async () => {
    // The orchestrator calls this from inside its lifecycle write; awaiting the
    // network there would stall task progression (plan §9.2, §12).
    const ledger = new MemoryControlLedger();
    const { send } = recordingSend();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatcher = new WebhookCallbackDispatcher({
      target: target(),
      ledger,
      secret: SECRET,
      send: async (url, init) => {
        await gate;
        return send(url, init);
      },
      sleep: async () => {},
    });

    const returned = dispatcher.onTaskEvent(task(), event());
    expect(returned).toBeUndefined();
    expect(dispatcher.inflightCount).toBe(1);
    release();
    await dispatcher.drain();
  });
});

describe("callback: quiesce", () => {
  it("drains in-flight deliveries and refuses new ones", async () => {
    const ledger = new MemoryControlLedger();
    const { calls, send } = recordingSend();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatcher = new WebhookCallbackDispatcher({
      target: target(),
      ledger,
      secret: SECRET,
      send: async (url, init) => {
        await gate;
        return send(url, init);
      },
      sleep: async () => {},
    });

    dispatcher.onTaskEvent(task(), event());
    const drained = dispatcher.drain();
    release();
    await drained;

    expect(calls).toHaveLength(1);
    dispatcher.onTaskEvent(task({ taskId: "task-2" }), event({ taskId: "task-2" }));
    await dispatcher.drain();
    expect(calls).toHaveLength(1);
  });

  it("re-schedules a delivery left pending by an earlier process", async () => {
    const ledger = new MemoryControlLedger();
    const { calls, send } = recordingSend();
    // Simulate a crash mid-retry: the event is durable, the delivery row is pending.
    await ledger.putTask(task());
    await ledger.appendEvent({ taskId: "task-1", kind: "accepted", status: "accepted", time: "t", summary: "a" });
    await ledger.appendEvent({ taskId: "task-1", kind: "completed", status: "completed", time: "t", summary: "b" });
    await ledger.appendEvent({ taskId: "task-1", kind: "completed", status: "completed", time: "t", summary: "c" });
    await ledger.appendEvent({ taskId: "task-1", kind: "completed", status: "completed", time: "t", summary: "d" });
    await ledger.putCallbackDelivery({
      deliveryId: "task-1:3",
      taskId: "task-1",
      event: "completed",
      attempts: 2,
      status: "pending",
      lastError: "HTTP 500",
      updatedAt: "t",
    });

    const dispatcher = new WebhookCallbackDispatcher({ target: target(), ledger, secret: SECRET, send, sleep: async () => {} });
    expect(await dispatcher.resumePending()).toBe(1);
    await dispatcher.drain();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers["x-dsh-control-delivery"]).toBe("task-1:3");
    expect(ledger.findCallbackDelivery("task-1:3")).toMatchObject({ status: "delivered" });
  });

  it("does not re-schedule a delivery that already succeeded", async () => {
    const ledger = new MemoryControlLedger();
    const { calls, send } = recordingSend();
    await ledger.putTask(task());
    await ledger.appendEvent({ taskId: "task-1", kind: "completed", status: "completed", time: "t", summary: "a" });
    await ledger.putCallbackDelivery({
      deliveryId: "task-1:0",
      taskId: "task-1",
      event: "completed",
      attempts: 1,
      status: "delivered",
      updatedAt: "t",
    });

    const dispatcher = new WebhookCallbackDispatcher({ target: target(), ledger, secret: SECRET, send, sleep: async () => {} });
    expect(await dispatcher.resumePending()).toBe(0);
    await dispatcher.drain();
    expect(calls).toEqual([]);
  });

  it("ignores a pending delivery whose event is gone", async () => {
    const ledger = new MemoryControlLedger();
    const { calls, send } = recordingSend();
    await ledger.putCallbackDelivery({
      deliveryId: "task-missing:9",
      taskId: "task-missing",
      event: "completed",
      attempts: 1,
      status: "pending",
      updatedAt: "t",
    });
    const dispatcher = new WebhookCallbackDispatcher({ target: target(), ledger, secret: SECRET, send, sleep: async () => {} });
    expect(await dispatcher.resumePending()).toBe(0);
    await dispatcher.drain();
    expect(calls).toEqual([]);
  });
});

describe("callback: orchestrator wiring", () => {
  it("notifies once per subscribed lifecycle event and never blocks the task", async () => {
    const ledger = new MemoryControlLedger();
    const { calls, send } = recordingSend();
    const dispatcher = new WebhookCallbackDispatcher({
      target: target({ events: ["prompt_queued", "completed"] }),
      ledger,
      secret: SECRET,
      send,
      sleep: async () => {},
    });
    const orchestrator = new ControlOrchestrator({
      ledger,
      hosts: new FakeHosts(),
      policy: () => compilePolicy(EMPTY_CALLER_POLICY),
      onEvent: (record, committed) => dispatcher.onTaskEvent(record, committed),
    });

    const result = await orchestrator.dispatch(
      { callerId: "codex", operations: expandOperations(["session.prompt", "task.read"]) },
      {
        requestId: "r1",
        workspace: { path: "E:/work/app" },
        session: { kind: "new" },
        messages: [{ text: "x", mode: "queue" }],
        wait: { until: "accepted", timeoutMs: 0 },
      },
    );

    // `prompt_queued` fired during the dispatch; `accepted` and
    // `workspace_resolved` were not subscribed to.
    await dispatcher.settle();
    expect(calls.map((call) => call.headers["x-dsh-control-event"])).toEqual(["prompt_queued"]);

    await orchestrator.applySignal(result.sessionId, { status: "running", summary: "turn started" });
    await orchestrator.applySignal(result.sessionId, { status: "idle", summary: "turn ended (stop)" });
    await dispatcher.settle();

    expect(calls.map((call) => call.headers["x-dsh-control-event"])).toEqual(["prompt_queued", "completed"]);
    const snapshot = orchestrator.getTask({ callerId: "codex", operations: expandOperations(["task.read"]) }, {
      taskId: result.taskId,
      limit: 50,
    });
    expect(snapshot.task.status).toBe("completed");
  });

  it("does not let a stalled receiver delay the lifecycle write", async () => {
    const ledger = new MemoryControlLedger();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatcher = new WebhookCallbackDispatcher({
      target: target({ events: ["accepted", "completed"] }),
      ledger,
      secret: SECRET,
      send: async () => {
        await gate;
        return { ok: true, status: 200 };
      },
      sleep: async () => {},
    });
    const orchestrator = new ControlOrchestrator({
      ledger,
      hosts: new FakeHosts(),
      policy: () => compilePolicy(EMPTY_CALLER_POLICY),
      onEvent: (record, committed) => dispatcher.onTaskEvent(record, committed),
    });

    // The receiver never answers; dispatch must still settle.
    const result = await orchestrator.dispatch(
      { callerId: "codex", operations: expandOperations(["session.prompt", "task.read"]) },
      {
        requestId: "r1",
        workspace: { path: "E:/work/app" },
        session: { kind: "new" },
        messages: [{ text: "x", mode: "queue" }],
        wait: { until: "accepted", timeoutMs: 0 },
      },
    );
    expect(result.status).toBe("prompt_queued");
    expect(dispatcher.inflightCount).toBeGreaterThan(0);

    release();
    await dispatcher.drain();
  });

  it("contains a throwing notifier so the lifecycle write still commits", async () => {
    const ledger = new MemoryControlLedger();
    const orchestrator = new ControlOrchestrator({
      ledger,
      hosts: new FakeHosts(),
      policy: () => compilePolicy(EMPTY_CALLER_POLICY),
      onEvent: () => {
        throw new Error("notifier exploded");
      },
    });

    const result = await orchestrator.dispatch(
      { callerId: "codex", operations: expandOperations(["session.prompt", "task.read"]) },
      {
        requestId: "r1",
        workspace: { path: "E:/work/app" },
        session: { kind: "new" },
        messages: [{ text: "x", mode: "queue" }],
        wait: { until: "accepted", timeoutMs: 0 },
      },
    );
    expect(result.status).toBe("prompt_queued");
  });
});
