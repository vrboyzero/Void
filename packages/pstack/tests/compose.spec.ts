import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import * as Pstack from "../src/index.js";
import type { PstackConfig } from "../src/config.js";
import type { PstackSkillRegistration } from "../src/skills-contribute.js";
import type { PstackPromptSection } from "../src/prompt.js";

/**
 * 真组合测试：真 `Context` + 真工具注册表（`dsh-tools`），技能 / 命令 / 子代理用最小的假服务顶替。
 *
 * 为什么要真工具注册表：`defineTool` 的两个 schema 是不是注册表接受，假替身证明不了——它会把
 * `parameters` 和 `output` 照单全收。这一层真跑一遍，才能证明「模型看得见这两个工具」。
 */

let context: Context | undefined;

afterEach(async () => {
  await context?.fiber.dispose();
  context = undefined;
});

interface Harness {
  ctx: Context
  skills: PstackSkillRegistration[]
  commands: { name: string }[]
}

async function boot(config: PstackConfig = {}): Promise<Harness> {
  const ctx = new Context();
  // 工具注册表依赖 `systemPrompt`（它把自己的 schema 段贡献进系统提示词），少挂一个它就永远
  // PENDING，插件跟着一起不激活——那样测出来的「什么都没注册」是假象。
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const skills: PstackSkillRegistration[] = [];
  const commands: { name: string }[] = [];
  ctx.provide("skills", {
    register(skill: PstackSkillRegistration) {
      skills.push(skill);
      return () => undefined;
    },
  });
  ctx.provide("commands", {
    register(definition: { name: string }) {
      commands.push(definition);
      return () => undefined;
    },
  });
  ctx.provide("subagents", {
    async startActivation() {
      throw new Error("本测试不真的派生子代理");
    },
  });
  await ctx.plugin(Pstack, config);
  // 插件用 `ctx.inject()` 等三个服务出现再挂载各自的贡献，那是子 fiber：父 fiber 的 await 不等它们。
  await settle();
  context = ctx;
  return { ctx, skills, commands };
}

/** 让 cordis 把已经就绪的 inject 子 fiber 全部激活完。 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function toolNames(ctx: Context): string[] {
  return ctx.tools.schemas().map((schema) => schema.name).sort();
}

describe("@void/pstack composition", () => {
  it("registers the vendored skills plus the DSH harness skill", async () => {
    const { skills } = await boot();
    expect(skills).toHaveLength(56);
    const names = skills.map((skill) => skill.name);
    expect(names).toContain("poteto-mode");
    expect(names).toContain(Pstack.HARNESS_SKILL_NAME);
    expect(skills.filter((skill) => skill.name === Pstack.HARNESS_SKILL_NAME)[0]?.invocation).toEqual({
      modelInvocable: true,
      userInvocable: true,
    });
  });

  it("registers both delegates into the real tool registry", async () => {
    const { ctx } = await boot();
    expect(toolNames(ctx)).toContain("pstack_agent");
    expect(toolNames(ctx)).toContain("pstack_comment_sicko");
  });

  it("registers the /pstack-mode command", async () => {
    const { commands } = await boot();
    expect(commands.map((command) => command.name)).toEqual(["pstack-mode"]);
  });

  it("keeps the skills rename map working through the plugin config", async () => {
    const { skills } = await boot({ renameSkills: { tdd: "pstack-tdd", teach: "pstack-teach" } });
    const names = skills.map((skill) => skill.name);
    expect(names).toContain("pstack-tdd");
    expect(names).not.toContain("tdd");
  });

  it("registers nothing when both skills and subagents are off", async () => {
    const { ctx, skills, commands } = await boot({ skills: false, subagents: false });
    expect(skills).toEqual([]);
    expect(toolNames(ctx)).toEqual([]);
    // 命令是常驻段的会话开关，和技能/子代理各自独立，关掉那两个不该把它一起关掉。
    expect(commands.map((command) => command.name)).toEqual(["pstack-mode"]);
  });

  it("drops both tools when the plugin fiber is disposed (HMR safety)", async () => {
    const { ctx } = await boot();
    expect(toolNames(ctx)).toContain("pstack_agent");
    const fiber = [...ctx.registry.values()].flatMap((runtime) => [...runtime.fibers]).find((f) => f.name === "void-pstack");
    expect(fiber).toBeDefined();
    await fiber!.dispose();
    expect(toolNames(ctx)).toEqual([]);
  });

  it("installs the standing section on every new agent when potetoMode is always", async () => {
    const { ctx } = await boot({ potetoMode: "always" });
    const sections: PstackPromptSection[] = [];
    ctx.emit("agent/created", {
      agent: {
        id: "session-1",
        ctx: {
          systemPrompt: {
            section(input: PstackPromptSection) {
              sections.push(input);
              return () => undefined;
            },
          },
        },
      },
    });
    expect(sections.map((section) => section.name)).toEqual(["pstack:poteto-mode"]);
    expect(sections[0]?.text).toContain("poteto-mode");
  });

  it("stays quiet about new agents when potetoMode is off", async () => {
    const { ctx } = await boot({ potetoMode: "off" });
    const sections: PstackPromptSection[] = [];
    ctx.emit("agent/created", {
      agent: { id: "session-1", ctx: { systemPrompt: { section: (input: PstackPromptSection) => (sections.push(input), () => undefined) } } },
    });
    expect(sections).toEqual([]);
  });
});
