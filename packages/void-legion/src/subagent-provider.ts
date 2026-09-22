import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { SubagentProvider, SubagentResult } from "@deepseek-ai/dsh-subagent";
import { ScheduleCancelledError, type ScheduleWorker, type TaskRunContext } from "./scheduler.js";
import type { DelegationTeamMember } from "./team.js";

/**
 * P5 的真实派活侧：把调度器的一个任务交给 dsh 的真实子代理。
 *
 * 这一层只干四件事，每件都对应文档里一条不让步的要求：
 * 1. **逐 lane 的说明书**——不再给所有人发同一段 `task`（§15.2 派活纪律）。每个
 *    lane 拿到的是自己的 `scopeSummary`、自己的上游产出、自己的工作区归属。
 * 2. **逐任务模型路由**——`modelRef` 走 `agentOptions` 落到子代理上（§15.3）。
 * 3. **能力预检**——provider 声明不支持的能力，**在派出去之前就拒绝**，不静默降级
 *    （dsh 服务自己也会校验，但那时错误已经发生在半路）。
 * 4. **取消真的传到子代理**——调度器的逐任务 signal 直接交给 `start`，并且
 *    abort 后的失败按「已取消」上报，不记成任务自己的错（§15.2）。
 */

/** 派活侧的错误：能力不匹配、模型路由写法不对。 */
export class SubagentDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubagentDispatchError";
  }
}

/**
 * 取子代理 seam：**必须用 `ctx.get("subagents")`，不能写 `ctx.subagents`**。
 *
 * 属性访问要过 cordis 的 inject 检查，插件没声明 `subagents` 就抛
 * `cannot get property "subagents" without inject`——2026-09-23 真机派活就是这样整队瞬崩的
 * （三条 lane 落在同一毫秒、全部 failed，一个子代理都没起）。军团插件也不该因为宿主没装
 * subagent 包就整个装不上：这里取不到时给一句人话。
 */
function subagentHost(ctx: Context): Context["subagents"] {
  const host = ctx.get("subagents") as Context["subagents"] | undefined;
  if (host === undefined) {
    throw new SubagentDispatchError("派活缺少子代理 seam：宿主没有装 subagents（@deepseek-ai/dsh-subagent）");
  }
  return host;
}

/** 一个 lane 的完整说明书素材（prompt 构造的唯一入口）。 */
export interface LaneBrief {
  laneId: string;
  teamId: string;
  /** 团队总目标：lane 必须知道自己在为谁干活。 */
  goal: string;
  /** 这个 lane 自己的活；空则退回身份标签。 */
  brief: string;
  member: DelegationTeamMember;
  /** 只有本 lane `dependsOn` 的上游产出，不是全队产出。 */
  upstream: Record<string, unknown>;
  modelRef?: string | undefined;
  workspace: string;
  writes: boolean;
}

/** 把调度器的任务上下文翻译成说明书素材。 */
export function laneBriefFromContext(context: TaskRunContext): LaneBrief {
  const member = context.member;
  const own = member.scopeSummary ?? member.identityLabel ?? context.laneId;
  return {
    laneId: context.laneId,
    teamId: context.teamId,
    goal: context.task,
    brief: own,
    member,
    upstream: context.upstream,
    modelRef: context.modelRef,
    workspace: context.workspace,
    writes: context.writesWorkspace,
  };
}

/**
 * 逐 lane 渲染说明书。
 *
 * 三条纪律：**只给自己的活**（不给别人的 brief）、**只给自己的上游产出**、
 * **如实说明是否要改文件**（写任务和只读任务的验收标准不一样）。
 */
export function renderLanePrompt(brief: LaneBrief): ContentBlock[] {
  const lines = [
    `你是军团 lane "${brief.laneId}" 的执行体，队伍是 "${brief.teamId}"。`,
    `身份：${brief.member.identityLabel ?? brief.member.agentId ?? "未命名"}。`,
    `团队总目标：${brief.goal.trim() || "（未写明）"}`,
    `你这一次的活：${brief.brief}`,
  ];
  if (brief.member.role !== undefined) lines.push(`队伍模式：${brief.member.role}。`);
  if (brief.writes) {
    lines.push(
      `工作区：${brief.workspace}（本次要改文件；同一工作区的写任务由宿主串行派发，不会有人和你同时写）。`,
    );
  } else {
    lines.push(`工作区：${brief.workspace}（本次只读，不要改文件）。`);
  }
  if (brief.modelRef !== undefined) lines.push(`模型路由：${brief.modelRef}。`);

  const upstreamIds = Object.keys(brief.upstream);
  if (upstreamIds.length > 0) {
    lines.push("", "上游产出（只有你依赖的那些）：");
    for (const laneId of upstreamIds) {
      lines.push(`- ${laneId}：${renderUpstream(brief.upstream[laneId])}`);
    }
  } else if (brief.member.dependsOn !== undefined && brief.member.dependsOn.length > 0) {
    lines.push("", "上游产出：还没拿到（宿主没有传进来，不要凭空假设）。");
  }

  lines.push("", "做完后如实汇报：做了什么、结果在哪、有没有没做完的部分。");
  return [{ type: "text", text: lines.join("\n") }];
}

function renderUpstream(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return "[上游产出无法序列化]";
  }
}

/** 解析后的模型路由。 */
export interface ParsedModelRef {
  /** 路由里显式写了的 provider；没写就交给 provider 自己的默认路由。 */
  provider?: string;
  model: string;
}

/**
 * 解析 `modelRef`：`model` 或 `provider/model`。
 *
 * 写错就报错，**不猜**——猜错的代价是「以为用了便宜模型，实际用了贵的」。
 */
export function parseModelRef(modelRef: string, source = "模型路由"): ParsedModelRef {
  const text = modelRef.trim();
  if (text.length === 0) throw new SubagentDispatchError(`${source}不能是空字符串`);
  const parts = text.split("/");
  if (parts.length === 1) {
    const model = parts[0] ?? "";
    if (model.length === 0) throw new SubagentDispatchError(`${source}写法不对: ${modelRef}`);
    return { model };
  }
  if (parts.length !== 2) {
    throw new SubagentDispatchError(`${source}写法不对: ${modelRef}（应为 model 或 provider/model）`);
  }
  const provider = parts[0] ?? "";
  const model = parts[1] ?? "";
  if (provider.length === 0 || model.length === 0) {
    throw new SubagentDispatchError(`${source}写法不对: ${modelRef}（应为 model 或 provider/model）`);
  }
  return { provider, model };
}

/** 一次派活对 provider 的能力要求。 */
export interface DispatchRequirements {
  modelRef?: string | undefined;
  /** 需要结构化产出（`SubagentResult.structured`）。 */
  structured?: boolean | undefined;
  /** 需要逐子代理身份注入。 */
  persona?: string | undefined;
}

/**
 * 派出去之前的能力预检。
 *
 * 宁可在这里失败，也不要在子代理跑到一半才发现模型路由没生效。
 *
 * 模型路由那一档**只在 provider 显式声明 `agentOptions: false` 时才拒**：目标契约
 * （alpha.2）用这个 flag 声明支持，而本机 rc.6 的 `SubagentCapabilities` 根本没有
 * 这个字段（`SubagentStartRequest.agentOptions` 却存在且被 spawn provider 真正读取，
 * 见其 `index.js` 的 `request.agentOptions?.provider ?? parent.options.provider`）。
 * 字段缺失＝没声明不支持，不能当成不支持。
 */
export function assertProviderSupports(provider: SubagentProvider, requirements: DispatchRequirements): void {
  const capabilities = provider.capabilities;
  const supportsAgentOptions = (capabilities as { agentOptions?: boolean }).agentOptions !== false;
  if (requirements.modelRef !== undefined && !supportsAgentOptions) {
    throw new SubagentDispatchError(
      `子代理 provider "${provider.name}" 不支持逐任务模型路由，拒绝按 ${requirements.modelRef} 派活（不会退回默认模型）`,
    );
  }
  if (requirements.structured === true && !capabilities.outputSchema) {
    throw new SubagentDispatchError(`子代理 provider "${provider.name}" 不支持结构化产出，拒绝派活`);
  }
  if (requirements.persona !== undefined && !capabilities.persona) {
    throw new SubagentDispatchError(`子代理 provider "${provider.name}" 不支持逐子代理身份注入，拒绝派活`);
  }
}

/**
 * 并发上限的三方取小：本次运行上限、全服务闸门容量、provider 容量（§15.3）。
 *
 * dsh 的 provider 接口没有容量字段，所以 provider 容量只能由装配方声明；
 * 没声明就是「不额外收紧」，而不是「猜一个数」。
 */
export function effectiveConcurrency(input: {
  runLimit: number;
  gateCapacity: number;
  providerCapacity?: number | undefined;
}): number {
  const values = [input.runLimit, input.gateCapacity];
  if (input.providerCapacity !== undefined) values.push(input.providerCapacity);
  return Math.max(1, Math.min(...values));
}

export interface ScheduledWorkerOptions {
  /** provider 名；默认 `spawn`。 */
  provider?: string;
  /** provider 容量；缺省不额外收紧。 */
  providerCapacity?: number;
  /** 逐子代理身份注入（P6 接 SOUL/FACET 修订时填）。 */
  persona?: (context: TaskRunContext) => string | undefined;
  /** 说明书构造器；缺省 `renderLanePrompt(laneBriefFromContext(context))`。 */
  buildPrompt?: (context: TaskRunContext) => ContentBlock[];
  /** 记录本次派活的 provider 名与路由（用于运行记录的诚实交代）。 */
  onDispatch?: (info: { laneId: string; provider: string; modelRef?: string }) => void;
}

/**
 * 调度器的真实 worker 工厂。
 *
 * 与 `createSubagentWorker` 的区别：这个接的是调度器的逐任务上下文（带逐任务
 * signal、工作区归属、模型路由），并且**只有它**会把取消如实上报成取消。
 */
export function createScheduledWorker(
  ctx: Context,
  parent: Agent,
  options: ScheduledWorkerOptions = {},
): ScheduleWorker {
  const providerName = options.provider ?? "spawn";
  return async (context: TaskRunContext): Promise<unknown> => {
    const brief = laneBriefFromContext(context);
    const subagents = subagentHost(ctx);
    const provider = subagents.getProvider(providerName);
    if (provider === undefined) {
      throw new SubagentDispatchError(`没有这个子代理 provider: ${providerName}`);
    }
    assertProviderSupports(provider, { modelRef: brief.modelRef, persona: options.persona?.(context) });

    const agentOptions = brief.modelRef === undefined ? undefined : parseModelRef(brief.modelRef);
    const persona = options.persona?.(context);
    options.onDispatch?.({
      laneId: brief.laneId,
      provider: providerName,
      ...(brief.modelRef === undefined ? {} : { modelRef: brief.modelRef }),
    });

    const buildPrompt = options.buildPrompt ?? ((item: TaskRunContext) => renderLanePrompt(laneBriefFromContext(item)));
    const run = await subagents.start(providerName, {
      parent,
      label: brief.member.identityLabel ?? brief.laneId,
      prompt: buildPrompt(context),
      signal: context.signal,
      ...(agentOptions === undefined ? {} : { agentOptions }),
      ...(persona === undefined ? {} : { persona }),
    });
    // 子会话 id 由调度器转交宿主（逐任务的 `reportChildSession`），
    // 不在 worker 构造时固定——同一个 worker 会被不同 run 复用。
    context.reportChildSession?.(String(run.id));
    try {
      const result: SubagentResult = await run.result;
      if (result.stopReason !== "completed") {
        if (context.signal.aborted) {
          throw new ScheduleCancelledError(`lane "${brief.laneId}" 已取消（子代理停在 "${result.stopReason}"）`);
        }
        throw new SubagentDispatchError(`lane "${brief.laneId}" 的子代理没有跑完: "${result.stopReason}"`);
      }
      return {
        laneId: brief.laneId,
        stopReason: result.stopReason,
        output: result.output,
        ...(result.structured === undefined ? {} : { structured: result.structured }),
        ...(brief.modelRef === undefined ? {} : { modelRef: brief.modelRef }),
        provider: providerName,
      };
    } finally {
      // 无论成功、失败还是取消，子代理都必须释放（§15.2 finally 释放）。
      await run.dispose();
    }
  };
}
