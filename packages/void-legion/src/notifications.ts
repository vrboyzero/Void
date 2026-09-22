/**
 * 运行终态的持久通知（§16.2 L9 的前半段：军团负责「在终态持久化时记录待投递事件」）。
 *
 * 为什么落盘而不是只发一次事件：浏览器可能根本没开着。面板断线、或者压根没打开时跑完的
 * 那一次，重新连上必须还能看到「哪支队伍在什么时候跑完、成没成」——所以终态一落定就写进
 * `<数据根>/legion/notifications.json`，面板重连后按未读补读（A13「持久通知可补读」）。
 *
 * 三条硬规矩，都是 L9 点名的：
 * 1. **一次终态只产生一个事件**：`eventId = <runId>#<序号>`。同一个 runId 的终态被重复
 *    观察到（重试投递、面板重读、进程重启后重新结算）也只留一条——重试不能变成第二条通知。
 * 2. **通知失败不影响运行结果**：记录或落盘出问题只在运行记录里留一条 `run_notify_failed`
 *    事件，绝不改 run 状态、也绝不重跑成员任务。
 * 3. **只放状态与受控结果链接**：这里存的是状态、逐任务计数和运行记录的**相对路径**，
 *    不含成员产出正文、SOUL 正文或会话内容（L9 第五条）。
 *
 * @module @void/void-legion/notifications
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./atomic-file.js";
import { isTerminalRunStatus, type RunRecord, type RunStatus } from "./run-store.js";

/**
 * 终态事件名（P6g）。control 的投递适配订阅它，把终态投给 webhook。
 *
 * 只在**真的新记了一条通知**时才发：同一终态被重复观察（重试、重启后重新结算）不发第二条，
 * 否则「重试」会变成刷屏。没装 control 时只是没人听，军团照常工作。
 */
export const LEGION_RUN_TERMINAL_EVENT = "legion/run-terminal";

declare module "@deepseek-ai/cordis" {
  interface Events {
    /** 一次运行进入终态的持久事件（与 {@link LegionRunFinished} 同形）。 */
    "legion/run-terminal"(event: LegionRunFinished): void;
  }
}

/** 本版本能读写的通知文件版本。 */
export const LEGION_NOTIFICATION_VERSION = 1;

/** 通知文件名（在 `<数据根>/legion/` 下）。 */
export const LEGION_NOTIFICATION_FILE = "notifications.json";

/**
 * 最多留多少条。终态通知是给人看的补读材料，不是审计日志：留太多只会让面板难读，
 * 而完整结果始终在运行记录里。超了先丢最老的**已读**条目，再丢最老的未读条目。
 */
export const LEGION_NOTIFICATION_LIMIT = 200;

export class LegionNotificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegionNotificationError";
  }
}

/** 通知里允许出现的运行状态：终态集合（`running` 不是结果，不进通知）。 */
export type LegionNotificationStatus = Exclude<RunStatus, "running">;

/** 逐任务计数。`blocked`（没轮到）与 `failed`（自己挂了）分开记，答得上「是它不行还是没轮到它」。 */
export interface LegionNotificationCounts {
  total: number;
  completed: number;
  failed: number;
  blocked: number;
  cancelled: number;
  interrupted: number;
}

/**
 * 一次运行终态的事件（L9 第一条的 `LegionRunFinished`）。
 *
 * `resultRef` 是**相对数据根**的路径，不是绝对路径：通知会走出这个进程（面板、以后的
 * webhook），不该顺手把本机目录结构带上。
 */
export interface LegionRunFinished {
  eventId: string;
  runId: string;
  teamId: string;
  status: LegionNotificationStatus;
  finishedAt: string;
  counts: LegionNotificationCounts;
  resultRef: string;
}

/** 落盘的那一条：事件本身 + 本地状态（读没读过、投递到哪一步了）。 */
export interface LegionNotificationRecord extends LegionRunFinished {
  recordedAt: string;
  /** 人已经在面板里看过了。没读过的不删，这正是「断线补读」要的东西。 */
  readAt?: string;
  /**
   * 网络投递记录（P6g 的 control 适配用）。
   *
   * 本地按 eventId 去重，网络只能按「至少一次」交付：送达成功但回写前崩溃仍可能重发，
   * 所以接收端必须按 eventId 幂等——这里如实记次数与最后一次错误，不宣称恰好一次。
   */
  delivery?: LegionDeliveryState;
}

/** 网络投递记录：控制面回写的就是这一份。 */
export interface LegionDeliveryState {
  /** 累计尝试次数。跨进程接着数：重启后不从头开始，免得「试了 5 次」看起来像只试过 1 次。 */
  attempts: number;
  /** 接收端已接收的时刻。本地靠它跳过重投；这也是重启后不重发的依据。 */
  deliveredAt?: string;
  /** 最后一次失败的原因（HTTP 状态或传输错误名），成功时保留上一次的值便于排查。 */
  lastError?: string;
}

/** 事件 id：一次已提交终态的 runId + 序号。序号留给「同一 run 的后续事件」，当前恒为 1。 */
export function notificationEventId(runId: string, sequence: number): string {
  return `${runId}#${sequence}`;
}

/**
 * 运行记录 → 事件。**非终态回 `undefined`**：还在跑不是结果，不编事件出来。
 *
 * 时间取 `endedAt`（终态那一刻），没有就退回 `updatedAt`——重启结算的旧记录可能缺前者。
 */
export function runFinishedEvent(record: RunRecord): LegionRunFinished | undefined {
  if (!isTerminalRunStatus(record.status)) return undefined;
  return {
    eventId: notificationEventId(record.runId, 1),
    runId: record.runId,
    teamId: record.teamId,
    status: record.status as LegionNotificationStatus,
    finishedAt: record.endedAt ?? record.updatedAt,
    counts: countTasks(record),
    resultRef: `legion/runs/${record.runId}.json`,
  };
}

function countTasks(record: RunRecord): LegionNotificationCounts {
  const count = (status: RunRecord["tasks"][number]["status"]): number =>
    record.tasks.filter((task) => task.status === status).length;
  return {
    total: record.tasks.length,
    completed: count("completed"),
    failed: count("failed"),
    blocked: count("blocked"),
    cancelled: count("cancelled"),
    interrupted: count("interrupted"),
  };
}

export interface LegionNotificationStoreOptions {
  /** 军团数据根（绝对路径）：通知写在它下面的 `legion/` 里，和队伍、运行记录同一层。 */
  dataDir: string;
  now?: (() => Date) | undefined;
  limit?: number | undefined;
}

/**
 * 通知仓库。一个实例对应一个数据根；重启后新建实例就能读回全部未读通知。
 *
 * 读坏了**照实报错**，不返回空列表：把「文件坏了」显示成「没有通知」，等于让人以为
 * 那次运行没发生过。
 */
export class LegionNotificationStore {
  private readonly dataDir: string;
  private readonly now: () => Date;
  private readonly limit: number;
  /**
   * 进程内串行化。
   *
   * 三个写方法都是「读整份 → 改 → 写整份」，两个 run 同时终态时并发跑就会互相覆盖：
   * 后写的把先写的那条通知整条抹掉。跨进程竞态照实存在（同一数据根被两个进程同时写），
   * 这里只保证本进程内不丢。
   */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: LegionNotificationStoreOptions) {
    if (!path.isAbsolute(options.dataDir)) {
      throw new LegionNotificationError("军团通知数据根必须是绝对路径");
    }
    this.dataDir = path.resolve(options.dataDir);
    this.now = options.now ?? (() => new Date());
    this.limit = options.limit ?? LEGION_NOTIFICATION_LIMIT;
  }

  get path(): string {
    return path.join(this.dataDir, "legion", LEGION_NOTIFICATION_FILE);
  }

  /** 全部通知，**最新在前**（面板直接按这个顺序画）。 */
  async list(): Promise<LegionNotificationRecord[]> {
    return (await this.read()).reverse();
  }

  /** 还没读过的，最新在前。 */
  async unread(): Promise<LegionNotificationRecord[]> {
    return (await this.list()).filter((record) => record.readAt === undefined);
  }

  /**
   * 记一条终态事件。
   *
   * 已经有同 `eventId` 的就**一个字都不动**，返回 `recorded: false` 和原来那条——重复观察
   * 同一终态（重试、重启后重新结算、面板重读）必须幂等，否则「重试」会变成刷屏。
   */
  async record(event: LegionRunFinished): Promise<{ recorded: boolean; record: LegionNotificationRecord }> {
    return await this.enqueue(async () => {
      const records = await this.read();
      const existing = records.find((item) => item.eventId === event.eventId);
      if (existing !== undefined) return { recorded: false, record: existing };
      const record: LegionNotificationRecord = { ...event, recordedAt: this.now().toISOString() };
      records.push(record);
      await this.write(prune(records, this.limit));
      return { recorded: true, record };
    });
  }

  /** 标记已读，返回这次真正标记了几条（已经读过的不算）。 */
  async markRead(eventIds: readonly string[]): Promise<number> {
    if (eventIds.length === 0) return 0;
    return await this.enqueue(async () => {
      const wanted = new Set(eventIds);
      const records = await this.read();
      const at = this.now().toISOString();
      let marked = 0;
      for (const record of records) {
        if (!wanted.has(record.eventId) || record.readAt !== undefined) continue;
        record.readAt = at;
        marked += 1;
      }
      if (marked > 0) await this.write(records);
      return marked;
    });
  }

  /**
   * 回写一条通知的网络投递记录（P6g）。
   *
   * 整份替换 `delivery`，不做字段级合并：控制面每次给的都是完整状态。
   *
   * @returns 事件是否还在文件里；被裁掉的老条目没有可写的地方，回 `false`。
   */
  async markDelivery(eventId: string, patch: LegionDeliveryState): Promise<boolean> {
    return await this.enqueue(async () => {
      const records = await this.read();
      const target = records.find((item) => item.eventId === eventId);
      if (target === undefined) return false;
      target.delivery = { ...patch };
      await this.write(records);
      return true;
    });
  }

  /** 把一次读-改-写排进队列；前一次失败也不能卡住后面的。 */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<LegionNotificationRecord[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new LegionNotificationError(
        `军团通知文件损坏: ${this.path}（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
    if (typeof raw !== "object" || raw === null) {
      throw new LegionNotificationError(`军团通知文件损坏: ${this.path}（顶层不是对象）`);
    }
    const value = raw as Record<string, unknown>;
    if (value.version !== LEGION_NOTIFICATION_VERSION) {
      throw new LegionNotificationError(
        `不支持的军团通知版本: ${String(value.version)}（本版本只认 ${LEGION_NOTIFICATION_VERSION}）`,
      );
    }
    if (!Array.isArray(value.events)) {
      throw new LegionNotificationError(`军团通知文件损坏: ${this.path}（缺少 events）`);
    }
    return value.events.map((item, index) => parseNotification(item, this.path, index));
  }

  private async write(records: readonly LegionNotificationRecord[]): Promise<void> {
    const document = { version: LEGION_NOTIFICATION_VERSION, events: records };
    await writeFileAtomic(this.path, `${JSON.stringify(document, null, 2)}\n`);
  }
}

function parseNotification(raw: unknown, source: string, index: number): LegionNotificationRecord {
  if (typeof raw !== "object" || raw === null) {
    throw new LegionNotificationError(`军团通知文件损坏: ${source}（第 ${index + 1} 条不是对象）`);
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.eventId !== "string" || typeof value.runId !== "string" || typeof value.status !== "string") {
    throw new LegionNotificationError(`军团通知文件损坏: ${source}（第 ${index + 1} 条缺少 eventId / runId / status）`);
  }
  return value as unknown as LegionNotificationRecord;
}

/**
 * 截断到上限：先丢最老的已读，再丢最老的未读。
 *
 * 顺序按文件里的先后（＝记录顺序），不按时间字符串排序——同一秒内跑完两次时，
 * 排序会让「哪条更老」变得不确定。
 */
function prune(records: readonly LegionNotificationRecord[], limit: number): LegionNotificationRecord[] {
  if (records.length <= limit) return [...records];
  const kept: LegionNotificationRecord[] = [];
  let overflow = records.length - limit;
  for (const record of records) {
    if (overflow > 0 && record.readAt !== undefined) {
      overflow -= 1;
      continue;
    }
    kept.push(record);
  }
  return kept.length <= limit ? kept : kept.slice(kept.length - limit);
}
