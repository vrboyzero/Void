import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import * as VoidMemoryProvider from "@void/void-memory/provider";
import * as VoidMemoryTool from "@void/void-memory/tool";
import * as VoidMemoryLibrary from "@void/void-memory/memory-service";
import * as VoidSoulAuthority from "@void/void-soul/authority-service";
import * as VoidSoulLibrary from "@void/void-soul/soul-service";
import * as VoidToolsContracts from "@void/void-tools/registry";
import * as VoidToolsPolicy from "@void/void-tools/policy";
import * as VoidLegion from "@void/void-legion/service";
import type { VoidMemory } from "@void/void-memory";
import type { VoidToolContracts } from "@void/void-tools";
import type { VoidTeam } from "@void/void-legion";

let context: Context | undefined;
let dataDir: string | undefined;

afterEach(async () => {
  await context?.fiber.dispose();
  context = undefined;
  if (dataDir !== undefined) {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    dataDir = undefined;
  }
});

/**
 * Boot the full void composition (memory + tools + legion) in one Cordis
 * context, through the real Loader with a mocked module resolver.
 *
 * 记忆 provider 用的是**当前契约**的 `@void/void-memory/provider`：它要求绑定
 * 档案身份后才给句柄（`forAgent`），所以这里显式给一个隔离数据根，不碰日常 home。
 */
async function boot(): Promise<Context> {
  dataDir = await mkdtemp(join(tmpdir(), "void-vertical-closure-"));
  const ctx = new Context();
  await ctx.plugin(Loader);
  const modules = new Map<string, unknown>([
    ["@deepseek-ai/dsh-system-prompt", SystemPrompt],
    ["@deepseek-ai/dsh-tools", ToolRuntime],
    ["@void/void-memory/provider", VoidMemoryProvider],
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
  await ctx.loader.create({ name: "@void/void-memory/provider", config: { dataDir } });
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

    // Memory seam: 身份绑定后才拿得到句柄，写入与检索都在这个档案自己的目录里。
    const memory = context.get("voidMemory") as VoidMemory;
    expect(memory).toBeDefined();
    const handle = memory.forAgent({ agentId: "xiaobei" });
    const written = await handle.write({ body: "the void remembers hello world" });
    expect(written.entryId).toMatch(/^[0-9]{8}-[0-9]{4}$/);
    const hits = await handle.search({ query: "void", k: 5 });
    expect(hits.length).toBeGreaterThan(0);
    // 另一个档案看不到：A 记 B 查不到。
    expect(await memory.forAgent({ agentId: "xiaoma" }).search({ query: "void", k: 5 })).toEqual([]);

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

  /**
   * 回归（P7 真机发现）：宿主 rc 线不给运行期档案名（见 13.1），装包的人可能只漏一个
   * `DSH_PROFILE`。那**不该**让整棵插件树加载失败——cordis 把构造器抛错当插件启动失败，
   * 一个漏配的变量会掀掉整个 GUI（web 起不来，报 `plugin tree failed to load`）。
   * 三个服务都要照常加载，真正用到数据的时候才报一句看得懂的错。
   */
  it("没有档案名时三个服务照常加载，用到数据才报错", async () => {
    const saved = process.env.DSH_PROFILE;
    delete process.env.DSH_PROFILE;
    try {
      const ctx = new Context();
      context = ctx;
      await ctx.plugin(Loader);
      const modules = new Map<string, unknown>([
        ["@void/void-soul/authority-service", VoidSoulAuthority],
        ["@void/void-soul/soul-service", VoidSoulLibrary],
        ["@void/void-memory/memory-service", VoidMemoryLibrary],
      ]);
      ctx.loader.internal = {
        version: "v2",
        async import(specifier: string) {
          if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`);
          return modules.get(specifier);
        },
      } as unknown as NonNullable<typeof ctx.loader.internal>;
      await ctx.loader.create({ name: "@void/void-soul/authority-service" });
      await ctx.loader.create({ name: "@void/void-soul/soul-service" });
      await ctx.loader.create({ name: "@void/void-memory/memory-service" });
      await ctx.loader.await();

      const authority = ctx.get("voidAuthority") as { dataRoot?: string; forSession(id: string): Promise<unknown> };
      const soul = ctx.get("voidSoul") as { dataRoot?: string; listProfiles(): Promise<unknown> };
      const memory = ctx.get("voidMemoryLibrary") as { dataRoot?: string; listAgents(): Promise<unknown> };
      expect(authority.dataRoot).toBeUndefined();
      expect(soul.dataRoot).toBeUndefined();
      expect(memory.dataRoot).toBeUndefined();
      await expect(authority.forSession("session-a")).rejects.toThrow(/权威档案没有数据根，无法解析派活身份/);
      await expect(soul.listProfiles()).rejects.toThrow(/灵魂档案没有数据根，无法读写档案与模组/);
      await expect(memory.listAgents()).rejects.toThrow(/人格记忆没有数据根，无法读写记忆/);
    } finally {
      if (saved === undefined) delete process.env.DSH_PROFILE;
      else process.env.DSH_PROFILE = saved;
    }
  });
});
