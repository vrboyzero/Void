import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { type ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { Agent } from "@deepseek-ai/dsh-agent";
import * as VoidLegionService from "../src/service.js";
import * as VoidLegionTool from "../src/tool.js";
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

async function boot(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(Loader);
  const modules = new Map<string, unknown>([
    ["@deepseek-ai/dsh-system-prompt", SystemPrompt],
    ["@deepseek-ai/dsh-tools", ToolRuntime],
    ["@void/void-legion/service", VoidLegionService],
    ["@void/void-legion/tool", VoidLegionTool],
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
  await ctx.loader.create({ name: "@void/void-legion/service" });
  await ctx.loader.create({ name: "@void/void-legion/tool" });
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

  it("dispatches every lane to ctx.subagents in dependency order (real closure)", async () => {
    context = await boot();
    const team = context.get("voidTeam") as VoidTeam;
    team.defineTeam(threeLaneTeam);

    const started: Array<{ name: string; request: Record<string, unknown> }> = [];
    context.provide("subagents", {
      async start(name: string, request: Record<string, unknown>) {
        started.push({ name, request });
        return {
          result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "ok" }] }),
          async dispose() {},
        };
      },
    });

    const parent = { id: "parent-session-1" } as unknown as Agent;
    const tool = context.tools.get("launch_legion")!;
    const result = await tool.execute(
      { teamId: "legion-tool-demo", task: "build" },
      mockExec(parent),
    ) as { order: string[]; results: Array<{ laneId: string; status: string }> };

    expect(result.order).toEqual(["lane_plan", "lane_code", "lane_verify"]);
    expect(started).toHaveLength(3);
    // 第一个 lane 的 parent 是 exec.agent（真实子代理 parent 链路）。
    expect(started[0]!.request.parent).toBe(parent);
    expect(started[0]!.request.prompt).toBeDefined();
    // 所有 lane 经真实 worker 完成。
    expect(result.results.every((r) => r.status === "completed")).toBe(true);
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
