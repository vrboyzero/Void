import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { type ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createTeamDocument } from "../src/contracts.js";
import * as VoidLegionService from "../src/service.js";
import * as VoidLegionTool from "../src/tool.js";
import * as VoidLegionRunTool from "../src/run-tool.js";
import type { VoidTeam } from "../src/service.js";
import type { DelegationTeamMetadata } from "../src/team.js";

let context: Context | undefined;

afterEach(async () => {
  await context?.fiber.dispose();
  context = undefined;
});

const threeLaneTeam: DelegationTeamMetadata = {
  id: "legion-tool-demo",
  mode: "plan_execute_verify",
  sharedGoal: "prove launch_legion closes the real-subagent loop",
  memberRoster: [
    { laneId: "lane_plan", role: "researcher", authorityRelationToManager: "peer" },
    { laneId: "lane_code", role: "coder", authorityRelationToManager: "subordinate", dependsOn: ["lane_plan"] },
    { laneId: "lane_verify", role: "verifier", authorityRelationToManager: "peer", dependsOn: ["lane_code"] },
  ],
};

/**
 * 一个假 subagents 服务：`getProvider` 是必须的——真实 worker 派活前先问
 * provider 支不支持这次要的能力（模型路由/结构化产出/身份注入），不问就派是
 * 「静默降级」。
 *
 * 默认声明 `persona: true`：真的 `spawn` provider（`dsh-subagent-spawn-in-process`）
 * 就是这么声明的，而军团现在每次都带逐成员身份，不声明就会在派出去之前被拒。
 */
function fakeSubagents(
  started: Array<{ name: string; request: Record<string, unknown> }>,
  options: { capabilities?: Record<string, boolean>; output?: unknown; stopReason?: string } = {},
) {
  const provider = {
    name: "spawn",
    capabilities: options.capabilities ?? { persona: true },
    inheritsParentContext: false,
  };
  return {
    list: () => ["spawn"],
    getProvider: (name: string) => (name === "spawn" ? provider : undefined),
    async start(name: string, request: Record<string, unknown>) {
      started.push({ name, request });
      return {
        id: `child-${started.length}`,
        result: Promise.resolve({
          stopReason: options.stopReason ?? "completed",
          output: options.output ?? [{ type: "text", text: "ok" }],
        }),
        async dispose() {},
      };
    },
  };
}

/**
 * 假权威来源：和真服务一样**按会话**解析。只认 `sessionId` 那一个会话，别的会话
 * 返回 `undefined`——退回默认身份正是这里要防的事。
 *
 * 逐成员身份（`personaFor`）也照真服务的样子按 `agentId` 取；`personaError` 用来演
 * 「这个成员的身份取不出来」，好验证整次派活被拒。
 */
function authoritySource(input: {
  sessionId?: string;
  actorId: string;
  profiles: Array<[string, { id: string; superiors: readonly string[]; subordinates: readonly string[] }]>;
  personas?: Record<string, string>;
  personaError?: string;
}) {
  const profiles = new Map(input.profiles);
  return {
    forSession: async (sessionId: string) => {
      if (input.sessionId !== undefined && sessionId !== input.sessionId) return undefined;
      return { actorId: input.actorId, profiles };
    },
    personaFor: async (agentId: string) => {
      if (input.personaError !== undefined) throw new Error(input.personaError);
      return input.personas?.[agentId] ?? `${agentId} 的底线`;
    },
  };
}

/** 小贝是小马的上级：这条边是下面几个用例共用的身份图。 */
const managerAndSubordinate: Array<[string, { id: string; superiors: readonly string[]; subordinates: readonly string[] }]> = [
  ["xiaobei", { id: "xiaobei", superiors: [], subordinates: ["xiaoma"] }],
  ["xiaoma", { id: "xiaoma", superiors: ["xiaobei"], subordinates: [] }],
];

async function boot(config?: Record<string, unknown>): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(Loader);
  const modules = new Map<string, unknown>([
    ["@deepseek-ai/dsh-system-prompt", SystemPrompt],
    ["@deepseek-ai/dsh-tools", ToolRuntime],
    ["@void/void-legion/service", VoidLegionService],
    ["@void/void-legion/tool", VoidLegionTool],
    ["@void/void-legion/run-tool", VoidLegionRunTool],
  ]);
  ctx.loader.internal = {
    version: "v2",
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`);
      return modules.get(specifier);
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>;
  await ctx.loader.create({ name: "@deepseek-ai/dsh-system-prompt" });
  await ctx.loader.create({ name: "@deepseek-ai/dsh-tools" });
  await ctx.loader.create({ name: "@void/void-legion/service", ...(config === undefined ? {} : { config }) });
  await ctx.loader.create({ name: "@void/void-legion/tool" });
  await ctx.loader.create({ name: "@void/void-legion/run-tool" });
  await ctx.loader.await();
  return ctx;
}

function findFiber(ctx: Context, pluginName: string) {
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers) {
      if (fiber.name === pluginName) return fiber;
    }
  }
  return undefined;
}

function mockExec(parent: Agent): ToolRunContext {
  return { agent: parent, signal: new AbortController().signal } as unknown as ToolRunContext;
}

describe("launch_legion tool through the Loader", () => {
  it("registers launch_legion (model-visible)", async () => {
    context = await boot();
    expect(context.tools.get("launch_legion")).toBeDefined();
    expect(context.tools.schemas().some((s) => s.name === "launch_legion")).toBe(true);
  });

  it("rejects an unauthorized roster before starting a subagent", async () => {
    context = await boot();
    const team = context.get("voidTeam") as VoidTeam;
    team.defineTeam({ ...threeLaneTeam, memberRoster: [{ laneId: "manager", agentId: "xiaobei" }] });
    context.provide("voidAuthority", authoritySource({
      sessionId: "parent-session-1",
      actorId: "xiaoma",
      profiles: managerAndSubordinate,
    }));
    const started: string[] = [];
    context.provide("subagents", { start: async (name: string) => { started.push(name); return {}; } });
    await expect(context.tools.get("launch_legion")!.execute({ teamId: threeLaneTeam.id }, mockExec({ id: "parent-session-1" } as Agent))).rejects.toThrow(/不能指挥/);
    expect(started).toEqual([]);
  });

  it("rejects a launch with no authority profiles before starting a subagent", async () => {
    context = await boot();
    const started: string[] = [];
    context.provide("subagents", { start: async (name: string) => { started.push(name); return {}; } });
    await expect(context.tools.get("launch_legion")!.execute({ teamId: threeLaneTeam.id }, mockExec({} as Agent))).rejects.toThrow(/缺少权威档案/);
    expect(started).toEqual([]);
  });

  it("refuses a session with no soul binding instead of falling back to a default identity", async () => {
    context = await boot();
    const team = context.get("voidTeam") as VoidTeam;
    team.defineTeam({ ...threeLaneTeam, managerAgentId: "xiaobei", memberRoster: [{ laneId: "lane_plan", agentId: "xiaoma" }] });
    // 权威来源只认 parent-session-1；别的会话解析不出身份。
    context.provide("voidAuthority", authoritySource({
      sessionId: "parent-session-1",
      actorId: "xiaobei",
      profiles: managerAndSubordinate,
    }));
    const started: string[] = [];
    context.provide("subagents", { start: async (name: string) => { started.push(name); return {}; } });
    await expect(context.tools.get("launch_legion")!.execute(
      { teamId: threeLaneTeam.id },
      mockExec({ id: "some-other-session" } as Agent),
    )).rejects.toThrow(/会话 some-other-session 没有绑定灵魂档案/);
    expect(started).toEqual([]);
  });

  it("dispatches every lane to ctx.subagents in dependency order (real closure)", async () => {
    context = await boot();
    const team = context.get("voidTeam") as VoidTeam;
    team.defineTeam({ ...threeLaneTeam, managerAgentId: "xiaobei", memberRoster: [
      { laneId: "lane_plan", agentId: "xiaoma", role: "researcher" },
      { laneId: "lane_code", agentId: "xiaoma", role: "coder", dependsOn: ["lane_plan"] },
      { laneId: "lane_verify", agentId: "xiaoma", role: "verifier", dependsOn: ["lane_code"] },
    ] });
    context.provide("voidAuthority", authoritySource({
      sessionId: "parent-session-1",
      actorId: "xiaobei",
      profiles: managerAndSubordinate,
    }));

    const started: Array<{ name: string; request: Record<string, unknown> }> = [];
    context.provide("subagents", fakeSubagents(started));

    const parent = { id: "parent-session-1" } as unknown as Agent;
    const launch = context.tools.get("launch_legion")!;
    const dispatched = await launch.execute(
      { teamId: "legion-tool-demo", task: "build" },
      mockExec(parent),
    ) as { runId: string; status: string; tasks: Array<{ laneId: string; status: string }> };

    // 派活不等跑完：拿到的是 runId，不是结果。
    expect(dispatched.runId).toMatch(/^legion-tool-demo-/);
    expect(dispatched.tasks.map((item) => item.laneId).sort()).toEqual(["lane_code", "lane_plan", "lane_verify"]);

    // 用 legion_run 等它跑完，再看完整视图。
    const run = context.tools.get("legion_run")!;
    const settled = await run.execute({ runId: dispatched.runId, wait: true }, mockExec(parent)) as {
      status: string;
      tasks: Array<{ laneId: string; status: string; childSessionId?: string }>;
      events: Array<{ kind: string }>;
    };

    expect(settled.status).toBe("completed");
    expect(settled.tasks.every((item) => item.status === "completed")).toBe(true);
    expect(started).toHaveLength(3);
    // 第一个 lane 的 parent 是 exec.agent（真实子代理 parent 链路）。
    expect(started[0]!.request.parent).toBe(parent);
    expect(started[0]!.request.prompt).toBeDefined();
    // 依赖顺序真的落到了派发顺序上：上游先起。
    expect(settled.tasks.map((item) => item.laneId)).toEqual(["lane_plan", "lane_code", "lane_verify"]);
    // 原生 child session 链接：界面能从运行记录跳回真正干活的会话（§15.2）。
    expect(settled.tasks.map((item) => item.childSessionId)).toEqual(["child-1", "child-2", "child-3"]);
  });

  // 2026-09-23 真机派活撞到的缺陷：面板（P6c）建的队伍只落在磁盘上，工具层却只查内存，
  // 于是「面板里看得见、派活说队伍不存在」，一个子代理都没起。
  it("dispatches a team that only exists on disk (the panel's teams)", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "void-legion-tool-disk-"));
    try {
      context = await boot({ dataDir });
      const team = context.get("voidTeam") as VoidTeam;
      await team.saveTeam(
        createTeamDocument({
          id: "legion-tool-disk",
          mode: "plan_execute_verify",
          managerAgentId: "xiaobei",
          members: [{ laneId: "lane_plan", agentId: "xiaoma", role: "researcher" }],
        }),
        { expectedRevision: 0 },
      );
      context.provide("voidAuthority", authoritySource({
        sessionId: "parent-session-1",
        actorId: "xiaobei",
        profiles: managerAndSubordinate,
      }));
      const started: Array<{ name: string; request: Record<string, unknown> }> = [];
      context.provide("subagents", fakeSubagents(started));

      // 内存里始终没有这支队伍：它只存在于磁盘上。
      expect(team.observe("legion-tool-disk")).toBeUndefined();

      const parent = { id: "parent-session-1" } as unknown as Agent;
      const dispatched = await context.tools.get("launch_legion")!.execute(
        { teamId: "legion-tool-disk" },
        mockExec(parent),
      ) as { runId: string; tasks: Array<{ laneId: string }> };

      expect(dispatched.runId).toMatch(/^legion-tool-disk-/);
      expect(dispatched.tasks.map((item) => item.laneId)).toEqual(["lane_plan"]);
      expect(started).toHaveLength(1);
      // 等这次跑完再删数据根，免得后台还在写。
      await context.tools.get("legion_run")!.execute({ runId: dispatched.runId, wait: true }, mockExec(parent));
    } finally {
      await context?.fiber.dispose();
      context = undefined;
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("hands every lane its own member identity, never the dispatcher's", async () => {
    context = await boot();
    const team = context.get("voidTeam") as VoidTeam;
    team.defineTeam({ ...threeLaneTeam, managerAgentId: "xiaobei", memberRoster: [
      { laneId: "lane_plan", agentId: "xiaoma", role: "researcher" },
      { laneId: "lane_code", agentId: "xiaohong", role: "coder", dependsOn: ["lane_plan"] },
    ] });
    context.provide("voidAuthority", authoritySource({
      sessionId: "parent-session-1",
      actorId: "xiaobei",
      profiles: [
        ["xiaobei", { id: "xiaobei", superiors: [], subordinates: ["xiaoma", "xiaohong"] }],
        ["xiaoma", { id: "xiaoma", superiors: ["xiaobei"], subordinates: [] }],
        ["xiaohong", { id: "xiaohong", superiors: ["xiaobei"], subordinates: [] }],
      ],
      personas: { xiaoma: "小马：写码的底线", xiaohong: "小红：验收的底线" },
    }));
    const started: Array<{ name: string; request: Record<string, unknown> }> = [];
    context.provide("subagents", fakeSubagents(started));

    const parent = { id: "parent-session-1" } as unknown as Agent;
    const dispatched = await context.tools.get("launch_legion")!.execute(
      { teamId: "legion-tool-demo" },
      mockExec(parent),
    ) as { runId: string };
    await context.tools.get("legion_run")!.execute({ runId: dispatched.runId, wait: true }, mockExec(parent));

    expect(started).toHaveLength(2);
    // 每个 lane 拿到的是**自己成员**的身份（按 label 就是 lane id 对上号）。
    const byLane = new Map(started.map((item) => [String(item.request.label), String(item.request.persona)]));
    expect(byLane.get("lane_plan")).toBe("小马：写码的底线");
    expect(byLane.get("lane_code")).toBe("小红：验收的底线");
    // 派活者（xiaobei）的身份一个都没混进来。
    for (const persona of byLane.values()) expect(persona).not.toContain("xiaobei");
    // 说明书还是逐 lane 的，身份与说明书是两件事（prompt 由宿主自己组装，形状不由这里定）。
    const prompts = started.map((item) => JSON.stringify(item.request.prompt));
    expect(prompts[0]).toContain("lane_plan");
    expect(prompts[1]).toContain("lane_code");
  });

  it("refuses the whole launch when one member identity cannot be read", async () => {
    context = await boot();
    const team = context.get("voidTeam") as VoidTeam;
    team.defineTeam({ ...threeLaneTeam, managerAgentId: "xiaobei", memberRoster: [
      { laneId: "lane_plan", agentId: "xiaoma", role: "researcher" },
    ] });
    context.provide("voidAuthority", authoritySource({
      sessionId: "parent-session-1",
      actorId: "xiaobei",
      profiles: managerAndSubordinate,
      personaError: "没有这份档案，取不出派活身份: xiaoma",
    }));
    const started: Array<{ name: string; request: Record<string, unknown> }> = [];
    context.provide("subagents", fakeSubagents(started));

    await expect(context.tools.get("launch_legion")!.execute(
      { teamId: "legion-tool-demo" },
      mockExec({ id: "parent-session-1" } as Agent),
    )).rejects.toThrow(/整队不派：1 个成员取不出派活身份——lane lane_plan 的派活身份取不出来（xiaoma）：没有这份档案/);
    // 取不出身份就一个子代理都不启动——不派「一半有名分、一半没名分」的队伍。
    expect(started).toEqual([]);
  });

  // 手动计划只管「这一步干什么」：谁来做、什么角色、依赖与写锁由队伍说了算。
  // 计划那条路以前自己造名单，模型照提示只写 laneId/title 就会派出一批没有档案 id 的人，
  // 权限检查在派发前直接拒（2026-09-23 真机派活撞到过 `派活目标缺少档案 id`）。
  it("fills a manual plan's missing fields from the team roster", async () => {
    context = await boot();
    const team = context.get("voidTeam") as VoidTeam;
    team.defineTeam({
      ...threeLaneTeam,
      managerAgentId: "xiaobei",
      memberRoster: [
        { laneId: "lane_plan", agentId: "xiaoma", role: "researcher" },
        { laneId: "lane_code", agentId: "xiaohong", role: "coder", dependsOn: ["lane_plan"] },
      ],
    });
    context.provide("voidAuthority", authoritySource({
      sessionId: "parent-session-1",
      actorId: "xiaobei",
      profiles: [
        ["xiaobei", { id: "xiaobei", superiors: [], subordinates: ["xiaoma", "xiaohong"] }],
        ["xiaoma", { id: "xiaoma", superiors: ["xiaobei"], subordinates: [] }],
        ["xiaohong", { id: "xiaohong", superiors: ["xiaobei"], subordinates: [] }],
      ],
      personas: { xiaoma: "小马：写码的底线", xiaohong: "小红：验收的底线" },
    }));
    const started: Array<{ name: string; request: Record<string, unknown> }> = [];
    context.provide("subagents", fakeSubagents(started));

    const parent = { id: "parent-session-1" } as unknown as Agent;
    const dispatched = await context.tools.get("launch_legion")!.execute(
      {
        teamId: "legion-tool-demo",
        plan: JSON.stringify({
          goal: "手动计划也要有人来做",
          tasks: [
            { laneId: "lane_plan", title: "出计划" },
            { laneId: "lane_code", title: "照计划写" },
          ],
        }),
      },
      mockExec(parent),
    ) as { runId: string; tasks: Array<{ laneId: string; agentId?: string }> };

    // 计划里一个字都没写 agentId：身份是从队伍那条 lane 上继承来的。
    expect(dispatched.tasks.map((item) => item.agentId)).toEqual(["xiaoma", "xiaohong"]);
    await context.tools.get("legion_run")!.execute({ runId: dispatched.runId, wait: true }, mockExec(parent));
    const byLane = new Map(started.map((item) => [String(item.request.label), String(item.request.persona)]));
    expect(byLane.get("lane_plan")).toBe("小马：写码的底线");
    expect(byLane.get("lane_code")).toBe("小红：验收的底线");
  });

  // 模型路由是**逐任务**的：回执、运行记录、真派下去的 `agentOptions` 必须是同一条，
  // 而且各 lane 各走各的。回执说谎或串线，都会让「以为用了便宜模型、实际用了贵的」这种
  // 事查不出来（2026-09-23 真机核对过两条真模型路由，见文档 A10 行）。
  it("reports each lane's own model route in the receipt, the run record and the dispatch", async () => {
    context = await boot();
    const team = context.get("voidTeam") as VoidTeam;
    team.defineTeam({
      ...threeLaneTeam,
      managerAgentId: "xiaobei",
      memberRoster: [
        { laneId: "lane_plan", agentId: "xiaoma", role: "researcher" },
        { laneId: "lane_code", agentId: "xiaohong", role: "coder", dependsOn: ["lane_plan"] },
      ],
    });
    context.provide("voidAuthority", authoritySource({
      sessionId: "parent-session-1",
      actorId: "xiaobei",
      profiles: [
        ["xiaobei", { id: "xiaobei", superiors: [], subordinates: ["xiaoma", "xiaohong"] }],
        ["xiaoma", { id: "xiaoma", superiors: ["xiaobei"], subordinates: [] }],
        ["xiaohong", { id: "xiaohong", superiors: ["xiaobei"], subordinates: [] }],
      ],
      personas: { xiaoma: "小马：写码的底线", xiaohong: "小红：验收的底线" },
    }));
    const started: Array<{ name: string; request: Record<string, unknown> }> = [];
    // 逐任务模型路由要 provider 明确声明 `agentOptions`，不声明就在派出去之前被拒。
    context.provide("subagents", fakeSubagents(started, { capabilities: { persona: true, agentOptions: true } }));

    const parent = { id: "parent-session-1" } as unknown as Agent;
    const dispatched = await context.tools.get("launch_legion")!.execute(
      {
        teamId: "legion-tool-demo",
        plan: JSON.stringify({
          goal: "两条 lane 各走各的路由",
          tasks: [
            { laneId: "lane_plan", title: "出计划", modelRef: "deepseek-flash" },
            { laneId: "lane_code", title: "照计划写", modelRef: "deepseek-v4-pro" },
          ],
        }),
      },
      mockExec(parent),
    ) as { runId: string; tasks: Array<{ laneId: string; modelRef?: string }> };

    expect(dispatched.tasks.map((item) => item.modelRef)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);

    const settled = await context.tools.get("legion_run")!.execute(
      { runId: dispatched.runId, wait: true },
      mockExec(parent),
    ) as { tasks: Array<{ laneId: string; modelRef?: string }> };
    expect(settled.tasks.map((item) => item.modelRef)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);

    // 真派下去的那一份也要各是自己的路由（裸模型名解析成 `{ model }`，不带 provider）。
    const routes = new Map(started.map((item) => [String(item.request.label), item.request.agentOptions]));
    expect(routes.get("lane_plan")).toEqual({ model: "deepseek-flash" });
    expect(routes.get("lane_code")).toEqual({ model: "deepseek-v4-pro" });
  });

  // 一次 run 可以只跑队伍的一部分 lane：从队伍继承来的跨 lane 引用（依赖/汇报/指挥/交接）
  // 若指向这次不跑的 lane，就要丢掉——那条 lane 不在名单里，「依赖它」「向它汇报」都无从
  // 谈起。真机派活撞到过 `成员 lane_front 的汇报对象不在名单里: lane_plan`。
  it("drops the team's cross-lane references that this run leaves out", async () => {
    context = await boot();
    const team = context.get("voidTeam") as VoidTeam;
    team.defineTeam({
      ...threeLaneTeam,
      managerAgentId: "xiaobei",
      memberRoster: [
        { laneId: "lane_plan", agentId: "xiaobei", role: "researcher" },
        { laneId: "lane_code", agentId: "xiaoma", role: "coder", dependsOn: ["lane_plan"], reportsTo: ["lane_plan"] },
      ],
    });
    context.provide("voidAuthority", authoritySource({
      sessionId: "parent-session-1",
      actorId: "xiaobei",
      profiles: managerAndSubordinate,
    }));
    const started: Array<{ name: string; request: Record<string, unknown> }> = [];
    context.provide("subagents", fakeSubagents(started));

    const parent = { id: "parent-session-1" } as unknown as Agent;
    const dispatched = await context.tools.get("launch_legion")!.execute(
      {
        teamId: "legion-tool-demo",
        plan: JSON.stringify({ goal: "只跑写码那条", tasks: [{ laneId: "lane_code", title: "写码" }] }),
      },
      mockExec(parent),
    ) as { runId: string; tasks: Array<{ laneId: string; agentId?: string }> };

    // 计划只跑了 lane_code：它继承来的 dependsOn/reportsTo 都指向没跑的 lane_plan，
    // 校验因此通过，身份照旧从队伍继承。
    expect(dispatched.tasks.map((item) => item.laneId)).toEqual(["lane_code"]);
    expect(dispatched.tasks[0]!.agentId).toBe("xiaoma");
    await context.tools.get("legion_run")!.execute({ runId: dispatched.runId, wait: true }, mockExec(parent));
    expect(started).toHaveLength(1);
  });

  it("legion_run returns a snapshot without waiting by default", async () => {
    context = await boot();
    const team = context.get("voidTeam") as VoidTeam;
    team.defineTeam({ ...threeLaneTeam, managerAgentId: "xiaobei", memberRoster: [
      { laneId: "lane_plan", agentId: "xiaoma", role: "researcher" },
    ] });
    context.provide("voidAuthority", authoritySource({
      sessionId: "parent-session-1",
      actorId: "xiaobei",
      profiles: managerAndSubordinate,
    }));
    const started: Array<{ name: string; request: Record<string, unknown> }> = [];
    context.provide("subagents", fakeSubagents(started));

    const parent = { id: "parent-session-1" } as unknown as Agent;
    const dispatched = await context.tools.get("launch_legion")!.execute(
      { teamId: "legion-tool-demo" },
      mockExec(parent),
    ) as { runId: string };

    const snapshot = await context.tools.get("legion_run")!.execute(
      { runId: dispatched.runId },
      mockExec(parent),
    ) as { runId: string; teamId: string; status: string; schedule: string; memberLimit: number; maxConcurrentTasks: number };

    expect(snapshot.runId).toBe(dispatched.runId);
    expect(snapshot.teamId).toBe("legion-tool-demo");
    expect(["running", "completed"]).toContain(snapshot.status);
    expect(snapshot.maxConcurrentTasks).toBeGreaterThan(0);
    expect(snapshot.memberLimit).toBeGreaterThan(0);
  });

  it("legion_cancel stops the whole run and never dispatches the rest", async () => {
    context = await boot();
    const team = context.get("voidTeam") as VoidTeam;
    team.defineTeam({ ...threeLaneTeam, managerAgentId: "xiaobei", memberRoster: [
      { laneId: "lane_plan", agentId: "xiaoma", role: "researcher" },
      { laneId: "lane_code", agentId: "xiaoma", role: "coder", dependsOn: ["lane_plan"] },
    ] });
    context.provide("voidAuthority", authoritySource({
      sessionId: "parent-session-1",
      actorId: "xiaobei",
      profiles: managerAndSubordinate,
    }));

    // 第一个 lane 卡住不返回，好在它跑着的时候叫停。
    let release: (() => void) | undefined;
    const started: string[] = [];
    const gate = new Promise<void>((resolve) => { release = resolve; });
    context.provide("subagents", {
      list: () => ["spawn"],
      getProvider: (name: string) => (name === "spawn" ? { name: "spawn", capabilities: { persona: true }, inheritsParentContext: false } : undefined),
      async start(_name: string, request: Record<string, unknown>) {
        started.push(String(request.label));
        if (started.length === 1) await gate;
        return {
          id: `child-${started.length}`,
          result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "ok" }] }),
          async dispose() {},
        };
      },
    });

    const parent = { id: "parent-session-1" } as unknown as Agent;
    const dispatched = await context.tools.get("launch_legion")!.execute(
      { teamId: "legion-tool-demo" },
      mockExec(parent),
    ) as { runId: string };

    const cancelled = await context.tools.get("legion_cancel")!.execute(
      { runId: dispatched.runId, reason: "改需求了" },
      mockExec(parent),
    ) as { status: string; scope: string };

    expect(cancelled.scope).toBe("run");
    expect(["cancelled", "running"]).toContain(cancelled.status);

    release?.();
    const settled = await context.tools.get("legion_run")!.execute(
      { runId: dispatched.runId, wait: true },
      mockExec(parent),
    ) as { tasks: Array<{ laneId: string; status: string }> };

    // 取消之后不再派发后面的任务。
    expect(started).toHaveLength(1);
    expect(settled.tasks.find((item) => item.laneId === "lane_code")!.status).toBe("cancelled");
  });

  it("releases launch_legion when the service is disposed (HMR-safe)", async () => {
    context = await boot();
    expect(context.tools.get("launch_legion")).toBeDefined();

    // dispose 军团 service（VoidTeam）→ tool 因 inject "voidTeam" 级联释放。
    const service = findFiber(context, "VoidTeam");
    expect(service).toBeDefined();
    await service!.dispose();

    expect(context.tools.get("launch_legion")).toBeUndefined();
  });
});
