/**
 * 通知契约：入口认的第二类业务来源（§16.1 第五行「通知结果」，§16.2 L9 第五条）。
 *
 * 为什么单独一类而不是塞进业务视图：视图是「点开看细节」的，通知是「不看也得知道」的。
 * 运行结束这类事发生在面板没开、甚至浏览器没开的时候，重连之后必须能补读到——
 * 所以它有自己的注册表、自己的路由，并且**只读**（唯一的写操作是标记已读）。
 *
 * 三条约定：
 * 1. **来源只报事实**：条目里放状态与受控结果链接，不放成员产出正文、SOUL 正文或会话内容。
 * 2. **持久化在来源那边**：入口不存通知，只聚合与转发。谁产生事件，谁负责落盘与补读。
 * 3. **形状不对就报错**：少一个字段的条目会让面板画出半条通知，这种错要当场炸出来，
 *    而不是安静丢掉（丢掉等于「那次运行没发生过」）。
 *
 * @module @void/void-entry/notifications
 */

/** 通知的严重程度：面板只用它决定配色，不做任何语义分支。 */
export type VoidNotificationLevel = "info" | "warn" | "danger";

/** 一条通知。 */
export interface VoidNotification {
  /** 来源内唯一。同一来源的重复 id 视为同一条。 */
  id: string;
  title: string;
  /** 一句话说清发生了什么（可省）。 */
  summary?: string;
  /** 发生时间（ISO 字符串）。 */
  at: string;
  level?: VoidNotificationLevel;
  /** 附带的事实键值对，面板按原样列出。 */
  meta?: Record<string, string>;
  /** 人已经看过了。没读过的会在面板里高亮，并且**不会被删**。 */
  read?: boolean;
}

/** 来源回给入口的列表。 */
export interface VoidNotificationList {
  items: readonly VoidNotification[];
  /** 列表上方那句话：为什么空、为什么少、为什么不能标记已读。 */
  note?: string;
}

/**
 * 一个通知来源。
 *
 * `list` 可以只回条目数组（省掉 note）；`markRead` 可省——不能标记已读的来源照样能显示，
 * 面板会如实说明「这个来源不支持标记已读」。`markRead` 能算出真正标了几条就回个数，
 * 算不出来可以什么都不回（入口按「请求了几条」如实汇报，不替来源编数字）。
 */
export interface VoidNotificationSource {
  id: string;
  title: string;
  list(): Promise<VoidNotificationList | readonly VoidNotification[]>;
  markRead?(ids: readonly string[]): Promise<number | void>;
}

/** 入口聚合后给面板的一条：带上来源，面板才知道「标记已读」该发回哪里。 */
export interface VoidNotificationItem extends VoidNotification {
  source: string;
  sourceTitle: string;
}

/** `GET /void/api/notifications` 的响应。 */
export interface VoidNotificationPayload {
  items: VoidNotificationItem[];
  /** 未读条数（面板画角标用，不必自己数）。 */
  unread: number;
  /** 有哪些来源（面板据此决定要不要画通知条）。 */
  sources: Array<{ id: string; title: string }>;
  /** 读不出来的来源与来源自己写的说明，原样带上。 */
  notes: string[];
}

/**
 * 校验来源回的条目。
 *
 * 只校验「画得出来」必需的三个字段。校验失败抛错，由调用方转成一条 note——
 * 一个来源坏掉不该让整个通知条消失。
 */
export function assertNotificationItems(sourceId: string, items: readonly unknown[]): VoidNotification[] {
  return items.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`通知来源 ${sourceId} 的第 ${index + 1} 条不是对象`);
    }
    const value = item as Record<string, unknown>;
    for (const key of ["id", "title", "at"] as const) {
      if (typeof value[key] !== "string" || value[key] === "") {
        throw new Error(`通知来源 ${sourceId} 的第 ${index + 1} 条缺少 ${key}`);
      }
    }
    if (value.level !== undefined && !["info", "warn", "danger"].includes(String(value.level))) {
      throw new Error(`通知来源 ${sourceId} 的第 ${index + 1} 条的 level 不认识: ${String(value.level)}`);
    }
    return value as unknown as VoidNotification;
  });
}

/**
 * 排序：**未读在前**，其次按时间倒序。
 *
 * 未读优先的理由：这一栏存在的意义就是「你不在的时候出过事」。已读的旧通知沉下去，
 * 但仍然留在列表里，随时能翻回去看。
 */
export function sortNotifications(items: readonly VoidNotificationItem[]): VoidNotificationItem[] {
  return [...items].sort((a, b) => {
    const unreadA = a.read === true ? 1 : 0;
    const unreadB = b.read === true ? 1 : 0;
    if (unreadA !== unreadB) return unreadA - unreadB;
    if (a.at !== b.at) return a.at < b.at ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
