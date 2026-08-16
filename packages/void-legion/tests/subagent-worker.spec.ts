import { describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createSubagentWorker } from "../src/subagent-worker.js";
import type { LaneWorkerInput } from "../src/service.js";

interface MockRun {
  result: Promise<unknown>;
  dispose(): Promise<void>;
}

function laneInput(overrides: Partial<LaneWorkerInput> = {}): LaneWorkerInput {
  return {
    laneId: "lane_code",
    teamId: "legion-demo",
    task: "write code",
    member: { laneId: "lane_code", role: "coder", identityLabel: "coder" },
    upstream: { lane_plan: { plan: "x" } },
    ...overrides,
  };
}

describe("createSubagentWorker (真实 ctx.subagents worker)", () => {
  it("派活给 ctx.subagents.start，返回 completed 结果", async () => {
    const started: Array<{ name: string; request: Record<string, unknown> }> = [];
    const ctx = {
      subagents: {
        async start(name: string, request: Record<string, unknown>): Promise<MockRun> {
          started.push({ name, request });
          return {
            result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "done" }] }),
            async dispose() {},
          };
        },
      },
    } as unknown as Context;
    const parent = { id: "parent-session-1" } as unknown as Agent;

    const worker = createSubagentWorker(ctx, parent);
    const out = await worker(laneInput()) as Record<string, unknown>;

    expect(started).toHaveLength(1);
    expect(started[0].name).toBe("spawn");
    expect(started[0].request.label).toBe("coder");
    expect(started[0].request.parent).toBe(parent);
    const prompt = (started[0].request.prompt as Array<{ text: string }>)[0].text;
    expect(prompt).toContain("write code");
    expect(prompt).toContain("lane_plan");
    expect(out).toMatchObject({ laneId: "lane_code", stopReason: "completed" });
  });

  it("子代理非 completed 时抛错（触发 lane failed）", async () => {
    const ctx = {
      subagents: {
        async start(): Promise<MockRun> {
          return {
            result: Promise.resolve({ stopReason: "error", output: [] }),
            async dispose() {},
          };
        },
      },
    } as unknown as Context;

    const worker = createSubagentWorker(ctx, {} as Agent);
    await expect(worker(laneInput())).rejects.toThrow(/error/);
  });

  it("结算后总是 dispose 子代理（finally 释放）", async () => {
    let disposed = false;
    const ctx = {
      subagents: {
        async start(): Promise<MockRun> {
          return {
            result: Promise.resolve({ stopReason: "completed", output: [] }),
            async dispose() { disposed = true; },
          };
        },
      },
    } as unknown as Context;

    const worker = createSubagentWorker(ctx, {} as Agent);
    await worker(laneInput());
    expect(disposed).toBe(true);
  });
});
