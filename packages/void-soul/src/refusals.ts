/**
 * 「灵魂没装进模型」的通知来源：把当场发生的拒绝留成面板能读的一条。
 *
 * 为什么要有它（13.3 第 3 条）：装不下就明确拒绝、不悄悄截断——拒绝原文已经写清了字数、
 * 预算与补救方向，但它此前只进宿主日志。人在面板上看不到「这次为什么没带灵魂」，只会
 * 觉得角色没生效，于是去改档案、改模组，越查越偏。这里把拒绝变成通知条的一条。
 *
 * 三条约定与军团的来源一致（§16.1）：**只报事实**（拒绝原文里没有 SOUL 正文，只有字数、
 * 变量名与预算出处）、**不新增 UI 插件**（注册进 `ctx.voidSuite`，入口负责聚合与渲染）、
 * **形状不对就当场拒收**（入口那侧校验）。契约类型在这里本地重述：void-soul 不依赖
 * void-entry，两边只共享形状。
 *
 * 与军团终态通知的关键差别：**只活在本次进程里**。拒绝是当场发生的事，宿主重启之后那次
 * 会话已经不在了，留档没有意义（军团运行记录要留档，是因为事后还要查）。列表里会如实
 * 说明这一点，不让人以为「没通知就是没拒绝过」。
 *
 * @module @void/void-soul/refusals
 */

/** 通知来源 id：面板靠它把「标记已读」的请求送回正确的来源。 */
export const REFUSAL_NOTIFICATION_SOURCE_ID = "void-soul:refusals";

/** 最多留多少条。只留最近这些：拒绝是给人当场看的，不是审计日志。 */
export const REFUSAL_RING_SIZE = 50;

/** 通知条目的形状（与 `@void/void-entry/notifications` 的 `VoidNotification` 一致）。 */
export interface SoulRefusalItem {
  /** 来源内唯一，形如 `<会话 id>#<序号>`。 */
  id: string;
  title: string;
  summary?: string;
  at: string;
  level?: "info" | "warn" | "danger";
  meta?: Record<string, string>;
  read?: boolean;
}

export interface SoulRefusalList {
  items: SoulRefusalItem[];
  /** 列表上方那句话：为什么空、为什么不落盘，都写在这里。 */
  note?: string;
}

export interface SoulRefusalSource {
  id: string;
  title: string;
  list(): Promise<SoulRefusalList>;
  /** 回真正标了几条（已经读过的不算）。 */
  markRead?(ids: readonly string[]): Promise<number | void>;
}

/** 记一条拒绝需要的最小事实。 */
export interface SoulRefusalInput {
  /** 会话 id（`agent/created` 拿到的 `agent.id`，绑定表就是按它查档案的）。 */
  sessionId: string;
  /** 拒绝原文：为什么没装进去、差多少、怎么办。 */
  reason: string;
  /** 发生时间，默认当下；测试可注入。 */
  at?: Date;
}

interface StoredRefusal {
  seq: number;
  sessionId: string;
  reason: string;
  at: string;
  read: boolean;
}

/** 从会话 id 反查档案，用于把通知写得像人话；查不到就只报会话。 */
export type RefusalDescriber = (sessionId: string) => Promise<{ profileId?: string | undefined } | undefined>;

/**
 * 进程内的拒绝记录：新记录在前，超过 `REFUSAL_RING_SIZE` 挤掉最老的。
 *
 * 挤掉的那条就不再能标记已读了——`markRead` 如实回「标到了几条」，不替来源编数字。
 */
export class SoulRefusalLog {
  private readonly entries: StoredRefusal[] = [];
  private nextSeq = 1;

  /** 记一条，回它落下来的条目（面板下一次 `list()` 就能看到）。 */
  record(input: SoulRefusalInput): SoulRefusalItem {
    const stored: StoredRefusal = {
      seq: this.nextSeq,
      sessionId: input.sessionId,
      reason: input.reason,
      at: (input.at ?? new Date()).toISOString(),
      read: false,
    };
    this.nextSeq += 1;
    this.entries.unshift(stored);
    if (this.entries.length > REFUSAL_RING_SIZE) this.entries.length = REFUSAL_RING_SIZE;
    return toItem(stored);
  }

  /** 当前留着的条目（新在前）。 */
  list(): SoulRefusalItem[] {
    return this.entries.map(toItem);
  }

  get size(): number {
    return this.entries.length;
  }

  /** 标记已读，回真正标了几条；已经被挤掉或本来就已读的不算。 */
  markRead(ids: readonly string[]): number {
    const wanted = new Set(ids);
    let marked = 0;
    for (const entry of this.entries) {
      if (!wanted.has(idOf(entry)) || entry.read) continue;
      entry.read = true;
      marked += 1;
    }
    return marked;
  }
}

/**
 * 造通知来源。
 *
 * `describe` 是取值函数：把会话 id 翻成档案名要读绑定表，读不到就照实只说会话——
 * 通知面不该因为查不到名字就消失（那样等于「那次拒绝没发生过」）。
 */
export function createRefusalNotifications(log: SoulRefusalLog, describe?: RefusalDescriber): SoulRefusalSource {
  return {
    id: REFUSAL_NOTIFICATION_SOURCE_ID,
    title: "灵魂未生效",
    async list(): Promise<SoulRefusalList> {
      const items: SoulRefusalItem[] = [];
      for (const item of log.list()) {
        items.push(describe === undefined ? item : await withProfile(item, describe));
      }
      return {
        items,
        note:
          items.length === 0
            ? "还没有拒绝过。说明书装不进模型时（超出上下文预算、会话没有绑定档案、变量取不到值）这里会留一条，写明为什么。"
            : "只留本次进程里的最近 50 条：宿主重启后这里会清空，历史请在宿主日志里按 void-soul 查。",
      };
    },
    async markRead(ids: readonly string[]): Promise<number> {
      return log.markRead(ids);
    },
  };
}

function idOf(entry: StoredRefusal): string {
  return `${entry.sessionId}#${entry.seq}`;
}

function toItem(entry: StoredRefusal): SoulRefusalItem {
  return {
    id: idOf(entry),
    title: `灵魂没装进模型（会话 ${entry.sessionId}）`,
    summary: entry.reason,
    at: entry.at,
    level: "danger",
    meta: { 会话: entry.sessionId },
    read: entry.read,
  };
}

async function withProfile(item: SoulRefusalItem, describe: RefusalDescriber): Promise<SoulRefusalItem> {
  const sessionId = item.meta?.会话 ?? "";
  let profileId: string | undefined;
  try {
    profileId = (await describe(sessionId))?.profileId;
  } catch {
    // 查档案名失败不该让整条通知消失：照原样报会话，拒绝本身仍然看得见。
    return item;
  }
  if (profileId === undefined || profileId === "") return item;
  return {
    ...item,
    title: `档案 ${profileId} 的说明书没装进模型`,
    meta: { ...item.meta, 档案: profileId },
  };
}
