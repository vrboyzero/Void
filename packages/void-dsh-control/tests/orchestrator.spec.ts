import { describe, expect, it } from "vitest";
import { ControlOrchestrator } from "../src/orchestrator.js";
import { MemoryControlLedger } from "../src/ledger.js";
import { EMPTY_CALLER_POLICY, compilePolicy } from "../src/policy.js";
import { expandOperations, ControlError, type ControlOperation } from "../src/protocol.js";
import type { CallerIdentity } from "../src/auth.js";
import { signalFromAgentError, signalFromAgentStatus, signalsFromSessionEvent } from "../src/events.js";
import { FakeHosts } from "./support/fake-hosts.js";

function identity(callerId: string, operations: ControlOperation[] = ["session.prompt", "task.read", "task.cancel"]): CallerIdentity {
  return { callerId, operations: expandOperations(operations) };
}

function build(options: { policy?: Parameters<typeof compilePolicy>[0]; hosts?: FakeHosts } = {}) {
  const hosts = options.hosts ?? new FakeHosts();
  const ledger = new MemoryControlLedger();
  const orchestrator = new ControlOrchestrator({
    ledger,
    hosts,
    policy: () => compilePolicy(options.policy ?? EMPTY_CALLER_POLICY),
  });
  return { hosts, ledger, orchestrator };
}

const NEW_SESSION = { kind: "new" } as const;

describe("orchestrator: scenario A — open a project path and create a session", () => {
  it("registers the workspace, creates a session, delivers the message and returns a cursor", async () => {
    const { hosts, orchestrator } = build();
    const result = await orchestrator.dispatch(identity("codex"), {
      requestId: "r1",
      workspace: { path: "E:/work/app" },
      session: NEW_SESSION,
      messages: [{ text: "请完成任务", mode: "queue" }],
      wait: { until: "accepted", timeoutMs: 0 },
    });

    expect(hosts.registeredPaths).toEqual(["E:/work/app"]);
    expect(result.taskId).toMatch(/^task-/);
    expect(result.workspaceId).toBeTruthy();
    expect(result.sessionId).toBeTruthy();
    expect(result.status).toBe("prompt_queued");
    expect(result.eventCursor).toBe("3");
    expect(hosts.deliveries).toHaveLength(1);
    expect(hosts.deliveries[0]).toMatchObject({ kind: "prompt", mode: "queue", text: "请完成任务" });
  });

  it("returns the live policy alongside the task", async () => {
    const { orchestrator } = build({
      policy: { ...EMPTY_CALLER_POLICY, callerInstructions: "先读文档", instructionsVersion: 7 },
    });
    const result = await orchestrator.dispatch(identity("codex"), {
      requestId: "r1",
      workspace: { path: "E:/work/app" },
      session: NEW_SESSION,
      messages: [{ text: "x", mode: "queue" }],
      wait: { until: "accepted", timeoutMs: 0 },
    });
    expect(result.callerInstructions).toBe("先读文档");
    expect(result.instructionsVersion).toBe(7);
  });
});

describe("orchestrator: scenario B — new session in an existing workspace", () => {
  it("attaches the new session to the workspace and leaves its other sessions alone", async () => {
    const { hosts, orchestrator } = build();
    const workspace = hosts.seedWorkspace("E:/work/app", ["session-existing"]);
    hosts.seedSession("session-existing", "E:/work/app");

    const result = await orchestrator.dispatch(identity("codex"), {
      requestId: "r1",
      workspace: { workspaceId: workspace.workspaceId },
      session: NEW_SESSION,
      messages: [{ text: "x", mode: "queue" }],
      wait: { until: "accepted", timeoutMs: 0 },
    });

    expect(hosts.registeredPaths).toEqual([]);
    expect(result.workspaceId).toBe(workspace.workspaceId);
    expect(result.sessionId).not.toBe("session-existing");
    expect(hosts.workspaces.get(workspace.workspaceId)!.sessionIds).toEqual(["session-existing", result.sessionId]);
    expect(hosts.deliveries.map((entry) => entry.sessionId)).toEqual([result.sessionId]);
  });
});

describe("orchestrator: scenario C — continue an existing or cold session", () => {
  it("delivers into a matching session", async () => {
    const { hosts, orchestrator } = build();
    hosts.seedWorkspace("E:/work/app", ["session-1"]);
    hosts.seedSession("session-1", "E:/work/app");

    const task = await orchestrator.sendMessage(identity("codex"), {
      requestId: "r1",
      sessionId: "session-1",
      message: { text: "继续", mode: "queue" },
    });

    expect(task.status).toBe("prompt_queued");
    expect(hosts.deliveries).toHaveLength(1);
  });

  it("resolves a session by its cwd even when the workspace list is stale", async () => {
    const { hosts, orchestrator } = build();
    const workspace = hosts.seedWorkspace("E:/work/app", []);
    hosts.seedSession("session-cold", "E:/work/app");

    const result = await orchestrator.dispatch(identity("codex"), {
      requestId: "r1",
      workspace: { workspaceId: workspace.workspaceId },
      session: { kind: "existing", sessionId: "session-cold" },
      messages: [{ text: "x", mode: "queue" }],
      wait: { until: "accepted", timeoutMs: 0 },
    });

    expect(result.sessionId).toBe("session-cold");
    expect(hosts.deliveries).toHaveLength(1);
  });

  it("fails a workspace mismatch without writing a message", async () => {
    const { hosts, orchestrator } = build();
    const workspace = hosts.seedWorkspace("E:/work/app", []);
    hosts.seedSession("session-other", "E:/work/other");

    const error = await orchestrator
      .dispatch(identity("codex"), {
        requestId: "r1",
        workspace: { workspaceId: workspace.workspaceId },
        session: { kind: "existing", sessionId: "session-other" },
        messages: [{ text: "x", mode: "queue" }],
        wait: { until: "accepted", timeoutMs: 0 },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ControlError);
    expect((error as ControlError).code).toBe("dsh-control/session-workspace-mismatch");
    expect(hosts.deliveries).toEqual([]);
  });

  it("fails an unknown session without writing a message", async () => {
    const { hosts, orchestrator } = build();
    const error = await orchestrator
      .sendMessage(identity("codex"), { requestId: "r1", sessionId: "missing", message: { text: "x", mode: "queue" } })
      .catch((caught: unknown) => caught);
    expect((error as ControlError).code).toBe("dsh-control/session-not-found");
    expect(hosts.deliveries).toEqual([]);
  });
});

describe("orchestrator: scenario D — idempotency", () => {
  it("replays the original task instead of creating a second session or message", async () => {
    const { hosts, orchestrator } = build();
    const command = {
      requestId: "same",
      workspace: { path: "E:/work/app" },
      session: NEW_SESSION,
      messages: [{ text: "x", mode: "queue" } as const],
      wait: { until: "accepted", timeoutMs: 0 } as const,
    };

    const first = await orchestrator.dispatch(identity("codex"), command);
    const second = await orchestrator.dispatch(identity("codex"), command);

    expect(second.taskId).toBe(first.taskId);
    expect(second.sessionId).toBe(first.sessionId);
    expect(hosts.registeredPaths).toEqual(["E:/work/app"]);
    expect(hosts.deliveries).toHaveLength(1);
  });

  it("scopes idempotency per caller", async () => {
    const { hosts, orchestrator } = build();
    const command = {
      requestId: "same",
      workspace: { path: "E:/work/app" },
      session: NEW_SESSION,
      messages: [{ text: "x", mode: "queue" } as const],
      wait: { until: "accepted", timeoutMs: 0 } as const,
    };

    const first = await orchestrator.dispatch(identity("codex"), command);
    const second = await orchestrator.dispatch(identity("claude"), command);

    expect(second.taskId).not.toBe(first.taskId);
    expect(hosts.deliveries).toHaveLength(2);
  });

  it("records the replay in the event trail", async () => {
    const { orchestrator } = build();
    const command = {
      requestId: "same",
      workspace: { path: "E:/work/app" },
      session: NEW_SESSION,
      messages: [{ text: "x", mode: "queue" } as const],
      wait: { until: "accepted", timeoutMs: 0 } as const,
    };
    await orchestrator.dispatch(identity("codex"), command);
    const result = await orchestrator.dispatch(identity("codex"), command);
    const snapshot = orchestrator.getTask(identity("codex"), { taskId: result.taskId, limit: 50 });
    expect(snapshot.events.map((event) => event.kind)).toContain("idempotent_replay");
  });
});

describe("orchestrator: scenario F — cursor resume", () => {
  it("returns only events after the cursor and never re-delivers", async () => {
    const { hosts, orchestrator } = build();
    const result = await orchestrator.dispatch(identity("codex"), {
      requestId: "r1",
      workspace: { path: "E:/work/app" },
      session: NEW_SESSION,
      messages: [{ text: "x", mode: "queue" }],
      wait: { until: "accepted", timeoutMs: 0 },
    });

    const first = orchestrator.getTask(identity("codex"), { taskId: result.taskId, limit: 50 });
    expect(first.events.map((event) => event.seq)).toEqual([0, 1, 2, 3]);

    const second = orchestrator.getTask(identity("codex"), {
      taskId: result.taskId,
      afterCursor: first.task.eventCursor,
      limit: 50,
    });
    expect(second.events).toEqual([]);
    expect(hosts.deliveries).toHaveLength(1);
  });

  it("waits for a target status and returns events after the cursor", async () => {
    const { orchestrator } = build();
    const result = await orchestrator.dispatch(identity("codex"), {
      requestId: "r1",
      workspace: { path: "E:/work/app" },
      session: NEW_SESSION,
      messages: [{ text: "x", mode: "queue" }],
      wait: { until: "accepted", timeoutMs: 0 },
    });

    const pending = orchestrator.waitTask(identity("codex"), {
      taskId: result.taskId,
      afterCursor: result.eventCursor,
      until: "completed",
      timeoutMs: 5_000,
      limit: 50,
    });

    // The host reports the turn lifecycle; the task then settles by itself.
    await orchestrator.applySignal(result.sessionId, signalFromAgentStatus(true));
    await orchestrator.applySignal(
      result.sessionId,
      signalsFromSessionEvent({ type: "turn/end", seq: 3, time: 0, data: { reason: { kind: "stop" } } })[0]!,
    );
    await orchestrator.applySignal(result.sessionId, signalFromAgentStatus(false));

    const snapshot = await pending;
    expect(snapshot.task.status).toBe("completed");
    // A duplicate idle notification carries no new information.
    expect(snapshot.events.map((event) => event.status)).toEqual(["running", "idle", "completed"]);
  });

  it("times out without changing the task", async () => {
    const { orchestrator } = build();
    const result = await orchestrator.dispatch(identity("codex"), {
      requestId: "r1",
      workspace: { path: "E:/work/app" },
      session: NEW_SESSION,
      messages: [{ text: "x", mode: "queue" }],
      wait: { until: "accepted", timeoutMs: 0 },
    });
    const snapshot = await orchestrator.waitTask(identity("codex"), {
      taskId: result.taskId,
      until: "completed",
      timeoutMs: 30,
      limit: 50,
    });
    expect(snapshot.task.status).toBe("prompt_queued");
  });
});

describe("orchestrator: assistant summary", () => {
  it("accumulates bounded assistant text and marks truncation", async () => {
    const { orchestrator } = build();
    const result = await orchestrator.dispatch(identity("codex"), {
      requestId: "r1",
      workspace: { path: "E:/work/app" },
      session: NEW_SESSION,
      messages: [{ text: "x", mode: "queue" }],
      wait: { until: "accepted", timeoutMs: 0 },
    });

    await orchestrator.applySignal(result.sessionId, {
      status: "assistant_message",
      summary: "assistant message",
      sessionSeq: 1,
      assistantText: "done",
    });

    const snapshot = orchestrator.getTask(identity("codex"), { taskId: result.taskId, limit: 50 });
    expect(snapshot.task.assistantSummary).toBe("done");
    expect(snapshot.task.assistantSummaryTruncated).toBe(false);
  });
});

describe("orchestrator: task locks", () => {
  it("refuses a competing steer", async () => {
    const { hosts, orchestrator } = build();
    hosts.seedWorkspace("E:/work/app", ["session-1"]);
    hosts.seedSession("session-1", "E:/work/app");

    await orchestrator.sendMessage(identity("codex"), {
      requestId: "r1",
      sessionId: "session-1",
      message: { text: "a", mode: "steer" },
    });

    const error = await orchestrator
      .sendMessage(identity("claude"), {
        requestId: "r2",
        sessionId: "session-1",
        message: { text: "b", mode: "steer" },
      })
      .catch((caught: unknown) => caught);

    expect((error as ControlError).code).toBe("dsh-control/session-locked");
    expect(hosts.deliveries).toHaveLength(1);
  });

  it("refuses a competing queued message while another task holds the lock", async () => {
    // §7.3: only one external control task owns a session at a time. A queued
    // message that slipped through would overwrite the session→task mapping and
    // steal running/idle attribution from the task that actually drives it.
    const { hosts, orchestrator } = build();
    hosts.seedWorkspace("E:/work/app", ["session-1"]);
    hosts.seedSession("session-1", "E:/work/app");

    await orchestrator.sendMessage(identity("codex"), {
      requestId: "r1",
      sessionId: "session-1",
      message: { text: "a", mode: "steer" },
    });

    const error = await orchestrator
      .sendMessage(identity("claude"), {
        requestId: "r2",
        sessionId: "session-1",
        message: { text: "b", mode: "queue" },
      })
      .catch((caught: unknown) => caught);

    expect((error as ControlError).code).toBe("dsh-control/session-locked");
    // The refused message never reached the host.
    expect(hosts.deliveries).toHaveLength(1);
  });

  it("keeps routing host events to the task that owns the session", async () => {
    const { hosts, orchestrator } = build();
    hosts.seedWorkspace("E:/work/app", ["session-1"]);
    hosts.seedSession("session-1", "E:/work/app");

    const owner = await orchestrator.sendMessage(identity("codex"), {
      requestId: "r1",
      sessionId: "session-1",
      message: { text: "a", mode: "queue" },
    });
    await orchestrator
      .sendMessage(identity("claude"), { requestId: "r2", sessionId: "session-1", message: { text: "b", mode: "queue" } })
      .catch(() => undefined);

    await orchestrator.applySignal("session-1", { status: "running", summary: "turn started" });
    await orchestrator.applySignal("session-1", { status: "idle", summary: "turn ended (stop)" });

    const snapshot = orchestrator.getTask(identity("codex"), { taskId: owner.taskId, limit: 50 });
    expect(snapshot.task.status).toBe("completed");
    expect(orchestrator.lockSnapshot().size).toBe(0);
  });

  it("does not let an inject-only task take session ownership", async () => {
    const { hosts, orchestrator } = build();
    hosts.seedWorkspace("E:/work/app", ["session-1"]);
    hosts.seedSession("session-1", "E:/work/app");

    const owner = await orchestrator.sendMessage(identity("codex"), {
      requestId: "r1",
      sessionId: "session-1",
      message: { text: "a", mode: "queue" },
    });
    await orchestrator.injectContext(identity("claude"), { requestId: "r2", sessionId: "session-1", text: "hint" });

    await orchestrator.applySignal("session-1", { status: "running", summary: "turn started" });
    await orchestrator.applySignal("session-1", { status: "idle", summary: "turn ended (stop)" });

    const snapshot = orchestrator.getTask(identity("codex"), { taskId: owner.taskId, limit: 50 });
    expect(snapshot.task.status).toBe("completed");
  });

  it("releases the lock when the owning task reaches a terminal status", async () => {
    const { hosts, orchestrator } = build();
    hosts.seedWorkspace("E:/work/app", ["session-1"]);
    hosts.seedSession("session-1", "E:/work/app");

    const task = await orchestrator.sendMessage(identity("codex"), {
      requestId: "r1",
      sessionId: "session-1",
      message: { text: "a", mode: "steer" },
    });
    await orchestrator.cancelTask(identity("codex"), { taskId: task.taskId });
    expect(orchestrator.lockSnapshot().size).toBe(0);

    await expect(
      orchestrator.sendMessage(identity("claude"), {
        requestId: "r2",
        sessionId: "session-1",
        message: { text: "b", mode: "steer" },
      }),
    ).resolves.toBeTruthy();
  });
});

describe("orchestrator: cancel", () => {
  it("cancels through the host and marks the task cancelled", async () => {
    const { hosts, orchestrator } = build();
    const result = await orchestrator.dispatch(identity("codex"), {
      requestId: "r1",
      workspace: { path: "E:/work/app" },
      session: NEW_SESSION,
      messages: [{ text: "x", mode: "queue" }],
      wait: { until: "accepted", timeoutMs: 0 },
    });

    const task = await orchestrator.cancelTask(identity("codex"), { taskId: result.taskId });
    expect(task.status).toBe("cancelled");
    expect(hosts.deliveries.some((entry) => entry.kind === "cancel")).toBe(true);
    // Cancellation never deletes a session.
    expect(hosts.sessions.has(result.sessionId)).toBe(true);
  });

  it("is a no-op for an already terminal task", async () => {
    const { hosts, orchestrator } = build();
    const result = await orchestrator.dispatch(identity("codex"), {
      requestId: "r1",
      workspace: { path: "E:/work/app" },
      session: NEW_SESSION,
      messages: [{ text: "x", mode: "queue" }],
      wait: { until: "accepted", timeoutMs: 0 },
    });
    await orchestrator.cancelTask(identity("codex"), { taskId: result.taskId });
    const again = await orchestrator.cancelTask(identity("codex"), { taskId: result.taskId });
    expect(again.status).toBe("cancelled");
    expect(hosts.deliveries.filter((entry) => entry.kind === "cancel")).toHaveLength(1);
  });

  it("hides another caller's task from a caller without task.read", async () => {
    const { orchestrator } = build();
    const result = await orchestrator.dispatch(identity("codex"), {
      requestId: "r1",
      workspace: { path: "E:/work/app" },
      session: NEW_SESSION,
      messages: [{ text: "x", mode: "queue" }],
      wait: { until: "accepted", timeoutMs: 0 },
    });
    const stranger = identity("stranger", ["session.prompt"]);
    expect(() => orchestrator.getTask(stranger, { taskId: result.taskId, limit: 10 })).toThrowError(ControlError);
    expect(() => orchestrator.getTask(stranger, { taskId: result.taskId, limit: 10 })).toThrowError(/unknown task/);
  });
});

describe("orchestrator: inject", () => {
  it("injects without waking the agent and says so", async () => {
    const { hosts, orchestrator } = build();
    hosts.seedWorkspace("E:/work/app", ["session-1"]);
    hosts.seedSession("session-1", "E:/work/app");

    const task = await orchestrator.injectContext(identity("codex", ["session.inject"]), {
      requestId: "r1",
      sessionId: "session-1",
      text: "背景信息",
    });

    // Injection is a delivery, not a request for work: the task settles at once
    // so it never occupies the caller's concurrency budget.
    expect(task.status).toBe("completed");
    expect(hosts.deliveries).toEqual([{ kind: "inject", sessionId: "session-1", requestId: "r1", text: "背景信息" }]);
    const snapshot = orchestrator.getTask(identity("codex"), { taskId: task.taskId, limit: 50 });
    expect(snapshot.events.map((event) => event.status)).toEqual([
      "accepted",
      "session_resumed",
      "prompt_queued",
      "idle",
      "completed",
    ]);
    expect(snapshot.events.at(-3)!.summary).toMatch(/not executed/);
  });
});

describe("orchestrator: failure handling", () => {
  it("records a stable failure on the task and rethrows", async () => {
    const { orchestrator, ledger } = build();
    const error = await orchestrator
      .dispatch(identity("codex"), {
        requestId: "r1",
        workspace: { workspaceId: "missing" },
        session: NEW_SESSION,
        messages: [{ text: "x", mode: "queue" }],
        wait: { until: "accepted", timeoutMs: 0 },
      })
      .catch((caught: unknown) => caught);

    expect((error as ControlError).code).toBe("dsh-control/workspace-not-found");
    const tasks = ledger.listTasks();
    // The workspace failure happens before the task exists, so nothing is left behind.
    expect(tasks).toEqual([]);
  });

  it("summarizes a host failure without forwarding its message", async () => {
    const hosts = new FakeHosts();
    hosts.promptSession = async () => {
      throw new Error("E:/secret/path exploded");
    };
    const { orchestrator, ledger } = build({ hosts });

    const error = await orchestrator
      .dispatch(identity("codex"), {
        requestId: "r1",
        workspace: { path: "E:/work/app" },
        session: NEW_SESSION,
        messages: [{ text: "x", mode: "queue" }],
        wait: { until: "accepted", timeoutMs: 0 },
      })
      .catch((caught: unknown) => caught);

    // A raw host failure is normalized before it leaves the orchestrator, so a
    // caller can never see the host's own message.
    expect(error).toBeInstanceOf(ControlError);
    expect((error as ControlError).code).toBe("dsh-control/host-unavailable");
    expect((error as ControlError).message).not.toContain("secret");

    const task = ledger.listTasks()[0]!;
    expect(task.status).toBe("failed");
    expect(task.errorCode).toBe("dsh-control/host-unavailable");
    expect(task.errorMessage).not.toContain("secret");
  });

  it("enforces the per-caller active-task cap", async () => {
    const { orchestrator } = build();
    const results = [];
    for (let index = 0; index < 8; index += 1) {
      results.push(
        await orchestrator.dispatch(identity("codex"), {
          requestId: `r${index}`,
          workspace: { path: "E:/work/app" },
          session: NEW_SESSION,
          messages: [{ text: "x", mode: "queue" }],
          wait: { until: "accepted", timeoutMs: 0 },
        }),
      );
    }
    const error = await orchestrator
      .dispatch(identity("codex"), {
        requestId: "overflow",
        workspace: { path: "E:/work/app" },
        session: NEW_SESSION,
        messages: [{ text: "x", mode: "queue" }],
        wait: { until: "accepted", timeoutMs: 0 },
      })
      .catch((caught: unknown) => caught);
    expect((error as ControlError).code).toBe("dsh-control/limit-exceeded");
  });

  it("refuses new work after disposal begins", async () => {
    const { orchestrator } = build();
    orchestrator.stopAccepting();
    const error = await orchestrator
      .dispatch(identity("codex"), {
        requestId: "r1",
        workspace: { path: "E:/work/app" },
        session: NEW_SESSION,
        messages: [{ text: "x", mode: "queue" }],
        wait: { until: "accepted", timeoutMs: 0 },
      })
      .catch((caught: unknown) => caught);
    expect((error as ControlError).code).toBe("dsh-control/host-unavailable");
  });

  it("rejects forbidden content before touching the host", async () => {
    const { hosts, orchestrator } = build({
      policy: { ...EMPTY_CALLER_POLICY, forbiddenPatterns: ["BEGIN PRIVATE KEY"] },
    });
    const error = await orchestrator
      .dispatch(identity("codex"), {
        requestId: "r1",
        workspace: { path: "E:/work/app" },
        session: NEW_SESSION,
        messages: [{ text: "-----BEGIN PRIVATE KEY-----", mode: "queue" }],
        wait: { until: "accepted", timeoutMs: 0 },
      })
      .catch((caught: unknown) => caught);
    expect((error as ControlError).code).toBe("dsh-control/policy-forbidden-content");
    expect(hosts.deliveries).toEqual([]);
    expect(hosts.registeredPaths).toEqual([]);
  });
});

describe("orchestrator: agent signals", () => {
  it("maps an agent error to a failed task and releases the lock", async () => {
    const { orchestrator } = build();
    const result = await orchestrator.dispatch(identity("codex"), {
      requestId: "r1",
      workspace: { path: "E:/work/app" },
      session: NEW_SESSION,
      messages: [{ text: "x", mode: "queue" }],
      wait: { until: "accepted", timeoutMs: 0 },
    });

    await orchestrator.applySignal(result.sessionId, signalFromAgentError("model unavailable"));
    const snapshot = orchestrator.getTask(identity("codex"), { taskId: result.taskId, limit: 50 });
    expect(snapshot.task.status).toBe("failed");
    expect(snapshot.events.at(-1)!.summary).toContain("model unavailable");
    expect(orchestrator.lockSnapshot().size).toBe(0);
  });

  it("ignores signals for sessions no task owns", async () => {
    const { orchestrator } = build();
    await expect(orchestrator.applySignal("nobody", signalFromAgentStatus(true))).resolves.toBeUndefined();
  });

  it("ignores signals after a task is terminal", async () => {
    const { orchestrator } = build();
    const result = await orchestrator.dispatch(identity("codex"), {
      requestId: "r1",
      workspace: { path: "E:/work/app" },
      session: NEW_SESSION,
      messages: [{ text: "x", mode: "queue" }],
      wait: { until: "accepted", timeoutMs: 0 },
    });
    await orchestrator.cancelTask(identity("codex"), { taskId: result.taskId });
    await orchestrator.applySignal(result.sessionId, signalFromAgentStatus(true));
    const snapshot = orchestrator.getTask(identity("codex"), { taskId: result.taskId, limit: 50 });
    expect(snapshot.task.status).toBe("cancelled");
  });
});

describe("orchestrator: listings", () => {
  it("filters workspaces by path prefix", async () => {
    const { hosts, orchestrator } = build();
    hosts.seedWorkspace("E:/work/app");
    hosts.seedWorkspace("E:/other/app");
    const items = await orchestrator.listWorkspaces("E:/work");
    expect(items.map((item) => item.path)).toEqual(["E:/work/app"]);
    expect(items[0]!.sessionCount).toBe(0);
  });

  it("filters sessions by workspace membership", async () => {
    const { hosts, orchestrator } = build();
    const workspace = hosts.seedWorkspace("E:/work/app", ["session-1"]);
    hosts.seedSession("session-1", "E:/work/app");
    hosts.seedSession("session-2", "E:/other/app");

    const items = await orchestrator.listSessions({ workspaceId: workspace.workspaceId });
    expect(items.map((item) => item.sessionId)).toEqual(["session-1"]);
    expect(items[0]!.resumable).toBe(true);
  });

  it("fails a listing for an unknown workspace", async () => {
    const { orchestrator } = build();
    await expect(orchestrator.listSessions({ workspaceId: "nope" })).rejects.toThrowError(/not registered/);
  });
});
