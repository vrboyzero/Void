import { SoulProfileError } from "./profile.js";
import type { SoulRecord } from "./registry.js";

export interface AuthorityProfile {
  id: string;
  superiors: readonly string[];
  subordinates: readonly string[];
}

/** 一次派活用的身份快照：谁是派活者，以及整份身份图。 */
export interface AuthoritySnapshot {
  actorId: string;
  profiles: ReadonlyMap<string, AuthorityProfile>;
}

/**
 * 权威档案来源（`voidAuthority` 服务）。军团只消费这个契约，不自己造身份图，
 * 否则「组织图与权限检查读同一份快照」就落空了。
 *
 * 按会话解析，而不是给一个全局 `actorId`：宿主里同时活着多个会话，一个静态值必然
 * 让 B 会话拿着 A 的身份去派活。
 */
export interface AuthoritySource {
  /** 解析不出就返回 `undefined`（比如这个会话还没绑定档案），**不退回默认身份**。 */
  forSession(sessionId: string): Promise<AuthoritySnapshot | undefined>;
  /**
   * 逐成员身份文本（底线 + 当前角色），军团把它装进子代理的 `persona` 段。
   *
   * 按 `agentId` 取**那个成员自己的**档案，取不出来就抛错——**绝不退回派活者的身份**
   * （文档：必须显式绑定子成员身份，不能误把父身份当子身份）。
   */
  personaFor(agentId: string): Promise<string>;
  bindChildSession?(sessionId: string, agentId: string): Promise<void>;
}

/**
 * 把一份档案读成身份图里的一个点。`authority` 没写就是「没有上下级」——
 * 不是「默认是上级」：关系没写明，`assertMayDirect` 一律拒绝。
 */
export function authorityProfileOf(record: SoulRecord): AuthorityProfile {
  const authority = record.frontMatter.authority;
  if (authority === undefined || !authority.enabled) {
    return { id: record.id, superiors: [], subordinates: [] };
  }
  return { id: record.id, superiors: authority.superiors, subordinates: authority.subordinates };
}

/** 整份身份图。组织图与权限检查读同一份记录，不各自维护一份。 */
export function buildAuthorityProfiles(records: ReadonlyMap<string, SoulRecord>): Map<string, AuthorityProfile> {
  const profiles = new Map<string, AuthorityProfile>();
  for (const record of records.values()) profiles.set(record.id, authorityProfileOf(record));
  return profiles;
}

/**
 * 关系引用的是稳定 id，写错一个字母就等于这条边不存在——而「边不存在」在派活时表现为
 * 「没有许可」，人会以为是权限规则出了问题。所以这里让写错的档案直接读不进来。
 */
export function assertAuthorityReferences(records: ReadonlyMap<string, SoulRecord>): void {
  for (const record of records.values()) {
    const authority = record.frontMatter.authority;
    if (authority === undefined || !authority.enabled) continue;
    for (const key of ["superiors", "subordinates"] as const) {
      for (const reference of authority[key]) {
        if (!records.has(reference)) {
          throw new SoulProfileError(`档案 ${record.id} 的 ${key} 引用了不存在的档案: ${reference}`);
        }
      }
    }
  }
}

/** 派活前逐个检查目标。任意一个不被允许，就整次拒绝。 */
export function assertMayDirectAll(actor: AuthorityProfile, targets: readonly AuthorityProfile[]): void {
  for (const target of targets) assertMayDirect({ actor, target });
}

/** 身份底线先于队伍许可。下级不能指挥上级；关系没写明就拒绝。 */
export function assertMayDirect(input: {
  actor: AuthorityProfile;
  target: AuthorityProfile;
}): void {
  if (input.actor.id === input.target.id) return;
  const actorIsSubordinate = input.actor.superiors.includes(input.target.id) || input.target.subordinates.includes(input.actor.id);
  const actorIsSuperior = input.actor.subordinates.includes(input.target.id) || input.target.superiors.includes(input.actor.id);
  if (actorIsSubordinate || !actorIsSuperior) {
    throw new SoulProfileError(`${input.actor.id} 不能指挥 ${input.target.id}`);
  }
}
