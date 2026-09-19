/**
 * Regression tests for the issues recorded in plan §26.
 *
 * Each block names the review item it locks down, so a future refactor that
 * reintroduces the defect fails with the reason rather than just a red test.
 */
import { describe, expect, it } from "vitest";
import { ControlOrchestrator } from "../src/orchestrator.js";
import { MemoryControlLedger, StorageControlLedger, controlDomainSpec, type TaskRecord } from "../src/ledger.js";
import { EMPTY_CALLER_POLICY, compilePolicy } from "../src/policy.js";
import { ControlError, expandOperations, type ControlOperation } from "../src/protocol.js";
import type { CallerIdentity } from "../src/auth.js";
import { FakeHosts } from "./support/fake-hosts.js";

function identity(callerId: string, operations: ControlOperation[] = ["session.prompt", "task.read", "task.cancel"]): CallerIdentity {
  return { callerId, operations: expandOperations(operations) };
}

function build(options: { hosts?: FakeHosts; ledger?: MemoryControlLedger } = {}) {
  const hosts = options.hosts ?? new FakeHosts();
  const ledger = options.ledger ?? new MemoryControlLedger();
  const orchestrator = new ControlOrchestrator({
    ledger,
    hosts,
    policy: () => compilePolicy(EMPTY_CALLER_POLICY),
  });
  return { hosts, ledger, orchestrator };
}

const NEW_SESSION = { kind: "new" } as const;

/** Spin the event loop until a condition holds, so races are observed, not guessed. */
async function until(predicate: () => boolean, turns = 200): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition never became true");
}

/** Let a few macrotask turns pass without asserting anything. */
async function tick(turns = 5): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function dispatchCommand(requestId: string, path = "E:/work/app") {
  return {
    requestId,
    workspace: { path },
    session: NEW_SESSION,
    messages: [{ text: "请完成任务", mode: "queue" as const }],
    wait: { until: "accepted" as const, timeoutMs: 0 },
  };
}

describe("§26.1-3 idempotency has no read-then-reserve window", () => {
  it("delivers once when two identical requests race", async () => {
    const { hosts, orchestrator } = build();
    hosts.seedWorkspace("E:/work/app", ["session-1"]);
    hosts.seedSession("session-1", "E:/work/app");

    // Both chains start before either can observe the other's reservation.
    const [first, second] = await Promise.all([
      orchestrator.sendMessage(identity("codex"), {
        requestId: "r-race",
        sessionId: "session-1",
        message: { text: "a", mode: "queue" },
      }),
      orchestrator.sendMessage(identity("codex"), {
        requestId: "r-race",
        sessionId: "session-1",
        message: { text: "a", mode: "queue" },
      }),
    ]);

    expect(first.taskId).toBe(second.taskId);
    expect(hosts.promptCount).toBe(1);
  });

  it("delivers once when two identical dispatches race", async () => {
    const { hosts, orchestrator } = build();
    const [first, second] = await Promise.all([
      orchestrator.dispatch(identity("codex"), dispatchCommand("r-race")),
      orchestrator.dispatch(identity("codex"), dispatchCommand("r-race")),
    ]);

    expect(first.taskId).toBe(second.taskId);
    expect(hosts.promptCount).toBe(1);
    expect(hosts.registeredPaths).toHaveLength(1);
  });

  it("still lets different requestIds run concurrently", async () => {
    const { hosts, orchestrator } = build();
    hosts.seedWorkspace("E:/work/app", ["session-1", "session-2"]);
    hosts.seedSession("session-1", "E:/work/app");
    hosts.seedSession("session-2", "E:/work/app");

    await Promise.all([
      orchestrator.sendMessage(identity("codex"), { requestId: "r1", sessionId: "session-1", message: { text: "a", mode: "queue" } }),
      orchestrator.sendMessage(identity("codex"), { requestId: "r2", sessionId: "session-2", message: { text: "b", mode: "queue" } }),
    ]);

    expect(hosts.promptCount).toBe(2);
  });

  it("scopes the key by caller, so two callers may reuse a requestId", async () => {
    const { hosts, orchestrator } = build();
    hosts.seedWorkspace("E:/work/app", ["session-1", "session-2"]);
    hosts.seedSession("session-1", "E:/work/app");
    hosts.seedSession("session-2", "E:/work/app");

    await orchestrator.sendMessage(identity("codex"), { requestId: "shared", sessionId: "session-1", message: { text: "a", mode: "queue" } });
    await orchestrator.sendMessage(identity("claude"), { requestId: "shared", sessionId: "session-2", message: { text: "b", mode: "queue" } });

    expect(hosts.promptCount).toBe(2);
  });
});

describe("§26.1-6 disposal drains accepted work", () => {
  it("waits for an in-flight admission chain before settling", async () => {
    const hosts = new FakeHosts();
    hosts.seedWorkspace("E:/work/app", ["session-1"]);
    hosts.seedSession("session-1", "E:/work/app");
    hosts.holdPrompts();
    const { orchestrator, ledger } = build({ hosts });

    const pending = orchestrator.sendMessage(identity("codex"), {
      requestId: "r1",
      sessionId: "session-1",
      message: { text: "a", mode: "queue" },
    });
    // Wait until the delivery is genuinely parked inside the host.
    await until(() => hosts.startedPrompts === 1);
    expect(orchestrator.inflightCount).toBe(1);

    let drained = false;
    const drain = orchestrator.drain().then(() => {
      drained = true;
    });
    await tick();
    // Still blocked on the delivery the host has not finished.
    expect(drained).toBe(false);

    hosts.releasePrompts();
    await drain;
    expect(drained).toBe(true);

    // The task reached a durable state before the ledger is closed.
    const task = (await pending).taskId;
    expect(ledger.getTask(task)?.status).toBe("prompt_queued");
  });

  it("refuses work that was queued behind the same key", async () => {
    const hosts = new FakeHosts();
    hosts.seedWorkspace("E:/work/app", ["session-1"]);
    hosts.seedSession("session-1", "E:/work/app");
    hosts.holdPrompts();
    const { orchestrator } = build({ hosts });

    const first = orchestrator.sendMessage(identity("codex"), {
      requestId: "r1",
      sessionId: "session-1",
      message: { text: "a", mode: "queue" },
    });
    await until(() => hosts.startedPrompts === 1);
    // Same key: this chain can only start after the first one releases.
    const second = orchestrator.sendMessage(identity("codex"), {
      requestId: "r1",
      sessionId: "session-1",
      message: { text: "a", mode: "queue" },
    });

    const drained = orchestrator.drain();
    hosts.releasePrompts();
    await drained;
    await expect(second).rejects.toThrowError(/shutting down/);
    await first;
    expect(hosts.promptCount).toBe(1);
  });

  it("refuses a new request once draining", async () => {
    const { orchestrator } = build();
    await orchestrator.drain();
    await expect(
      orchestrator.sendMessage(identity("codex"), { requestId: "r1", sessionId: "s", message: { text: "a", mode: "queue" } }),
    ).rejects.toThrowError(ControlError);
    await expect(
      orchestrator.sendMessage(identity("codex"), { requestId: "r1", sessionId: "s", message: { text: "a", mode: "queue" } }),
    ).rejects.toThrowError(/shutting down/);
  });

  it("releases a long-poll instead of holding shutdown open", async () => {
    const { orchestrator } = build();
    const result = await orchestrator.dispatch(identity("codex"), dispatchCommand("r1"));
    expect(result.status).toBe("prompt_queued");

    const waiting = orchestrator.waitTask(identity("codex"), {
      taskId: result.taskId,
      until: "completed",
      timeoutMs: 120_000,
      limit: 50,
    });
    await until(() => orchestrator.inflightCount === 0);
    const drained = orchestrator.drain();
    // Neither the waiter nor the drain may sit on the full 120s timeout.
    await expect(waiting).resolves.toBeTruthy();
    await expect(drained).resolves.toBeUndefined();
  });
});

describe("§26.1-4 a locked session is never stolen", () => {
  it("attributes events to the owner and frees the lock when it completes", async () => {
    const { hosts, orchestrator } = build();
    hosts.seedWorkspace("E:/work/app", ["session-1"]);
    hosts.seedSession("session-1", "E:/work/app");

    const owner = await orchestrator.sendMessage(identity("codex"), {
      requestId: "r1",
      sessionId: "session-1",
      message: { text: "a", mode: "queue" },
    });
    const rival = await orchestrator
      .sendMessage(identity("claude"), { requestId: "r2", sessionId: "session-1", message: { text: "b", mode: "queue" } })
      .catch((error: unknown) => error);

    expect((rival as ControlError).code).toBe("dsh-control/session-locked");
    expect(orchestrator.lockSnapshot().get("session-1")).toBe(owner.taskId);

    await orchestrator.applySignal("session-1", { status: "running", summary: "turn started" });
    await orchestrator.applySignal("session-1", { status: "idle", summary: "turn ended (stop)" });

    expect(orchestrator.getTask(identity("codex"), { taskId: owner.taskId, limit: 50 }).task.status).toBe("completed");
    expect(orchestrator.lockSnapshot().size).toBe(0);

    // The lock is reusable once the owner is terminal.
    await expect(
      orchestrator.sendMessage(identity("claude"), { requestId: "r3", sessionId: "session-1", message: { text: "c", mode: "queue" } }),
    ).resolves.toBeTruthy();
  });

  it("frees the lock when the owner fails", async () => {
    const hosts = new FakeHosts();
    hosts.seedWorkspace("E:/work/app", ["session-1"]);
    hosts.seedSession("session-1", "E:/work/app");
    const { orchestrator } = build({ hosts });

    await orchestrator.sendMessage(identity("codex"), { requestId: "r1", sessionId: "session-1", message: { text: "a", mode: "queue" } });
    await orchestrator.applySignal("session-1", { status: "failed", summary: "model error" });
    expect(orchestrator.lockSnapshot().size).toBe(0);
  });
});

describe("§26.1-7 restart recovery adjudicates against the host", () => {
  /** Minimal in-memory storage domain double for recovery tests. */
  function storageLedger() {
    const tables = new Map<string, Map<string, unknown>>();
    const domain = {
      table(name: string) {
        const table = tables.get(name) ?? new Map<string, unknown>();
        tables.set(name, table);
        return {
          get: (key: string) => table.get(key),
          put: async (key: string, value: unknown) => {
            table.set(key, value);
          },
          keys: () => table.keys(),
          entries: () => table.entries(),
        };
      },
      close: async () => {},
    };
    return { ledger: new StorageControlLedger(domain as never), tables };
  }

  function orphan(overrides: Partial<TaskRecord>): TaskRecord {
    return {
      taskId: "task-orphan",
      callerId: "codex",
      requestId: "r1",
      status: "prompt_queued",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastCursor: 3,
      ...overrides,
    };
  }

  async function seed(ledger: StorageControlLedger, record: TaskRecord) {
    await ledger.putTask(record);
    for (const status of ["accepted", "workspace_resolved", "session_created", "prompt_queued"] as const) {
      await ledger.appendEvent({ taskId: record.taskId, kind: status, status, time: "t", summary: status });
    }
  }

  it("reports a delivered orphan as possibly-completed rather than never-sent", async () => {
    const { ledger } = storageLedger();
    await seed(ledger, orphan({ sessionId: "session-1" }));

    const report = await ledger.init({ sessionExists: async () => true });

    expect(report.orphanedTaskIds).toEqual(["task-orphan"]);
    expect(report.deliveredTaskIds).toEqual(["task-orphan"]);
    const task = ledger.getTask("task-orphan")!;
    expect(task.status).toBe("failed");
    expect(task.errorMessage).toMatch(/may have continued or completed/);
    expect(task.errorCode).toBe("dsh-control/host-unavailable");
  });

  it("reports an undelivered orphan as safely retryable", async () => {
    const { ledger } = storageLedger();
    await ledger.putTask(orphan({ status: "workspace_resolved", lastCursor: 1 }));
    await ledger.appendEvent({ taskId: "task-orphan", kind: "accepted", status: "accepted", time: "t", summary: "a" });
    await ledger.appendEvent({ taskId: "task-orphan", kind: "workspace_resolved", status: "workspace_resolved", time: "t", summary: "b" });

    const report = await ledger.init({ sessionExists: async () => true });

    expect(report.orphanedTaskIds).toEqual(["task-orphan"]);
    expect(report.deliveredTaskIds).toEqual([]);
    expect(ledger.getTask("task-orphan")!.errorMessage).toMatch(/before the request reached the session/);
  });

  it("notes when a delivered orphan's session is gone", async () => {
    const { ledger } = storageLedger();
    await seed(ledger, orphan({ sessionId: "session-gone" }));
    await ledger.init({ sessionExists: async () => false });
    expect(ledger.getTask("task-orphan")!.errorMessage).toMatch(/session no longer exists/);
  });

  it("still fails an orphan when no adjudicator is available", async () => {
    const { ledger } = storageLedger();
    await seed(ledger, orphan({ sessionId: "session-1" }));
    const report = await ledger.init();
    expect(report.orphanedTaskIds).toEqual(["task-orphan"]);
    expect(report.deliveredTaskIds).toEqual(["task-orphan"]);
    expect(ledger.getTask("task-orphan")!.status).toBe("failed");
  });

  it("leaves a terminal task alone", async () => {
    const { ledger } = storageLedger();
    await ledger.putTask(orphan({ status: "completed", lastCursor: 0 }));
    await ledger.appendEvent({ taskId: "task-orphan", kind: "completed", status: "completed", time: "t", summary: "done" });
    const report = await ledger.init({ sessionExists: async () => true });
    expect(report.orphanedTaskIds).toEqual([]);
    expect(ledger.getTask("task-orphan")!.status).toBe("completed");
  });
});

describe("§26.1-5 the notifier never blocks the lifecycle write", () => {
  it("commits every event while the notifier is stalled", async () => {
    const { hosts, orchestrator, ledger } = build();
    hosts.seedWorkspace("E:/work/app", ["session-1"]);
    hosts.seedSession("session-1", "E:/work/app");

    let observed = 0;
    const stalled = new ControlOrchestrator({
      ledger,
      hosts,
      policy: () => compilePolicy(EMPTY_CALLER_POLICY),
      onEvent: () => {
        observed += 1;
        // A notifier that never settles must not stall anything.
        return new Promise<void>(() => {});
      },
    });

    const result = await stalled.dispatch(identity("codex"), dispatchCommand("r1"));
    expect(result.status).toBe("prompt_queued");
    expect(observed).toBeGreaterThan(0);
    await stalled.applySignal(result.sessionId, { status: "running", summary: "turn started" });
    await stalled.applySignal(result.sessionId, { status: "idle", summary: "turn ended (stop)" });
    expect(ledger.getTask(result.taskId)!.status).toBe("completed");
    await stalled.drain();
  });

  it("keeps a rejected notifier promise from surfacing", async () => {
    const { hosts, ledger } = build();
    hosts.seedWorkspace("E:/work/app", ["session-1"]);
    hosts.seedSession("session-1", "E:/work/app");
    const orchestrator = new ControlOrchestrator({
      ledger,
      hosts,
      policy: () => compilePolicy(EMPTY_CALLER_POLICY),
      onEvent: async () => {
        throw new Error("receiver exploded");
      },
    });
    const result = await orchestrator.dispatch(identity("codex"), dispatchCommand("r1"));
    expect(result.status).toBe("prompt_queued");
  });
});

describe("ledger domain stays declarative", () => {
  it("keeps the declared domain name and version", () => {
    expect(controlDomainSpec.name).toBe("dsh_agent_control");
    expect(controlDomainSpec.version).toBe(1);
  });
});
