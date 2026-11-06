import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { SubagentResult } from "@deepseek-ai/dsh-subagent";
import { SubagentDispatchError, startSubagent, type SubagentRuntime } from "./subagent-compat.js";
import type { LaneWorker, LaneWorkerInput } from "./service.js";

/**
 * 真实子代理 worker（阶段 3 收尾）：把军团 lane 派活给 dsh 的真实子代理
 * （一次性 one-shot 子代理），替代可注入回调的缺省 no-op。
 *
 * 依赖 dsh 的 subagents seam（`@deepseek-ai/dsh-subagent`）：
 * - 0.2.1+：`ctx.subagents.startActivation({provider,label,request,signal,delivery})`
 *   返回 `SubagentActivation`（`childId` / `result` / `dispose`）；
 * - 0.2.0 及以前：`ctx.subagents.start(name, request)` 返回 `SubagentRun`（`id` / `result` / `dispose`）。
 * 版本差异与 dispatch 的收口在 `subagent-compat.ts`；本文件只消费统一句柄。
 * - `request.parent` 必须是发起派活的 Agent（在 launch_legion 工具里来自 `exec.agent`）；
 * - `SubagentResult` 的 `stopReason !== 'completed'` 即失败，`dispose` 必须 finally 调用。
 */
export interface SubagentWorkerOptions {
  /** 目标 provider 名；默认 `spawn`。 */
  provider?: string;
  /** 取消信号，贯穿 start 与 run 生命周期；缺省为永不取消。 */
  signal?: AbortSignal;
  /** 每个 lane 的 prompt 构造器；缺省按 lane 角色 + 任务 + 上游输出拼文本。 */
  buildPrompt?: (input: LaneWorkerInput) => ContentBlock[];
}

/** 把每个 lane 派活给 dsh 真实子代理的 worker 工厂。 */
export function createSubagentWorker(
  ctx: Context,
  parent: Agent,
  options: SubagentWorkerOptions = {},
): LaneWorker {
  const provider = options.provider ?? "spawn";
  const signal = options.signal ?? new AbortController().signal;
  const buildPrompt = options.buildPrompt ?? defaultBuildPrompt;
  return async (input: LaneWorkerInput): Promise<unknown> => {
    // 用 `ctx.get` 而不是 `ctx.subagents`：属性访问要过 cordis 的 inject 检查，没声明就抛
    // `cannot get property "subagents" without inject`（真机派活撞过，见 subagent-provider.ts）。
    const subagents = ctx.get("subagents") as Context["subagents"] | undefined;
    if (subagents === undefined) {
      throw new SubagentDispatchError("派活缺少子代理 seam：宿主没有装 subagents（@deepseek-ai/dsh-subagent）");
    }
    const run = await startSubagent(subagents as unknown as SubagentRuntime, {
      provider,
      label: input.member.identityLabel ?? input.laneId,
      parent,
      prompt: buildPrompt(input),
      signal,
    });
    try {
      const result: SubagentResult = await run.result;
      if (result.stopReason !== "completed") {
        throw new Error(`lane "${input.laneId}" subagent ended with "${result.stopReason}"`);
      }
      return {
        laneId: input.laneId,
        stopReason: result.stopReason,
        output: result.output,
        ...(result.structured === undefined ? {} : { structured: result.structured }),
      };
    } finally {
      await run.dispose();
    }
  };
}

function defaultBuildPrompt(input: LaneWorkerInput): ContentBlock[] {
  const lines = [
    `你是军团 lane "${input.laneId}" 的执行体。`,
    `团队模式：${input.member.role ?? "default"}。`,
    `任务：${input.task || "（无）"}`,
  ];
  const upstreamKeys = Object.keys(input.upstream);
  if (upstreamKeys.length > 0) {
    lines.push(`上游 lane 输出（供参考）：${JSON.stringify(input.upstream)}`);
  }
  return [{ type: "text", text: lines.join("\n") }];
}
