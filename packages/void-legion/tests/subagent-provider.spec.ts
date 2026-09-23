import { describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SubagentCapabilities, SubagentProvider } from "@deepseek-ai/dsh-subagent";
import {
  SubagentDispatchError,
  assertProviderSupports,
  createScheduledWorker,
  effectiveConcurrency,
  laneBriefFromContext,
  parseModelRef,
  renderLanePrompt,
} from "../src/subagent-provider.js";
import { ScheduleCancelledError, type TaskRunContext } from "../src/scheduler.js";

function context(overrides: Partial<TaskRunContext> = {}): TaskRunContext {
  return {
    runId: "legion-demo-20260922120000-01",
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

function capabilities(overrides: Partial<SubagentCapabilities> = {}): SubagentCapabilities {
  return { outputSchema: false, depthLimit: false, toolFilter: false, persona: false, ...overrides };
}

function provider(name: string, caps: Partial<SubagentCapabilities> = {}): SubagentProvider {
  return { name, capabilities: capabilities(caps), inheritsParentContext: false } as unknown as SubagentProvider;
}

interface MockRun {
  result: Promise<unknown>;
  dispose(): Promise<void>;
}

function fakeCtx(run: MockRun, providerImpl: SubagentProvider = provider("spawn")) {
  const started: Array<{ name: string; request: Record<string, unknown> }> = [];
  const subagents = {
    getProvider: (name: string) => (name === providerImpl.name ? providerImpl : undefined),
    async start(name: string, request: Record<string, unknown>): Promise<MockRun> {
      started.push({ name, request });
      return run;
    },
  };
  // 真宿主上取服务走 `ctx.get`（属性访问要过 inject 检查，没声明就抛
  // `cannot get property "subagents" without inject`），假 ctx 照这个形状来。
  const ctx = {
    subagents,
    get: (name: string) => (name === "subagents" ? subagents : undefined),
  } as unknown as Context;
  return { ctx, started };
}

describe("parseModelRef", () => {
  it("只有 model 时不猜 provider", () => {
    expect(parseModelRef("deepseek-chat")).toEqual({ model: "deepseek-chat" });
  });

  it("provider/model 拆成两段", () => {
    expect(parseModelRef("deepseek/deepseek-reasoner")).toEqual({
      provider: "deepseek",
      model: "deepseek-reasoner",
    });
  });

  it("去掉首尾空白", () => {
    expect(parseModelRef("  deepseek/chat  ")).toEqual({ provider: "deepseek", model: "chat" });
  });

  it("空字符串、三段、缺边都拒绝（不猜）", () => {
    expect(() => parseModelRef("   ")).toThrow(/不能是空字符串/);
    expect(() => parseModelRef("a/b/c")).toThrow(/应为 model 或 provider\/model/);
    expect(() => parseModelRef("/chat")).toThrow(/应为 model 或 provider\/model/);
    expect(() => parseModelRef("deepseek/")).toThrow(/应为 model 或 provider\/model/);
  });
});

describe("renderLanePrompt（逐 lane 说明书，不是全队同一段）", () => {
  it("写自己的活、身份、总目标、工作区与写权限", () => {
    const text = renderLanePrompt(laneBriefFromContext(context()))[0] as { text: string };
    expect(text.text).toContain('lane "lane_code"');
    expect(text.text).toContain("小贝");
    expect(text.text).toContain("把登录页做出来");
    expect(text.text).toContain("写登录页的实现");
    expect(text.text).toContain("本次要改文件");
    expect(text.text).toContain("default");
  });

  it("只读任务明说不要改文件", () => {
    const text = renderLanePrompt(laneBriefFromContext(context({ writesWorkspace: false })))[0] as { text: string };
    expect(text.text).toContain("本次只读，不要改文件");
  });

  it("只带上游产出，不带别人的", () => {
    const brief = laneBriefFromContext(
      context({ upstream: { lane_plan: { plan: "先做表单" }, lane_other: { secret: "不该出现" } } }),
    );
    // 上游裁剪由调度器负责；这里断言渲染如实列出给它的那些。
    const text = renderLanePrompt(brief)[0] as { text: string };
    expect(text.text).toContain("lane_plan");
    expect(text.text).toContain("先做表单");
  });

  it("依赖了但没拿到上游产出时如实说，不编", () => {
    const text = renderLanePrompt(laneBriefFromContext(context({ upstream: {} })))[0] as { text: string };
    expect(text.text).toContain("还没拿到");
    expect(text.text).toContain("不要凭空假设");
  });

  it("没有依赖时完全不提上游", () => {
    const member = { laneId: "lane_solo", identityLabel: "独狼" };
    const text = renderLanePrompt(
      laneBriefFromContext(context({ laneId: "lane_solo", member, upstream: {} })),
    )[0] as { text: string };
    expect(text.text).not.toContain("上游产出");
  });

  it("没有 scopeSummary 时退回身份标签，再退回 laneId", () => {
    const member = { laneId: "lane_code", identityLabel: "小贝" };
    expect(renderLanePrompt(laneBriefFromContext(context({ member })))[0]).toMatchObject({});
    const text = renderLanePrompt(laneBriefFromContext(context({ member })))[0] as { text: string };
    expect(text.text).toContain("你这一次的活：小贝");

    const bare = { laneId: "lane_bare" };
    const bareText = renderLanePrompt(laneBriefFromContext(context({ laneId: "lane_bare", member: bare })))[0] as {
      text: string;
    };
    expect(bareText.text).toContain("你这一次的活：lane_bare");
  });

  it("循环引用的上游产出不会炸，如实标记", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const text = renderLanePrompt(laneBriefFromContext(context({ upstream: { lane_plan: cyclic } })))[0] as {
      text: string;
    };
    expect(text.text).toContain("[上游产出无法序列化]");
  });
});

describe("assertProviderSupports（派出去之前就拒）", () => {
  it("显式声明 agentOptions: false 时拒绝模型路由", () => {
    const item = provider("spawn", {}) as unknown as { capabilities: Record<string, boolean> };
    item.capabilities.agentOptions = false;
    expect(() => assertProviderSupports(item as unknown as SubagentProvider, { modelRef: "deepseek/chat" })).toThrow(
      /不支持逐任务模型路由/,
    );
  });

  it("字段缺失（本机 rc.6 就是这样）不算不支持——请求字段存在且被 provider 读取", () => {
    expect(() => assertProviderSupports(provider("spawn"), { modelRef: "deepseek/chat" })).not.toThrow();
  });

  it("结构化产出与身份注入按 flag 拒", () => {
    expect(() => assertProviderSupports(provider("spawn"), { structured: true })).toThrow(/不支持结构化产出/);
    expect(() => assertProviderSupports(provider("spawn"), { persona: "你是小贝" })).toThrow(/不支持逐子代理身份注入/);
    expect(() =>
      assertProviderSupports(provider("spawn", { outputSchema: true, persona: true }), {
        structured: true,
        persona: "你是小贝",
      }),
    ).not.toThrow();
  });

  it("没提要求就不检查", () => {
    expect(() => assertProviderSupports(provider("spawn"), {})).not.toThrow();
  });
});

describe("effectiveConcurrency（三方取小）", () => {
  it("没有 provider 容量时取运行上限与闸门容量的较小值", () => {
    expect(effectiveConcurrency({ runLimit: 8, gateCapacity: 4 })).toBe(4);
    expect(effectiveConcurrency({ runLimit: 2, gateCapacity: 4 })).toBe(2);
  });

  it("provider 容量更小时以它为准", () => {
    expect(effectiveConcurrency({ runLimit: 8, gateCapacity: 8, providerCapacity: 2 })).toBe(2);
  });

  it("任何一路为 0 也至少留 1（不出现零并发死锁）", () => {
    expect(effectiveConcurrency({ runLimit: 0, gateCapacity: 0, providerCapacity: 0 })).toBe(1);
  });
});

describe("createScheduledWorker（真实派活）", () => {
  it("把 modelRef 变成 agentOptions 落到子代理上", async () => {
    const { ctx, started } = fakeCtx({
      result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "done" }] }),
      async dispose() {},
    });
    const worker = createScheduledWorker(ctx, { id: "parent" } as Agent);
    const out = (await worker(context({ modelRef: "deepseek/deepseek-reasoner" }))) as Record<string, unknown>;

    expect(started).toHaveLength(1);
    expect(started[0].request.agentOptions).toEqual({ provider: "deepseek", model: "deepseek-reasoner" });
    expect(out).toMatchObject({ laneId: "lane_code", modelRef: "deepseek/deepseek-reasoner", provider: "spawn" });
  });

  it("没写 modelRef 就不传 agentOptions（不覆盖父级路由）", async () => {
    const { ctx, started } = fakeCtx({
      result: Promise.resolve({ stopReason: "completed", output: [] }),
      async dispose() {},
    });
    await createScheduledWorker(ctx, {} as Agent)(context());
    expect("agentOptions" in started[0].request).toBe(false);
  });

  it("逐任务 signal 直接交给 start（取消能传到子代理）", async () => {
    const { ctx, started } = fakeCtx({
      result: Promise.resolve({ stopReason: "completed", output: [] }),
      async dispose() {},
    });
    const controller = new AbortController();
    await createScheduledWorker(ctx, {} as Agent)(context({ signal: controller.signal }));
    expect(started[0].request.signal).toBe(controller.signal);
  });

  it("onDispatch 记下真实 provider 与路由", async () => {
    const seen: Array<{ laneId: string; provider: string; modelRef?: string }> = [];
    const { ctx } = fakeCtx({
      result: Promise.resolve({ stopReason: "completed", output: [] }),
      async dispose() {},
    });
    await createScheduledWorker(ctx, {} as Agent, { onDispatch: (info) => seen.push(info) })(
      context({ modelRef: "deepseek/chat" }),
    );
    expect(seen).toEqual([{ laneId: "lane_code", provider: "spawn", modelRef: "deepseek/chat" }]);
  });

  it("provider 不存在时报错（不静默换一个）", async () => {
    const { ctx } = fakeCtx({
      result: Promise.resolve({ stopReason: "completed", output: [] }),
      async dispose() {},
    });
    await expect(createScheduledWorker(ctx, {} as Agent, { provider: "acp" })(context())).rejects.toThrow(
      /没有这个子代理 provider: acp/,
    );
  });

  it("能力不支持时在派出去之前就拒，start 不被调用", async () => {
    const { ctx, started } = fakeCtx(
      {
        result: Promise.resolve({ stopReason: "completed", output: [] }),
        async dispose() {},
      },
      provider("spawn", { persona: false }),
    );
    await expect(
      createScheduledWorker(ctx, {} as Agent, { persona: () => "你是小贝" })(context()),
    ).rejects.toThrow(/不支持逐子代理身份注入/);
    expect(started).toHaveLength(0);
  });

  it("支持身份注入时把 persona 传下去", async () => {
    const { ctx, started } = fakeCtx(
      {
        result: Promise.resolve({ stopReason: "completed", output: [] }),
        async dispose() {},
      },
      provider("spawn", { persona: true }),
    );
    await createScheduledWorker(ctx, {} as Agent, { persona: () => "你是小贝" })(context());
    expect(started[0].request.persona).toBe("你是小贝");
  });

  it("子代理首轮必须等到自己的会话绑定落盘，失败则停止而不借父身份", async () => {
    let beforeStep: ((input: unknown, next: () => Promise<{ kind: string }>) => Promise<unknown>) | undefined;
    let releaseBinding: (() => void) | undefined;
    const bindingGate = new Promise<void>((resolve) => { releaseBinding = resolve; });
    let firstStepFinished = false;
    let disposed = false;
    const bindings: Array<[string, string]> = [];
    const subagents = {
      getProvider: () => provider("spawn", { persona: true }),
      async start() {
        const firstStep = beforeStep!(
          { agent: { id: "child-1", session: { header: { parentSession: "parent-1", origin: "subagent" } } } },
          async () => ({ kind: "enter" }),
        ).then(() => { firstStepFinished = true; });
        return {
          id: "child-1",
          result: firstStep.then(() => ({ stopReason: "completed", output: [] })),
          async dispose() { disposed = true; },
        };
      },
    };
    const ctx = {
      get: (name: string) => name === "subagents" ? subagents : undefined,
      on: (_name: string, listener: typeof beforeStep) => { beforeStep = listener; return () => {}; },
    } as unknown as Context;
    const worker = createScheduledWorker(ctx, { id: "parent-1" } as Agent, {
      persona: () => "成员身份",
      bindChildSession: async (sessionId, agentId) => {
        bindings.push([sessionId, agentId]);
        expect(firstStepFinished).toBe(false);
        await bindingGate;
      },
    });
    const work = worker(context());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bindings).toEqual([["child-1", "xiaobei"]]);
    expect(firstStepFinished).toBe(false);
    releaseBinding?.();
    await work;
    expect(firstStepFinished).toBe(true);
    expect(disposed).toBe(true);
  });

  it("子代理绑定失败时拒绝首轮并释放子代理", async () => {
    let beforeStep: ((input: unknown, next: () => Promise<{ kind: string }>) => Promise<unknown>) | undefined;
    let disposed = false;
    let entered = false;
    const subagents = {
      getProvider: () => provider("spawn", { persona: true }),
      async start() {
        const firstStep = beforeStep!(
          { agent: { id: "child-2", session: { header: { parentSession: "parent-1", origin: "subagent" } } } },
          async () => { entered = true; return { kind: "enter" }; },
        );
        const result = firstStep.then(() => ({ stopReason: "completed", output: [] }));
        return {
          id: "child-2",
          result,
          async dispose() { disposed = true; await Promise.allSettled([result]); },
        };
      },
    };
    const ctx = {
      get: (name: string) => name === "subagents" ? subagents : undefined,
      on: (_name: string, listener: typeof beforeStep) => { beforeStep = listener; return () => {}; },
    } as unknown as Context;
    await expect(createScheduledWorker(ctx, { id: "parent-1" } as Agent, {
      bindChildSession: async () => { throw new Error("binding failed"); },
    })(context())).rejects.toThrow("binding failed");
    expect(entered).toBe(false);
    expect(disposed).toBe(true);
  });

  it("子代理没跑完就抛错（调度器记 failed）", async () => {
    const { ctx } = fakeCtx({
      result: Promise.resolve({ stopReason: "error", output: [] }),
      async dispose() {},
    });
    await expect(createScheduledWorker(ctx, {} as Agent)(context())).rejects.toThrow(/没有跑完: "error"/);
  });

  it("已取消时按取消上报，不记成任务自己的错", async () => {
    const controller = new AbortController();
    controller.abort();
    const { ctx } = fakeCtx({
      result: Promise.resolve({ stopReason: "aborted", output: [] }),
      async dispose() {},
    });
    await expect(
      createScheduledWorker(ctx, {} as Agent)(context({ signal: controller.signal })),
    ).rejects.toBeInstanceOf(ScheduleCancelledError);
  });

  it("成功、失败、取消都 dispose 子代理", async () => {
    for (const stopReason of ["completed", "error", "aborted"]) {
      let disposed = false;
      const { ctx } = fakeCtx({
        result: Promise.resolve({ stopReason, output: [] }),
        async dispose() {
          disposed = true;
        },
      });
      const controller = new AbortController();
      if (stopReason === "aborted") controller.abort();
      await createScheduledWorker(ctx, {} as Agent)(context({ signal: controller.signal })).catch(() => undefined);
      expect(disposed).toBe(true);
    }
  });

  it("结构化产出原样带回", async () => {
    const { ctx } = fakeCtx({
      result: Promise.resolve({ stopReason: "completed", output: [], structured: { files: ["a.ts"] } }),
      async dispose() {},
    });
    const out = (await createScheduledWorker(ctx, {} as Agent)(context())) as Record<string, unknown>;
    expect(out.structured).toEqual({ files: ["a.ts"] });
  });
});
