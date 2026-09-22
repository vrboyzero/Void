import type { AuthoritySource } from "@void/void-soul";
import { SubagentDispatchError } from "./subagent-provider.js";
import type { DelegationTeamMember } from "./team.js";

/**
 * 逐子代理身份注入（能力表「子代理继承」行：**必须显式绑定子成员身份，不能误把父身份
 * 当子身份**）。
 *
 * 身份文本只能同步地交出去（`ScheduledWorkerOptions.persona` 是同步回调），所以整份名单
 * 必须在**派出任何子代理之前**一次性取好。取身份这一步挂在 `dispatch` 的 `authorize` 里
 * ——宿主保证它在任何 lane 启动之前跑完（`run-coordinator.ts:175`），所以一个成员取不出
 * 身份就整次派活失败，不会出现「一半子代理有名分、一半无名分」。
 *
 * 取不到就抛，**不回退到派活者的身份**：静默降级等于给子代理一个假名分。
 *
 * 一次报全（A17）：有几个成员取不出身份就列几个，不只报第一个。成员被**停用**时原因会原样带出来
 * （`档案已停用，拒绝派活: …`），人要拿着它回灵魂档案面板启用——一次说全才不用反复试。
 */
export async function loadMemberPersonas(input: {
  authority: AuthoritySource;
  members: readonly DelegationTeamMember[];
}): Promise<Map<string, string>> {
  const { authority } = input;
  if (typeof authority.personaFor !== "function") {
    throw new SubagentDispatchError("派活缺少逐成员身份：这个权威档案来源不提供 personaFor");
  }
  const personas = new Map<string, string>();
  // 一处取不出来就整队不派（上面那条：不能出现「一半有名分、一半没名分」），但**要把话一次说全**：
  // 只报第一个坏的，人改完再派又撞上第二个——尤其「已停用」这种要回面板上处理的原因（A17）。
  const failures: string[] = [];
  for (const member of input.members) {
    const agentId = member.agentId?.trim() ?? "";
    if (agentId.length === 0) throw new SubagentDispatchError(`派活目标缺少档案 id: ${member.laneId}`);
    let text: string;
    try {
      text = await authority.personaFor(agentId);
    } catch (error) {
      failures.push(`lane ${member.laneId} 的派活身份取不出来（${agentId}）：${describe(error)}`);
      continue;
    }
    if (text.trim().length === 0) {
      failures.push(`lane ${member.laneId} 的派活身份是空的（${agentId}）`);
      continue;
    }
    personas.set(member.laneId, text);
  }
  if (failures.length > 0) {
    throw new SubagentDispatchError(`整队不派：${failures.length} 个成员取不出派活身份——${failures.join("；")}`);
  }
  return personas;
}

/**
 * 同步查身份：worker 只认这张提前取好的表。
 *
 * 表里没有这个 lane 就抛——**不返回 `undefined`**，因为 `undefined` 在宿主那边等于
 * 「这次不带 persona」，子代理会顶着继承来的身份跑，正是文档要禁的那件事。
 */
export function personaOf(personas: ReadonlyMap<string, string>, laneId: string): string {
  const text = personas.get(laneId);
  if (text === undefined) throw new SubagentDispatchError(`lane "${laneId}" 没有取到派活身份，拒绝按无名分派出去`);
  return text;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
