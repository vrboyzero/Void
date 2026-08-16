import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { SubagentResult } from "@deepseek-ai/dsh-subagent";
import type { LaneWorker, LaneWorkerInput } from "./service.js";

/**
 * 真实子代理 worker（阶段 3 收尾）：把军团 lane 派活给 dsh 的真实子代理
 * （`ctx.subagents.start`，一次性 one-shot 子代理），替代可注入回调的缺省 no-op。
 *
 * 依赖 dsh 的 subagents seam（`@deepseek-ai/dsh-subagent`）：
 * - `ctx.subagents.start(name, request)` 建立一次性子代理，`name` 是 provider 名
 *   （默认 `spawn`，与 dsh 的 `subagent-spawn-in-process` 对齐）；
 * - `request.parent` 必须是发起派活的 Agent（在 launch_legion 工具里来自 `exec.agent`）；
 * - `SubagentRun.result` 解析子代理终态（`stopReason !== 'completed'` 即失败），
 *   `dispose` 必须 finally 调用以释放子代理。
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
    const run = await ctx.subagents.start(provider, {
      parent,
      label: input.member.identityLabel ?? input.laneId,
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
