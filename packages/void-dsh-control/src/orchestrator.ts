/**
 * Control-plane orchestration for the Lingbang control plane (plan §6.1, §7).
 *
 * The orchestrator is the only place that sequences Workspace resolution,
 * Session creation/resume, message delivery, task locking and ledger writes. It
 * talks to the running Web profile exclusively through {@link HostPorts}, which
 * the plugin wires onto `ctx.workspaceController` / `ctx.sessionController`, so
 * the whole admission chain is testable without booting a model provider.
 *
 * @module @void/void-dsh-control/orchestrator
 */
import {
  ControlError,
  LIMITS,
  formatCursor,
  parseCursor,
  type ControlOperation,
  type DispatchResult,
  type MessageMode,
  type SessionProjection,
  type TaskEventView,
  type TaskStatus,
  type TaskView,
  type WorkspaceProjection,
} from "./protocol.js";
import { accumulateAssistantText, boundSummary, type TaskSignal } from "./events.js";
import type { ControlLedger, TaskEventRecord, TaskRecord } from "./ledger.js";
import { summarizeFailure } from "./ledger.js";
import { idempotencyKey, mintTaskId, satisfiesWait, type DispatchWaitTarget } from "./state-machine.js";
import type { CallerIdentity } from "./auth.js";
import type { CompiledCallerPolicy } from "./policy.js";

/** One Workspace row as the host reports it. */
export interface HostWorkspace {
  readonly workspaceId: string;
  readonly path: string;
  readonly title: string;
  readonly sessionIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One Session row as the host reports it. */
export interface HostSession {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly running: boolean;
  readonly blank: boolean;
  readonly updatedAt: number;
  readonly parentSessionId?: string;
}

/** One prompt delivery request. */
export interface HostPromptRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly mode: "queue" | "steer";
  readonly text: string;
}

/** Everything the orchestrator needs from the running profile. */
export interface HostPorts {
  /** Register or resolve a Workspace over an existing directory. */
  openWorkspace(path: string): Promise<HostWorkspace>;
  /** List registered Workspaces. */
  listWorkspaces(): Promise<readonly HostWorkspace[]>;
  /** Resolve one Workspace identity. */
  getWorkspace(workspaceId: string): Promise<HostWorkspace | undefined>;
  /** List Sessions known to the host. */
  listSessions(): Promise<readonly HostSession[]>;
  /** Create or idempotently adopt one Session. */
  createSession(request: { workspaceId?: string; cwd?: string; agentPreset?: string }): Promise<{ sessionId: string }>;
  /** Fork one completed-turn prefix into a new Session. */
  forkSession(request: { sessionId: string; atSeq?: number }): Promise<{ sessionId: string }>;
  /** Read one Session without activating it. */
  inspectSession(sessionId: string): Promise<{ exists: boolean; cwd?: string }>;
  /** Admit one prompt through the Session prompt entry point. */
  promptSession(request: HostPromptRequest): Promise<void>;
  /** Inject model-facing context without waking an idle agent. */
  injectContext(request: { sessionId: string; text: string; requestId: string }): Promise<void>;
  /** Cancel the active turn of one Session. */
  cancelSession(sessionId: string): Promise<void>;
}

/** One message to deliver, already resolved against the workspace. */
export interface PreparedMessage {
  readonly text: string;
  readonly mode: MessageMode;
}

/** Input of {@link ControlOrchestrator.dispatch}. */
export interface DispatchCommand {
  readonly requestId: string;
  readonly workspace: { workspaceId?: string; path?: string };
  readonly session: { kind: "new" } | { kind: "existing"; sessionId: string } | { kind: "fork"; sessionId: string; atSeq?: number };
  readonly messages: readonly PreparedMessage[];
  readonly wait: { until: DispatchWaitTarget; timeoutMs: number };
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Input of {@link ControlOrchestrator.sendMessage}. */
export interface SendMessageCommand {
  readonly requestId: string;
  readonly sessionId: string;
  readonly message: PreparedMessage;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Options of the orchestrator. */
export interface OrchestratorOptions {
  readonly ledger: ControlLedger;
  readonly hosts: HostPorts;
  /** Live policy provider so a settings change is visible without a restart. */
  readonly policy: () => CompiledCallerPolicy;
  /** Clock, injectable for deterministic tests. */
  readonly now?: () => number;
  /**
   * Observer called after every committed task event.
   *
   * `record()` is the single funnel for lifecycle changes, so this is the one
   * place an outbound notifier can attach without racing the projection. The
   * hook must not throw; its rejection is contained.
   */
  readonly onEvent?: (record: TaskRecord, event: TaskEventRecord) => void | Promise<void>;
}

/** One recorded task plus its events, as returned to callers. */
export interface TaskSnapshot {
  readonly task: TaskView;
  readonly events: readonly TaskEventView[];
}

/** In-process notification used to implement `dsh_wait_task` without polling. */
type Waiter = () => void;

/**
 * Sequential control-plane orchestrator.
 *
 * Task locks are process-local by design (plan §7.3): the ledger records the
 * holder for audit, but mutual exclusion itself belongs to this process because
 * only this process can actually deliver to the session.
 */
export class ControlOrchestrator {
  private readonly ledger: ControlLedger;
  private readonly hosts: HostPorts;
  private readonly policy: () => CompiledCallerPolicy;
  private readonly now: () => number;
  private readonly onEvent: ((record: TaskRecord, event: TaskEventRecord) => void | Promise<void>) | undefined;
  private readonly locks = new Map<string, string>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly sessionToTask = new Map<string, string>();
  /**
   * Per-`idempotencyKey` promise chain.
   *
   * Admission reads the idempotency table and only reserves the key several
   * awaits later, so two concurrent requests carrying the same `requestId` can
   * both observe "no reservation" and both deliver. The chain makes that
   * read-then-reserve sequence atomic within this process — which is the only
   * place delivery can actually happen (plan §6.1, §10.2, scenario D).
   */
  private readonly keyLocks = new Map<string, Promise<void>>();
  /** Admission chains that have been accepted and not yet settled. */
  private readonly inflight = new Set<Promise<unknown>>();
  /**
   * Tasks observed actually running. An idle notification only completes a task
   * that reached `running` first, so a stale idle left over from an earlier turn
   * on the same session cannot close a freshly queued task.
   */
  private readonly sawRunning = new Set<string>();
  /**
   * 每个 Session 一条信号链，保证 `applySignal` 逐条、按序执行。
   *
   * 见 `applySignal` 的说明：派发方以 `void` 触发，同一回合的信号会并发到达。
   */
  private readonly signalChains = new Map<string, Promise<unknown>>();
  private counter = 0;
  private accepting = true;

  constructor(options: OrchestratorOptions) {
    this.ledger = options.ledger;
    this.hosts = options.hosts;
    this.policy = options.policy;
    this.now = options.now ?? (() => Date.now());
    this.onEvent = options.onEvent;
  }

  /**
   * Stop accepting new work and release long-poll waiters.
   *
   * Called during plugin disposal: an in-flight request must not start a new
   * admission chain while the endpoint is going away, and a `dsh_wait_task`
   * long-poll must not hold shutdown open for its full timeout (plan §7.3, §16).
   */
  stopAccepting(): void {
    this.accepting = false;
    for (const set of this.waiters.values()) {
      for (const waiter of [...set]) waiter();
    }
  }

  /** Resume acceptance. Test-only counterpart of {@link stopAccepting}. */
  startAccepting(): void {
    this.accepting = true;
  }

  /**
   * Wait until every accepted admission chain has settled.
   *
   * The disposer awaits this before closing the ledger, so no task can still be
   * writing to storage after teardown (plan §12, §16).
   */
  async drain(): Promise<void> {
    this.stopAccepting();
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  /** Admission chains still running, for diagnostics. */
  get inflightCount(): number {
    return this.inflight.size;
  }

  /** Sessions currently locked by a control task, for diagnostics. */
  lockSnapshot(): ReadonlyMap<string, string> {
    return new Map(this.locks);
  }

  /**
   * Execute a full dispatch: resolve workspace, resolve session, deliver
   * messages, and optionally wait for a status.
   *
   * @param identity - Authenticated caller.
   * @param command - Validated dispatch command.
   * @returns The task projection, including a cursor for later `wait` calls.
   */
  async dispatch(identity: CallerIdentity, command: DispatchCommand): Promise<DispatchResult> {
    return await this.track(this.runDispatch(identity, command));
  }

  private async runDispatch(identity: CallerIdentity, command: DispatchCommand): Promise<DispatchResult> {
    this.assertAccepting();

    const key = idempotencyKey(identity.callerId, command.requestId);
    return await this.withKeyLock(key, async () => {
      // Re-checked inside the lock: waiting behind a concurrent chain for the
      // same key may have outlived shutdown.
      this.assertAccepting();

      const existing = this.ledger.findIdempotent(key);
      if (existing !== undefined) {
        const task = this.requireTask(existing.taskId);
        await this.record(task.taskId, "idempotent_replay", task.status, "replayed an earlier request with the same requestId");
        return this.toDispatchResult(task);
      }

      this.assertCallerCapacity(identity.callerId);
      this.checkTexts(command.messages.map((message) => message.text));

      const workspace = await this.resolveWorkspace(command.workspace);
      const task = await this.createTask(identity, command, workspace.workspaceId);

      try {
        await this.record(task.taskId, "workspace_resolved", "workspace_resolved", `workspace ${workspace.workspaceId}`);

        const sessionId = await this.resolveSession(task.taskId, command, workspace);
        // Ownership is claimed before anything is delivered: a second task that
        // finds this session locked must fail here rather than steal the event
        // stream from the task that actually drives it (plan §7.3).
        if (startsTurn(command.messages)) this.claimSession(sessionId, task.taskId);
        await this.bindSession(task.taskId, sessionId);

        await this.deliver(command.messages, sessionId, command.requestId);
        await this.record(task.taskId, "prompt_queued", "prompt_queued", `${command.messages.length} message(s) delivered`);

        const settled = await this.awaitStatus(task.taskId, command.wait.until, command.wait.timeoutMs);
        return this.toDispatchResult(settled);
      } catch (error) {
        const failure = toStableError(error);
        await this.failTask(task.taskId, failure);
        throw failure;
      }
    });
  }

  /**
   * Deliver one message into an existing Session.
   *
   * @param identity - Authenticated caller.
   * @param command - Validated send command.
   * @returns The resulting task projection.
   */
  async sendMessage(identity: CallerIdentity, command: SendMessageCommand): Promise<TaskView> {
    return await this.track(this.runSendMessage(identity, command));
  }

  private async runSendMessage(identity: CallerIdentity, command: SendMessageCommand): Promise<TaskView> {
    this.assertAccepting();

    const key = idempotencyKey(identity.callerId, command.requestId);
    return await this.withKeyLock(key, async () => {
      this.assertAccepting();

      const existing = this.ledger.findIdempotent(key);
      if (existing !== undefined) {
        const task = this.requireTask(existing.taskId);
        await this.record(task.taskId, "idempotent_replay", task.status, "replayed an earlier request with the same requestId");
        return this.toTaskView(task);
      }

      this.assertCallerCapacity(identity.callerId);
      this.checkTexts([command.message.text]);

      const inspection = await this.hosts.inspectSession(command.sessionId);
      if (!inspection.exists) {
        throw new ControlError("dsh-control/session-not-found", "session does not exist and is not resumable", {
          sessionId: command.sessionId,
        });
      }

      const task = await this.createTask(
        identity,
        { requestId: command.requestId, metadata: command.metadata } as DispatchCommand,
        undefined,
        command.sessionId,
      );

      try {
        await this.record(task.taskId, "session_resumed", "session_resumed", `session ${command.sessionId}`);
        if (startsTurn([command.message])) this.claimSession(command.sessionId, task.taskId);
        await this.bindSession(task.taskId, command.sessionId);
        await this.deliver([command.message], command.sessionId, command.requestId);
        await this.record(task.taskId, "prompt_queued", "prompt_queued", "1 message delivered");
        return this.toTaskView(this.requireTask(task.taskId));
      } catch (error) {
        const failure = toStableError(error);
        await this.failTask(task.taskId, failure);
        throw failure;
      }
    });
  }

  /**
   * Inject model-facing context without waking an idle agent.
   *
   * Injection never starts a turn, so it deliberately does **not** take the
   * session lock and does **not** become the session's event owner: doing so
   * would steal running/idle attribution from the task that actually drives the
   * session (plan §7.3).
   *
   * @param identity - Authenticated caller.
   * @param command - Session, text and request identity.
   * @returns The resulting task projection.
   */
  async injectContext(
    identity: CallerIdentity,
    command: { requestId: string; sessionId: string; text: string },
  ): Promise<TaskView> {
    return await this.track(this.runInjectContext(identity, command));
  }

  private async runInjectContext(
    identity: CallerIdentity,
    command: { requestId: string; sessionId: string; text: string },
  ): Promise<TaskView> {
    this.assertAccepting();

    const key = idempotencyKey(identity.callerId, command.requestId);
    return await this.withKeyLock(key, async () => {
      this.assertAccepting();

      const existing = this.ledger.findIdempotent(key);
      if (existing !== undefined) {
        const task = this.requireTask(existing.taskId);
        await this.record(task.taskId, "idempotent_replay", task.status, "replayed an earlier request with the same requestId");
        return this.toTaskView(task);
      }

      this.checkTexts([command.text]);

      const inspection = await this.hosts.inspectSession(command.sessionId);
      if (!inspection.exists) {
        throw new ControlError("dsh-control/session-not-found", "session does not exist and is not resumable", {
          sessionId: command.sessionId,
        });
      }

      const task = await this.createTask(
        identity,
        { requestId: command.requestId } as DispatchCommand,
        undefined,
        command.sessionId,
      );

      try {
        await this.record(task.taskId, "session_resumed", "session_resumed", `session ${command.sessionId}`);
        await this.bindSession(task.taskId, command.sessionId);
        await this.hosts.injectContext({ sessionId: command.sessionId, text: command.text, requestId: command.requestId });
        // Injection never wakes the agent, so the task stops immediately with an
        // explicit marker rather than pretending work started (plan §6.1). It is
        // completed at once so it cannot occupy the caller's concurrency budget.
        await this.record(task.taskId, "prompt_queued", "prompt_queued", "context injected but not executed");
        await this.record(task.taskId, "idle", "idle", "no agent turn was started");
        await this.record(task.taskId, "completed", "completed", "context injected; nothing executed");
        return this.toTaskView(this.requireTask(task.taskId));
      } catch (error) {
        const failure = toStableError(error);
        await this.failTask(task.taskId, failure);
        throw failure;
      }
    });
  }

  /**
   * Read one task with a bounded page of events.
   *
   * @param identity - Authenticated caller.
   * @param query - Task identity, cursor and page size.
   * @returns The task snapshot.
   */
  getTask(identity: CallerIdentity, query: { taskId: string; afterCursor?: string; limit: number }): TaskSnapshot {
    const record = this.requireTask(query.taskId);
    this.assertTaskVisible(identity, record);
    return { task: this.toTaskView(record), events: this.pageEvents(record, parseCursor(query.afterCursor), query.limit) };
  }

  /**
   * Wait for a task to reach a status, returning only events after the cursor.
   *
   * @param identity - Authenticated caller.
   * @param query - Task identity, cursor, target status and timeout.
   * @returns The task snapshot observed when the wait settled.
   */
  async waitTask(
    identity: CallerIdentity,
    query: { taskId: string; afterCursor?: string; until: string; timeoutMs: number; limit: number },
  ): Promise<TaskSnapshot> {
    const record = this.requireTask(query.taskId);
    this.assertTaskVisible(identity, record);
    const from = parseCursor(query.afterCursor);
    const settled = await this.awaitStatus(record.taskId, query.until, query.timeoutMs);
    return {
      task: this.toTaskView(settled),
      events: this.pageEvents(settled, from, query.limit),
    };
  }

  /**
   * Cancel the active turn of a task's session.
   *
   * Cancellation reuses the host's existing cancel semantics; it never deletes a
   * Session, a Workspace or any project file (plan §6.1).
   *
   * @param identity - Authenticated caller.
   * @param query - Task identity.
   * @returns The resulting task projection.
   */
  async cancelTask(identity: CallerIdentity, query: { taskId: string }): Promise<TaskView> {
    const record = this.requireTask(query.taskId);
    this.assertTaskVisible(identity, record);

    if (record.status === "completed" || record.status === "failed" || record.status === "cancelled") {
      return this.toTaskView(record);
    }

    const sessionId = record.sessionId;
    if (sessionId !== undefined) {
      const holder = this.locks.get(sessionId);
      if (holder !== undefined && holder !== record.taskId && !identity.operations.has("task.cancel")) {
        throw new ControlError("dsh-control/session-locked", "another control task owns this session", { sessionId });
      }
      await this.hosts.cancelSession(sessionId);
    }

    const updated = await this.record(record.taskId, "cancelled", "cancelled", "cancelled by caller");
    this.releaseLock(updated.taskId);
    return this.toTaskView(this.requireTask(record.taskId));
  }

  /**
   * List registered Workspaces, optionally filtered by path prefix.
   *
   * @param pathPrefix - Optional absolute path prefix.
   * @returns Bounded Workspace projections.
   */
  async listWorkspaces(pathPrefix?: string): Promise<readonly WorkspaceProjection[]> {
    const workspaces = await this.hosts.listWorkspaces();
    const normalized = pathPrefix?.replace(/[\\/]+$/, "").toLowerCase();
    return workspaces
      .filter((workspace) => normalized === undefined || workspace.path.toLowerCase().startsWith(normalized))
      .map((workspace) => toWorkspaceProjection(workspace));
  }

  /**
   * List Sessions, optionally filtered by Workspace or path.
   *
   * @param query - Filter and archived-inclusion options.
   * @returns Bounded Session projections.
   */
  async listSessions(query: { workspaceId?: string; path?: string }): Promise<readonly SessionProjection[]> {
    const sessions = await this.hosts.listSessions();
    let allowed: Set<string> | undefined;

    if (query.workspaceId !== undefined) {
      const workspace = await this.hosts.getWorkspace(query.workspaceId);
      if (workspace === undefined) {
        throw new ControlError("dsh-control/workspace-not-found", "workspace is not registered", {
          workspaceId: query.workspaceId,
        });
      }
      allowed = new Set(workspace.sessionIds);
    } else if (query.path !== undefined) {
      const workspaces = await this.hosts.listWorkspaces();
      const target = query.path.replace(/[\\/]+$/, "").toLowerCase();
      const workspace = workspaces.find((candidate) => candidate.path.toLowerCase() === target);
      if (workspace === undefined) {
        throw new ControlError("dsh-control/workspace-not-found", "no registered workspace matches that path", {
          path: query.path,
        });
      }
      allowed = new Set(workspace.sessionIds);
    }

    return sessions
      .filter((session) => allowed === undefined || allowed.has(session.sessionId))
      .map((session) => toSessionProjection(session));
  }

  /**
   * Apply one host-derived signal to whichever task owns the session.
   *
   * @param sessionId - Session the signal belongs to.
   * @param signal - Bounded signal derived in `events.ts`.
   */
  async applySignal(sessionId: string, signal: TaskSignal): Promise<void> {
    // 同一 Session 的信号必须**按到达顺序、逐条**应用。
    //
    // 派发方（`index.ts` 的事件订阅）是以 `void` 触发本方法的——同一个回合里 `turn/start`、
    // `assistant/message`、`turn/end` 常前后脚到达，若并发执行会有两个后果：状态机看到的是
    // 乱序的信号；而 `record()` 是「同步读投影 → await 追加事件 → 写回投影」，两次并发调用
    // 都基于同一份旧投影写回，后写的会把先写的字段**静默抹掉**（`assistantSummary` 就在这条
    // 路径上）。按 sessionId 分桶串行化，两个问题一起消掉。
    const previous = this.signalChains.get(sessionId) ?? Promise.resolve();
    const queued = previous.then(() => this.applySignalNow(sessionId, signal));
    // 链上只留「已结束」标记：一次失败不能毒化该 Session 后续的信号。
    this.signalChains.set(
      sessionId,
      queued.then(
        () => undefined,
        () => undefined,
      ),
    );
    return queued;
  }

  private async applySignalNow(sessionId: string, signal: TaskSignal): Promise<void> {
    const taskId = this.sessionToTask.get(sessionId);
    if (taskId === undefined) return;
    const record = this.ledger.getTask(taskId);
    if (record === undefined) return;
    if (record.status === "completed" || record.status === "failed" || record.status === "cancelled") return;

    // A duplicate idle notification carries no new information.
    if (signal.status === "idle" && record.status === "idle" && signal.sessionSeq === undefined) return;

    if (signal.status === "running") this.sawRunning.add(taskId);

    const updated = await this.record(taskId, signal.status, signal.status, signal.summary, signal.sessionSeq);
    if (signal.assistantText !== undefined) {
      const accumulated = accumulateAssistantText(updated.assistantSummary, signal.assistantText);
      await this.ledger.putTask({
        ...updated,
        assistantSummary: accumulated.text,
        assistantSummaryTruncated: accumulated.truncated,
      });
      this.notify(taskId);
    }

    if (signal.status === "failed") {
      this.releaseLock(taskId);
      return;
    }

    // The agent settled after doing this task's work, so the control round is
    // over. `sawRunning` is what keeps an unrelated idle from closing a task
    // that was only just queued (plan §9.2, scenario F).
    if (signal.status === "idle" && this.sawRunning.has(taskId)) {
      await this.record(taskId, "completed", "completed", "task completed: agent reached idle");
      this.sawRunning.delete(taskId);
      this.releaseLock(taskId);
    }
  }

  /**
   * Take exclusive ownership of a Session for one task.
   *
   * Lock and event routing are set together on purpose: ownership is what
   * decides which task a running/idle signal belongs to, so a task that does not
   * hold the lock must never become the session's event owner (plan §7.3).
   *
   * @param sessionId - Session being driven.
   * @param taskId - Task requesting ownership.
   * @throws ControlError `dsh-control/session-locked` when another task holds it.
   */
  private claimSession(sessionId: string, taskId: string): void {
    const holder = this.locks.get(sessionId);
    if (holder !== undefined && holder !== taskId) {
      throw new ControlError("dsh-control/session-locked", "another control task owns this session", {
        sessionId,
        holderTaskId: holder,
      });
    }
    this.locks.set(sessionId, taskId);
    this.sessionToTask.set(sessionId, taskId);
  }

  /**
   * Record which Session a task drives, without taking ownership.
   *
   * Re-reads the projection rather than merging a caller-held snapshot: an
   * earlier hop may have advanced the cursor, and writing a stale copy back
   * would silently rewind the task's status and event position.
   *
   * @param taskId - Task the session belongs to.
   * @param sessionId - Session the task addresses.
   */
  private async bindSession(taskId: string, sessionId: string): Promise<void> {
    const current = this.requireTask(taskId);
    await this.ledger.putTask({ ...current, sessionId });
  }

  private assertAccepting(): void {
    if (!this.accepting) {
      throw new ControlError("dsh-control/host-unavailable", "control plane is shutting down and no longer accepts tasks");
    }
  }

  /**
   * Register an admission chain so {@link drain} can wait for it.
   *
   * @param operation - The chain, already started.
   * @returns The same promise, for `return await` at the entry point.
   */
  private track<T>(operation: Promise<T>): Promise<T> {
    this.inflight.add(operation);
    void operation.then(
      () => this.inflight.delete(operation),
      () => this.inflight.delete(operation),
    );
    return operation;
  }

  /**
   * Serialize admission chains that share one idempotency key.
   *
   * The chain is per key, not global: unrelated callers keep running in
   * parallel, while two requests carrying the same `callerId + requestId` are
   * ordered so the second one sees the first one's reservation.
   *
   * @param key - Idempotency key.
   * @param body - The read-then-reserve admission sequence.
   * @returns Whatever `body` resolves to.
   */
  private async withKeyLock<T>(key: string, body: () => Promise<T>): Promise<T> {
    const previous = this.keyLocks.get(key) ?? Promise.resolve();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.keyLocks.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await body();
    } finally {
      release();
      if (this.keyLocks.get(key) === tail) this.keyLocks.delete(key);
    }
  }

  private assertCallerCapacity(callerId: string): void {
    const active = this.ledger
      .listTasks()
      .filter((task) => task.callerId === callerId)
      .filter((task) => task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled");
    if (active.length >= LIMITS.maxConcurrentTasksPerCaller) {
      throw new ControlError("dsh-control/limit-exceeded", "caller already has the maximum number of active control tasks", {
        active: active.length,
        limit: LIMITS.maxConcurrentTasksPerCaller,
      });
    }
  }

  private checkTexts(texts: readonly string[]): void {
    const policy = this.policy();
    const scanned = texts.join("\n");
    for (const pattern of policy.forbiddenPatterns) {
      if (!pattern.test(scanned)) continue;
      // The offending text is never echoed back: it is exactly the content the
      // user asked never to have copied into a response.
      throw new ControlError("dsh-control/policy-forbidden-content", "request contains content forbidden by the configured caller policy", {
        pattern: pattern.source,
      });
    }
  }

  private async resolveWorkspace(target: { workspaceId?: string; path?: string }): Promise<HostWorkspace> {
    if (target.workspaceId !== undefined) {
      const workspace = await this.hosts.getWorkspace(target.workspaceId);
      if (workspace === undefined) {
        throw new ControlError("dsh-control/workspace-not-found", "workspace is not registered", {
          workspaceId: target.workspaceId,
        });
      }
      return workspace;
    }
    if (target.path !== undefined) {
      // Path policy (existence, allowedRoots, realpath containment) is enforced
      // by the caller before this point; the host call only registers the result.
      return await this.hosts.openWorkspace(target.path);
    }
    throw new ControlError("dsh-control/invalid-request", "workspace target must name a workspaceId or a path");
  }

  private async createTask(
    identity: CallerIdentity,
    command: Pick<DispatchCommand, "requestId" | "metadata">,
    workspaceId: string | undefined,
    sessionId?: string,
  ): Promise<TaskRecord> {
    const now = new Date(this.now()).toISOString();
    const record: TaskRecord = {
      taskId: mintTaskId(this.now(), ++this.counter),
      callerId: identity.callerId,
      requestId: command.requestId,
      status: "accepted",
      createdAt: now,
      updatedAt: now,
      lastCursor: -1,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(sessionId === undefined ? {} : { sessionId }),
    };
    await this.ledger.putTask(record);
    // The idempotency key is reserved before any delivery so a retry can never
    // append a second user message (plan §10.3).
    await this.ledger.putIdempotent({
      key: idempotencyKey(identity.callerId, command.requestId),
      taskId: record.taskId,
      callerId: identity.callerId,
      requestId: command.requestId,
      createdAt: now,
    });
    const stored = await this.record(record.taskId, "accepted", "accepted", "request accepted");
    return this.ledger.getTask(stored.taskId) ?? record;
  }

  private async resolveSession(
    taskId: string,
    command: DispatchCommand,
    workspace: HostWorkspace,
  ): Promise<string> {
    const target = command.session;

    if (target.kind === "fork") {
      const inspection = await this.hosts.inspectSession(target.sessionId);
      if (!inspection.exists) {
        throw new ControlError("dsh-control/session-not-found", "fork source session does not exist", {
          sessionId: target.sessionId,
        });
      }
      if (!workspace.sessionIds.includes(target.sessionId) && inspection.cwd !== workspace.path) {
        throw new ControlError("dsh-control/session-workspace-mismatch", "fork source session belongs to another workspace", {
          sessionId: target.sessionId,
          workspaceId: workspace.workspaceId,
        });
      }
      const forked = await this.hosts.forkSession(
        target.atSeq === undefined ? { sessionId: target.sessionId } : { sessionId: target.sessionId, atSeq: target.atSeq },
      );
      await this.record(taskId, "session_created", "session_created", `forked from ${target.sessionId}`);
      return forked.sessionId;
    }

    if (target.kind === "existing") {
      const inspection = await this.hosts.inspectSession(target.sessionId);
      if (!inspection.exists) {
        throw new ControlError("dsh-control/session-not-found", "session does not exist and is not resumable", {
          sessionId: target.sessionId,
        });
      }
      const inWorkspace =
        workspace.sessionIds.includes(target.sessionId) ||
        (inspection.cwd !== undefined && samePath(inspection.cwd, workspace.path));
      if (!inWorkspace) {
        throw new ControlError(
          "dsh-control/session-workspace-mismatch",
          "session does not belong to the addressed workspace",
          { sessionId: target.sessionId, workspaceId: workspace.workspaceId },
        );
      }
      await this.record(taskId, "session_resumed", "session_resumed", `session ${target.sessionId}`);
      return target.sessionId;
    }

    const created = await this.hosts.createSession({ workspaceId: workspace.workspaceId, cwd: workspace.path });
    await this.record(taskId, "session_created", "session_created", `session ${created.sessionId}`);
    return created.sessionId;
  }

  private async deliver(
    messages: readonly PreparedMessage[],
    sessionId: string,
    requestId: string,
  ): Promise<void> {
    // Ownership was claimed by the caller before the first delivery, so this
    // only sequences the host calls.
    for (const [index, message] of messages.entries()) {
      if (message.mode === "inject") {
        await this.hosts.injectContext({
          sessionId,
          text: message.text,
          requestId: `${requestId}#${index}`,
        });
        continue;
      }
      await this.hosts.promptSession({
        requestId: `${requestId}#${index}`,
        sessionId,
        mode: message.mode,
        text: message.text,
      });
    }
  }

  /**
   * Release the per-session lock a task holds, if it still holds it.
   *
   * @param taskId - Task that reached a terminal status.
   */
  private releaseLock(taskId: string): void {
    const task = this.ledger.getTask(taskId);
    if (task?.sessionId === undefined) return;
    if (this.locks.get(task.sessionId) !== taskId) return;
    this.locks.delete(task.sessionId);
    if (this.sessionToTask.get(task.sessionId) === taskId) this.sessionToTask.delete(task.sessionId);
  }

  /**
   * Append one immutable event and advance the task projection.
   *
   * Always re-reads the stored projection first. Callers hold snapshots taken
   * before earlier hops, and merging those back would rewind fields a later hop
   * already committed (`sessionId` in particular).
   *
   * @param taskId - Task the event belongs to.
   * @param kind - Event kind.
   * @param status - Status the event moves the task to.
   * @param summary - Bounded, caller-safe account.
   * @param sessionSeq - Session event sequence this event corresponds to.
   * @returns The updated projection.
   */
  private async record(
    taskId: string,
    kind: TaskEventRecord["kind"],
    status: TaskStatus,
    summary: string,
    sessionSeq?: number,
  ): Promise<TaskRecord> {
    const current = this.requireTask(taskId);
    const time = new Date(this.now()).toISOString();
    // Event first, projection second: the append-only trail is authoritative and
    // the projection is repairable from it (plan §10.2).
    const event = await this.ledger.appendEvent({
      taskId,
      kind,
      status,
      time,
      summary: boundSummary(summary),
      ...(sessionSeq === undefined ? {} : { sessionSeq }),
    });
    const next: TaskRecord = { ...current, status, updatedAt: time, lastCursor: event.seq };
    await this.ledger.putTask(next);
    this.notify(taskId);
    if (this.onEvent !== undefined) {
      // Deliberately not awaited. The event is already durable, and a notifier
      // that talks to a remote receiver would otherwise let an HTTP retry chain
      // stall task progression (plan §9.2, §12). The notifier owns its own
      // error handling and its own quiesce.
      try {
        const observed = this.onEvent(next, event);
        if (observed !== undefined) void Promise.resolve(observed).catch(() => undefined);
      } catch {
        // A synchronous notifier failure must not fail the lifecycle write.
      }
    }
    return next;
  }

  /**
   * Move a task to `failed`, recording a stable caller-facing summary.
   *
   * @param taskId - Failing task.
   * @param error - Failure raised while handling the request.
   */
  private async failTask(taskId: string, error: unknown): Promise<void> {
    const summary = summarizeFailure(error);
    const failed = await this.record(taskId, "failed", "failed", summary.message);
    await this.ledger.putTask({ ...failed, errorCode: summary.code, errorMessage: summary.message });
    this.releaseLock(taskId);
  }

  private requireTask(taskId: string): TaskRecord {
    const record = this.ledger.getTask(taskId);
    if (record === undefined) {
      throw new ControlError("dsh-control/task-not-found", "unknown task", { taskId });
    }
    return record;
  }

  private assertTaskVisible(identity: CallerIdentity, record: TaskRecord): void {
    if (record.callerId === identity.callerId) return;
    if (identity.operations.has("task.read")) return;
    throw new ControlError("dsh-control/task-not-found", "unknown task", { taskId: record.taskId });
  }

  private pageEvents(record: TaskRecord, afterSeq: number, limit: number): readonly TaskEventView[] {
    return this.ledger.listEvents(record.taskId, afterSeq, limit).map((event) => toEventView(event));
  }

  private notify(taskId: string): void {
    const set = this.waiters.get(taskId);
    if (set === undefined) return;
    for (const waiter of set) waiter();
  }

  /**
   * Wait until a task satisfies `until`, or the timeout elapses.
   *
   * Waiting is notification-driven with a timeout race; it never polls the host
   * and never changes the agent's own running policy (plan §6.1).
   *
   * @param taskId - Task to observe.
   * @param fromCursor - Cursor the caller already holds.
   * @param until - Wait target.
   * @param timeoutMs - Maximum wait.
   * @returns The task projection at settlement.
   */
  private async awaitStatus(taskId: string, until: string, timeoutMs: number): Promise<TaskRecord> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const record = this.requireTask(taskId);
      // A shutting-down control plane stops long-polling rather than holding
      // teardown open for the caller's full timeout.
      if (this.satisfies(record, until) || timeoutMs === 0 || !this.accepting) return record;
      const remaining = deadline - this.now();
      if (remaining <= 0) return record;
      await this.waitForNotification(taskId, remaining);
    }
  }

  private satisfies(record: TaskRecord, until: string): boolean {
    if (until === "accepted") return true;
    return satisfiesWait(record.status, until as DispatchWaitTarget);
  }

  private waitForNotification(taskId: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const set = this.waiters.get(taskId) ?? new Set<Waiter>();
      this.waiters.set(taskId, set);
      const timer = setTimeout(() => {
        set.delete(waiter);
        resolve();
      }, timeoutMs);
      const waiter: Waiter = () => {
        clearTimeout(timer);
        set.delete(waiter);
        resolve();
      };
      set.add(waiter);
    });
  }

  private toTaskView(record: TaskRecord): TaskView {
    return {
      taskId: record.taskId,
      callerId: record.callerId,
      requestId: record.requestId,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      eventCursor: formatCursor(record.lastCursor),
      ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
      ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
      ...(record.errorCode === undefined || record.errorMessage === undefined
        ? {}
        : { error: { code: record.errorCode, message: record.errorMessage } }),
      ...(record.assistantSummary === undefined ? {} : { assistantSummary: record.assistantSummary }),
      ...(record.assistantSummaryTruncated === undefined
        ? {}
        : { assistantSummaryTruncated: record.assistantSummaryTruncated }),
    };
  }

  private toDispatchResult(record: TaskRecord): DispatchResult {
    if (record.workspaceId === undefined || record.sessionId === undefined) {
      throw new ControlError("dsh-control/internal", "dispatch completed without a workspace and session");
    }
    const policy = this.policy();
    return {
      taskId: record.taskId,
      workspaceId: record.workspaceId,
      sessionId: record.sessionId,
      status: record.status,
      eventCursor: formatCursor(record.lastCursor),
      callerInstructions: policy.callerInstructions,
      instructionsVersion: policy.instructionsVersion,
      events: this.pageEvents(record, -1, LIMITS.maxEventPageSize),
    };
  }
}

/**
 * Whether a message list starts or queues an agent turn.
 *
 * `inject` only stages model-facing context; it wakes nothing, so it neither
 * needs nor may take the session lock (plan §6.1, §7.3).
 *
 * @param messages - Prepared messages of one request.
 * @returns True when at least one message reaches the prompt entry point.
 */
function startsTurn(messages: readonly PreparedMessage[]): boolean {
  return messages.some((message) => message.mode !== "inject");
}

/**
 * Normalize any failure raised while handling a request into a stable error.
 *
 * A `ControlError` already carries a published code and a caller-safe message.
 * Anything else came from a host port and is summarized, because a host error
 * message can embed filesystem paths, environment values or internal
 * identifiers the caller has no business seeing (plan §11 requirement 12).
 *
 * @param error - Failure raised while handling the request.
 * @returns The error to record on the task and to rethrow.
 */
export function toStableError(error: unknown): ControlError {
  if (error instanceof ControlError) return error;
  return new ControlError("dsh-control/host-unavailable", "the control plane could not complete the request");
}

/**
 * Compare two host paths for equality using the platform's case rules.
 *
 * @param left - First path.
 * @param right - Second path.
 * @returns True when both name the same location.
 */
export function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const trimmed = value.replace(/[\\/]+$/, "").replace(/\\/g, "/");
    return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
  };
  return normalize(left) === normalize(right);
}

/**
 * Project a host Workspace row for external callers.
 *
 * @param workspace - Host row.
 * @returns The bounded projection.
 */
export function toWorkspaceProjection(workspace: HostWorkspace): WorkspaceProjection {
  return {
    workspaceId: workspace.workspaceId,
    path: workspace.path,
    title: workspace.title,
    sessionCount: workspace.sessionIds.length,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}

/**
 * Project a host Session row for external callers.
 *
 * @param session - Host row.
 * @returns The bounded projection.
 */
export function toSessionProjection(session: HostSession): SessionProjection {
  return {
    sessionId: session.sessionId,
    running: session.running,
    blank: session.blank,
    updatedAt: new Date(session.updatedAt).toISOString(),
    // A cold session is resumable by definition; the host reports existence via
    // the list, so everything listed here can be resumed.
    resumable: true,
    ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
    ...(session.parentSessionId === undefined ? {} : { parentSessionId: session.parentSessionId }),
  };
}

/**
 * Project one ledger event for external callers.
 *
 * @param event - Ledger event row.
 * @returns The bounded projection.
 */
export function toEventView(event: TaskEventRecord): TaskEventView {
  return {
    seq: event.seq,
    kind: event.kind,
    status: event.status,
    time: event.time,
    summary: event.summary,
    ...(event.sessionSeq === undefined ? {} : { sessionSeq: event.sessionSeq }),
  };
}

/**
 * Operations each tool requires, kept beside the orchestrator for auditing.
 *
 * `dsh_control_info` is deliberately absent: it must be readable by every
 * authenticated caller, because it is the only place the user's live caller
 * policy is published.
 */
export const TOOL_OPERATIONS: Readonly<Record<string, ControlOperation>> = Object.freeze({
  dsh_dispatch_session_task: "session.prompt",
  dsh_send_message: "session.prompt",
  dsh_inject_context: "session.inject",
  dsh_list_workspaces: "workspace.read",
  dsh_list_sessions: "session.list",
  dsh_get_task: "task.read",
  dsh_wait_task: "task.read",
  dsh_cancel_task: "task.cancel",
});

/**
 * Additional operations a tool requires for a specific input shape.
 *
 * `dsh_dispatch_session_task` registers a Workspace when the target names an
 * absolute path, which is a different capability from prompting one that is
 * already registered. Keeping it in the same auditing table as
 * {@link TOOL_OPERATIONS} means the minimal-privilege rule stays reviewable in
 * one place (plan §7.1, §11 requirement 4, scenario A).
 */
export const TOOL_CONDITIONAL_OPERATIONS: Readonly<
  Record<string, readonly { readonly when: string; readonly operation: ControlOperation }[]>
> = Object.freeze({
  dsh_dispatch_session_task: Object.freeze([
    {
      when: "target.workspace.path is used (path-based workspace addressing registers a workspace)",
      operation: "workspace.open" as ControlOperation,
    },
  ]),
});
