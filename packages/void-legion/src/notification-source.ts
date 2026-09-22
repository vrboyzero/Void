/**
 * 「军团运行」通知来源：把落盘的终态事件翻成面板能直接画的通知。
 *
 * 位置说明（§16.1）：入口只认「业务视图 / 通知来源」两类契约，**不新增第四个 UI 插件**；
 * 军团把来源注册进 `ctx.voidSuite`，入口负责聚合、同源校验与渲染。这个文件属于军团，
 * 因为它最清楚「一次运行结束意味着什么」。
 *
 * 契约类型在这里**本地重述**（和 detail-view.ts 同样的理由）：void-legion 不依赖 void-entry，
 * 两边只共享形状。形状对不上时入口会如实拒收，而不是悄悄少画一条通知。
 *
 * @module @void/void-legion/notification-source
 */
import type { Context } from "@deepseek-ai/cordis";
import type { LegionNotificationRecord, LegionNotificationStore } from "./notifications.js";

/** 通知来源 id：面板靠它把「标记已读」的请求送回正确的来源。 */
export const RUN_NOTIFICATION_SOURCE_ID = "void-legion:runs";

/** 通知条目的形状（与 `@void/void-entry/notifications` 的 `VoidNotification` 一致）。 */
export interface LegionNotificationItem {
  /** 来源内唯一。这里直接用 `eventId`（`<runId>#<序号>`）。 */
  id: string;
  title: string;
  summary?: string;
  at: string;
  level?: "info" | "warn" | "danger";
  meta?: Record<string, string>;
  read?: boolean;
}

export interface LegionNotificationList {
  items: LegionNotificationItem[];
  /** 列表上方那句话：为什么少、为什么空、为什么不能标记已读，都写在这里。 */
  note?: string;
}

export interface LegionNotificationSource {
  id: string;
  title: string;
  list(): Promise<LegionNotificationList>;
  /** 回真正标了几条（已经读过的不算）。 */
  markRead?(ids: readonly string[]): Promise<number | void>;
}

/** 通知来源需要宿主提供的东西：通知仓库（`ctx.voidTeam.notifications`）。 */
export interface LegionNotificationHost {
  notifications?: LegionNotificationStore | undefined;
}

/**
 * 造「军团运行」通知来源。
 *
 * `host` 是个取值函数而不是现成的仓库：插件挂载顺序不保证 `voidTeam` 先就位，
 * 每次读的时候再取一次，才能做到「军团后挂上来自动生效」（L9 第五条）。
 */
export function createRunNotifications(host: () => LegionNotificationHost | undefined): LegionNotificationSource[] {
  const source: LegionNotificationSource = {
    id: RUN_NOTIFICATION_SOURCE_ID,
    title: "军团运行",
    async list(): Promise<LegionNotificationList> {
      const store = host()?.notifications;
      if (store === undefined) {
        return {
          items: [],
          note: "军团这次没有数据根，终态通知没地方落盘（重启后什么都留不下）。本次进程里的运行记录仍然能在军团的任务视图里看到。",
        };
      }
      const records = await store.list();
      return {
        items: records.map(toItem),
        ...(records.length === 0
          ? { note: "还没有跑完的运行。队伍派活结束（完成、失败、取消或宿主重启结算）后，这里会留一条。" }
          : {}),
      };
    },
    async markRead(ids: readonly string[]): Promise<number | void> {
      const store = host()?.notifications;
      if (store === undefined) return;
      return store.markRead(ids);
    },
  };
  return [source];
}

function toItem(record: LegionNotificationRecord): LegionNotificationItem {
  const counts = record.counts;
  const detail = `完成 ${counts.completed}/${counts.total}，失败 ${counts.failed}，未轮到 ${counts.blocked}`;
  const extra: string[] = [];
  if (counts.cancelled > 0) extra.push(`取消 ${counts.cancelled}`);
  if (counts.interrupted > 0) extra.push(`中断 ${counts.interrupted}`);
  return {
    id: record.eventId,
    title: `运行 ${record.runId} ${statusText(record.status)}`,
    summary: [detail, ...extra].join("，"),
    at: record.finishedAt,
    level: statusLevel(record.status),
    meta: {
      队伍: record.teamId,
      运行: record.runId,
      结果: record.resultRef,
    },
    read: record.readAt !== undefined,
  };
}

function statusText(status: LegionNotificationRecord["status"]): string {
  switch (status) {
    case "completed":
      return "已跑完";
    case "failed":
      return "有任务失败";
    case "cancelled":
      return "被取消";
    case "interrupted":
      return "被宿主重启中断";
  }
}

function statusLevel(status: LegionNotificationRecord["status"]): "info" | "warn" | "danger" {
  switch (status) {
    case "completed":
    case "cancelled":
      return "info";
    case "interrupted":
      return "warn";
    case "failed":
      return "danger";
  }
}

/**
 * 插件外壳：把来源注册进入口。
 *
 * 没有 `voidSuite`（或那版入口还不认通知来源）时**安静退出**——军团照常工作，
 * 只是没有面板通知，这和没有面板时的情况一样。
 */
interface NotificationHost {
  registerNotificationSource(source: LegionNotificationSource): () => void;
}

export const name = "void-legion-notifications";
export const inject = ["voidSuite", "voidTeam"];

export function apply(ctx: Context): void {
  ctx.inject(["voidSuite", "voidTeam"], (viewCtx) => {
    const suite = viewCtx.get("voidSuite") as NotificationHost | undefined;
    if (suite === undefined || typeof suite.registerNotificationSource !== "function") return;
    const host = (): LegionNotificationHost | undefined => viewCtx.get("voidTeam") as LegionNotificationHost | undefined;
    for (const source of createRunNotifications(host)) {
      viewCtx.effect(() => suite.registerNotificationSource(source), `void-legion: notification source ${source.id}`);
    }
  });
}
