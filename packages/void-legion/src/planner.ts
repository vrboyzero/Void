/**
 * 任务计划：把「一句话目标」变成一份 Host 能验证的任务图。
 *
 * 两条路都汇到这里（§17.2 P5 验收「手动/自动计划都由 Host 验证」）：
 * - **手动**：队伍配置里已经写好了名单，{@link taskPlanFromRoster} 直接把它读成计划；
 * - **自动**：由模型产出结构化计划，{@link parseTaskPlan} 严格解析后交给
 *   {@link validateTaskPlan} 验证。
 *
 * 自动计划这条路上，模型只是**提议者**。计划里出现的每个 lane、每条依赖、每个
 * 档案、每个阶段号都要在 Host 这里过一遍：依赖指向不存在的 lane 就报错，而不是
 * 当没看见——旧实现「未知依赖被忽略」正是 §19.1 记的高危项。
 *
 * @module @void/void-legion/planner
 */
import { assertLaneId, assertMemberLimit, countTeamMembers } from "./contracts.js";
import { laneOrder, LegionPlanError, validateTeamPlan } from "./plan-validator.js";
import type { DelegationTeamMember, TeamSchedule } from "./team.js";

/** 计划本身不合法（解析不了、字段缺失、依赖对不上）。 */
export class TaskPlanError extends LegionPlanError {
  constructor(message: string) {
    super(message);
    this.name = "TaskPlanError";
  }
}

/** 一个计划任务。字段与 `DelegationTeamMember` 对齐，只是多了人话的 `title`。 */
export interface PlannedTask {
  laneId: string;
  agentId?: string;
  /** 这一步要干什么。必填：没有标题的任务没法验收。 */
  title: string;
  /** 补充说明，可选。 */
  brief?: string;
  dependsOn?: string[];
  stage?: number;
  modelRef?: string;
  workspace?: string;
  writes?: boolean;
}

export interface TaskPlan {
  goal: string;
  tasks: PlannedTask[];
}

function readOptionalStringArray(source: Record<string, unknown>, key: string, where: string): string[] | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new TaskPlanError(`任务计划的 ${where}.${key} 必须是非空字符串数组`);
  }
  return value as string[];
}

function readOptionalString(source: Record<string, unknown>, key: string, where: string): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TaskPlanError(`任务计划的 ${where}.${key} 必须是字符串`);
  return value.length === 0 ? undefined : value;
}

/**
 * 严格解析一份任务计划。
 *
 * 只接受 JSON 对象，字段类型不对就报错——不猜测、不用默认值补齐。放行一份读不懂
 * 的计划，等于让调度器去执行一份没人验证过的任务图。
 */
export function parseTaskPlan(text: string, source = "任务计划"): TaskPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new TaskPlanError(`任务计划不是合法 JSON: ${source}（${error instanceof Error ? error.message : String(error)}）`);
  }
  return parseTaskPlanValue(raw, source);
}

export function parseTaskPlanValue(raw: unknown, source = "任务计划"): TaskPlan {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TaskPlanError(`任务计划必须是对象: ${source}`);
  }
  const value = raw as Record<string, unknown>;
  const goal = value.goal;
  if (typeof goal !== "string" || goal.trim().length === 0) {
    throw new TaskPlanError(`任务计划的 goal 必须是非空字符串: ${source}`);
  }
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
    throw new TaskPlanError(`任务计划没有 tasks，拒绝派活: ${source}`);
  }
  const tasks = value.tasks.map((item, index) => {
    const where = `tasks[${index}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new TaskPlanError(`任务计划的 ${where} 必须是对象`);
    }
    const entry = item as Record<string, unknown>;
    const laneId = entry.laneId;
    if (typeof laneId !== "string") throw new TaskPlanError(`任务计划的 ${where}.laneId 必须是字符串`);
    assertLaneId(laneId);
    const title = entry.title;
    if (typeof title !== "string" || title.trim().length === 0) {
      throw new TaskPlanError(`任务计划的 ${where}.title 必须是非空字符串（没有标题的任务没法验收）`);
    }
    const task: PlannedTask = { laneId, title };
    const agentId = readOptionalString(entry, "agentId", where);
    if (agentId !== undefined) task.agentId = agentId;
    const brief = readOptionalString(entry, "brief", where);
    if (brief !== undefined) task.brief = brief;
    const modelRef = readOptionalString(entry, "modelRef", where);
    if (modelRef !== undefined) task.modelRef = modelRef;
    const workspace = readOptionalString(entry, "workspace", where);
    if (workspace !== undefined) task.workspace = workspace;
    const dependsOn = readOptionalStringArray(entry, "dependsOn", where);
    if (dependsOn !== undefined) task.dependsOn = dependsOn;
    if (entry.stage !== undefined) {
      if (typeof entry.stage !== "number" || !Number.isInteger(entry.stage) || entry.stage < 1) {
        throw new TaskPlanError(`任务计划的 ${where}.stage 必须是从 1 开始的整数`);
      }
      task.stage = entry.stage;
    }
    if (entry.writes !== undefined) {
      if (typeof entry.writes !== "boolean") throw new TaskPlanError(`任务计划的 ${where}.writes 必须是布尔值`);
      task.writes = entry.writes;
    }
    return task;
  });
  return { goal, tasks };
}

/** 手动计划：队伍配置里的名单本来就是计划，读出来即可。 */
export function taskPlanFromRoster(roster: readonly DelegationTeamMember[], goal: string): TaskPlan {
  return {
    goal,
    tasks: roster.map((member) => ({
      laneId: member.laneId,
      title: member.scopeSummary ?? member.identityLabel ?? member.laneId,
      ...(member.agentId === undefined ? {} : { agentId: member.agentId }),
      ...(member.dependsOn === undefined ? {} : { dependsOn: [...member.dependsOn] }),
      ...(member.stage === undefined ? {} : { stage: member.stage }),
      ...(member.modelRef === undefined ? {} : { modelRef: member.modelRef }),
      ...(member.workspace === undefined ? {} : { workspace: member.workspace }),
      ...(member.writes === undefined ? {} : { writes: member.writes }),
    })),
  };
}

/**
 * 计划 → 运行名单。`title`/`brief` 折进 `scopeSummary`，调度器只认名单。
 *
 * `base` 是队伍里**已经绑好的那条 lane**（按 laneId 索引）。合并规则两句话：
 *
 * 1. **计划写了的字段以计划为准，没写的沿用队伍**——模型只写「这一步干什么」就够了，
 *    不必把队伍配置抄一遍。身份字段（`agentId`/`role`/`identityLabel`）正是从这里继承的：
 *    少了它，手动计划派出去的人没有档案 id，权限检查会直接拒（2026-09-23 真机派活撞到过
 *    `派活目标缺少档案 id: lane_front`）。
 * 2. **跨 lane 的引用只保留指向本次名单里的**（`dependsOn`/`reportsTo`/`mayDirect`/
 *    `handoffTo`）。一次 run 可以只跑队伍的一部分 lane；不跑的那条不在名单里，
 *    「依赖它」「向它汇报」「指挥它」都无从谈起，照抄队伍的引用会被校验器拒
 *    （同一轮真机撞到过 `成员 lane_front 的汇报对象不在名单里: lane_plan`）。
 *    计划自己写的引用不过滤——那是计划内部的矛盾，该由校验器报出来。
 */
export function taskPlanToRoster(
  plan: TaskPlan,
  base?: ReadonlyMap<string, DelegationTeamMember>,
): DelegationTeamMember[] {
  const lanes = new Set(plan.tasks.map((task) => task.laneId));
  const withinRun = (targets: readonly string[]): string[] => targets.filter((laneId) => lanes.has(laneId));
  return plan.tasks.map((task) => {
    const fixed = base?.get(task.laneId);
    const inherited: DelegationTeamMember | undefined = fixed === undefined ? undefined : {
      ...fixed,
      ...(fixed.dependsOn === undefined ? {} : { dependsOn: withinRun(fixed.dependsOn) }),
      ...(fixed.reportsTo === undefined ? {} : { reportsTo: withinRun(fixed.reportsTo) }),
      ...(fixed.mayDirect === undefined ? {} : { mayDirect: withinRun(fixed.mayDirect) }),
      ...(fixed.handoffTo === undefined ? {} : { handoffTo: withinRun(fixed.handoffTo) }),
    };
    return {
      ...(inherited ?? {}),
      laneId: task.laneId,
      ...(task.agentId === undefined ? {} : { agentId: task.agentId }),
      ...(task.dependsOn === undefined ? {} : { dependsOn: [...task.dependsOn] }),
      ...(task.stage === undefined ? {} : { stage: task.stage }),
      ...(task.modelRef === undefined ? {} : { modelRef: task.modelRef }),
      ...(task.workspace === undefined ? {} : { workspace: task.workspace }),
      ...(task.writes === undefined ? {} : { writes: task.writes }),
      scopeSummary: task.brief === undefined ? task.title : `${task.title}——${task.brief}`,
    };
  });
}

export interface ValidateTaskPlanOptions {
  plan: TaskPlan;
  schedule: TeamSchedule;
  memberLimit: number;
  /** 允许使用的档案。给了就要求计划里的 agentId 必须在其中（§17.2「成员存在」）。 */
  allowedAgents?: readonly { agentId: string; label?: string }[] | undefined;
  /** 允许的模型路由。给了就要求计划里的 modelRef 必须在其中。 */
  allowedModelRefs?: readonly string[] | undefined;
  /**
   * 队伍里**已经绑好的**名单。计划里没写的字段沿用它——谁来做、什么角色、依赖与写锁
   * 由队伍说了算，模型只写「这一步干什么」（合并规则见 {@link taskPlanToRoster}）。
   */
  fixedRoster?: readonly DelegationTeamMember[] | undefined;
  temporaryMembers?: readonly DelegationTeamMember[] | undefined;
}

export interface ValidatedTaskPlan {
  roster: DelegationTeamMember[];
  /** 拓扑顺序，调度器直接照它走。 */
  order: string[];
  memberCount: number;
}

/**
 * 验证一份计划，通过后给出可执行的运行名单。
 *
 * 检查项一条都不省：lane 唯一、依赖指向本计划内的 lane、不成环、阶段号与调度方式
 * 一致、人数不超上限、档案存在、模型路由在白名单里。任何一条不过就抛
 * {@link LegionPlanError}，绝不「忽略看不懂的部分继续跑」。
 */
export function validateTaskPlan(options: ValidateTaskPlanOptions): ValidatedTaskPlan {
  const { plan, schedule, memberLimit } = options;
  assertMemberLimit(memberLimit);

  const seen = new Set<string>();
  for (const task of plan.tasks) {
    if (seen.has(task.laneId)) throw new TaskPlanError(`任务计划的 lane id 重复: ${task.laneId}`);
    seen.add(task.laneId);
  }

  if (options.allowedAgents !== undefined) {
    const allowed = new Set(options.allowedAgents.map((agent) => agent.agentId));
    for (const task of plan.tasks) {
      if (task.agentId === undefined) continue;
      if (allowed.has(task.agentId)) continue;
      throw new TaskPlanError(`任务计划的 ${task.laneId} 用了不在名单里的档案: ${task.agentId}`);
    }
  }

  if (options.allowedModelRefs !== undefined) {
    const allowed = new Set(options.allowedModelRefs);
    for (const task of plan.tasks) {
      if (task.modelRef === undefined) continue;
      if (allowed.has(task.modelRef)) continue;
      throw new TaskPlanError(`任务计划的 ${task.laneId} 用了不允许的模型路由: ${task.modelRef}`);
    }
  }

  const fixed = options.fixedRoster === undefined
    ? undefined
    : new Map(options.fixedRoster.map((member) => [member.laneId, member]));
  const roster = taskPlanToRoster(plan, fixed);
  // 依赖指向、成环、阶段号、人数上限都交给同一个校验器，避免两套规则分叉。
  validateTeamPlan({
    members: roster,
    ...(options.temporaryMembers === undefined ? {} : { temporaryMembers: options.temporaryMembers }),
    memberLimit,
    schedule,
  });

  return {
    roster,
    order: laneOrder(roster, { strict: schedule === "staged" }),
    memberCount: countTeamMembers([...roster, ...(options.temporaryMembers ?? [])]),
  };
}

export interface PlanInstructionOptions {
  goal: string;
  /** 可以派的人。计划只能从这里面挑。 */
  agents: readonly { agentId: string; label?: string }[];
  schedule: TeamSchedule;
  memberLimit: number;
  /** 允许的模型路由，空着表示不限制。 */
  allowedModelRefs?: readonly string[] | undefined;
}

/**
 * 给自动规划者的说明书。
 *
 * 把「只能从这份名单里挑人」「必须写成这个形状」写在提示里，是为了让 Host 的
 * 拒绝变成可预期的事：模型知道边界在哪，就不会一边猜一边被拒。
 */
export function renderPlanInstruction(options: PlanInstructionOptions): string {
  const agents = options.agents
    .map((agent) => (agent.label === undefined ? `- ${agent.agentId}` : `- ${agent.agentId}（${agent.label}）`))
    .join("\n");
  const scheduleRule =
    options.schedule === "staged"
      ? "本次是分阶段调度：**每个任务都必须写 stage**（从 1 开始的整数），同一阶段内的任务可以并行。"
      : options.schedule === "sequential"
        ? "本次是顺序调度：任何时刻只跑一个任务，用 dependsOn 写明先后。**不要写 stage**。"
        : "本次是并行调度：依赖满足就同时跑，用 dependsOn 写明真正的先后。**不要写 stage**。";
  const modelRule =
    options.allowedModelRefs === undefined || options.allowedModelRefs.length === 0
      ? "modelRef 可以不写（跟随默认路由）。"
      : `modelRef 只能从这些里选：${options.allowedModelRefs.join(" / ")}；不写就跟随默认路由。`;
  return [
    "把下面这个目标拆成一份任务计划，只输出 JSON，不要输出别的文字。",
    "",
    `目标：${options.goal}`,
    "",
    "可以派的人（agentId 只能从这里面挑，也可以不写 agentId）：",
    agents.length === 0 ? "- （没有可用档案，请不要写 agentId）" : agents,
    "",
    "输出格式：",
    "```json",
    '{"goal":"<目标原文>","tasks":[{"laneId":"lane_plan","agentId":"xiaobei","title":"做什么","brief":"补充说明","dependsOn":[],"stage":1,"modelRef":"fast","workspace":"default","writes":true}]}',
    "```",
    "",
    `规则：最多 ${options.memberLimit} 个人（含指挥者与临时成员，按 agentId 去重）。`,
    scheduleRule,
    modelRule,
    "laneId 只能用小写字母、数字、下划线和连字符；dependsOn 只能指向本计划里出现过的 laneId。",
    "writes 表示这个任务会不会改工作区；不写就按写任务处理（会串行）。只读任务请明确写 false。",
  ].join("\n");
}

/** 一行行展示计划，给人看的是人话，不是 JSON。 */
export function renderPlanSummary(plan: TaskPlan): string {
  const lines = [`目标：${plan.goal}`, `任务 ${plan.tasks.length} 个：`];
  for (const task of plan.tasks) {
    const parts = [`${task.laneId}｜${task.title}`];
    if (task.agentId !== undefined) parts.push(`档案 ${task.agentId}`);
    if (task.stage !== undefined) parts.push(`阶段 ${task.stage}`);
    if (task.dependsOn !== undefined && task.dependsOn.length > 0) parts.push(`依赖 ${task.dependsOn.join(",")}`);
    if (task.modelRef !== undefined) parts.push(`模型 ${task.modelRef}`);
    if (task.workspace !== undefined) parts.push(`工作区 ${task.workspace}`);
    if (task.writes === false) parts.push("只读");
    lines.push(`- ${parts.join("｜")}`);
  }
  return lines.join("\n");
}
