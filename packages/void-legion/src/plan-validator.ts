/**
 * 派活前的名单校验与拓扑排序。
 *
 * 这一层存在的理由（方案文档 §19.1「现有任务图可能静默漏跑、空跑成功」）：
 * 旧实现遇到未知依赖直接 `continue`，图上少一条边就当没写，于是任务静默漏跑；
 * 又没有环检查，成环的成员永远进不了队列，也当成功返回。调度器不该承担修正坏
 * 数据的责任——坏名单必须在**派发之前**被拒绝，并且说清是哪一条坏了。
 *
 * @module @void/void-legion/plan-validator
 */
import { assertLaneId, assertMemberLimit, countTeamMembers, type TeamSchedule } from "./contracts.js";
import type { DelegationTeamMember } from "./team.js";

export class LegionPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegionPlanError";
  }
}

export interface TeamPlanInput {
  /** 固定名单（来自已保存的队伍配置）。 */
  members: readonly DelegationTeamMember[];
  /** 本次 run 才加进来的临时成员（L14）。它们不写回固定名单。 */
  temporaryMembers?: readonly DelegationTeamMember[] | undefined;
  memberLimit: number;
  schedule: TeamSchedule;
}

function collectUnknown(input: {
  member: DelegationTeamMember;
  field: "dependsOn" | "reportsTo" | "mayDirect" | "handoffTo";
  label: string;
  known: ReadonlySet<string>;
}): void {
  for (const target of input.member[input.field] ?? []) {
    if (input.member.laneId === target) {
      throw new LegionPlanError(`成员 ${input.member.laneId} 的${input.label}指向自己`);
    }
    if (!input.known.has(target)) {
      throw new LegionPlanError(`成员 ${input.member.laneId} 的${input.label}不在名单里: ${target}`);
    }
  }
}

/**
 * 校验一份即将派发的名单。
 *
 * @returns 固定名单 + 临时成员合成后的实际名单（顺序：固定在前，临时在后）。
 * @throws {LegionPlanError} 任何一条不合法都整次拒绝，不挑着执行。
 */
export function validateTeamPlan(input: TeamPlanInput): DelegationTeamMember[] {
  assertMemberLimit(input.memberLimit);
  const roster = [...input.members, ...(input.temporaryMembers ?? [])];
  if (roster.length === 0) throw new LegionPlanError("队伍没有成员，拒绝派活");
  const memberCount = countTeamMembers(roster);
  if (memberCount > input.memberLimit) {
    throw new LegionPlanError(
      `队伍人数超出上限: ${memberCount} > ${input.memberLimit}（按档案去重后计数，含指挥者与临时成员；改上限或减人后再派）`,
    );
  }

  const seen = new Set<string>();
  const fixedLanes = new Set(input.members.map((member) => member.laneId));
  const temporaryLanes = new Set<string>();
  for (const member of input.members) {
    assertLaneId(member.laneId);
    if (seen.has(member.laneId)) throw new LegionPlanError(`成员 lane id 重复: ${member.laneId}`);
    seen.add(member.laneId);
  }
  for (const member of input.temporaryMembers ?? []) {
    assertLaneId(member.laneId);
    if (temporaryLanes.has(member.laneId)) throw new LegionPlanError(`临时成员 lane id 重复: ${member.laneId}`);
    temporaryLanes.add(member.laneId);
    if (fixedLanes.has(member.laneId)) throw new LegionPlanError(`临时成员与固定名单重复: ${member.laneId}`);
    seen.add(member.laneId);
  }

  for (const member of roster) {
    collectUnknown({ member, field: "dependsOn", label: "依赖", known: seen });
    collectUnknown({ member, field: "reportsTo", label: "汇报对象", known: seen });
    collectUnknown({ member, field: "mayDirect", label: "指挥许可", known: seen });
    collectUnknown({ member, field: "handoffTo", label: "交接对象", known: seen });
  }

  if (input.schedule === "staged") {
    for (const member of roster) {
      if (member.stage === undefined) {
        throw new LegionPlanError(`分阶段调度要求每个成员写明阶段号，成员 ${member.laneId} 没写`);
      }
    }
  } else {
    for (const member of roster) {
      if (member.stage !== undefined) {
        throw new LegionPlanError(`成员 ${member.laneId} 写了阶段号，但本次调度是 ${input.schedule}，阶段号不会生效`);
      }
    }
  }

  // 环检查放最后：前面的报错更具体，先报出来更有用。
  laneOrder(roster, { strict: true });
  return roster;
}

/** 从剩余节点里走出一条真实的环，用于报错信息（比「存在环」有用得多）。 */
function describeCycle(remaining: ReadonlySet<string>, byLane: ReadonlyMap<string, DelegationTeamMember>): string {
  const start = [...remaining][0]!;
  const path: string[] = [];
  const seen = new Map<string, number>();
  let current = start;
  while (!seen.has(current)) {
    seen.set(current, path.length);
    path.push(current);
    const next = (byLane.get(current)?.dependsOn ?? []).find((dep) => remaining.has(dep));
    if (next === undefined) break;
    current = next;
  }
  const from = seen.get(current);
  const loop = from === undefined ? path : path.slice(from);
  return [...loop, loop[0]].join(" → ");
}

/**
 * 拓扑排序。`strict` 时未知依赖直接报错（派活路径用这个）；非严格模式保留旧的
 * 「忽略未知依赖」行为，只给不参与派发的调用方用。
 */
export function laneOrder(roster: readonly DelegationTeamMember[], options: { strict: boolean }): string[] {
  const byLane = new Map(roster.map((member) => [member.laneId, member]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const member of roster) indegree.set(member.laneId, 0);
  for (const member of roster) {
    for (const dep of member.dependsOn ?? []) {
      if (!byLane.has(dep)) {
        if (options.strict) {
          throw new LegionPlanError(`成员 ${member.laneId} 依赖了名单里没有的成员: ${dep}`);
        }
        continue;
      }
      indegree.set(member.laneId, (indegree.get(member.laneId) ?? 0) + 1);
      const list = dependents.get(dep);
      if (list) list.push(member.laneId);
      else dependents.set(dep, [member.laneId]);
    }
  }
  const queue = roster.filter((member) => (indegree.get(member.laneId) ?? 0) === 0).map((member) => member.laneId);
  const order: string[] = [];
  while (queue.length > 0) {
    const laneId = queue.shift()!;
    order.push(laneId);
    for (const dependent of dependents.get(laneId) ?? []) {
      const next = (indegree.get(dependent) ?? 1) - 1;
      indegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }
  if (order.length < roster.length) {
    const ordered = new Set(order);
    const remaining = new Set(roster.map((member) => member.laneId).filter((laneId) => !ordered.has(laneId)));
    throw new LegionPlanError(`成员依赖成环: ${describeCycle(remaining, byLane)}`);
  }
  return order;
}

/** 派活路径的拓扑排序：未知依赖和环都在这里被拒绝。 */
export function orderLanes(roster: readonly DelegationTeamMember[]): string[] {
  return laneOrder(roster, { strict: true });
}
