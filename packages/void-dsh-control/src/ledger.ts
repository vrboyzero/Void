/**
 * Control-plane ledger for the Lingbang control plane (plan §10).
 *
 * The ledger is a second fact source, deliberately separate from the session
 * event log: the session log records what the DSH agent saw, the ledger records
 * what an external caller asked for and what happened to that request.
 *
 * `@deepseek-ai/dsh-storage-domain` has no cross-table transaction, so every
 * state change follows the plan's ordering: **append the immutable event first,
 * then update the task projection**. A crash between the two leaves a task that
 * the next startup repairs from its events rather than one that lies about
 * having completed.
 *
 * @module @void/void-dsh-control/ledger
 */
import { defineDomain, domainTable, type Domain } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import { CONTROL_ERROR_CODES, TASK_STATUSES, type ControlErrorCode, type TaskEventKind, type TaskStatus } from "./protocol.js";

/** Ledger domain name. Independent of Workspace and Session projection domains. */
export const CONTROL_DOMAIN_NAME = "dsh_agent_control";

/** Ledger schema version; bumped only with a monotonic migration. */
export const CONTROL_DOMAIN_VERSION = 1;

const taskStatusSchema = z.enum(TASK_STATUSES);
const errorCodeSchema = z.enum(CONTROL_ERROR_CODES);
const taskEventKindSchema = z.enum([
  ...TASK_STATUSES,
  "policy_rejected",
  "idempotent_replay",
] as const satisfies readonly TaskEventKind[]);

/** One control task projection. */
export const TaskRecordSchema = z.object({
  taskId: z.string(),
  callerId: z.string(),
  requestId: z.string(),
  status: taskStatusSchema,
  workspaceId: z.string().optional(),
  sessionId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastCursor: z.number().int(),
  errorCode: errorCodeSchema.optional(),
  errorMessage: z.string().optional(),
  assistantSummary: z.string().optional(),
  assistantSummaryTruncated: z.boolean().optional(),
});

/** One immutable task lifecycle event. */
export const TaskEventRecordSchema = z.object({
  taskId: z.string(),
  seq: z.number().int().nonnegative(),
  kind: taskEventKindSchema,
  status: taskStatusSchema,
  time: z.string(),
  summary: z.string(),
  sessionSeq: z.number().int().nonnegative().optional(),
});

/** One caller request key mapped to the task it produced. */
export const IdempotencyRecordSchema = z.object({
  key: z.string(),
  taskId: z.string(),
  callerId: z.string(),
  requestId: z.string(),
  createdAt: z.string(),
});

/** One callback delivery attempt record. */
export const CallbackDeliveryRecordSchema = z.object({
  deliveryId: z.string(),
  taskId: z.string(),
  event: z.string(),
  attempts: z.number().int().nonnegative(),
  status: z.enum(["pending", "delivered", "failed"]),
  lastError: z.string().optional(),
  updatedAt: z.string(),
});

/** Published policy metadata; the rules themselves stay in user settings. */
export const PolicyMetaRecordSchema = z.object({
  instructionsVersion: z.number().int().nonnegative(),
  publishedAt: z.string(),
  summary: z.string(),
});

/** Storage-domain declaration for the control plane. */
export const controlDomainSpec = defineDomain({
  name: CONTROL_DOMAIN_NAME,
  version: CONTROL_DOMAIN_VERSION,
  tables: {
    tasks: domainTable<string, z.infer<typeof TaskRecordSchema>>(TaskRecordSchema),
    task_events: domainTable<string, z.infer<typeof TaskEventRecordSchema>>(TaskEventRecordSchema),
    idempotency: domainTable<string, z.infer<typeof IdempotencyRecordSchema>>(IdempotencyRecordSchema),
    callback_deliveries: domainTable<string, z.infer<typeof CallbackDeliveryRecordSchema>>(CallbackDeliveryRecordSchema),
    policy_meta: domainTable<string, z.infer<typeof PolicyMetaRecordSchema>>(PolicyMetaRecordSchema),
  },
});

/** One control task projection. */
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

/** One immutable task lifecycle event. */
export type TaskEventRecord = z.infer<typeof TaskEventRecordSchema>;

/** One caller request key mapped to the task it produced. */
export type IdempotencyRecord = z.infer<typeof IdempotencyRecordSchema>;

/** One callback delivery attempt record. */
export type CallbackDeliveryRecord = z.infer<typeof CallbackDeliveryRecordSchema>;

/** Published policy metadata. */
export type PolicyMetaRecord = z.infer<typeof PolicyMetaRecordSchema>;

/** Persistence contract the orchestrator depends on. */
export interface ControlLedger {
  /**
   * Load state and repair projections left behind by an earlier process.
   *
   * @param adjudicator - Optional host view used to tell "the message had
   * already been delivered" from "nothing was ever sent" (plan §10.3).
   */
  init(adjudicator?: RecoveryAdjudicator): Promise<LedgerRecoveryReport>;
  /** Release backend resources. Idempotent. */
  close(): Promise<void>;

  getTask(taskId: string): TaskRecord | undefined;
  listTasks(): readonly TaskRecord[];
  putTask(record: TaskRecord): Promise<void>;

  /** Append one immutable event, returning the sequence it was stored under. */
  appendEvent(event: Omit<TaskEventRecord, "seq">): Promise<TaskEventRecord>;
  listEvents(taskId: string, afterSeq: number, limit: number): readonly TaskEventRecord[];
  countEvents(taskId: string): number;

  findIdempotent(key: string): IdempotencyRecord | undefined;
  putIdempotent(record: IdempotencyRecord): Promise<void>;

  putCallbackDelivery(record: CallbackDeliveryRecord): Promise<void>;
  /** Look up one delivery by its idempotency id. */
  findCallbackDelivery(deliveryId: string): CallbackDeliveryRecord | undefined;
  listCallbackDeliveries(): readonly CallbackDeliveryRecord[];

  putPolicyMeta(record: PolicyMetaRecord): Promise<void>;
  getPolicyMeta(): PolicyMetaRecord | undefined;
}

/**
 * Host view startup recovery consults before declaring an orphan failed.
 *
 * The ledger alone cannot tell whether a queued message was actually received,
 * because that fact lives in the Session log. Asking the host is what keeps
 * recovery from reporting "nothing happened" about work that may still be
 * running (plan §10.3).
 */
export interface RecoveryAdjudicator {
  /** Whether a Session still exists on the host. */
  sessionExists(sessionId: string): Promise<boolean>;
}

/** What startup recovery did, reported so activation can log it truthfully. */
export interface LedgerRecoveryReport {
  /** Tasks moved to `failed` because the previous process died mid-flight. */
  readonly orphanedTaskIds: readonly string[];
  /** Tasks whose projection already matched their events. */
  readonly consistentTaskIds: readonly string[];
  /**
   * Orphans whose messages had already reached the prompt entry point.
   *
   * These may have run to completion outside the control plane, so a caller must
   * check the session rather than assume the work never happened.
   */
  readonly deliveredTaskIds: readonly string[];
}

/** Statuses that prove at least one message reached the prompt entry point. */
const DELIVERED_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "prompt_queued",
  "running",
  "assistant_message",
  "idle",
]);

/**
 * Whether a task status proves the request was already handed to the host.
 *
 * @param status - Task status at restart.
 * @returns True when a message was delivered before the process died.
 */
export function wasDelivered(status: TaskStatus): boolean {
  return DELIVERED_STATUSES.has(status);
}

/**
 * Compose the caller-facing account of an orphaned task.
 *
 * @param task - Orphaned task projection.
 * @param sessionAlive - Whether its session still exists on the host.
 * @returns The bounded summary plus the error code to store.
 */
function describeOrphan(task: TaskRecord, sessionAlive: boolean): { code: ControlErrorCode; message: string } {
  if (!wasDelivered(task.status)) {
    return {
      code: "dsh-control/host-unavailable",
      message: "process restarted before the request reached the session",
    };
  }
  if (sessionAlive) {
    return {
      code: "dsh-control/host-unavailable",
      message:
        "process restarted after the message was delivered; the agent may have continued or completed this work outside the control plane",
    };
  }
  return {
    code: "dsh-control/host-unavailable",
    message: "process restarted after the message was delivered, and the session no longer exists",
  };
}

/**
 * Repair a task projection from its recorded events.
 *
 * Used at startup for every non-terminal task. The event trail is authoritative
 * because it is append-only; the projection is derived and therefore repairable.
 *
 * @param events - Events of one task, ordered by sequence.
 * @returns The status the events prove, or `undefined` when there are none.
 */
export function statusFromEvents(events: readonly TaskEventRecord[]): TaskStatus | undefined {
  let last: TaskStatus | undefined;
  for (const event of events) last = event.status;
  return last;
}

/** In-memory ledger used by unit tests and by an explicitly configured degraded mode. */
export class MemoryControlLedger implements ControlLedger {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly events = new Map<string, TaskEventRecord[]>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly callbacks = new Map<string, CallbackDeliveryRecord>();
  private policyMeta: PolicyMetaRecord | undefined;
  private closed = false;

  async init(): Promise<LedgerRecoveryReport> {
    return { orphanedTaskIds: [], consistentTaskIds: [...this.tasks.keys()], deliveredTaskIds: [] };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** Whether {@link close} has been called; asserted by teardown tests. */
  get isClosed(): boolean {
    return this.closed;
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(): readonly TaskRecord[] {
    return [...this.tasks.values()];
  }

  async putTask(record: TaskRecord): Promise<void> {
    this.tasks.set(record.taskId, record);
  }

  async appendEvent(event: Omit<TaskEventRecord, "seq">): Promise<TaskEventRecord> {
    const list = this.events.get(event.taskId) ?? [];
    const stored: TaskEventRecord = { ...event, seq: list.length };
    list.push(stored);
    this.events.set(event.taskId, list);
    return stored;
  }

  listEvents(taskId: string, afterSeq: number, limit: number): readonly TaskEventRecord[] {
    return (this.events.get(taskId) ?? []).filter((event) => event.seq > afterSeq).slice(0, limit);
  }

  countEvents(taskId: string): number {
    return (this.events.get(taskId) ?? []).length;
  }

  findIdempotent(key: string): IdempotencyRecord | undefined {
    return this.idempotency.get(key);
  }

  async putIdempotent(record: IdempotencyRecord): Promise<void> {
    this.idempotency.set(record.key, record);
  }

  async putCallbackDelivery(record: CallbackDeliveryRecord): Promise<void> {
    this.callbacks.set(record.deliveryId, record);
  }

  findCallbackDelivery(deliveryId: string): CallbackDeliveryRecord | undefined {
    return this.callbacks.get(deliveryId);
  }

  listCallbackDeliveries(): readonly CallbackDeliveryRecord[] {
    return [...this.callbacks.values()];
  }

  async putPolicyMeta(record: PolicyMetaRecord): Promise<void> {
    this.policyMeta = record;
  }

  getPolicyMeta(): PolicyMetaRecord | undefined {
    return this.policyMeta;
  }
}

/** Composite key for one event row. */
function eventKey(taskId: string, seq: number): string {
  return `${taskId}\u0000${seq.toString().padStart(12, "0")}`;
}

/**
 * Ledger backed by `ctx.storageDomain`.
 *
 * Writes go through the domain's serialized write chain, so concurrent
 * dispatches never interleave a task projection with its events.
 */
export class StorageControlLedger implements ControlLedger {
  private readonly domain: Domain<typeof controlDomainSpec>;
  /**
   * 每个任务一条追加链，保证同一任务的 `appendEvent` 串行执行。
   *
   * seq 由「已有条数」推出，而读和写之间隔着 `await table.put(...)`。调用方
   * （`orchestrator.applySignal`）是以 `void` 触发的，同一 Session 的 `running` 与
   * `assistant_message` 常前后脚到达，两个调用会读到同一个条数、写同一个 key，**后写的静默
   * 覆盖先写的**——真机上就是因此丢了事件，而任务状态照样推进（`sawRunning` 在 await 之前
   * 就置位了），症状极难反推。
   *
   * 串行化按 taskId 分桶，所以一个任务的积压不会拖住别的任务。
   */
  private readonly appendChains = new Map<string, Promise<unknown>>();
  private closed = false;

  constructor(domain: Domain<typeof controlDomainSpec>) {
    this.domain = domain;
  }

  async init(adjudicator?: RecoveryAdjudicator): Promise<LedgerRecoveryReport> {
    const orphanedTaskIds: string[] = [];
    const consistentTaskIds: string[] = [];
    const deliveredTaskIds: string[] = [];
    const tasks = this.domain.table("tasks");
    const events = this.domain.table("task_events");

    for (const [taskId, task] of tasks.entries()) {
      const recorded = this.readEvents(taskId, -1, Number.MAX_SAFE_INTEGER);
      if (recorded.length === 0) {
        consistentTaskIds.push(taskId);
        continue;
      }
      const proven = statusFromEvents(recorded);
      if (proven === undefined || proven === task.status) {
        consistentTaskIds.push(taskId);
        continue;
      }
      // The projection disagrees with the append-only trail: the trail wins.
      orphanedTaskIds.push(taskId);
      const repaired: TaskRecord = { ...task, status: proven, updatedAt: new Date().toISOString(), lastCursor: recorded[recorded.length - 1]!.seq };
      await tasks.put(taskId, repaired);
    }

    // A non-terminal task whose process is gone can never resume. Before
    // declaring what happened, ask the host whether the session still exists:
    // "the message was delivered" and "nothing was ever sent" are very different
    // answers for the caller (plan §10.3).
    for (const [taskId, task] of tasks.entries()) {
      if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") continue;

      const delivered = wasDelivered(task.status);
      let sessionAlive = false;
      if (delivered && task.sessionId !== undefined && adjudicator !== undefined) {
        sessionAlive = await adjudicator.sessionExists(task.sessionId).catch(() => false);
      }
      const description = describeOrphan(task, sessionAlive);

      const time = new Date().toISOString();
      const event = await this.appendEvent({
        taskId,
        kind: "failed",
        status: "failed",
        time,
        summary: description.message,
      });
      await tasks.put(taskId, {
        ...task,
        status: "failed",
        updatedAt: time,
        lastCursor: event.seq,
        errorCode: description.code,
        errorMessage: description.message,
      });
      if (!orphanedTaskIds.includes(taskId)) orphanedTaskIds.push(taskId);
      if (delivered) deliveredTaskIds.push(taskId);
    }

    void events;
    return { orphanedTaskIds, consistentTaskIds, deliveredTaskIds };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.domain.close();
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.domain.table("tasks").get(taskId);
  }

  listTasks(): readonly TaskRecord[] {
    return [...this.domain.table("tasks").entries()].map(([, value]) => value);
  }

  async putTask(record: TaskRecord): Promise<void> {
    await this.domain.table("tasks").put(record.taskId, record);
  }

  async appendEvent(event: Omit<TaskEventRecord, "seq">): Promise<TaskEventRecord> {
    // 同一任务的追加排队执行；seq 的分配（读条数）与其落盘（写 key）之间不能再被别的
    // appendEvent 插进来，否则两者会算出同一个 seq、后写的覆盖先写的。
    const previous = this.appendChains.get(event.taskId) ?? Promise.resolve();
    const queued = previous.then(() => this.appendNow(event));
    // 链上只保留「已结束」的标记：失败不能毒化后续追加，成功也不必留住结果。
    this.appendChains.set(event.taskId, queued.then(
      () => undefined,
      () => undefined,
    ));
    return queued;
  }

  private async appendNow(event: Omit<TaskEventRecord, "seq">): Promise<TaskEventRecord> {
    const table = this.domain.table("task_events");
    const nextSeq = this.countEvents(event.taskId);
    const stored: TaskEventRecord = { ...event, seq: nextSeq };
    await table.put(eventKey(event.taskId, nextSeq), stored);
    return stored;
  }

  listEvents(taskId: string, afterSeq: number, limit: number): readonly TaskEventRecord[] {
    return this.readEvents(taskId, afterSeq, limit);
  }

  countEvents(taskId: string): number {
    let count = 0;
    for (const key of this.domain.table("task_events").keys()) {
      if (key.startsWith(`${taskId}\u0000`)) count += 1;
    }
    return count;
  }

  findIdempotent(key: string): IdempotencyRecord | undefined {
    return this.domain.table("idempotency").get(key);
  }

  async putIdempotent(record: IdempotencyRecord): Promise<void> {
    await this.domain.table("idempotency").put(record.key, record);
  }

  async putCallbackDelivery(record: CallbackDeliveryRecord): Promise<void> {
    await this.domain.table("callback_deliveries").put(record.deliveryId, record);
  }

  findCallbackDelivery(deliveryId: string): CallbackDeliveryRecord | undefined {
    return this.domain.table("callback_deliveries").get(deliveryId);
  }

  listCallbackDeliveries(): readonly CallbackDeliveryRecord[] {
    return [...this.domain.table("callback_deliveries").entries()].map(([, value]) => value);
  }

  async putPolicyMeta(record: PolicyMetaRecord): Promise<void> {
    await this.domain.table("policy_meta").put("current", record);
  }

  getPolicyMeta(): PolicyMetaRecord | undefined {
    return this.domain.table("policy_meta").get("current");
  }

  private readEvents(taskId: string, afterSeq: number, limit: number): TaskEventRecord[] {
    const prefix = `${taskId}\u0000`;
    const out: TaskEventRecord[] = [];
    for (const [key, value] of this.domain.table("task_events").entries()) {
      if (!key.startsWith(prefix)) continue;
      if (value.seq <= afterSeq) continue;
      out.push(value);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out.slice(0, limit);
  }
}

/**
 * Build the caller-facing error projection stored on a failed task.
 *
 * @param error - Failure raised while handling the request.
 * @returns The stable code plus a message safe to hand back.
 */
export function summarizeFailure(error: unknown): { code: ControlErrorCode; message: string } {
  if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && (CONTROL_ERROR_CODES as readonly string[]).includes(code)) {
      return { code: code as ControlErrorCode, message: String((error as { message: unknown }).message) };
    }
  }
  // Host errors are summarized, never forwarded: their message may embed paths,
  // environment values or an internal stack.
  return { code: "dsh-control/internal", message: "control plane failed to complete the request" };
}
