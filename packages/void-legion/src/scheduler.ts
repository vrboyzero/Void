/**
 * 调度器：把一次 run 的任务按三种调度语义派出去，管住并发、工作区写锁与取消。
 *
 * 三种语义（§15.3）：
 * - `parallel`：依赖满足就派，受并发上限约束；
 * - `sequential`：任何时刻只跑一个，按拓扑顺序；
 * - `staged`：按阶段号分批，上一阶段全部落定才开始下一阶段。
 *
 * 两条不在这个文件里让步的规矩：
 *
 * 1. **工作区写锁是默认行为**（§15.3）：不声明 `writes: false` 的任务当写任务，
 *    同一工作区的写任务串行。并发的代价是慢，并发写错的代价是改坏别人的文件。
 * 2. **取消不是「假装停下来了」**（§15.2）：取消后不再派发新任务；已经在跑的任务
 *    被 abort，但调度器**等它真的落定**才把 run 结掉。底层停不下来时，任务按
 *    `cancelled` 记账并留下诊断，绝不写成 `completed`。
 *
 * 并发槽位和工作区锁由调用方传入的 {@link DispatchGate} 持有，所以**不同 run 之间
 * 也共享这两个约束**（§15.3 最后一句）。
 *
 * @module @void/void-legion/scheduler
 */
import { assertMaxConcurrentTasks, DEFAULT_MAX_CONCURRENT_TASKS } from "./contracts.js";
import { laneOrder } from "./plan-validator.js";
import {
  isTerminalTaskStatus,
  normalizeRunOutput,
  type RunEventKind,
  type RunRecord,
  type RunTaskRecord,
} from "./run-store.js";
import type { DelegationTeamMember, TeamSchedule } from "./team.js";

/** 取消引起的失败。调度器把它和「worker 自己跑挂了」分开记。 */
export class ScheduleCancelledError extends Error {
  constructor(message = "调度已取消") {
    super(message);
    this.name = "ScheduleCancelledError";
  }
}

/** 派给 worker 的一次任务。 */
export interface TaskRunContext {
  runId: string;
  teamId: string;
  laneId: string;
  task: string;
  member: DelegationTeamMember;
  /** 上游（dependsOn）任务的产出，按 laneId 键。 */
  upstream: Record<string, unknown>;
  /** 逐任务模型路由；空着表示跟随调用方默认路由。 */
  modelRef?: string;
  workspace: string;
  writesWorkspace: boolean;
  /** 本次任务的取消信号。worker 应当把它转给底层执行体。 */
  signal: AbortSignal;
  /**
   * 把底层真实子会话的 id 报给宿主（§15.2「原生 child session 链接」）。
   * 有了它，界面才能从运行记录跳回真正干活的会话；没有它，记录就只是个自说自话的账本。
   */
  reportChildSession?: (childSessionId: string) => void;
}

export type ScheduleWorker = (context: TaskRunContext) => Promise<unknown>;

export interface DispatchGateOptions {
  maxConcurrentTasks?: number | undefined;
}

interface SlotWaiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  detach: () => void;
}

interface LockWaiter extends SlotWaiter {
  runId: string;
  laneId: string;
}

interface WorkspaceLock {
  holder: string | undefined;
  queue: LockWaiter[];
}

/**
 * 全服务共享的并发槽位 + 工作区写锁。
 *
 * 放在 service 上而不是每次 run 新建，是因为 §15.3 要求**不同 run 也共享**这两个
 * 约束：两次派活各开四个请求，加起来还是把 provider 打满。
 */
export class DispatchGate {
  private capacityValue: number;
  private active = 0;
  private readonly slotQueue: SlotWaiter[] = [];
  private readonly locks = new Map<string, WorkspaceLock>();
  private readonly availableListeners = new Set<() => void>();

  constructor(options: DispatchGateOptions = {}) {
    this.capacityValue = assertMaxConcurrentTasks(options.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS);
  }

  /**
   * 订阅「槽位或锁空出来了」。
   *
   * 跨 run 共享容量时必须能订阅：一个 run 的任务全在排队等另一个 run 占着的槽位
   * 时，它自己没有任务会落定，等自己的落定通知就是死等。
   */
  onAvailable(listener: () => void): () => void {
    this.availableListeners.add(listener);
    return () => {
      this.availableListeners.delete(listener);
    };
  }

  private notifyAvailable(): void {
    for (const listener of [...this.availableListeners]) listener();
  }

  get capacity(): number {
    return this.capacityValue;
  }

  get activeCount(): number {
    return this.active;
  }

  get waitingCount(): number {
    return this.slotQueue.length;
  }

  /**
   * 改并发上限。**只影响之后的获取**：正在跑的任务不会被强杀（§15.2
   * 「降低限制不强杀正在运行的成员」）。
   */
  setCapacity(value: number): void {
    this.capacityValue = assertMaxConcurrentTasks(value);
    this.pump();
  }

  /** 当前被占用的工作区。 */
  busyWorkspaces(): string[] {
    return [...this.locks.entries()].filter(([, lock]) => lock.holder !== undefined).map(([key]) => key);
  }

  async acquireSlot(signal?: AbortSignal | undefined): Promise<() => void> {
    if (signal?.aborted === true) throw new ScheduleCancelledError();
    if (this.active < this.capacityValue) {
      this.active += 1;
      return () => this.releaseSlot();
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: SlotWaiter = { resolve, reject, detach: () => {} };
      if (signal !== undefined) {
        const onAbort = (): void => {
          const index = this.slotQueue.indexOf(waiter);
          if (index >= 0) this.slotQueue.splice(index, 1);
          reject(new ScheduleCancelledError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.detach = () => signal.removeEventListener("abort", onAbort);
      }
      this.slotQueue.push(waiter);
    });
  }

  /**
   * 拿一个工作区的写锁。同一个键的写任务串行，先来先得。
   * 只读任务（`writes: false`）根本不调用它。
   */
  async acquireWorkspace(key: string, runId: string, laneId: string, signal?: AbortSignal | undefined): Promise<() => void> {
    if (signal?.aborted === true) throw new ScheduleCancelledError();
    let lock = this.locks.get(key);
    if (lock === undefined) {
      lock = { holder: undefined, queue: [] };
      this.locks.set(key, lock);
    }
    if (lock.holder === undefined) {
      lock.holder = `${runId}/${laneId}`;
      return () => this.releaseWorkspace(key);
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: LockWaiter = { resolve, reject, runId, laneId, detach: () => {} };
      if (signal !== undefined) {
        const onAbort = (): void => {
          const index = lock.queue.indexOf(waiter);
          if (index >= 0) lock.queue.splice(index, 1);
          reject(new ScheduleCancelledError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.detach = () => signal.removeEventListener("abort", onAbort);
      }
      lock.queue.push(waiter);
    });
  }

  private releaseSlot(): void {
    this.active -= 1;
    this.pump();
    this.notifyAvailable();
  }

  private releaseWorkspace(key: string): void {
    const lock = this.locks.get(key);
    if (lock === undefined) return;
    const next = lock.queue.shift();
    if (next === undefined) {
      lock.holder = undefined;
    } else {
      next.detach();
      lock.holder = `${next.runId}/${next.laneId}`;
      next.resolve(() => this.releaseWorkspace(key));
    }
    this.notifyAvailable();
  }

  private pump(): void {
    while (this.active < this.capacityValue) {
      const next = this.slotQueue.shift();
      if (next === undefined) return;
      next.detach();
      this.active += 1;
      next.resolve(() => this.releaseSlot());
    }
  }
}
export interface ScheduleOptions {
  record: RunRecord;
  worker: ScheduleWorker;
  gate: DispatchGate;
  /** 整队取消。 */
  signal?: AbortSignal | undefined;
  /** 每次状态变化后的回调（用来落盘 / 推给界面）。 */
  onUpdate?: ((record: RunRecord) => void | Promise<void>) | undefined;
  /** 子代理真正起来之后回调，交出原生子会话 id（§15.2「原生 child session 链接」）。 */
  onLaneStart?: ((info: { laneId: string; childSessionId: string }) => void) | undefined;
  now?: (() => Date) | undefined;
}

export interface ScheduleHandle {
  runId: string;
  /** 实时记录：读到的就是当前进度。 */
  readonly record: RunRecord;
  /** 全部任务落定、run 结掉之后才 resolve。 */
  readonly done: Promise<RunRecord>;
  /** 取消单个成员：不再派发它；正在跑的就地 abort。 */
  cancelLane(laneId: string, reason?: string): void;
  /** 取消全队：不再派发任何新任务。 */
  cancelRun(reason?: string): void;
}

export const DEFAULT_WORKSPACE = "default";

/** 任务是不是写任务。**不声明就当写**，理由见模块头。 */
export function writesWorkspace(member: DelegationTeamMember): boolean {
  return member.writes !== false;
}

export function workspaceOf(member: DelegationTeamMember): string {
  const workspace = member.workspace?.trim();
  return workspace === undefined || workspace.length === 0 ? DEFAULT_WORKSPACE : workspace;
}

/**
 * 开始调度。**立刻返回**，runId 与进度就在 handle 上，`done` 才是结束。
 *
 * 旧实现的 `launch` 是同步跑完才返回的：派活方拿不到 runId，中途没法叫停，也
 * 看不到「现在跑到哪」。
 */
export function startSchedule(options: ScheduleOptions): ScheduleHandle {
  const { record, worker, gate } = options;
  const now = options.now ?? (() => new Date());
  const tasks = new Map(record.tasks.map((task) => [task.laneId, task]));
  const members = new Map(record.frozenRoster.map((member) => [member.laneId, member]));
  const order = laneOrder(record.frozenRoster, { strict: false });
  const outputs = new Map<string, unknown>();
  const cancelledLanes = new Set<string>();
  const controllers = new Map<string, AbortController>();
  // 已经派出去的任务。它拿到槽位之前 status 还是 `pending`，所以不能只靠 status
  // 判断「派过没有」，否则同一轮循环会把它派第二次。
  const dispatched = new Set<string>();
  let runCancelled = false;
  let cancelReason: string | undefined;

  const stageOf = (task: RunTaskRecord): number => task.stage ?? 1;

  // 变化通知：调度循环靠它醒过来，不用轮询、不用定时器。两种来源——本 run 的
  // 任务落定，以及共享闸门空出槽位/锁（那可能来自另一个 run）。
  let wake: (() => void) | undefined;

  const stamp = (): string => now().toISOString();

  const emit = (kind: RunEventKind, laneId?: string, detail?: string): void => {
    record.events.push({
      at: stamp(),
      kind,
      ...(laneId === undefined ? {} : { laneId }),
      ...(detail === undefined ? {} : { detail }),
    });
  };

  const publish = async (): Promise<void> => {
    record.updatedAt = stamp();
    if (options.onUpdate !== undefined) await options.onUpdate(record);
  };

  const wakeUp = (): void => {
    const resume = wake;
    wake = undefined;
    resume?.();
  };

  const waitForChange = (): Promise<void> =>
    new Promise<void>((resolve) => {
      wake = resolve;
    });

  /** 上游没干成的任务：标 `blocked`，记清是谁拖的，不派发、不重试。 */
  const markBlocked = (): void => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of record.tasks) {
        if (task.status !== "pending") continue;
        const blocker = task.dependsOn.find((dep) => {
          const upstream = tasks.get(dep);
          return upstream !== undefined && isTerminalTaskStatus(upstream.status) && upstream.status !== "completed";
        });
        if (blocker === undefined) continue;
        task.status = "blocked";
        task.blockedBy = blocker;
        task.endedAt = stamp();
        task.error = `上游任务 ${blocker} 没干成，本任务不派发`;
        emit("task_blocked", task.laneId, `被 ${blocker} 阻塞`);
        changed = true;
      }
    }
  };

  /** 分阶段调度：上一阶段有人没干成，本阶段整体不派发。 */
  const blockedStages = new Set<number>();

  const refreshBlockedStages = (): void => {
    if (record.schedule !== "staged") return;
    const stages = [...new Set(record.tasks.map(stageOf))].sort((a, b) => a - b);
    for (const stage of stages) {
      if (blockedStages.has(stage)) continue;
      const inStage = record.tasks.filter((task) => stageOf(task) === stage);
      const failed = inStage.find(
        (task) =>
          task.status === "failed" || task.status === "blocked" || task.status === "cancelled" || task.status === "interrupted",
      );
      if (failed === undefined) continue;
      blockedStages.add(stage);
      for (const task of record.tasks) {
        if (stageOf(task) <= stage) continue;
        if (task.status !== "pending") continue;
        task.status = "blocked";
        task.blockedBy = failed.laneId;
        task.endedAt = stamp();
        task.error = `分阶段调度：阶段 ${stage} 的 ${failed.laneId} 没干成，本阶段不派发`;
        emit("task_blocked", task.laneId, `阶段 ${stage} 失败，阻塞后续阶段`);
      }
    }
  };

  /** 现在能派的候选，按拓扑顺序。 */
  const dispatchable = (): RunTaskRecord[] => {
    const candidates: RunTaskRecord[] = [];
    for (const laneId of order) {
      const task = tasks.get(laneId);
      if (task === undefined || task.status !== "pending" || dispatched.has(laneId)) continue;
      if (cancelledLanes.has(laneId)) continue;
      const depsSatisfied = task.dependsOn.every((dep) => tasks.get(dep)?.status === "completed");
      if (!depsSatisfied) continue;
      candidates.push(task);
    }
    if (record.schedule !== "staged") return candidates;
    // 阶段闸门看的是「还没落定的任务里最小的阶段号」，不是候选里最小的：上一阶段
    // 的任务可能已经派出去正在跑（status 还是 pending），这时候不能放下一阶段。
    const unfinished = record.tasks.filter((task) => task.status === "pending" || task.status === "running");
    if (unfinished.length === 0) return candidates;
    const lowest = Math.min(...unfinished.map(stageOf));
    return candidates.filter((task) => stageOf(task) === lowest);
  };

  const finishRun = (): void => {
    // 终态里不该有 `pending`。真剩下了，记成失败并留诊断，不写一份骗人的记录。
    for (const task of record.tasks) {
      if (task.status !== "pending") continue;
      task.status = "failed";
      task.endedAt = stamp();
      task.error = "调度结束时这个任务既没派出去也没被阻塞，按失败记账";
      emit("task_failed", task.laneId, task.error);
    }
    if (runCancelled) {
      record.status = "cancelled";
    } else if (record.tasks.every((task) => task.status === "completed")) {
      record.status = "completed";
    } else if (record.tasks.some((task) => task.status === "failed")) {
      record.status = "failed";
    } else if (record.tasks.some((task) => task.status === "cancelled")) {
      record.status = "cancelled";
    } else if (record.tasks.some((task) => task.status === "interrupted")) {
      record.status = "interrupted";
    } else if (record.tasks.every((task) => task.status === "blocked")) {
      // 全员被阻塞：这不是「失败」，是没跑起来。记 failed 会让人去找不存在的报错。
      record.status = "failed";
    } else {
      record.status = "failed";
    }
    record.endedAt = stamp();
    emit(runCancelled ? "run_cancelled" : "run_finished", undefined, cancelReason);
  };

  const run = async (): Promise<RunRecord> => {
    const running = new Map<string, Promise<void>>();
    const offAvailable = gate.onAvailable(wakeUp);

    // 任务表和运行名单是两份数据，正常情况下同源。真出现分歧（记录被人手改过、
    // 写到一半），把对不上的记成失败，而不是让它在终态里挂着 `pending` 或者被
    // 悄悄漏掉——「空跑成功」就是这么来的（§17.2）。
    for (const task of record.tasks) {
      if (members.has(task.laneId)) continue;
      task.status = "failed";
      task.endedAt = stamp();
      task.error = `运行名单里没有 ${task.laneId}`;
      emit("task_failed", task.laneId, task.error);
    }
    for (const laneId of order) {
      if (tasks.has(laneId)) continue;
      const task: RunTaskRecord = {
        laneId,
        status: "failed",
        dependsOn: [],
        attempts: 1,
        endedAt: stamp(),
        error: `名单里的 ${laneId} 没有任务记录，本次没有派它`,
      };
      record.tasks.push(task);
      tasks.set(laneId, task);
      emit("task_failed", laneId, task.error);
    }

    const dispatch = (task: RunTaskRecord): void => {
      dispatched.add(task.laneId);
      const member = members.get(task.laneId);
      if (member === undefined) {
        task.status = "failed";
        task.error = `运行名单里没有 ${task.laneId}`;
        task.endedAt = stamp();
        emit("task_failed", task.laneId, task.error);
        wakeUp();
        return;
      }
      const controller = new AbortController();
      controllers.set(task.laneId, controller);
      if (options.signal !== undefined) {
        const onRunAbort = (): void => controller.abort();
        if (options.signal.aborted) controller.abort();
        else options.signal.addEventListener("abort", onRunAbort, { once: true });
      }

      const upstream = Object.fromEntries(task.dependsOn.map((dep) => [dep, outputs.get(dep)]));
      const workspace = workspaceOf(member);
      const writes = writesWorkspace(member);

      const promise = (async (): Promise<void> => {
        let releaseSlot: (() => void) | undefined;
        let releaseLock: (() => void) | undefined;
        try {
          releaseSlot = await gate.acquireSlot(controller.signal);
          if (writes) releaseLock = await gate.acquireWorkspace(workspace, record.runId, task.laneId, controller.signal);
        } catch (error) {
          // 排队期间被取消：一次都没执行，照实记 cancelled。也可能循环已经先一步
          // 把它记成 cancelled 了（单人取消），那就不再改一遍。
          if (!isTerminalTaskStatus(task.status)) {
            task.status = controller.signal.aborted ? "cancelled" : "failed";
            task.endedAt = stamp();
            task.error = error instanceof Error ? error.message : String(error);
            if (task.status === "cancelled") emit("task_cancelled", task.laneId, "排队期间被取消，没有执行");
            else emit("task_failed", task.laneId, task.error);
          }
          running.delete(task.laneId);
          wakeUp();
          return;
        }

        task.status = "running";
        task.startedAt = stamp();
        emit("task_started", task.laneId, `工作区 ${workspace}${writes ? "（写）" : "（只读）"}`);
        void publish();

        try {
          const output = await worker({
            runId: record.runId,
            teamId: record.teamId,
            laneId: task.laneId,
            task: record.task,
            member,
            upstream,
            ...(task.modelRef === undefined ? {} : { modelRef: task.modelRef }),
            workspace,
            writesWorkspace: writes,
            signal: controller.signal,
            reportChildSession: (childSessionId: string) => {
              task.childSessionId = childSessionId;
              options.onLaneStart?.({ laneId: task.laneId, childSessionId });
              // 立刻落一次：宿主重启后要还能从记录里找回这个子会话。
              void publish();
            },
          });
          if (controller.signal.aborted) {
            // 取消之后仍然返回了结果：按已取消记账，并留下诊断（§15.2 不能假称已停止）。
            task.status = "cancelled";
            task.error = "取消后底层仍然返回了结果，按已取消记账（底层没停下来）";
            emit("task_cancelled", task.laneId, task.error);
          } else {
            const normalized = normalizeRunOutput(output);
            task.output = normalized.value;
            task.status = "completed";
            outputs.set(task.laneId, normalized.value);
            if (normalized.truncated) {
              emit("task_output_truncated", task.laneId, `产出 ${normalized.bytes} 字节，超过单任务上限，已换成带标记的摘要`);
            }
            emit("task_completed", task.laneId);
          }
        } catch (error) {
          if (controller.signal.aborted || error instanceof ScheduleCancelledError) {
            task.status = "cancelled";
            task.error = error instanceof Error ? error.message : String(error);
            emit("task_cancelled", task.laneId, task.error);
          } else {
            task.status = "failed";
            task.error = error instanceof Error ? error.message : String(error);
            emit("task_failed", task.laneId, task.error);
          }
        } finally {
          task.endedAt = stamp();
          controllers.delete(task.laneId);
          releaseLock?.();
          releaseSlot?.();
          void publish();
          // 先从 running 里摘掉再叫醒循环：否则循环醒来时会以为还有任务在跑。
          running.delete(task.laneId);
          wakeUp();
        }
      })();

      running.set(task.laneId, promise);
    };

    while (true) {
      markBlocked();
      refreshBlockedStages();

      if (runCancelled || options.signal?.aborted === true) {
        runCancelled = true;
        // 取消引起的「阻塞」不是真阻塞：上游是被这次取消带走的，不是自己跑挂的。
        // 所以根集合是**所有**已取消的任务（不管是刚扫到的，还是正在跑、被 abort 之后
        // 才落成 cancelled 的），顺着 blockedBy 一路传下去。
        // 上游自己失败造成的阻塞保持 blocked 不动——那是真话，不该被取消盖掉。
        const sweptByRun = new Set<string>();
        for (const task of record.tasks) {
          if (task.status === "cancelled") sweptByRun.add(task.laneId);
        }
        for (const task of record.tasks) {
          if (task.status !== "pending") continue;
          task.status = "cancelled";
          task.endedAt = stamp();
          task.error = cancelReason ?? "全队取消，未派发";
          sweptByRun.add(task.laneId);
          emit("task_cancelled", task.laneId, task.error);
        }
        for (let pass = 0; pass < record.tasks.length; pass += 1) {
          let changed = false;
          for (const task of record.tasks) {
            if (task.status !== "blocked" || task.blockedBy === undefined) continue;
            if (!sweptByRun.has(task.blockedBy)) continue;
            const blocker = task.blockedBy;
            task.status = "cancelled";
            task.blockedBy = undefined;
            task.endedAt = stamp();
            task.error = `上游 ${blocker} 被取消，本任务未派发`;
            sweptByRun.add(task.laneId);
            emit("task_cancelled", task.laneId, task.error);
            changed = true;
          }
          if (!changed) break;
        }
        for (const controller of controllers.values()) controller.abort();
      } else {
        for (const laneId of cancelledLanes) {
          const task = tasks.get(laneId);
          if (task !== undefined && task.status === "pending") {
            task.status = "cancelled";
            task.endedAt = stamp();
            task.error = "成员被单独取消，未派发";
            emit("task_cancelled", laneId, task.error);
          }
        }
      }

      const pendingLeft = record.tasks.some((task) => task.status === "pending");
      if (!pendingLeft && running.size === 0) break;

      let dispatchedThisRound = 0;
      if (!runCancelled && options.signal?.aborted !== true && pendingLeft) {
        const ownLimit = Math.max(1, Math.min(record.maxConcurrentTasks, gate.capacity));
        let budget = ownLimit - running.size;
        if (record.schedule === "sequential") budget = running.size === 0 ? 1 : 0;
        for (const task of dispatchable()) {
          if (budget <= 0) break;
          const member = members.get(task.laneId)!;
          // 写任务的工作区正被占着就跳过它，先看后面的候选，不占着槽位干等。
          if (writesWorkspace(member) && gate.busyWorkspaces().includes(workspaceOf(member))) continue;
          dispatch(task);
          dispatchedThisRound += 1;
          budget -= 1;
        }
      }

      if (running.size === 0 && dispatchedThisRound === 0) {
        // 一个都派不出去，也没有任务在跑：只剩「等别的 run 放开槽位/锁」这一种
        // 可能。真的没得等了才收工。
        if (dispatchable().length === 0) break;
      }
      await waitForChange();
    }

    offAvailable();
    // 等所有派出去的 promise 真的落定，包括取消后还在挣扎的。
    await Promise.allSettled([...running.values()]);
    finishRun();
    await publish();
    return record;
  };

  const done = run();

  return {
    runId: record.runId,
    record,
    done,
    cancelLane(laneId: string, reason?: string): void {
      if (!tasks.has(laneId)) return;
      cancelledLanes.add(laneId);
      controllers.get(laneId)?.abort();
      if (reason !== undefined) emit("task_cancelling", laneId, reason);
      // 叫醒调度循环：否则还没派发的成员要等「别的任务碰巧落定」才会被记账，
      // 在那之前它仍然是 pending——「取消后不再派发」就成了看运气的。
      wakeUp();
    },
    cancelRun(reason?: string): void {
      runCancelled = true;
      cancelReason = reason ?? "全队取消";
      for (const controller of controllers.values()) controller.abort();
      wakeUp();
    },
  };
}

export type { TeamSchedule };
