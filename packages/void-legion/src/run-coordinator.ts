import {
  DEFAULT_MEMBER_LIMIT,
  DEFAULT_TEAM_SCHEDULE,
  teamDocumentOf,
} from "./contracts.js";
import { validateTaskPlan, type TaskPlan } from "./planner.js";
import {
  RunStore,
  createRunRecord,
  nextRunId,
  runConclusion,
  summarizeRun,
  type RunRecord,
  type RunSummary,
} from "./run-store.js";
import { DispatchGate, startSchedule, type ScheduleHandle, type ScheduleWorker } from "./scheduler.js";
import { composeRunRoster } from "./team-repository.js";
import { runFinishedEvent, type LegionNotificationStore, type LegionRunFinished } from "./notifications.js";
import type { DelegationTeamMember, DelegationTeamMetadata } from "./team.js";

/**
 * 一次派活的收口：**冻结配置 → 校验计划 → 落盘 → 交给调度器 → 立刻返回 runId**。
 *
 * 这一层存在的理由（§15.2/§17.2）：
 * - 派活**不能等跑完才返回**——派活方要拿到 runId 才能看进度、叫停、取结果；
 * - 运行配置（名单、上限、模型路由、工作区、调度）在**启动那一刻冻结**，之后改队伍
 *   不影响已经在跑的这一次；
 * - 并发槽位与工作区锁属于**整个服务**，不是某一个 run——所以 `DispatchGate` 在这里
 *   持有并跨 run 传递（§15.3「不同 run 也共享该锁/容量约束」）；
 * - 进度**如实报**：当前任务、已结算/总数、最近活动时间、原生子会话 id，没有假百分比。
 */

/** 派活请求。 */
export interface LegionDispatchRequest {
  teamId: string;
  team: DelegationTeamMetadata;
  /** 本次任务书（团队总目标）。 */
  task?: string;
  /** 手动计划；给了就用它，不给就从名单直接生成逐任务记录。 */
  plan?: TaskPlan;
  /** 本次临时成员：只进这一次的名单，固定名单一个字不动（L14）。 */
  temporaryMembers?: readonly DelegationTeamMember[];
  /** 真实执行体（`createScheduledWorker` 的产物，或测试里的替身）。 */
  worker: ScheduleWorker;
  /** 派活方的取消信号。 */
  signal?: AbortSignal;
  /**
   * 权限快照校验（P4 的权威门禁）。**在派出任何任务之前**跑，抛错就一个都不派。
   */
  authorize?: (roster: readonly DelegationTeamMember[]) => void | Promise<void>;
  /** 本次运行的并发上限；缺省用队伍配置，再缺省用默认 4。 */
  maxConcurrentTasks?: number;
}

/** 进度视图：给工具与面板用，字段都是「已经发生的事实」。 */
export interface LegionRunProgress {
  runId: string;
  teamId: string;
  status: RunRecord["status"];
  schedule: RunRecord["schedule"];
  summary: RunSummary;
  /** 正在跑的任务（laneId + 状态 + 开始时间）。 */
  running: Array<{ laneId: string; agentId?: string; startedAt?: string; childSessionId?: string }>;
  /** 还没轮到的任务。 */
  pending: Array<{ laneId: string; agentId?: string; blockedBy?: string }>;
  /** 最近一次活动时间（记录更新时间，不是编出来的）。 */
  lastActivityAt: string;
  /** 本次 run 里出现过的原生子会话 id，供宿主跳转。 */
  childSessionIds: string[];
  /** 终态时的一句话结论。 */
  conclusion: string;
  /** 事件流（谁在什么时候干了什么）。 */
  events: RunRecord["events"];
}

export interface RunCoordinatorOptions {
  /** 运行记录仓库。没配数据根时不给：记录只活在内存里，**不假装存下来了**。 */
  store?: RunStore | undefined;
  /**
   * 终态通知仓库（§16.2 L9）。没配数据根时不给：通知也只在内存里，**不假装发出去了**。
   * 有它的时候，每次终态落盘后补记一条待投递事件——面板断线时跑完的那一次，重连能补读。
   */
  notifications?: LegionNotificationStore | undefined;
  /**
   * 终态事件的订阅者（P6g）。**只在真的新记了一条通知**时回调一次，用于把终态交给 control
   * 的 webhook 投递适配。没装 control 时不给：事件只是没人听，军团照常工作。
   *
   * 约定：必须立刻返回、不得抛异常（投递是后台的事，不许拖住刚跑完的那次运行）。
   */
  onTerminal?: ((event: LegionRunFinished) => void) | undefined;
  gate?: DispatchGate;
  now?: (() => Date) | undefined;
}

/** 派活时运行不在本进程里的错误（宿主重启过）。 */
export class LegionRunInactiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegionRunInactiveError";
  }
}

export class RunCoordinator {
  private readonly store: RunStore | undefined;
  private readonly notifications: LegionNotificationStore | undefined;
  private readonly onTerminal: ((event: LegionRunFinished) => void) | undefined;
  private readonly gate: DispatchGate;
  private readonly now: () => Date;
  private readonly active = new Map<string, ScheduleHandle>();
  /** 没有数据根时的运行记录（只在内存里，进程一退就没了——这一点如实告知）。 */
  private readonly memory = new Map<string, RunRecord>();

  constructor(options: RunCoordinatorOptions) {
    this.store = options.store;
    this.notifications = options.notifications;
    this.onTerminal = options.onTerminal;
    this.gate = options.gate ?? new DispatchGate({});
    this.now = options.now ?? (() => new Date());
  }

  /** 运行记录是否会落盘。false 表示只活在内存里。 */
  get persistent(): boolean {
    return this.store !== undefined;
  }

  /** 终态通知会不会落盘。 */
  get notifying(): boolean {
    return this.notifications !== undefined;
  }

  get notificationStore(): LegionNotificationStore | undefined {
    return this.notifications;
  }

  get runStore(): RunStore | undefined {
    return this.store;
  }

  get dispatchGate(): DispatchGate {
    return this.gate;
  }

  /** 改并发上限（L13）。只影响之后获取槽位的任务，不强杀在跑的（§15.3）。 */
  setCapacity(value: number): void {
    this.gate.setCapacity(value);
  }

  /** 本进程里还在跑的 run。 */
  activeRunIds(): string[] {
    return [...this.active.keys()];
  }

  /**
   * 派活。**立刻返回**已落盘的运行记录（含 runId），执行在后台继续。
   */
  async dispatch(request: LegionDispatchRequest): Promise<RunRecord> {
    const teamId = request.teamId;
    const schedule = request.team.schedule ?? DEFAULT_TEAM_SCHEDULE;
    const memberLimit = request.team.memberLimit ?? DEFAULT_MEMBER_LIMIT;
    const temporaryMembers = request.temporaryMembers ?? [];

    // 名单先定下来：手动计划走计划的校验，否则走名单校验。两条路都不允许
    // 「未知成员/成环/超人数」混进来。
    //
    // 手动计划那条路要把队伍的固定名单一起给它：计划负责「这一步干什么」，队伍负责
    // 「谁来做」。少了它，模型照提示只写 laneId/title 就会派出一批没有档案 id 的人，
    // 权限检查直接拒（2026-09-23 真机派活撞到过 `派活目标缺少档案 id: lane_front`）。
    const roster =
      request.plan === undefined
        ? composeRunRoster(teamDocumentOf(request.team), temporaryMembers)
        : validateTaskPlan({
            plan: request.plan,
            schedule,
            memberLimit,
            temporaryMembers,
            fixedRoster: teamDocumentOf(request.team).members,
          }).roster;

    // 权限快照：一个任务都不派之前先过门禁。
    if (request.authorize !== undefined) await request.authorize(roster);

    const at = this.now();
    const runId = await this.allocateRunId(teamId, at);
    const record = createRunRecord({
      runId,
      teamId,
      task: request.task,
      schedule,
      roster,
      memberLimit,
      maxConcurrentTasks: request.maxConcurrentTasks ?? request.team.maxConcurrentTasks,
      at,
    });
    await this.save(record);

    const handle = startSchedule({
      record,
      worker: request.worker,
      gate: this.gate,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      now: this.now,
      // 子代理一起来就把原生子会话 id 记进运行记录（§15.2「原生 child session 链接」）。
      onLaneStart: () => {
        void this.saveDuringRun(record);
      },
      // 每次落定都落盘：进程没了，磁盘上至少能看到跑到哪一步（§15.2 重启结算）。
      onUpdate: async (updated) => {
        await this.saveDuringRun(updated);
      },
    });
    this.active.set(runId, handle);
    void handle.done
      .catch(() => undefined)
      .finally(() => {
        this.active.delete(runId);
      });

    return record;
  }

  /** 落盘（有数据根）或留内存（没有）。两条路都留最新那份。 */
  private async save(record: RunRecord): Promise<void> {
    this.memory.set(record.runId, record);
    if (this.store !== undefined) await this.store.save(record);
  }

  /**
   * 跑起来之后的每次落盘。
   *
   * 和 `save` 的区别：**这里落盘失败不能往外抛**。派活已经返回了，抛出去就是没人接的
   * rejection，会连累宿主；而磁盘写不进去这件事本身必须留痕。所以照实记一条事件，
   * 内存里那份仍然是最新的——派活方看进度时能看到「运行记录落盘失败」。
   */
  private async saveDuringRun(record: RunRecord): Promise<void> {
    this.memory.set(record.runId, record);
    const stored = await this.persistDuringRun(record);
    if (stored) await this.notifyTerminal(record);
  }

  /**
   * 跑起来之后的那次落盘，回「记录是否真的在盘上」。
   *
   * 磁盘写不进去时**不能往外抛**（派活早返回了，抛出去就是没人接的 rejection），
   * 但也**不能说存下来了**——照实记一条 `run_persist_failed`，返回值如实回 false。
   */
  private async persistDuringRun(record: RunRecord): Promise<boolean> {
    if (this.store === undefined) return false;
    try {
      await this.store.save(record);
      return true;
    } catch (error) {
      record.events.push({
        at: record.updatedAt,
        kind: "run_persist_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * 终态补记一条待投递事件（§16.2 L9 第二条）。
   *
   * 挂在这里的理由：调度循环跑完最后一件事就是 `finishRun(); await publish();`，而
   * `publish` 正是走 `onUpdate` → 这里——**正常完成与中途取消两条路都会经过**。
   *
   * 两条自我约束：① 只在运行记录**确实落盘之后**才记通知——通知里的 `resultRef` 指向那份
   * 记录，记录不在盘上还发通知就是骗人；② 通知出问题**不能改运行结果、不能重跑成员任务**，
   * 也不能往外抛，只在运行记录里留一条 `run_notify_failed`。重复观察同一终态由 eventId 幂等兜住。
   */
  private async notifyTerminal(record: RunRecord): Promise<void> {
    if (this.notifications === undefined) return;
    const event = runFinishedEvent(record);
    if (event === undefined) return;
    let recorded = false;
    try {
      recorded = (await this.notifications.record(event)).recorded;
    } catch (error) {
      this.noteNotifyFailure(record, error);
      return;
    }
    // 只在真新记一条时发事件：重复观察同一终态不发第二条，否则「重试」会变成刷屏。
    if (!recorded) return;
    try {
      this.onTerminal?.(event);
    } catch (error) {
      // 订阅者出错同样只留痕：投递出问题不许改运行结果，也不许重跑成员任务（L9 第二条）。
      this.noteNotifyFailure(record, error);
    }
  }

  private noteNotifyFailure(record: RunRecord, error: unknown): void {
    record.events.push({
      at: record.updatedAt,
      kind: "run_notify_failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  /** 同一秒内的两次派活不能撞名，也不能覆盖同队的上一次运行。 */
  private async allocateRunId(teamId: string, at: Date): Promise<string> {
    for (let sequence = 1; sequence <= 999; sequence += 1) {
      const candidate = nextRunId(teamId, at, sequence);
      if (this.active.has(candidate) || this.memory.has(candidate)) continue;
      if (this.store === undefined || (await this.store.load(candidate)) === undefined) return candidate;
    }
    throw new LegionRunInactiveError(`同一秒内同一支队伍派活次数过多，拒绝生成运行 id: ${teamId}`);
  }

  /** 取运行记录：本进程在跑的就给内存里那份（最新），否则读盘。 */
  async require(runId: string): Promise<RunRecord> {
    const handle = this.active.get(runId);
    if (handle !== undefined) return handle.record;
    const inMemory = this.memory.get(runId);
    if (inMemory !== undefined) return inMemory;
    if (this.store === undefined) throw new LegionRunInactiveError(`运行记录不存在: ${runId}`);
    return this.store.require(runId);
  }

  /**
   * 等一次运行落定。
   *
   * 不在本进程里跑的（宿主重启过、或已经结束）直接给磁盘上那份——已经终态就是答案，
   * 还是 `running` 就说明它不在这个进程里跑，也如实返回，**不假装等到了结果**。
   */
  async waitFor(runId: string): Promise<RunRecord> {
    const handle = this.active.get(runId);
    if (handle !== undefined) return handle.done;
    return this.require(runId);
  }

  async progress(runId: string): Promise<LegionRunProgress> {
    const record = await this.require(runId);
    const childSessionIds = record.tasks
      .map((task) => task.childSessionId)
      .filter((value): value is string => value !== undefined);
    return {
      runId: record.runId,
      teamId: record.teamId,
      status: record.status,
      schedule: record.schedule,
      summary: summarizeRun(record),
      running: record.tasks
        .filter((task) => task.status === "running")
        .map((task) => ({
          laneId: task.laneId,
          ...(task.agentId === undefined ? {} : { agentId: task.agentId }),
          ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
          ...(task.childSessionId === undefined ? {} : { childSessionId: task.childSessionId }),
        })),
      pending: record.tasks
        .filter((task) => task.status === "pending" || task.status === "blocked")
        .map((task) => ({
          laneId: task.laneId,
          ...(task.agentId === undefined ? {} : { agentId: task.agentId }),
          ...(task.blockedBy === undefined ? {} : { blockedBy: task.blockedBy }),
        })),
      lastActivityAt: record.updatedAt,
      childSessionIds,
      conclusion: describeConclusion(record),
      events: record.events,
    };
  }

  async list(): Promise<RunRecord[]> {
    const persisted = this.store === undefined ? [] : await this.store.list();
    return mergeRuns(persisted, [...this.memory.values()]);
  }

  async listByTeam(teamId: string): Promise<RunRecord[]> {
    const persisted = this.store === undefined ? [] : await this.store.listByTeam(teamId);
    return mergeRuns(
      persisted,
      [...this.memory.values()].filter((record) => record.teamId === teamId),
    ).reverse();
  }

  /** 取消一个成员。**没轮到的直接不派**；在跑的走它自己的取消通道。 */
  async cancelLane(runId: string, laneId: string, reason?: string): Promise<RunRecord> {
    const handle = this.requireActive(runId);
    handle.cancelLane(laneId, reason);
    return handle.record;
  }

  /** 全队取消。 */
  async cancelRun(runId: string, reason?: string): Promise<RunRecord> {
    const handle = this.requireActive(runId);
    handle.cancelRun(reason);
    return handle.record;
  }

  private requireActive(runId: string): ScheduleHandle {
    const handle = this.active.get(runId);
    if (handle !== undefined) return handle;
    throw new LegionRunInactiveError(
      `这次运行不在本进程里跑（宿主重启过，或已经结束），无法取消: ${runId}`,
    );
  }

  /**
   * 重启结算：把上一轮没跑完的 run 与任务标成 `interrupted`。
   *
   * 只结算磁盘上还是 `running` 的；已经终态的一个字都不动。没有数据根时无从结算，
   * 返回空数组——因为**根本没有记录留下来**，不是「结算过了」。
   *
   * 结算出来的 `interrupted` 也是终态（A13 明确要求覆盖「重启」），所以同样补记通知：
   * 否则宿主重启过的那一次运行，面板上永远不会出现「它没跑完」。
   */
  async settleInterrupted(): Promise<RunRecord[]> {
    if (this.store === undefined) return [];
    const settled = await this.store.settleInterrupted();
    for (const record of settled) await this.notifyTerminal(record);
    return settled;
  }
}

/** 合并磁盘与内存里的运行记录（内存那份更新），按 runId 升序＝发生顺序。 */
function mergeRuns(persisted: readonly RunRecord[], inMemory: readonly RunRecord[]): RunRecord[] {
  const merged = new Map<string, RunRecord>();
  for (const record of persisted) merged.set(record.runId, record);
  for (const record of inMemory) merged.set(record.runId, record);
  return [...merged.values()].sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
}

/** 一句话结论，不编百分比。 */
function describeConclusion(record: RunRecord): string {
  const status = runConclusion(record);
  const summary = summarizeRun(record);
  if (status === "running") {
    return `还在跑：已结算 ${summary.completed + summary.failed + summary.blocked + summary.cancelled}/${summary.total}，在跑 ${summary.running}，还没轮到 ${summary.pending}`;
  }
  if (status === "completed") return `全部干完：${summary.completed}/${summary.total}`;
  if (status === "interrupted") return `宿主重启，这次没跑完（已结算 ${summary.completed}/${summary.total}），没有自动重跑`;
  if (status === "cancelled") return `已取消（已结算 ${summary.completed}/${summary.total}）`;
  return `有任务没干成：成功 ${summary.completed}，失败 ${summary.failed}，被阻塞 ${summary.blocked}，取消 ${summary.cancelled}`;
}
