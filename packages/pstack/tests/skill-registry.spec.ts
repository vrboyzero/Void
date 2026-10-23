import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import SkillRegistry from "@deepseek-ai/dsh-skill";
import * as Pstack from "../src/index.js";
import type { PstackSkillRegistration } from "../src/skills-contribute.js";

/**
 * 对着**真的技能注册表**跑一遍。
 *
 * 为什么不是假替身：本包注册的是运行期技能（`ctx.skills.register`），注册表要校验名字、调用策略、
 * 来源标签，然后把它们合并进目录并按调用策略渲染。假替身照单全收——它能证明「我调了 register」，
 * 证明不了「技能真的进了目录，且 `/` 菜单看得见、模型面看不见」。这两件事正是本移植的全部价值。
 */

let context: Context | undefined;

afterEach(async () => {
  await context?.fiber.dispose();
  context = undefined;
});

async function boot() {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(SkillRegistry);
  // 命令与子代理这两个服务本测试不关心，顶一个最小的。
  ctx.provide("commands", { register: () => () => undefined });
  ctx.provide("subagents", { startActivation: async () => { throw new Error("unused"); } });
  await ctx.plugin(Pstack);
  await settle();
  context = ctx;
  return ctx;
}

/** 让 cordis 把已经就绪的 inject 子 fiber 全部激活完。 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function skillsOf(ctx: Context) {
  const registry = ctx.get("skills") as { list(): Promise<{ name: string; invocation: { modelInvocable: boolean; userInvocable: boolean }; source: string; resourceBase?: { kind: string; path?: string } }[]> };
  return registry.list();
}

describe("@void/pstack against the real skill registry", () => {
  it("gets all 55 vendored skills plus the harness skill into the catalog", async () => {
    const ctx = await boot();
    const names = (await skillsOf(ctx)).map((skill) => skill.name);
    expect(names).toHaveLength(56);
    expect(names).toContain("poteto-mode");
    expect(names).toContain("how");
    expect(names).toContain("arena");
    expect(names).toContain("principle-laziness-protocol");
    expect(names).toContain(Pstack.HARNESS_SKILL_NAME);
  });

  it("keeps pstack's invocation policy: user-invocable in the / menu, hidden from the model", async () => {
    const ctx = await boot();
    const catalog = await skillsOf(ctx);
    const poteto = catalog.find((skill) => skill.name === "poteto-mode");
    expect(poteto?.invocation).toEqual({ modelInvocable: false, userInvocable: true });
    expect(poteto?.source).toBe("runtime");
    // 目录资源的相对引用（playbooks / references）必须指向包内那个技能目录。
    expect(poteto?.resourceBase?.kind).toBe("directory");
    expect(poteto?.resourceBase?.path?.endsWith("poteto-mode")).toBe(true);
    const setup = catalog.find((skill) => skill.name === "setup-pstack");
    expect(setup?.invocation).toEqual({ modelInvocable: true, userInvocable: true });
  });

  it("loads a full skill body through the registry, not just its summary", async () => {
    const ctx = await boot();
    const registry = ctx.get("skills") as { get(name: string): Promise<{ content: string; path?: string } | undefined> };
    const poteto = await registry.get("poteto-mode");
    expect(poteto?.content).toContain("## Playbooks");
    expect(poteto?.content.startsWith("---")).toBe(false);
    expect(poteto?.path?.endsWith("poteto-mode\\SKILL.md") || poteto?.path?.endsWith("poteto-mode/SKILL.md")).toBe(true);
  });

  it("hands the registry the rename map instead of silently shadowing a same-name skill", async () => {
    const ctx = new Context();
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(SkillRegistry);
    ctx.provide("commands", { register: () => () => undefined });
    ctx.provide("subagents", { startActivation: async () => { throw new Error("unused"); } });
    // 先放一个同名技能，模拟用户自己装的 tdd。
    const existing: PstackSkillRegistration = {
      name: "tdd",
      description: "用户自己装的 tdd",
      content: "# mine",
      source: "runtime",
      invocation: { modelInvocable: true, userInvocable: true },
    };
    (ctx.get("skills") as { register(skill: PstackSkillRegistration): () => void }).register(existing);
    await ctx.plugin(Pstack, { renameSkills: { tdd: "pstack-tdd" } });
    await settle();
    context = ctx;
    const catalog = await skillsOf(ctx);
    // 用户那份还在原位上（同名运行期技能是 first-wins，本包改名之后根本没去抢那个名字）。
    expect(catalog.find((skill) => skill.name === "tdd")).toBeDefined();
    expect(catalog.filter((skill) => skill.name === "tdd")).toHaveLength(1);
    expect(catalog.map((skill) => skill.name)).toContain("pstack-tdd");
  });

  it("removes every registered skill when the plugin fiber is disposed", async () => {
    const ctx = await boot();
    expect((await skillsOf(ctx)).length).toBe(56);
    const fiber = [...ctx.registry.values()].flatMap((runtime) => [...runtime.fibers]).find((f) => f.name === "void-pstack");
    await fiber!.dispose();
    expect(await skillsOf(ctx)).toEqual([]);
  });
});
