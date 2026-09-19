/**
 * Task lifecycle state machine and idempotency keying for the Lingbang control
 * plane (plan §6.1, §9.2, §10.3).
 *
 * The machine is intentionally small and total: every status has an explicit
 * successor list, terminal statuses have none, and `failed`/`cancelled` are
 * reachable from every non-terminal status so an aborted dispatch never has to
 * invent an illegal hop.
 *
 * @module @void/void-dsh-control/state-machine
 */
import { ControlError, TASK_STATUSES, TERMINAL_STATUSES, type TaskStatus } from "./protocol.js";

/**
 * Legal successors per status.
 *
 * Admission chain: `accepted → workspace_resolved → (session_created |
 * session_resumed) → prompt_queued`. Observation then alternates
 * `running ↔ assistant_message` until the agent settles into `idle`, from which
 * the task completes. `failed` and `cancelled` are appended to every
 * non-terminal row rather than repeated inline.
 */
const ADMISSION_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  accepted: ["workspace_resolved"],
  workspace_resolved: ["session_created", "session_resumed"],
  session_created: ["prompt_queued"],
  session_resumed: ["prompt_queued"],
  prompt_queued: ["running", "idle"],
  running: ["assistant_message", "idle"],
  assistant_message: ["running", "idle"],
  idle: ["running", "completed"],
  completed: [],
  failed: [],
  cancelled: [],
};

/** Complete transition table including the universal failure exits. */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = Object.freeze(
  Object.fromEntries(
    TASK_STATUSES.map((status) => {
      const base = ADMISSION_TRANSITIONS[status];
      if (isTerminal(status)) return [status, base];
      const exits = (["failed", "cancelled"] as const).filter((exit) => !base.includes(exit));
      return [status, [...base, ...exits]];
    }),
  ) as Record<TaskStatus, readonly TaskStatus[]>,
);

/**
 * Whether a status admits no further transition.
 *
 * @param status - Status to test.
 * @returns True for `completed`, `failed` and `cancelled`.
 */
export function isTerminal(status: TaskStatus): boolean {
  return (TERMINAL_STATUSES as readonly TaskStatus[]).includes(status);
}

/**
 * Whether one lifecycle hop is legal.
 *
 * @param from - Current status.
 * @param to - Proposed next status.
 * @returns True when the hop is in {@link TASK_TRANSITIONS}.
 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/**
 * Assert that a lifecycle hop is legal, failing with a stable control error
 * otherwise. Illegal hops indicate a bug in the orchestrator, never caller
 * input, so the message names both statuses for diagnostics.
 *
 * @param from - Current status.
 * @param to - Proposed next status.
 * @throws ControlError `dsh-control/internal` when the hop is illegal.
 */
export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (from === to) return;
  if (canTransition(from, to)) return;
  throw new ControlError("dsh-control/internal", `illegal task transition: ${from} -> ${to}`, { from, to });
}

/**
 * Statuses a caller may pass as `wait.until` for a dispatch call.
 *
 * `accepted` is always already satisfied by the time the tool answers, so it is
 * the "do not wait" value.
 */
export const DISPATCH_WAIT_TARGETS = [
  "accepted",
  "session_created",
  "session_resumed",
  "prompt_queued",
  "running",
  "idle",
  "completed",
  "failed",
  "cancelled",
] as const;

/** One `wait.until` target accepted by `dsh_dispatch_session_task`. */
export type DispatchWaitTarget = (typeof DISPATCH_WAIT_TARGETS)[number];

/** Observation order used to decide whether a wait target is already reached. */
const ADMISSION_RANK: Readonly<Record<TaskStatus, number>> = {
  accepted: 0,
  workspace_resolved: 1,
  session_created: 2,
  session_resumed: 2,
  prompt_queued: 3,
  running: 4,
  assistant_message: 5,
  idle: 6,
  completed: 7,
  failed: 7,
  cancelled: 7,
};

/**
 * Whether a current status already satisfies a wait target.
 *
 * A target expressed as an admission phase is satisfied once the task has
 * reached that phase or later. A terminal target is satisfied only by that exact
 * terminal status, because `failed` must never be reported as `completed`.
 *
 * @param current - Current task status.
 * @param target - Requested wait target.
 * @returns True when the caller's wait is already satisfied.
 */
export function satisfiesWait(current: TaskStatus, target: DispatchWaitTarget): boolean {
  if (target === "accepted") return true;
  if (target === "failed" || target === "cancelled") return current === target;
  if (target === "completed") return current === "completed";
  return ADMISSION_RANK[current] >= ADMISSION_RANK[target];
}

/**
 * Build the idempotency key for one caller request.
 *
 * Idempotency is scoped by caller so two different callers may safely reuse the
 * same `requestId` (plan §6.1). The key is a plain string because it is stored
 * as a ledger table key.
 *
 * @param callerId - Stable identity of the authenticated caller.
 * @param requestId - Caller-generated request identity.
 * @returns The composite ledger key.
 */
export function idempotencyKey(callerId: string, requestId: string): string {
  return `${callerId}\u0000${requestId}`;
}

/**
 * Mint a task identity. Task ids are process-minted and carry no caller input,
 * so they are safe to log and to hand back verbatim.
 *
 * @param now - Clock value used for the monotonic suffix.
 * @param counter - Process-local monotonic counter.
 * @returns The task id.
 */
export function mintTaskId(now: number, counter: number): string {
  return `task-${now.toString(36)}-${counter.toString(36)}`;
}
