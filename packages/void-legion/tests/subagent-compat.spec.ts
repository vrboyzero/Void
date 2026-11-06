import { describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  assertProviderSupports,
  createScheduledWorker,
} from "../src/subagent-provider.js";
import { startSubagent, usesActivationApi } from "../src/subagent-compat.js";
import type { TaskRunContext } from "../src/scheduler.js";

function context(overrides: Partial<TaskRunContext> = {}): TaskRunContext {
  return {
    runId: "legion-demo-20261106090000-01",
    teamId: "legion-demo",
    laneId: "lane_code",
    task: "把登录页做出来",
    member: {
      laneId: "lane_code",
      agentId: "xiaobei",
      identityLabel: "小贝",
      role: "coder",
      scopeSummary: "写登录页的实现",
      dependsOn: ["lane_plan"],
    },
    upstream: { lane_plan: { plan: "先做表单" } },
    modelRef: undefined,
    workspace: "default",
    writesWorkspace: true,
    signal: new AbortController().signal,
    ...overrides,
  };
}

interface ActivationCall {
  spec: Record<string, unknown>;
}

function fakeActivationCtx(startResult: { stopReason: string; output?: unknown[] } = { stopReason: "completed", output: [] }) {
  const calls: ActivationCall[] = [];
  const disposed: string[] = [];
  const subagents = {
    getProvider: (name: string) =>
      name === "spawn"
        ? {
            name: "spawn",
            inheritsParentContext: false,
            capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true },
          }
        : undefined,
    async startActivation(spec: Record<string, unknown>): Promise<Record<string, unknown>> {
      calls.push({ spec });
      return {
        childId: "child-session-1",
        result: Promise.resolve({ output: startResult.output ?? [], stopReason: startResult.stopReason }),
        async dispose() {
          disposed.push("child-session-1");
        },
      };
    },
  };
  const ctx = {
    get: (name: string) => (name === "subagents" ? subagents : undefined),
    on: () => () => undefined,
  } as unknown as Context;
  return { ctx, calls, disposed };
}

describe("usesActivationApi（0.2.1+ 能力探测）", () => {
  it("有 startActivation 才是新宿主", () => {
    expect(usesActivationApi({ startActivation: () => undefined })).toBe(true);
    expect(usesActivationApi({ start: () => undefined })).toBe(false);
    expect(usesActivationApi(undefined)).toBe(false);
  });
});

describe("assertProviderSupports（activation 模式）", () => {
  it("0.2.1+ 没有 persona 能力：身份并入提示词，不再拒绝", () => {
    const provider = {
      name: "spawn",
      inheritsParentContext: false,
      capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true },
    };
    expect(() => assertProviderSupports(provider as never, { persona: "你是小贝" }, "activation")).not.toThrow();
  });

  it("legacy 模式仍然拦 persona 不支持的 provider", () => {
    const provider = {
      name: "spawn",
      inheritsParentContext: false,
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
    };
    expect(() => assertProviderSupports(provider as never, { persona: "你是小贝" }, "legacy")).toThrow(
      /不支持逐子代理身份注入/,
    );
  });
});

describe("startSubagent（统一句柄）", () => {
  it("新宿主走 startActivation：childId→id、delivery=caller、persona 不写进 request", async () => {
    const calls: ActivationCall[] = [];
    const runtime = {
      async startActivation(spec: Record<string, unknown>) {
        calls.push({ spec });
        return {
          childId: "child-42",
          result: Promise.resolve({ output: [], stopReason: "completed" }),
          async dispose() {
            /* 释放占位 */
          },
        };
      },
    };
    const parent = { id: "parent" } as Agent;
    const handle = await startSubagent(runtime as never, {
      provider: "spawn",
      label: "小贝",
      parent,
      prompt: [{ type: "text", text: "干活" }],
      signal: new AbortController().signal,
      persona: "你是小贝",
    });
    expect(handle.id).toBe("child-42");
    expect(calls).toHaveLength(1);
    const spec = calls[0]?.spec as Record<string, unknown>;
    expect(spec.provider).toBe("spawn");
    expect(spec.label).toBe("小贝");
    expect(spec.delivery).toBe("caller");
    expect((spec.request as Record<string, unknown>).persona).toBeUndefined();
    expect((spec.request as Record<string, unknown>).parent).toBe(parent);
  });

  it("独立检出的 cwd 原样传给新宿主与旧宿主（B6）", async () => {
    const cwd = "C:/tmp/legion-worktrees/run/lane_a";
    const specs: Array<Record<string, unknown>> = [];
    const newRuntime = {
      async startActivation(spec: Record<string, unknown>) {
        specs.push(spec);
        return {
          childId: "child-1",
          result: Promise.resolve({ output: [], stopReason: "completed" }),
          async dispose() {},
        };
      },
    };
    const parent = { id: "parent" } as Agent;
    await startSubagent(newRuntime as never, {
      provider: "spawn",
      label: "lane_a",
      parent,
      prompt: [{ type: "text", text: "干活" }],
      signal: new AbortController().signal,
      cwd,
    });
    expect((specs[0]!.request as Record<string, unknown>).cwd).toBe(cwd);

    let legacyRequest: Record<string, unknown> | undefined;
    const oldRuntime = {
      async start(_name: string, request: Record<string, unknown>) {
        legacyRequest = request;
        return {
          id: "child-2",
          result: Promise.resolve({ output: [], stopReason: "completed" }),
          async dispose() {},
        };
      },
    };
    await startSubagent(oldRuntime as never, {
      provider: "spawn",
      label: "lane_a",
      parent,
      prompt: [{ type: "text", text: "干活" }],
      signal: new AbortController().signal,
      cwd,
    });
    expect(legacyRequest?.cwd).toBe(cwd);
  });

  it("旧宿主回退 start：id 保持字符串化，persona 走 request", async () => {
    let legacyRequest: Record<string, unknown> | undefined;
    const runtime = {
      async start(_name: string, request: Record<string, unknown>) {
        legacyRequest = request;
        return {
          id: "legacy-child",
          result: Promise.resolve({ output: [], stopReason: "completed" }),
          async dispose() {
            /* 释放占位 */
          },
        };
      },
    };
    const handle = await startSubagent(runtime as never, {
      provider: "spawn",
      label: "小贝",
      parent: { id: "parent" } as Agent,
      prompt: [{ type: "text", text: "干活" }],
      signal: new AbortController().signal,
      persona: "你是小贝",
    });
    expect(handle.id).toBe("legacy-child");
    expect(legacyRequest?.persona).toBe("你是小贝");
  });
});

describe("createScheduledWorker（0.2.1+ 真实派活路径）", () => {
  it("用 startActivation 派活：身份并入提示词、delivery=caller、结果与释放都对", async () => {
    const { ctx, calls, disposed } = fakeActivationCtx({ stopReason: "completed", output: [{ type: "text", text: "做完了" }] });
    const worker = createScheduledWorker(ctx, { id: "parent-1" } as Agent, {
      persona: () => "你是小贝：最佳拍档",
    });
    const output = (await worker(context())) as Record<string, unknown>;
    expect(output.laneId).toBe("lane_code");
    expect(output.stopReason).toBe("completed");
    expect(output.provider).toBe("spawn");
    expect(calls).toHaveLength(1);
    const spec = calls[0]?.spec as Record<string, unknown>;
    expect(spec.delivery).toBe("caller");
    const request = spec.request as Record<string, unknown>;
    expect(request.persona).toBeUndefined();
    const prompt = request.prompt as Array<{ type: string; text: string }>;
    expect(prompt.some((block) => block.text.includes("你是小贝：最佳拍档"))).toBe(true);
    expect(disposed).toEqual(["child-session-1"]);
  });

  it("没有 persona 时不往提示词里塞身份段", async () => {
    const { ctx, calls } = fakeActivationCtx();
    const worker = createScheduledWorker(ctx, { id: "parent-1" } as Agent);
    await worker(context());
    const request = (calls[0]?.spec as Record<string, unknown>).request as Record<string, unknown>;
    const prompt = request.prompt as Array<{ type: string; text: string }>;
    expect(prompt.some((block) => block.text.includes("你的身份设定"))).toBe(false);
  });
});
