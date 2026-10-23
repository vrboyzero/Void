/**
 * poteto-mode 常驻段。
 *
 * **它对应 pstack 的 Custom Mode**（Cursor 里 `/poteto-mode` 按 Option/Alt+Enter 常驻）。pstack 的
 * 做法是每轮把整份 `SKILL.md`（20 KB）放进上下文；这里改成**一段压缩过的常驻约束 + 一张路由表**，
 * 完整 playbook 仍按需用 `skill` 工具加载。原因是成本：常驻段每轮都要付 token，而 20 KB 里
 * 真正「每轮都生效」的只有回复规则、注释规则、自主度和 non-negotiables 的一部分。
 *
 * **为什么段文本放文件而不是写在 TS 里**：它是内容，不是逻辑。改文案不该触发一次构建语义的变化，
 * 也便于和 vendored 技能一起被 review。文件随包发布（`files` 里的 `prompts/`）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 包内 `prompts/` 的绝对路径；解析方式与 `skill-loader.ts` 同源（编译到 `lib/` 后 `../prompts/`）。 */
export const PSTACK_PROMPTS_DIR = fileURLToPath(new URL("../prompts/", import.meta.url));

/** 常驻段正文的文件名。 */
export const POTETO_MODE_STANDING_FILE = "poteto-mode-standing.md";

/** 常驻段的段名。固定字符串，避免和宿主或其它插件的段名相撞。 */
export const POTETO_MODE_SECTION_NAME = "pstack:poteto-mode";

/**
 * 段的排序位置。
 *
 * 取值参照 void-soul 的实测口径：宿主人设段是 `deployment:persona-prefix`(0)，角色层是 1 到 3，
 * 计划策略是 500。常驻工作风格属于「人设之后、任务策略之前」，所以取 10——比角色层晚，比任何
 * 任务级策略早。
 */
export const POTETO_MODE_SECTION_ORDER = 10;

/** 宿主 `ctx.systemPrompt.section()` 的入参。 */
export interface PstackPromptSection {
  readonly name: string
  readonly order: number
  readonly text: string
}

/** 只列本模块要用到的 Agent 表面。 */
export interface PstackPromptAgent {
  readonly id: string
  readonly ctx: { systemPrompt: { section(input: PstackPromptSection): () => void } }
}

/** 只列本模块要监听的两个事件。 */
export interface PstackAgentEvents {
  on(name: "agent/created", listener: (payload: { agent: PstackPromptAgent }) => void): () => void
  on(name: "agent/disposed", listener: (payload: { agent: PstackPromptAgent }) => void): () => void
}

/** 插件日志面；用结构类型，测试里给一个收集器即可。 */
export interface PstackLogger {
  info(message: string): void
  warn(message: string): void
}

/** 常驻段的文本。读不到就抛——包是坏的，没有「静默不装」的合理语义。 */
export function loadPotetoModeStandingText(directory: string = PSTACK_PROMPTS_DIR): string {
  const file = join(directory, POTETO_MODE_STANDING_FILE);
  const text = readFileSync(file, "utf8").trim();
  if (text.length === 0) throw new Error(`pstack: 常驻段文本是空的: ${file}`);
  return text;
}

/** 段控制器：负责按 Agent 装/摘，以及给 `/pstack-mode` 命令用的开关。 */
export interface PotetoModeSections {
  /** 给这个 Agent 装段；已经装过就什么都不做（幂等，`always` 模式与命令可能同时触发）。 */
  enable(agent: PstackPromptAgent): void
  /** 摘掉这个 Agent 的段；没装过就返回 false。 */
  disable(agentId: string): boolean
  /** 这个 Agent 现在有没有常驻段。 */
  has(agentId: string): boolean
}

/**
 * 建常驻段控制器。
 *
 * `always` 为真时订阅 `agent/created`，给每个新建 Agent 装段。这个事件是 **`@mode serial`**：
 * 宿主 `createAgent()` 的 JSDoc 写明它会「awaits serial `agent/created` listeners before releasing
 * queued work」，所以同步监听器里的段**保证**在第一次提示词装配之前装好——这一点与 void-soul 笔记里
 * 「宿主不等 `agent/created`」的说法相反（那份笔记针对的是它自己的异步读盘路径；本模块不需要
 * 装配瀑布上的补段逻辑）。
 *
 * **监听器绝不能抛**：同一个 JSDoc 说 serial 监听器失败会让**创建 Agent 直接 reject**。为一段
 * 可选的风格说明把会话创建搞失败不成比例，所以 `section()` 的异常在这里被接住并记日志。
 */
export function createPotetoModeSections(input: {
  events: PstackAgentEvents
  text: string
  logger: PstackLogger
  always: boolean
}): PotetoModeSections {
  const installed = new Map<string, () => void>();

  const enable = (agent: PstackPromptAgent): void => {
    if (installed.has(agent.id)) return;
    try {
      const dispose = agent.ctx.systemPrompt.section({
        name: POTETO_MODE_SECTION_NAME,
        order: POTETO_MODE_SECTION_ORDER,
        text: input.text,
      });
      installed.set(agent.id, dispose);
    } catch (error) {
      input.logger.warn(`pstack: 会话 ${agent.id} 装常驻段失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const disable = (agentId: string): boolean => {
    const dispose = installed.get(agentId);
    if (dispose === undefined) return false;
    installed.delete(agentId);
    dispose();
    return true;
  };

  input.events.on("agent/disposed", ({ agent }) => {
    installed.delete(agent.id);
  });

  if (input.always) {
    input.events.on("agent/created", ({ agent }) => {
      enable(agent);
    });
    input.logger.info("pstack: poteto-mode 常驻段已开启（每个新会话自动装载）");
  }

  return { enable, disable, has: (agentId) => installed.has(agentId) };
}
