import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { type ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { Agent } from "@deepseek-ai/dsh-agent";
import * as VoidSoulAuthority from "@void/void-soul/authority-service";
import * as VoidLegionService from "@void/void-legion/service";
import * as VoidLegionTool from "@void/void-legion/tool";
import * as VoidLegionRunTool from "@void/void-legion/run-tool";
import { saveSessionBindings, selectFacetForProfile } from "@void/void-soul";
import type { VoidTeam } from "@void/void-legion";
import { afterEach, describe, expect, it } from "vitest";

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

async function writeSoul(directory: string, lines: readonly string[]): Promise<void> {
  const dir = join(dataDir!, "agents", directory);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SOUL.md"), [...lines, ""].join("\n"), "utf8");
}

async function writeFacet(file: string, lines: readonly string[]): Promise<void> {
  const dir = join(dataDir!, "agents", "facets");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), [...lines, ""].join("\n"), "utf8");
}

/**
 * 逐子代理身份的跨包闭环：真灵魂服务 + 真军团 + 真 `launch_legion` 工具，只把
 * `ctx.subagents` 换成假的（真子代理要真实模型凭据）。宿主 `dsh-subagent` 收到
 * `persona` 之后会把它装成子代理的系统段 `deployment:persona-prefix`（装机 rc 里
 * 核对过：`lib/index.js:549-552`），所以这里断言「宿主到底收到了谁的身份」。
 */
function fakeSubagents(started: Array<{ name: string; request: Record<string, unknown> }>) {
  const provider = { name: "spawn", capabilities: { persona: true }, inheritsParentContext: false };
  return {
    list: () => ["spawn"],
    getProvider: (name: string) => (name === "spawn" ? provider : undefined),
    async start(name: string, request: Record<string, unknown>) {
      started.push({ name, request });
      return {
        id: `child-${started.length}`,
        result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "ok" }] }),
        async dispose() {},
      };
    },
  };
}

async function boot(options: { maxCharacters?: number } = {}): Promise<Context> {
  dataDir = await mkdtemp(join(tmpdir(), "void-persona-closure-"));
  // 三份档案：小贝是派活者（会话绑它），小马与小虹是被派的成员。
  await writeSoul("小贝", [
    "---", "id: xiaobei", "name: 小贝", "summary: 统筹",
    "authority:", "  subordinates: [xiaoma, xiaohong]", "---", "", "SOUL-小贝-统筹",
  ]);
  await writeSoul("小码", ["---", "id: xiaoma", "name: 小码", "summary: 写码", "---", "", "SOUL-小马-写码"]);
  await writeSoul("小红", ["---", "id: xiaohong", "name: 小红", "summary: 验收", "---", "", "SOUL-小红-验收"]);
  await writeFacet("coder.md", ["---", "id: coder", "name: 写码专家", "summary: 只写代码", "---", "", "# 角色", "FACET-只写代码"]);
  // 小马选了角色：身份是「底线 + 当前角色」，两段都要落到子代理身上。
  await selectFacetForProfile(dataDir, { profileId: "xiaoma", facetId: "coder" });
  await saveSessionBindings(dataDir, new Map([["parent-session-1", "xiaobei"]]));

  const ctx = new Context();
  await ctx.plugin(Loader);
  const modules = new Map<string, unknown>([
    ["@deepseek-ai/dsh-system-prompt", SystemPrompt],
    ["@deepseek-ai/dsh-tools", ToolRuntime],
    ["@void/void-soul/authority-service", VoidSoulAuthority],
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
  await ctx.loader.create({
    name: "@void/void-soul/authority-service",
    config: { dataDir, ...(options.maxCharacters === undefined ? {} : { maxCharacters: options.maxCharacters }) },
  });
  await ctx.loader.create({ name: "@void/void-legion/service" });
  await ctx.loader.create({ name: "@void/void-legion/tool" });
  await ctx.loader.create({ name: "@void/void-legion/run-tool" });
  await ctx.loader.await();
  return ctx;
}

function mockExec(parent: Agent): ToolRunContext {
  return { agent: parent, signal: new AbortController().signal } as unknown as ToolRunContext;
}

describe("逐子代理身份闭环（灵魂 → 军团 → 宿主 persona）", () => {
  it("每个 lane 拿到的是自己成员的底线加当前角色，派活者的身份不混进来", async () => {
    context = await boot();
    const team = context.get("voidTeam") as VoidTeam;
    team.defineTeam({
      id: "identity-demo",
      mode: "plan_execute_verify",
      managerAgentId: "xiaobei",
      memberRoster: [
        { laneId: "lane_plan", agentId: "xiaoma", role: "coder", authorityRelationToManager: "subordinate" },
        { laneId: "lane_code", agentId: "xiaohong", role: "verifier", authorityRelationToManager: "subordinate", dependsOn: ["lane_plan"] },
      ],
    });
    const started: Array<{ name: string; request: Record<string, unknown> }> = [];
    context.provide("subagents", fakeSubagents(started));

    const parent = { id: "parent-session-1" } as unknown as Agent;
    const dispatched = await context.tools.get("launch_legion")!.execute(
      { teamId: "identity-demo" },
      mockExec(parent),
    ) as { runId: string };
    await context.tools.get("legion_run")!.execute({ runId: dispatched.runId, wait: true }, mockExec(parent));

    expect(started).toHaveLength(2);
    const byLane = new Map(started.map((item) => [String(item.request.label), String(item.request.persona)]));
    // 先证明身份真的带上了：不然下面那些「不含」全是假绿。
    expect(byLane.get("lane_plan")).toBeTruthy();
    expect(byLane.get("lane_code")).toBeTruthy();
    // 底线 + 当前角色都落到子代理身上（P5 的「SOUL/FACET 修订」）。
    expect(byLane.get("lane_plan")).toContain("SOUL-小马-写码");
    expect(byLane.get("lane_plan")).toContain("FACET-只写代码");
    expect(byLane.get("lane_code")).toContain("SOUL-小红-验收");
    // 派活者的身份（小贝）一个都没混进来，成员之间也不串。
    for (const persona of byLane.values()) expect(persona).not.toContain("SOUL-小贝");
    expect(byLane.get("lane_code")).not.toContain("SOUL-小马");
    expect(byLane.get("lane_plan")).not.toContain("SOUL-小红");
  });

  it("身份取不出来就整次拒绝：连运行记录都不建，一个子代理都不启动", async () => {
    // 预算压到 5 字：档案还在、权威图自洽，只有「取身份」这一步过不去。
    context = await boot({ maxCharacters: 5 });
    const team = context.get("voidTeam") as VoidTeam;
    team.defineTeam({
      id: "identity-demo",
      mode: "plan_execute_verify",
      managerAgentId: "xiaobei",
      memberRoster: [
        { laneId: "lane_plan", agentId: "xiaoma", role: "coder", authorityRelationToManager: "subordinate" },
      ],
    });
    const started: Array<{ name: string; request: Record<string, unknown> }> = [];
    context.provide("subagents", fakeSubagents(started));

    await expect(context.tools.get("launch_legion")!.execute(
      { teamId: "identity-demo" },
      mockExec({ id: "parent-session-1" } as Agent),
    // A17 起改成整队一次报全：外面套一层「整队不派：N 个成员取不出派活身份——」，原因原文照旧带出来。
    )).rejects.toThrow(/整队不派：1 个成员取不出派活身份——lane lane_plan 的派活身份取不出来（xiaoma）：说明书超出本次上下文预算/);
    expect(started).toEqual([]);
    // 派发在任何子代理启动之前就被拦住，所以连运行记录都不该留。
    expect(await context.get("voidTeam")!.listRunsByTeam("identity-demo")).toEqual([]);
  });
});
