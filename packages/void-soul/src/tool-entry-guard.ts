/**
 * 把入口策略装到工具注册表上，覆盖模型的**全部**工具入口。
 *
 * 两条通道，优先走 Host 自己的那条：
 *
 * 1. **`tools.guard`（首选）**——`ToolRuntime.guard` 是 Host 提供的正式策略口子：
 *    「在 `tools/pre-execute` 瀑布之后注册一个单调 guard，任何匹配的 guard 都能
 *    返回原因拒绝，而没有任何 guard 能强制放行另一个 guard 拒掉的调用」。它同时
 *    覆盖**注册先后**（不是包 `register`，所以先注册的工具照样受管）和**作用域**
 *    （普通 context 全局生效，`agent.ctx` 上注册的只作用于该 Agent），并且返回
 *    Host 自己的 disposer 交给 `ctx.effect` 管生命周期。
 * 2. **包 `register`（兜底）**——给没有 `guard` 的注册表（测试替身、更早的 Host）
 *    用。工具照常出现在模型面前，但一调用就抛明确原因，既不静默消失（模型会反复
 *    重试一个看不见的工具），也不静默放行。
 *
 * @module @void/void-soul/tool-entry-guard
 */
import { entryDenialReason, EntryPolicyError, type EntryPolicyOptions, type ToolContractLike } from "./entry-policy.js";

/** Host 的 `ToolExecution` 里本模块用得到的部分。不引入 `@deepseek-ai/dsh-tools` 依赖。 */
export interface GuardedToolExecution {
  readonly name?: string | undefined;
  readonly agent?: unknown;
}

/**
 * 工具注册表里被本模块用到的部分。不引入 `@deepseek-ai/dsh-tools` 依赖。
 *
 * `guard` 是首选通道；`register` 只在没有 `guard` 时用。
 */
export interface GuardedToolRegistry {
  register?(tool: unknown): unknown;
  /** `ToolRuntime.guard`：返回 disposer，guard 返回字符串即拒绝该次调用。 */
  guard?(guard: (execution: GuardedToolExecution) => string | undefined): () => void;
}

interface ToolLike {
  name?: string;
  execute?: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}

export type ToolEntryGuardChannel = "guard" | "register";

export interface ToolEntryGuardResult {
  /** 撤销门禁。 */
  restore(): void;
  /** 被拒绝过的工具名（按首次判定顺序），供状态展示与测试断言。 */
  refused(): string[];
  /** 实际走的是哪条通道。 */
  channel(): ToolEntryGuardChannel;
}

function contractOf(tool: ToolLike): ToolContractLike | undefined {
  const contract = tool["contract"];
  if (typeof contract !== "object" || contract === null) return undefined;
  return contract as ToolContractLike;
}

function recorder(refused: string[]) {
  return (name: string): void => {
    if (name.length > 0 && !refused.includes(name)) refused.push(name);
  };
}

/**
 * 包装工具注册表。
 *
 * @param registry 真实的 `ctx.tools`。
 * @param policy 入口策略（隔离能力 + 显式开关 + 逐名放行）。
 * @throws {EntryPolicyError} 注册表两条通道都没有时拒绝安装——装不上就说清楚，
 * 不能让调用方以为门禁生效了。
 */
export function installToolEntryGuard(registry: GuardedToolRegistry, policy: EntryPolicyOptions): ToolEntryGuardResult {
  const refused: string[] = [];
  const record = recorder(refused);

  if (typeof registry.guard === "function") {
    const dispose = registry.guard((execution) => {
      const name = typeof execution.name === "string" ? execution.name : "";
      if (name.length === 0) return undefined;
      const reason = entryDenialReason({ name, policy });
      if (reason !== undefined) record(name);
      return reason;
    });
    return {
      restore() { dispose(); },
      refused() { return [...refused]; },
      channel() { return "guard"; },
    };
  }

  if (typeof registry.register !== "function") {
    throw new EntryPolicyError("工具注册表既没有 guard 也没有 register，入口门禁装不上，已拒绝");
  }

  const original = registry.register;
  registry.register = function guardedRegister(this: unknown, tool: unknown): unknown {
    const candidate = (typeof tool === "object" && tool !== null ? tool : {}) as ToolLike;
    const name = typeof candidate.name === "string" ? candidate.name : "";
    const contract = contractOf(candidate);
    const execute = candidate.execute;
    if (name.length === 0 || typeof execute !== "function") return original.call(this, tool);
    const wrapped: ToolLike = {
      ...candidate,
      execute: async (...args: unknown[]) => {
        const reason = entryDenialReason({ name, ...(contract === undefined ? {} : { contract }), policy });
        if (reason !== undefined) {
          record(name);
          throw new EntryPolicyError(reason);
        }
        return await execute.apply(candidate, args);
      },
    };
    return original.call(this, wrapped);
  };

  return {
    restore() {
      registry.register = original;
    },
    refused() {
      return [...refused];
    },
    channel() {
      return "register";
    },
  };
}
