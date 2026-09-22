/**
 * 队伍许可与身份禁止的合并判定，以及组织图。
 *
 * 两者放在同一个模块是刻意的：方案文档 §15.2 要求「组织图与权限检查读同一份队伍
 * 快照，图中箭头不能成为第二份权威数据」。只要渲染和判定分别去读两份结构，
 * 迟早会出现「图上画着能指挥、实际派不动」或者更糟的反向偏差。
 *
 * 判定顺序也照文档：**先身份禁止，再队伍许可**，两者取交集，任意一方拒绝即拒绝。
 * 身份先判是因为它更硬——队伍配置改一改就能放宽 `mayDirect`，身份底线不能。
 *
 * @module @void/void-legion/authority
 */
import { assertMayDirect, SoulProfileError, type AuthorityProfile } from "@void/void-soul";
import type { DelegationTeamMember } from "./team.js";

export class LegionAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegionAuthorityError";
  }
}

/** 一次派活冻结下来的名单。临时成员已经并进来，权限检查不会因为「临时」而放宽。 */
export interface TeamAuthoritySnapshot {
  members: readonly DelegationTeamMember[];
  managerAgentId?: string | undefined;
}

/** 按档案 id 找成员条目。一个档案在名单里只应出现一次（validateTeamPlan 已按 lane 去重）。 */
export function findMemberByAgent(snapshot: TeamAuthoritySnapshot, agentId: string): DelegationTeamMember | undefined {
  return snapshot.members.find((member) => member.agentId === agentId);
}

/** 队伍许可：目标 lane 是否在派活者的 `mayDirect` 边里。不从 `reportsTo` 推导。 */
export function teamPermits(snapshot: TeamAuthoritySnapshot, actorAgentId: string, targetLaneId: string): boolean {
  if (snapshot.managerAgentId !== undefined && snapshot.managerAgentId === actorAgentId) return true;
  const actor = findMemberByAgent(snapshot, actorAgentId);
  if (actor === undefined) return false;
  return (actor.mayDirect ?? []).includes(targetLaneId);
}

/**
 * 派活前校验：身份许可 ∩ 队伍许可。
 *
 * @throws {LegionAuthorityError} 身份禁止、目标不在名单、目标没有档案、队伍没授权，
 * 各给各的原因。不在这里「修正」成更宽的许可——文档明确禁止后台放宽。
 */
export function assertTeamDispatch(input: {
  snapshot: TeamAuthoritySnapshot;
  actor: AuthorityProfile;
  profiles: ReadonlyMap<string, AuthorityProfile>;
  targetLaneIds: readonly string[];
}): void {
  const byLane = new Map(input.snapshot.members.map((member) => [member.laneId, member]));
  for (const laneId of input.targetLaneIds) {
    const member = byLane.get(laneId);
    if (member === undefined) throw new LegionAuthorityError(`派活目标不在本次名单里: ${laneId}`);
    if (member.agentId === undefined || member.agentId.length === 0) {
      throw new LegionAuthorityError(`派活目标缺少档案 id: ${laneId}`);
    }
    const profile = input.profiles.get(member.agentId);
    if (profile === undefined) throw new LegionAuthorityError(`派活目标没有权威档案: ${member.agentId}`);
    // 1) 身份禁止优先：队伍许可再宽也盖不过底线。
    try {
      assertMayDirect({ actor: input.actor, target: profile });
    } catch (error) {
      if (error instanceof SoulProfileError) throw new LegionAuthorityError(error.message);
      throw error;
    }
    // 2) 队伍许可：必须显式写在 mayDirect 边上。
    if (!teamPermits(input.snapshot, input.actor.id, laneId)) {
      throw new LegionAuthorityError(`队伍没有授权 ${input.actor.id} 指挥 ${laneId}（需要在队伍的 mayDirect 里显式写明）`);
    }
  }
}

/**
 * 组织图（L12）。纯文本行，界面直接渲染，测试直接断言。
 *
 * 指挥边只画 `mayDirect`，汇报边只画 `reportsTo`，两者分开标注——图上不合并，
 * 才不会让人误以为「向我汇报」等于「我能派他活」。
 */
export function renderOrgChart(input: {
  id: string;
  schedule: string;
  mode: string;
  memberLimit: number;
  managerAgentId?: string | undefined;
  members: readonly DelegationTeamMember[];
}): string[] {
  const lines: string[] = [
    `队伍 ${input.id}（${input.mode} · ${input.schedule}，人数上限 ${input.memberLimit}，当前 ${input.members.length} 人）`,
  ];
  const manager = input.managerAgentId === undefined
    ? undefined
    : input.members.find((member) => member.agentId === input.managerAgentId);
  lines.push(
    input.managerAgentId === undefined
      ? "指挥: 未指定"
      : `指挥: ${input.managerAgentId}${manager === undefined ? "（不在名单里）" : `（lane ${manager.laneId}）`}`,
  );
  const label = (laneIds: readonly string[]): string => (laneIds.length === 0 ? "无" : laneIds.join(", "));
  for (const member of input.members) {
    const who = [member.identityLabel, member.agentId].filter((value): value is string => value !== undefined && value.length > 0);
    const head = [`- ${member.laneId}`, ...(who.length === 0 ? [] : [who.join(" / ")])];
    if (member.role !== undefined && member.role !== "default") head.push(`[${member.role}]`);
    if (member.stage !== undefined) head.push(`阶段 ${member.stage}`);
    lines.push(head.join(" · "));
    lines.push(`  汇报: ${label(member.reportsTo ?? [])}`);
    lines.push(`  可指挥: ${label(member.mayDirect ?? [])}`);
    lines.push(`  依赖: ${label(member.dependsOn ?? [])}`);
    if (member.handoffTo !== undefined && member.handoffTo.length > 0) {
      lines.push(`  交接: ${label(member.handoffTo)}`);
    }
  }
  return lines;
}
