import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import Storage from "@deepseek-ai/dsh-storage";
import * as JsonStorage from "@deepseek-ai/dsh-storage-json";
import * as StorageDomain from "@deepseek-ai/dsh-storage-domain";
import {
  CONTROL_DOMAIN_NAME,
  CONTROL_DOMAIN_VERSION,
  MemoryControlLedger,
  StorageControlLedger,
  controlDomainSpec,
  statusFromEvents,
  summarizeFailure,
  type TaskRecord,
} from "../src/ledger.js";
import { ControlError } from "../src/protocol.js";

const contexts: Context[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Boot the real storage stack over a JSON backend rooted in a temp directory. */
async function bootStorage(root: string): Promise<Context> {
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(Loader);
  const modules = new Map<string, unknown>([
    ["@deepseek-ai/dsh-storage", Storage],
    ["@deepseek-ai/dsh-storage-json", JsonStorage],
    ["@deepseek-ai/dsh-storage-domain", StorageDomain],
  ]);
  ctx.loader.internal = {
    version: "v2",
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`);
      return modules.get(specifier);
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>;
  await ctx.loader.create({ name: "@deepseek-ai/dsh-storage" });
  await ctx.loader.create({ name: "@deepseek-ai/dsh-storage-json", config: { root } });
  await ctx.loader.create({ name: "@deepseek-ai/dsh-storage-domain", config: { backend: "json" } });
  await ctx.loader.await();
  return ctx;
}

async function openLedger(root: string): Promise<{ ctx: Context; ledger: StorageControlLedger }> {
  const ctx = await bootStorage(root);
  const facility = ctx.get("storageDomain");
  expect(facility).toBeDefined();
  const domain = await facility!.open(controlDomainSpec);
  return { ctx, ledger: new StorageControlLedger(domain) };
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "task-1",
    callerId: "codex",
    requestId: "r1",
    status: "accepted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastCursor: -1,
    ...overrides,
  };
}

describe("ledger: domain declaration", () => {
  it("uses a storage-domain legal name and a versioned schema", () => {
    expect(CONTROL_DOMAIN_NAME).toBe("dsh_agent_control");
    expect(/^[a-z][a-z0-9_]*$/.test(CONTROL_DOMAIN_NAME)).toBe(true);
    expect(CONTROL_DOMAIN_VERSION).toBeGreaterThanOrEqual(1);
    expect(Object.keys(controlDomainSpec.tables).sort()).toEqual([
      "callback_deliveries",
      "idempotency",
      "policy_meta",
      "task_events",
      "tasks",
    ]);
  });

  it("rejects a record that does not match its schema at the durable read boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "void-dsh-ledger-"));
    roots.push(root);

    const first = await openLedger(root);
    await first.ledger.init();
    // `storage-domain` validates at the durable READ boundary, so a malformed
    // record is written and only refused on the next open. What matters for the
    // control plane is that it can never be silently read back as valid state.
    await first.ledger.putTask({ ...task(), status: "bogus" as TaskRecord["status"] });
    await first.ledger.close();
    await first.ctx.fiber.dispose();

    const ctx = await bootStorage(root);
    await expect(ctx.get("storageDomain")!.open(controlDomainSpec)).rejects.toThrowError();
  });
});

describe("ledger: task events", () => {
  it("appends dense, increasing sequences and pages by cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "void-dsh-ledger-"));
    roots.push(root);
    const { ledger } = await openLedger(root);
    await ledger.init();

    const first = await ledger.appendEvent({ taskId: "task-1", kind: "accepted", status: "accepted", time: "t0", summary: "a" });
    const second = await ledger.appendEvent({ taskId: "task-1", kind: "prompt_queued", status: "prompt_queued", time: "t1", summary: "b" });
    await ledger.appendEvent({ taskId: "task-2", kind: "accepted", status: "accepted", time: "t2", summary: "c" });

    expect([first.seq, second.seq]).toEqual([0, 1]);
    expect(ledger.countEvents("task-1")).toBe(2);
    expect(ledger.listEvents("task-1", -1, 10).map((event) => event.summary)).toEqual(["a", "b"]);
    expect(ledger.listEvents("task-1", 0, 10).map((event) => event.summary)).toEqual(["b"]);
    expect(ledger.listEvents("task-1", -1, 1).map((event) => event.summary)).toEqual(["a"]);
    expect(ledger.listEvents("task-2", -1, 10).map((event) => event.summary)).toEqual(["c"]);
  });

  it("survives a process restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "void-dsh-ledger-"));
    roots.push(root);

    const first = await openLedger(root);
    await first.ledger.init();
    await first.ledger.putTask(task({ status: "prompt_queued", lastCursor: 0 }));
    await first.ledger.appendEvent({ taskId: "task-1", kind: "prompt_queued", status: "prompt_queued", time: "t0", summary: "queued" });
    await first.ledger.close();
    await first.ctx.fiber.dispose();

    const second = await openLedger(root);
    const report = await second.ledger.init();
    // The task was mid-flight when the first process went away; it must not be
    // reported as still running (plan §10.3).
    expect(report.orphanedTaskIds).toEqual(["task-1"]);
    expect(second.ledger.getTask("task-1")!.status).toBe("failed");
    expect(second.ledger.getTask("task-1")!.errorMessage).toMatch(/restarted/);
    expect(second.ledger.listEvents("task-1", -1, 10).map((event) => event.kind)).toEqual(["prompt_queued", "failed"]);
    await second.ledger.close();
  });

  it("repairs a projection that disagrees with its event trail", async () => {
    const root = await mkdtemp(join(tmpdir(), "void-dsh-ledger-"));
    roots.push(root);

    const first = await openLedger(root);
    await first.ledger.init();
    await first.ledger.appendEvent({ taskId: "task-1", kind: "completed", status: "completed", time: "t0", summary: "done" });
    // A projection stuck at a non-terminal status while the trail already proved
    // completion is exactly what a crash between the two writes looks like.
    await first.ledger.putTask(task({ status: "running", lastCursor: 0 }));
    await first.ledger.close();
    await first.ctx.fiber.dispose();

    const second = await openLedger(root);
    const report = await second.ledger.init();
    expect(report.orphanedTaskIds).toContain("task-1");
    expect(second.ledger.getTask("task-1")!.status).toBe("completed");
    await second.ledger.close();
  });

  it("leaves terminal tasks alone on restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "void-dsh-ledger-"));
    roots.push(root);
    const { ledger } = await openLedger(root);
    await ledger.init();
    await ledger.putTask(task({ status: "completed", lastCursor: 0 }));
    await ledger.appendEvent({ taskId: "task-1", kind: "completed", status: "completed", time: "t0", summary: "done" });
    const report = await ledger.init();
    expect(report.orphanedTaskIds).toEqual([]);
    expect(report.consistentTaskIds).toEqual(["task-1"]);
  });
});

describe("ledger: idempotency, callbacks and policy metadata", () => {
  it("round-trips every auxiliary table", async () => {
    const root = await mkdtemp(join(tmpdir(), "void-dsh-ledger-"));
    roots.push(root);
    const { ledger } = await openLedger(root);
    await ledger.init();

    expect(ledger.findIdempotent("codex\u0000r1")).toBeUndefined();
    await ledger.putIdempotent({
      key: "codex\u0000r1",
      taskId: "task-1",
      callerId: "codex",
      requestId: "r1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(ledger.findIdempotent("codex\u0000r1")!.taskId).toBe("task-1");

    await ledger.putCallbackDelivery({
      deliveryId: "task-1:completed",
      taskId: "task-1",
      event: "completed",
      attempts: 2,
      status: "pending",
      lastError: "timeout",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(ledger.listCallbackDeliveries()).toHaveLength(1);
    expect(ledger.listCallbackDeliveries()[0]!.attempts).toBe(2);

    expect(ledger.getPolicyMeta()).toBeUndefined();
    await ledger.putPolicyMeta({ instructionsVersion: 3, publishedAt: "t", summary: "s" });
    expect(ledger.getPolicyMeta()!.instructionsVersion).toBe(3);
  });
});

describe("ledger: memory implementation", () => {
  it("satisfies the same contract", async () => {
    const ledger = new MemoryControlLedger();
    const report = await ledger.init();
    expect(report).toEqual({ orphanedTaskIds: [], consistentTaskIds: [], deliveredTaskIds: [] });

    await ledger.putTask(task());
    expect(ledger.getTask("task-1")!.callerId).toBe("codex");
    expect(ledger.listTasks()).toHaveLength(1);

    const event = await ledger.appendEvent({ taskId: "task-1", kind: "accepted", status: "accepted", time: "t", summary: "s" });
    expect(event.seq).toBe(0);
    expect(ledger.listEvents("task-1", -1, 10)).toHaveLength(1);
    expect(ledger.countEvents("task-1")).toBe(1);

    await ledger.close();
    expect(ledger.isClosed).toBe(true);
    // Closing is idempotent.
    await expect(ledger.close()).resolves.toBeUndefined();
  });
});

describe("ledger: helpers", () => {
  it("derives the proven status from an event trail", () => {
    expect(statusFromEvents([])).toBeUndefined();
    expect(
      statusFromEvents([
        { taskId: "t", seq: 0, kind: "accepted", status: "accepted", time: "t", summary: "" },
        { taskId: "t", seq: 1, kind: "completed", status: "completed", time: "t", summary: "" },
      ]),
    ).toBe("completed");
  });

  it("summarizes a control error verbatim but a host error generically", () => {
    expect(summarizeFailure(new ControlError("dsh-control/session-locked", "busy"))).toEqual({
      code: "dsh-control/session-locked",
      message: "busy",
    });
    expect(summarizeFailure(new Error("E:/private/path blew up"))).toEqual({
      code: "dsh-control/internal",
      message: "control plane failed to complete the request",
    });
  });
});
