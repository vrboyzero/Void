import { loadSavedFacetView, loadSoulRegistry, type SoulRecord } from "@void/void-soul";
import type { DelegationTeamMember } from "./team.js";

/**
 * 队伍面板要知道的事：这支队伍里有没有人**已经停用**（A17）。
 *
 * 为什么军团自己再读一遍：停用位住在灵魂档案的 `state.json` 里（`AgentFacetState.suspended`），
 * 而军团平时只从 `personaFor` 取身份——取的时候才知道被拒，那时人已经在看「派活失败」了。
 * 面板要在**派活之前**就把它摆出来，所以这里直接读登记表与各档案的状态位。
 *
 * **只读**：一个字节都不写，也不动名单。停用不是「把人从名单里去掉」——名单是队伍的配置，
 * 停用是那份档案的状态，两者各归各的（想临时换人就改名单，想让它回来就去灵魂档案面板启用）。
 */

/** 一个成员查出来的结果：已停用、还是「读不出来」。 */
export interface MemberSuspension {
  laneId: string;
  agentId: string;
  /** 已停用。读不出来时这里是 `false`，但 `reason` 会有话——**不能当成「没停用」**。 */
  suspended: boolean;
  /** 读不出来的原因（登记表里没有这份档案、状态位读不动）。没停用且读得出时没有。 */
  reason?: string;
}

export interface SuspensionIndex {
  /** 已停用的档案 id。 */
  suspended: ReadonlySet<string>;
  /** 登记表里有的档案 id：用来分辨「这份档案不在登记表里」与「这份档案好好的」。 */
  known: ReadonlySet<string>;
  /**
   * 读不动的地方，逐条报出来（`谁（id）：为什么`）。
   *
   * **空数组才代表「读过了，没有人停用」**：整张登记表读不动时 `suspended` 也是空的，
   * 但这里会有话——把「读不出来」当成「没停用」是最坏的一种静默降级。
   */
  problems: readonly string[];
}

/**
 * 读一遍档案登记表，把已停用的档案 id 收成一张表。
 *
 * 逐档案读状态位：一份读不动只影响它自己（记进 `problems`），不连累整张表——队伍面板不该
 * 因为某一份无关档案坏了就打不开。
 */
export async function loadSuspensionIndex(dataDir: string): Promise<SuspensionIndex> {
  let registry: Map<string, SoulRecord>;
  try {
    registry = await loadSoulRegistry(dataDir);
  } catch (error) {
    return { suspended: new Set<string>(), known: new Set<string>(), problems: [`档案登记表读不动：${describe(error)}`] };
  }
  const suspended = new Set<string>();
  const problems: string[] = [];
  for (const record of registry.values()) {
    try {
      const view = await loadSavedFacetView(dataDir, record);
      if (view.suspended) suspended.add(record.id);
    } catch (error) {
      problems.push(`${record.frontMatter.name ?? record.id}（${record.id}）：读不出停用状态（${describe(error)}）`);
    }
  }
  return { suspended, known: new Set(registry.keys()), problems };
}

/**
 * 名单 × 停用表：逐成员算一遍。
 *
 * 只报**有话要说**的成员（已停用、或读不出来）。没有档案 id 的成员这里跳过——那种名单在派活
 * 前会被另一条检查拦下（`派活目标缺少档案 id`），不是停用这件事。
 */
export function memberSuspensions(input: {
  members: readonly DelegationTeamMember[];
  index: SuspensionIndex;
}): readonly MemberSuspension[] {
  const reports: MemberSuspension[] = [];
  for (const member of input.members) {
    const agentId = member.agentId?.trim() ?? "";
    if (agentId.length === 0) continue;
    if (!input.index.known.has(agentId)) {
      reports.push({ laneId: member.laneId, agentId, suspended: false, reason: "登记表里没有这份档案" });
      continue;
    }
    if (input.index.suspended.has(agentId)) reports.push({ laneId: member.laneId, agentId, suspended: true });
  }
  return reports;
}

/** 队伍面板那一节有没有话要说（登记表读不动也算有话）。 */
export function hasSuspensionNews(input: {
  members: readonly DelegationTeamMember[];
  index: SuspensionIndex;
}): boolean {
  return input.index.problems.length > 0 || memberSuspensions(input).length > 0;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
