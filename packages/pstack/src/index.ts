/**
 * `@void/pstack` 的插件入口。
 *
 * 把 cursor 官方插件 pstack（MIT，v0.15.27）的四类内容搬进 DSH：
 *
 * 1. **55 个技能**（含 23 个 playbook、24 条原则、bugbot triage 参考）以运行期技能注册，
 *    在 `/` 菜单里按原名出现。
 * 2. **一份 pstack 在 DSH 上的适配层**，作为模型可调用的 `pstack-dsh-harness` 技能。
 * 3. **poteto-mode 常驻段**（对应 Cursor 的 Custom Mode），默认关，配置或 `/pstack-mode` 打开。
 * 4. **两个子代理工具** `pstack_agent` 与 `pstack_comment_sicko`，对应 `poteto-agent` 与
 *    `comment-sicko`。
 *
 * 四类都可以用配置单独关掉——装上之后不想看到 `/` 菜单多 55 个条目，就把 `skills` 关掉。
 *
 * **本包不搬的东西**：`automations/benny/`（依赖 Cursor Automations，本机不可能运行）、
 * `watch-pr` / `orch` 两个 CLI（bun + `gh` 的移植是独立的一坨，见 README 的 TODO），
 * 以及 `assets/logo.png`、`docs/guide/` 教程（对运行时无贡献）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { resolvePstackConfig, type PstackConfig } from "./config.js";
import { contributeSkills, type PstackSkillRegistry } from "./skills-contribute.js";
import {
  PSTACK_PROMPTS_DIR,
  createPotetoModeSections,
  loadPotetoModeStandingText,
  type PstackLogger,
} from "./prompt.js";
import { registerModeCommand, type PstackCommandRuntime } from "./mode-command.js";
import { registerPstackSubagentTools, isCompatibleSubagentRuntime, type PstackSubagentRuntime } from "./subagents.js";
import { PSTACK_SKILLS_DIR } from "./skill-loader.js";

export const name = "void-pstack";

/** 注册工具要 `tools`；其它服务（skills / commands / subagents）按可选服务处理，缺了会明确报出来。 */
export const inject = ["tools"];

export type { PstackConfig } from "./config.js";

/** 本插件注册的那个「适配层」技能名。 */
export const HARNESS_SKILL_NAME = "pstack-dsh-harness";

/** 把 DSH 适配层注册成一个模型可调用的技能：pstack 原文提到的 Cursor 工具名全靠它翻译。 */
function contributeHarnessSkill(registry: PstackSkillRegistry, promptsDir: string): string {
  const path = join(promptsDir, "dsh-harness.md");
  const content = readFileSync(path, "utf8").trim();
  if (content.length === 0) throw new Error(`pstack: 适配层文档是空的: ${path}`);
  registry.register({
    name: HARNESS_SKILL_NAME,
    description:
      "把 pstack 原文里的 Cursor 工具名与仅 Cursor 才有的能力映射到 DeepSeek Harness。当某个 pstack 技能提到 Task、AskQuestion、subagent_type、control-ui、control-cli、/deslop、Bugbot 或 Cursor cloud agents，或要写「跳过某步」的说明行之前，加载它。Map pstack's Cursor tool names and Cursor-only capabilities onto DeepSeek Harness. Load it when a pstack skill mentions Task, AskQuestion, subagent_type, control-ui, control-cli, /deslop, Bugbot, or Cursor cloud agents, or before writing a skipped-step line.",
    content,
    path,
    invocation: { modelInvocable: true, userInvocable: true },
    source: "runtime",
  });
  return path;
}

/**
 * 插件装配。
 *
 * **为什么要用 `ctx.inject()` 而不是 `ctx.get()` 取服务**：`ctx.get()` 是**严格查一次**，服务还没
 * 起来就返回 `undefined`。2026-10-12 真机踩到的就是这个——本插件在 `apply` 那一刻能拿到 `skills`
 * （它起得早），但拿不到 `subagents`（它起得晚），于是两个子代理工具一声不响地没注册，而插件
 * fiber 照样 ACTIVE、技能照样在册。`ctx.inject(names, cb)` 的做法是「等这个服务出现再跑这一段」，
 * 把时序列进 cordis 的依赖图，而不是靠加载顺序碰运气。
 *
 * 技能与命令也走同一条路：它们现在碰巧起得早，但那是当前的组合顺序，不是契约。
 */
export function apply(ctx: Context, config: PstackConfig = {}): void {
  const log = ctx.logger("void-pstack");
  const logger: PstackLogger = {
    info: (message) => log.info(message),
    warn: (message) => log.warn(message),
  };
  const resolved = resolvePstackConfig(config);

  if (resolved.skills) {
    ctx.inject(["skills"], (skillsCtx) => {
      const skills = skillsCtx.get("skills") as PstackSkillRegistry | undefined;
      // inject 已经等到服务出现；这里拿到 undefined 说明注册表本身没有 register（版本不对）。
      if (skills === undefined || typeof skills.register !== "function") {
        logger.warn("技能注册表没有 register 方法（宿主版本不匹配？），55 个技能一个都没注册。");
        return;
      }
      const contributed = contributeSkills(skills, resolved);
      logger.info(
        `技能已注册 ${contributed.registered.length} 个（改名 ${contributed.renamed.length}，跳过 ${contributed.skipped.length}）。`,
      );
      if (contributed.renamed.length > 0) {
        const pairs = contributed.renamed.map(([from, to]) => `${from}→${to}`).join("、");
        logger.info(`改名：${pairs}`);
      }
      if (contributed.skipped.length > 0) {
        logger.info(`跳过：${contributed.skipped.join("、")}`);
      }
      contributeHarnessSkill(skills, PSTACK_PROMPTS_DIR);
    });
  } else {
    logger.info("技能注册已关闭（skills: false）。");
  }

  const sections = createPotetoModeSections({
    // `agent/created` / `agent/disposed` 由宿主侧声明；这里按结构取用，见 prompt.ts 的类型说明。
    events: ctx as never,
    text: loadPotetoModeStandingText(),
    logger,
    always: resolved.potetoMode === "always",
  });

  ctx.inject(["commands"], (commandsCtx) => {
    const commands = commandsCtx.get("commands") as PstackCommandRuntime | undefined;
    if (commands === undefined || typeof commands.register !== "function") {
      logger.warn("命令注册表没有 register 方法，`/pstack-mode` 没装上。");
      return;
    }
    registerModeCommand({ commands, sections, logger });
  });

  if (resolved.subagents) {
    ctx.inject(["subagents"], (subagentsCtx) => {
      const subagents = subagentsCtx.get("subagents") as PstackSubagentRuntime | undefined;
      // 版本不匹配必须在这里说清楚。宿主 0.2.0→0.2.1 把 `start()` 换成了 `startActivation()`，
      // 少了这道检查，表现是「某次模型调用里蹦出 start is not a function」——离原因很远。
      if (!isCompatibleSubagentRuntime(subagents)) {
        logger.warn(
          "子代理服务没有 startActivation（宿主版本不匹配？0.2.1 之前叫 start），pstack_agent 与 pstack_comment_sicko 没注册。",
        );
        return;
      }
      registerPstackSubagentTools(subagentsCtx, {
        subagents,
        provider: resolved.subagentProvider,
        commentSickoPreset: resolved.commentSickoPreset,
        skillsDir: PSTACK_SKILLS_DIR,
        promptsDir: PSTACK_PROMPTS_DIR,
        logger,
      });
      logger.info(
        resolved.commentSickoPreset === undefined
          ? `子代理工具已注册（提供方 ${resolved.subagentProvider}；comment_sicko 无 preset，只读性只是提示词要求）。`
          : `子代理工具已注册（提供方 ${resolved.subagentProvider}；comment_sicko preset ${resolved.commentSickoPreset}）。`,
      );
    });
  } else {
    logger.info("子代理工具已关闭（subagents: false）。");
  }
}
