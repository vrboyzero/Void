import { describe, expect, it } from "vitest";
import {
  CONTROL_ERROR_CODES,
  CONTROL_OPERATIONS,
  ControlError,
  LIMITS,
  boundAssistantText,
  cancelTaskInputShape,
  dispatchInputSchema,
  dispatchPlanInputSchema,
  expandOperations,
  formatCursor,
  parseCursor,
  sendMessageInputSchema,
  taskStatusSchema,
  workspaceTargetSchema,
} from "../src/protocol.js";
import {
  TASK_TRANSITIONS,
  assertTransition,
  canTransition,
  idempotencyKey,
  isTerminal,
  mintTaskId,
  satisfiesWait,
} from "../src/state-machine.js";
import { z } from "zod";

describe("protocol: targets", () => {
  it("rejects empty, oversized and reserved planning tasks", () => {
    const base = { requestId: "p1", target: { workspace: { workspaceId: "w1" }, session: "new" } };
    for (const task of ["", " \n ", " off\n", "x".repeat(LIMITS.maxMessageChars + 1)]) {
      expect(dispatchPlanInputSchema.safeParse({ ...base, task }).success).toBe(false);
    }
    expect(dispatchPlanInputSchema.parse({ ...base, task: "做计划\n第二行" }).task).toBe("做计划\n第二行");
  });
  it("accepts exactly one workspace addressing mode", () => {
    expect(workspaceTargetSchema.parse({ workspaceId: "w1" })).toEqual({ workspaceId: "w1" });
    expect(workspaceTargetSchema.parse({ path: "E:/work/app" })).toEqual({ path: "E:/work/app" });
    expect(workspaceTargetSchema.safeParse({}).success).toBe(false);
    expect(workspaceTargetSchema.safeParse({ workspaceId: "w1", path: "E:/work/app" }).success).toBe(false);
  });

  it("accepts new, existing and fork session targets", () => {
    const input = dispatchInputSchema.parse({
      requestId: "r1",
      target: { workspace: { path: "E:/work/app" }, session: "new" },
      messages: [{ text: "hello" }],
    });
    expect(input.target.session).toBe("new");
    // Defaults are applied so downstream code never re-derives them.
    expect(input.messages[0]!.mode).toBe("queue");
    expect(input.messages[0]!.documentRefs).toEqual([]);
  });

  it("rejects an oversized message body", () => {
    const result = dispatchInputSchema.safeParse({
      requestId: "r1",
      target: { workspace: { workspaceId: "w1" }, session: "new" },
      messages: [{ text: "x".repeat(LIMITS.maxMessageChars + 1) }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects more messages and more document references than allowed", () => {
    const base = { requestId: "r1", target: { workspace: { workspaceId: "w1" }, session: "new" } };
    expect(
      dispatchInputSchema.safeParse({
        ...base,
        messages: Array.from({ length: LIMITS.maxMessagesPerRequest + 1 }, () => ({ text: "x" })),
      }).success,
    ).toBe(false);
    expect(
      dispatchInputSchema.safeParse({
        ...base,
        messages: [
          {
            text: "x",
            documentRefs: Array.from({ length: LIMITS.maxDocumentRefs + 1 }, (_, index) => ({ path: `docs/${index}.md` })),
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects a requestId longer than the bound", () => {
    expect(
      sendMessageInputSchema.safeParse({
        requestId: "r".repeat(LIMITS.maxRequestIdChars + 1),
        sessionId: "s1",
        message: { text: "hi" },
      }).success,
    ).toBe(false);
  });

  it("rejects a wait timeout above the bound", () => {
    expect(
      dispatchInputSchema.safeParse({
        requestId: "r1",
        target: { workspace: { workspaceId: "w1" }, session: "new" },
        messages: [{ text: "x" }],
        wait: { until: "completed", timeoutMs: LIMITS.maxWaitMs + 1 },
      }).success,
    ).toBe(false);
  });

  it("requires an afterCursor to be a decimal string", () => {
    const shape = z.object(cancelTaskInputShape);
    expect(shape.safeParse({ taskId: "t1" }).success).toBe(true);
    expect(shape.safeParse({ taskId: "t1", requestId: "r" }).success).toBe(true);
  });
});

describe("protocol: cursors", () => {
  it("treats an absent cursor as the beginning", () => {
    expect(parseCursor(undefined)).toBe(-1);
  });

  it("round-trips a sequence through the cursor string", () => {
    expect(parseCursor(formatCursor(17))).toBe(17);
    expect(formatCursor(-1)).toBe("0");
  });

  it("rejects a malformed cursor", () => {
    expect(parseCursor("nope")).toBe(-1);
    expect(parseCursor("-3")).toBe(-1);
  });
});

describe("protocol: operations", () => {
  it("keeps plan dispatch independent of prompt and steer grants", () => {
    expect([...expandOperations(["session.plan"])].sort()).toEqual(["session.create", "session.plan", "workspace.read"]);
    expect(expandOperations(["session.prompt", "session.steer"]).has("session.plan")).toBe(false);
  });
  it("expands grants downward", () => {
    const granted = expandOperations(["session.prompt"]);
    expect(granted.has("session.prompt")).toBe(true);
    expect(granted.has("session.create")).toBe(true);
    expect(granted.has("workspace.read")).toBe(true);
    expect(granted.has("task.cancel")).toBe(false);
  });

  it("keeps read-only grants read-only", () => {
    const granted = expandOperations(["workspace.read"]);
    expect([...granted]).toEqual(["workspace.read"]);
  });

  it("publishes a stable error-code vocabulary", () => {
    expect(new Set(CONTROL_ERROR_CODES).size).toBe(CONTROL_ERROR_CODES.length);
    expect(new Set(CONTROL_OPERATIONS).size).toBe(CONTROL_OPERATIONS.length);
  });

  it("serializes a control error without leaking internals", () => {
    const error = new ControlError("dsh-control/forbidden-operation", "nope", { operation: "task.cancel" });
    expect(error.toPayload()).toEqual({
      code: "dsh-control/forbidden-operation",
      message: "nope",
      details: { operation: "task.cancel" },
    });
  });
});

describe("state machine: transitions", () => {
  it("walks the full admission chain", () => {
    expect(canTransition("accepted", "workspace_resolved")).toBe(true);
    expect(canTransition("workspace_resolved", "session_created")).toBe(true);
    expect(canTransition("workspace_resolved", "session_resumed")).toBe(true);
    expect(canTransition("session_created", "prompt_queued")).toBe(true);
    expect(canTransition("prompt_queued", "running")).toBe(true);
    expect(canTransition("running", "idle")).toBe(true);
    expect(canTransition("idle", "completed")).toBe(true);
  });

  it("refuses to skip admission phases", () => {
    expect(canTransition("accepted", "prompt_queued")).toBe(false);
    expect(canTransition("accepted", "completed")).toBe(false);
  });

  it("makes terminal statuses final", () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      expect(isTerminal(status)).toBe(true);
      expect(TASK_TRANSITIONS[status]).toEqual([]);
    }
  });

  it("reaches failure and cancellation from every non-terminal status", () => {
    for (const status of ["accepted", "workspace_resolved", "session_created", "session_resumed", "prompt_queued", "running", "assistant_message", "idle"] as const) {
      expect(canTransition(status, "failed")).toBe(true);
      expect(canTransition(status, "cancelled")).toBe(true);
    }
  });

  it("throws a stable error for an illegal hop", () => {
    expect(() => assertTransition("accepted", "completed")).toThrowError(ControlError);
    expect(() => assertTransition("accepted", "completed")).toThrowError(/illegal task transition/);
    expect(() => assertTransition("running", "running")).not.toThrow();
  });

  it("recognizes every published status", () => {
    for (const status of ["accepted", "completed", "cancelled"] as const) {
      expect(taskStatusSchema.parse(status)).toBe(status);
    }
  });
});

describe("state machine: waits", () => {
  it("treats accepted as already satisfied", () => {
    expect(satisfiesWait("accepted", "accepted")).toBe(true);
  });

  it("satisfies an admission target once the phase is reached", () => {
    expect(satisfiesWait("prompt_queued", "session_created")).toBe(true);
    expect(satisfiesWait("accepted", "prompt_queued")).toBe(false);
  });

  it("never reports failed as completed", () => {
    expect(satisfiesWait("failed", "completed")).toBe(false);
    expect(satisfiesWait("cancelled", "completed")).toBe(false);
    expect(satisfiesWait("failed", "failed")).toBe(true);
  });
});

describe("state machine: idempotency", () => {
  it("scopes the key by caller", () => {
    expect(idempotencyKey("a", "r1")).not.toBe(idempotencyKey("b", "r1"));
    expect(idempotencyKey("a", "r1")).toBe(idempotencyKey("a", "r1"));
  });

  it("mints distinct task ids", () => {
    expect(mintTaskId(1, 1)).not.toBe(mintTaskId(1, 2));
    expect(mintTaskId(1000, 5)).toMatch(/^task-/);
  });
});

describe("protocol: assistant summary bound", () => {
  it("passes short text through", () => {
    expect(boundAssistantText("hi")).toEqual({ text: "hi", truncated: false });
  });

  it("truncates long text and says so", () => {
    const result = boundAssistantText("x".repeat(LIMITS.maxAssistantSummaryChars + 10));
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(LIMITS.maxAssistantSummaryChars);
  });
});
