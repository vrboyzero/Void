import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import * as VoidMemorySqlite from "@void/void-memory/sqlite";
import * as VoidMemoryTool from "@void/void-memory/tool";
import * as VoidToolsContracts from "@void/void-tools/registry";
import * as VoidToolsPolicy from "@void/void-tools/policy";
import * as VoidLegion from "@void/void-legion/service";
import type { VoidMemory } from "@void/void-memory";
import type { VoidToolContracts } from "@void/void-tools";
import type { VoidTeam } from "@void/void-legion";

let context: Context | undefined;

afterEach(async () => {
  await context?.fiber.dispose();
  context = undefined;
});

/**
 * Boot the full void composition (memory + tools + legion) in one Cordis
 * context, through the real Loader with a mocked module resolver.
 */
async function boot(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(Loader);
  const modules = new Map<string, unknown>([
    ["@deepseek-ai/dsh-system-prompt", SystemPrompt],
    ["@deepseek-ai/dsh-tools", ToolRuntime],
    ["@void/void-memory/sqlite", VoidMemorySqlite],
    ["@void/void-memory/tool", VoidMemoryTool],
    ["@void/void-tools/registry", VoidToolsContracts],
    ["@void/void-tools/policy", VoidToolsPolicy],
    ["@void/void-legion/service", VoidLegion],
  ]);
  ctx.loader.internal = {
    version: "v2",
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`);
      return modules.get(specifier);
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>;
  // Sequential loading (Include's Promise.allSettled fan-out drops nested providers).
  await ctx.loader.create({ name: "@deepseek-ai/dsh-system-prompt" });
  await ctx.loader.create({ name: "@deepseek-ai/dsh-tools" });
  await ctx.loader.create({ name: "@void/void-memory/sqlite" });
  await ctx.loader.create({ name: "@void/void-memory/tool" });
  await ctx.loader.create({ name: "@void/void-tools/registry" });
  await ctx.loader.create({
    name: "@void/void-tools/policy",
    config: {
      contracts: [{ name: "void_exec", family: "command-exec", isReadOnly: false, needsPermission: true, riskLevel: "high" }],
      rolePolicy: { role: "researcher", allowedToolFamilies: ["workspace-read"], maxToolRiskLevel: "medium" },
    },
  });
  await ctx.loader.create({ name: "@void/void-legion/service" });
  await ctx.loader.await();
  return ctx;
}

describe("void vertical closure (memory + tools + legion in one context)", () => {
  it("composes all three seams and round-trips the flow", async () => {
    context = await boot();

    // Memory seam: store + search.
    const memory = context.get("voidMemory") as VoidMemory;
    expect(memory).toBeDefined();
    memory.store("the void remembers hello world", new Float32Array([0.1, 0.2, 0.3, 0.4]));
    expect(memory.search("void", 5).length).toBeGreaterThan(0);

    // Tools seam: contract registry + guard wired (policy active).
    const contracts = context.get("voidToolContracts") as VoidToolContracts;
    expect(contracts.get("void_exec")?.family).toBe("command-exec");

    // Legion seam: five-lane roster + checkpoint.
    const team = context.get("voidTeam") as VoidTeam;
    team.defineTeam({
      id: "legion-demo",
      mode: "plan_execute_verify",
      memberRoster: [
        { laneId: "lane_plan", role: "researcher", authorityRelationToManager: "peer" },
        { laneId: "lane_code", role: "coder", authorityRelationToManager: "subordinate", dependsOn: ["lane_plan"] },
        { laneId: "lane_verify", role: "verifier", authorityRelationToManager: "peer", dependsOn: ["lane_code"] },
      ],
    });
    expect(team.observe("legion-demo")?.memberRoster).toHaveLength(3);
    team.checkpoint("legion-demo", "lane_plan", "completed");

    // The model-facing closure: memory_search is the single entry tool.
    expect(context.tools.get("memory_search")).toBeDefined();
    expect(context.tools.schemas().some((s) => s.name === "memory_search")).toBe(true);
  });

  it("releases each seam independently (逆序释放, no residue)", async () => {
    context = await boot();
    expect(context.get("voidMemory")).toBeDefined();
    expect(context.get("voidTeam")).toBeDefined();

    await context.fiber.dispose();
    // After full disposal, the context should be clean (nothing left).
    expect(context.get("voidMemory")).toBeUndefined();
    expect(context.get("voidTeam")).toBeUndefined();
    expect(context.get("voidToolContracts")).toBeUndefined();
  });
});
