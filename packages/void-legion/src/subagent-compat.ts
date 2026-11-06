/**
 * 子代理 API 兼容层：宿主 0.2.0 及以前 vs 0.2.1+（0.2.2 同形）。
 *
 * 0.2.1 把 `ctx.subagents.start(name, request)` 换成了
 * `ctx.subagents.startActivation({ provider, label, request, signal, delivery })`：
 * - 返回对象由 `{ id, result, dispose }` 变成 `{ childId, result, dispose }`；
 * - `request.persona` / `request.toolFilter` 被删除，逐子代理身份/工具面改为先做
 *   Agent Preset，再用 `agentPreset` 指定；
 * - `SubagentCapabilities` 改成 agentOptions / agentPreset / outputSchema / depthLimit。
 *
 * 本包 peerDependencies 仍覆盖 `>=0.1.0-rc.6 <0.3.0-0`，所以这里**运行期探测**宿主能力，
 * 不直接 import 新版类型（仓库 node_modules 里仍是 0.1.0-rc.6 的类型）。新 API 的入参与
 * 返回在这里用结构类型声明，只声明本包真正会读写的字段。
 *
 * ## persona 的降级路径（0.2.1+）
 *
 * 0.2.1 起没有逐子代理 persona 字段：要换身份只能走 `agentPreset`，而 preset 会覆盖子代理
 * 的 deployment persona 段（宿主身份底线）。军团每个 lane 的身份来自灵魂档案的
 * `personaFor()` 文本、不是 preset id，所以这里把身份说明**并入提示词**
 * （与同仓 pstack 的取舍一致，见 packages/pstack/src/subagents.ts 文件头）：子代理照样
 * 先读到自己的身份，而不是把它静默丢掉。旧宿主仍然走 request.persona。
 *
 * @module @void/void-legion/subagent-compat
 */

import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { SubagentResult } from "@deepseek-ai/dsh-subagent";

/** 派活侧的错误：能力不匹配、模型路由写法不对、宿主 API 缺失。 */
export class SubagentDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubagentDispatchError";
  }
}

/** 逐任务模型路由：新旧宿主都读 `AgentOptions` 的前两个字段。 */
export interface SubagentModelOptions {
  readonly provider?: string;
  readonly model?: string;
}

/** 一次派活需要的输入。 */
export interface StartSubagentOptions {
  /** provider 名；默认由调用方给 `spawn`。 */
  readonly provider: string;
  /** 子代理显示标签（新 API 必填，旧 API 里的 label）。 */
  readonly label: string;
  /** 发起派活的 Agent。 */
  readonly parent: Agent;
  /** 子代理第一轮的提示词。 */
  readonly prompt: ContentBlock[];
  /** 逐任务取消信号。 */
  readonly signal: AbortSignal;
  /** 模型路由；需要宿主 provider 支持 agentOptions。 */
  readonly agentOptions?: SubagentModelOptions;
  /** 旧宿主传给 request.persona；新宿主由调用方先并入 prompt。 */
  readonly persona?: string;
  /** 新宿主上换子代理组合 preset 的入口。 */
  readonly agentPreset?: string;
  /** 独立检出的绝对路径（B6）；宿主用它当子代理的 cwd。 */
  readonly cwd?: string;
}

/** 新旧 API 的统一运行句柄。 */
export interface StartedSubagent {
  /** 子会话 id；旧 API 的 `run.id`，新 API 的 `activation.childId`。 */
  readonly id: string;
  /** 子代理终态；不会因模型/传输失败而 reject（用 stopReason 表达）。 */
  readonly result: Promise<SubagentResult>;
  /** 停止并释放这次激活；必须 finally 调用。 */
  dispose(): Promise<void>;
}

// ── 旧 API（0.2.0 及以前）───────────────────────────────────────────────

interface LegacyRun {
  readonly id: string;
  readonly result: Promise<SubagentResult>;
  dispose(): Promise<void>;
}

interface LegacyStartRequest {
  readonly parent: Agent;
  readonly label: string;
  readonly prompt: ContentBlock[];
  readonly signal: AbortSignal;
  readonly agentOptions?: SubagentModelOptions;
  readonly persona?: string;
  readonly cwd?: string;
}

interface LegacySubagentRuntime {
  start(name: string, request: LegacyStartRequest): Promise<LegacyRun>;
}

// ── 新 API（0.2.1+）─────────────────────────────────────────────────────

/** `startActivation` 的 request 里本模块会写的字段。 */
export interface ActivationStartRequest {
  readonly parent: Agent;
  readonly prompt: ContentBlock[];
  readonly agentOptions?: SubagentModelOptions;
  readonly agentPreset?: string;
  readonly cwd?: string;
}

/** `startActivation` 的入参。 */
export interface ActivationSpec {
  readonly provider: string;
  readonly label: string;
  readonly request: ActivationStartRequest;
  readonly signal: AbortSignal;
  /** `parent` 会再给父会话投一条结算消息；`caller` 只把结果交回调用方。 */
  readonly delivery: "parent" | "caller";
}

/** `startActivation` 的返回。 */
export interface ActivationHandle {
  readonly childId: string;
  readonly result: Promise<SubagentResult>;
  dispose(): Promise<void>;
}

interface ActivationSubagentRuntime {
  startActivation(spec: ActivationSpec): Promise<ActivationHandle>;
}

/** `ctx.subagents` 在本模块用到的窄面（新旧能力的并集）。 */
export type SubagentRuntime = LegacySubagentRuntime & Partial<ActivationSubagentRuntime>;

/**
 * 宿主是否提供 0.2.1+ 的 `startActivation`。
 *
 * 先探测再调用：版本不匹配时不能等到子代理跑到一半才炸成
 * `start is not a function`（真机派活撞过，错误离原因很远）。
 */
export function usesActivationApi(runtime: unknown): runtime is ActivationSubagentRuntime {
  return (
    typeof runtime === "object" &&
    runtime !== null &&
    typeof (runtime as { startActivation?: unknown }).startActivation === "function"
  );
}

/** 把 persona 文本并入提示词：0.2.1+ 没有逐子代理 persona 字段时的降级路径。 */
export function withPersonaInstructions(prompt: ContentBlock[], persona: string): ContentBlock[] {
  const text = persona.trim();
  if (text.length === 0) return prompt;
  const identity: ContentBlock = { type: "text", text: `你的身份设定（必须遵守）：\n${text}` };
  return [...prompt, identity];
}

/**
 * 统一派活入口：新宿主走 `startActivation`，旧宿主回退 `start`。
 *
 * @returns 统一句柄：`{ id, result, dispose }`。
 * @throws SubagentDispatchError 宿主两个 API 都没有时。
 */
export async function startSubagent(runtime: SubagentRuntime, options: StartSubagentOptions): Promise<StartedSubagent> {
  const { provider, label, parent, prompt, signal, agentOptions, persona, agentPreset, cwd } = options;
  if (usesActivationApi(runtime)) {
    const activation = await runtime.startActivation({
      provider,
      label,
      request: {
        parent,
        prompt,
        ...(agentOptions === undefined ? {} : { agentOptions }),
        ...(agentPreset === undefined ? {} : { agentPreset }),
        ...(cwd === undefined ? {} : { cwd }),
      },
      signal,
      // 军团自己消费并记录每个 lane 的终态（run 记录 + 通知源），
      // 再给父会话投一份结算消息只会让同一件事出现两遍。
      delivery: "caller",
    });
    return {
      id: String(activation.childId),
      result: activation.result,
      dispose: () => activation.dispose(),
    };
  }

  if (typeof (runtime as Partial<LegacySubagentRuntime>).start !== "function") {
    throw new SubagentDispatchError(
      "派活缺少子代理 API：宿主既没有 startActivation（0.2.1+）也没有 start（0.2.0 及以前）",
    );
  }
  const run = await (runtime as LegacySubagentRuntime).start(provider, {
    parent,
    label,
    prompt,
    signal,
    ...(agentOptions === undefined ? {} : { agentOptions }),
    ...(persona === undefined ? {} : { persona }),
    ...(cwd === undefined ? {} : { cwd }),
  });
  return { id: String(run.id), result: run.result, dispose: () => run.dispose() };
}
