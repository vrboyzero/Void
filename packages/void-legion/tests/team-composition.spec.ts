import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import * as VoidLegion from "../src/service.js";
import type { VoidTeam } from "../src/service.js";
import type { DelegationTeamMetadata } from "../src/team.js";

const ACTIVE = 2;

let context: Context | undefined;

afterEach(async () => {
  await context?.fiber.dispose();
  context = undefined;
});

function findFiber(ctx: Context, pluginName: string) {
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers) {
      if (fiber.name === pluginName) return fiber;
    }
  }
  return undefined;
}

// The minimal five-lane legion from the plan (§5 最小军团核心流程).
const fiveLaneTeam: DelegationTeamMetadata = {
  id: "legion-demo",
  mode: "plan_execute_verify",
  sharedGoal: "prove the ctx.voidTeam seam",
  memberRoster: [
    { laneId: "lane_plan", role: "researcher", authorityRelationToManager: "peer" },
    { laneId: "lane_plan_doc", role: "default", authorityRelationToManager: "peer", dependsOn: ["lane_plan"] },
    { laneId: "lane_code", role: "coder", authorityRelationToManager: "subordinate", dependsOn: ["lane_plan_doc"] },
    { laneId: "lane_verify", role: "verifier", authorityRelationToManager: "peer", dependsOn: ["lane_code"] },
    { laneId: "lane_progress", role: "default", authorityRelationToManager: "subordinate", dependsOn: ["lane_plan_doc", "lane_code", "lane_verify"] },
  ],
};

async function boot(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(Loader);
  const modules = new Map<string, unknown>([["@void/void-legion/service", VoidLegion]]);
  ctx.loader.internal = {
    version: "v2",
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`);
      return modules.get(specifier);
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>;
  await ctx.loader.create({ name: "@void/void-legion/service" });
  await ctx.loader.await();
  return ctx;
}

describe("void legion seam through the Loader", () => {
  it("exposes the five-lane roster + authority graph + checkpoints", async () => {
    context = await boot();
    const team = context.get("voidTeam") as VoidTeam;
    expect(team).toBeDefined();

    team.defineTeam(fiveLaneTeam);
    const observed = team.observe("legion-demo");
    expect(observed).toBeDefined();
    expect(observed!.memberRoster).toHaveLength(5);

    // Authority relations preserved (peer vs subordinate).
    const code = observed!.memberRoster.find((m) => m.laneId === "lane_code")!;
    expect(code.authorityRelationToManager).toBe("subordinate");
    const verify = observed!.memberRoster.find((m) => m.laneId === "lane_verify")!;
    expect(verify.authorityRelationToManager).toBe("peer");

    // dependsOn chain preserved (lane_progress depends on plan_doc + code + verify).
    const progress = observed!.memberRoster.find((m) => m.laneId === "lane_progress")!;
    expect(progress.dependsOn).toEqual(["lane_plan_doc", "lane_code", "lane_verify"]);

    // Checkpoint heartbeat.
    team.checkpoint("legion-demo", "lane_code", "completed");
    expect(team.getCheckpoint("legion-demo", "lane_code")).toBe("completed");
  });

  it("releases the legion seam when the provider is disposed (HMR-safe)", async () => {
    context = await boot();
    expect(context.get("voidTeam")).toBeDefined();

    const provider = findFiber(context, "VoidTeam");
    expect(provider).toBeDefined();
    await provider!.dispose();
    expect(context.get("voidTeam")).toBeUndefined();
  });

  it("launches lanes in dependency order and checkpoints each", async () => {
    context = await boot();
    const team = context.get("voidTeam") as VoidTeam;
    team.defineTeam(fiveLaneTeam);

    const result = await team.launch("legion-demo", { worker: async () => ({ ok: true }) });
    // plan → plan_doc → code → verify → progress (dependsOn-respecting order).
    expect(result.order[0]).toBe("lane_plan");
    expect(result.order[1]).toBe("lane_plan_doc");
    expect(result.order[2]).toBe("lane_code");
    expect(result.order[3]).toBe("lane_verify");
    expect(result.order[4]).toBe("lane_progress");

    expect(team.getCheckpoint("legion-demo", "lane_code")).toBe("completed");
    expect(team.getCheckpoint("legion-demo", "lane_progress")).toBe("completed");
  });

  // §19.1「默认 no-op worker 让任何队伍都空跑成功」——最危险的一种假成功，必须拒绝。
  it("refuses to launch without a worker instead of silently succeeding", async () => {
    context = await boot();
    const team = context.get("voidTeam") as VoidTeam;
    team.defineTeam(fiveLaneTeam);

    await expect(team.launch("legion-demo")).rejects.toThrow(/派活缺少执行体/);
    // 拒绝发生在派发之前：一条 checkpoint 都不该被写成 completed。
    expect(team.getCheckpoint("legion-demo", "lane_plan")).toBeUndefined();
  });

  // §19.1「未知依赖被忽略」：少写一个成员，旧实现会当没写这条边继续跑。
  it("rejects a roster whose dependency points outside the roster", async () => {
    context = await boot();
    const team = context.get("voidTeam") as VoidTeam;
    team.defineTeam({
      id: "legion-broken",
      mode: "parallel_subtasks",
      memberRoster: [
        { laneId: "lane_a", authorityRelationToManager: "peer" },
        { laneId: "lane_b", authorityRelationToManager: "peer", dependsOn: ["lane_missing"] },
      ],
    });

    await expect(team.launch("legion-broken", { worker: async () => ({ ok: true }) })).rejects.toThrow(
      /成员 lane_b 的依赖不在名单里: lane_missing/,
    );
  });

  it("rejects a roster whose dependencies form a cycle", async () => {
    context = await boot();
    const team = context.get("voidTeam") as VoidTeam;
    team.defineTeam({
      id: "legion-cycle",
      mode: "parallel_subtasks",
      memberRoster: [
        { laneId: "lane_a", authorityRelationToManager: "peer", dependsOn: ["lane_b"] },
        { laneId: "lane_b", authorityRelationToManager: "peer", dependsOn: ["lane_a"] },
      ],
    });

    await expect(team.launch("legion-cycle", { worker: async () => ({ ok: true }) })).rejects.toThrow(/成员依赖成环/);
  });

  it("dispatches lanes in order, passing upstream outputs to downstream workers", async () => {
    context = await boot();
    const team = context.get("voidTeam") as VoidTeam;
    team.defineTeam(fiveLaneTeam);

    const seen: string[] = [];
    const result = await team.launch("legion-demo", {
      task: "build",
      worker: async ({ laneId, upstream }) => {
        seen.push(laneId);
        return { laneId, upstream: { ...upstream } };
      },
    });

    // 派发顺序 = 拓扑顺序。
    expect(seen).toEqual(["lane_plan", "lane_plan_doc", "lane_code", "lane_verify", "lane_progress"]);
    // 下游 lane 收到上游输出。
    const code = result.results.find((r) => r.laneId === "lane_code")!;
    expect((code.output as { upstream: Record<string, unknown> }).upstream).toHaveProperty("lane_plan_doc");
    const progress = result.results.find((r) => r.laneId === "lane_progress")!;
    expect((progress.output as { upstream: Record<string, unknown> }).upstream).toHaveProperty("lane_verify");
  });

  it("fails downstream lanes when an upstream lane fails (fail-fast propagation)", async () => {
    context = await boot();
    const team = context.get("voidTeam") as VoidTeam;
    team.defineTeam(fiveLaneTeam);

    const result = await team.launch("legion-demo", {
      worker: async ({ laneId }) => {
        if (laneId === "lane_code") throw new Error("code boom");
        return { ok: true };
      },
    });

    const code = result.results.find((r) => r.laneId === "lane_code")!;
    expect(code.status).toBe("failed");
    // lane_verify 直接依赖 lane_code → 被阻断，不派发；错误文案要指名是哪个上游没干成。
    const verify = result.results.find((r) => r.laneId === "lane_verify")!;
    expect(verify.status).toBe("failed");
    expect(verify.error).toContain("上游任务 lane_code 没干成");
    // lane_progress 依赖 lane_verify 和 lane_code → 也被阻断；两个上游都没干成时
    // 指名名单里靠前的那个（确定性：同一个计划每次给的文案一样）。
    const progress = result.results.find((r) => r.laneId === "lane_progress")!;
    expect(progress.status).toBe("failed");
    expect(progress.error).toContain("上游任务 lane_code 没干成");
    // 无依赖的 lane_plan 仍正常完成。
    expect(result.results.find((r) => r.laneId === "lane_plan")!.status).toBe("completed");
  });
});
