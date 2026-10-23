/**
 * `/pstack-mode` 用户命令：会话内开关 poteto-mode 常驻段。
 *
 * **为什么需要它**：配置项 `potetoMode: 'always'` 是「全局默认」，但要按会话切换就得改配置文件
 * 再重载，手感很差。pstack 的 Custom Mode 也是会话级的开关（Agent 窗口里每轮都在上下文里，
 * 直到退出该模式），所以这里给一个等价的会话级入口。
 *
 * 命令**不进模型**：宿主把它直接交给注册表里的 handler，只有 handler 想说话时才回一句文本。
 * 这样开一次模式不会消耗一次模型往返。
 */
import type { PstackLogger, PstackPromptAgent, PotetoModeSections } from "./prompt.js";

/** `ctx.commands` 的窄面。 */
export interface PstackCommandRuntime {
  register(definition: {
    readonly name: string
    readonly description: string
    readonly handler: (invocation: { readonly agent: PstackPromptAgent; readonly rawInput: string }) => PstackCommandResult
  }): () => void
}

/** 宿主 `CommandResult` 的两个分支里本模块会用的部分。 */
export type PstackCommandResult =
  | { readonly kind: "success"; readonly text?: string }
  | { readonly kind: "error"; readonly text: string }

/** 命令接受的三个词；其余一律报错，不猜用户想干什么。 */
export type ModeCommandAction = "on" | "off" | "status";

/** 解析 `/pstack-mode` 后面的参数。空参数等于 `status`。 */
export function parseModeCommand(rawInput: string): ModeCommandAction | undefined {
  const token = rawInput.trim().toLowerCase();
  if (token === "") return "status";
  if (token === "on" || token === "enable") return "on";
  if (token === "off" || token === "disable") return "off";
  if (token === "status") return "status";
  return undefined;
}

/** 注册 `/pstack-mode`。命令服务不在时返回 false，由调用方决定怎么报。 */
export function registerModeCommand(input: {
  commands: PstackCommandRuntime
  sections: PotetoModeSections
  logger: PstackLogger
}): boolean {
  input.commands.register({
    name: "pstack-mode",
    description: "Toggle the poteto-mode standing instructions for this session. Args: on, off, status.",
    handler: ({ agent, rawInput }) => {
      const action = parseModeCommand(rawInput);
      if (action === undefined) {
        return { kind: "error", text: "用法：/pstack-mode on|off|status" };
      }
      if (action === "on") {
        input.sections.enable(agent);
        input.logger.info(`pstack: 会话 ${agent.id} 打开 poteto-mode 常驻段`);
        return { kind: "success", text: "poteto-mode 常驻段已打开（本会话每轮生效）。" };
      }
      if (action === "off") {
        const removed = input.sections.disable(agent.id);
        input.logger.info(`pstack: 会话 ${agent.id} 关闭 poteto-mode 常驻段（本来就开着=${removed}）`);
        return { kind: "success", text: removed ? "poteto-mode 常驻段已关闭。" : "本来就没开，无需关闭。" };
      }
      return {
        kind: "success",
        text: input.sections.has(agent.id) ? "poteto-mode 常驻段：开。" : "poteto-mode 常驻段：关。",
      };
    },
  });
  return true;
}
