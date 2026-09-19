/**
 * Task/session event aggregation for the Lingbang control plane (plan §13).
 *
 * The aggregator turns host events into a small, bounded vocabulary that the
 * ledger can record. It is the only place that reads session payloads, and it
 * deliberately projects narrowly: event type, time, status, a short summary and
 * the session sequence. Tool arguments, tool results, file contents and model
 * reasoning never cross the control plane.
 *
 * @module @void/void-dsh-control/events
 */
import { boundAssistantText, LIMITS, type TaskStatus } from "./protocol.js";

/** Structural view of one committed session event. */
export interface SessionEventLike {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: unknown;
}

/** One task-level change derived from a host event. */
export interface TaskSignal {
  /** Status to record on the owning task. */
  readonly status: TaskStatus;
  /** Short, caller-safe account of what happened. */
  readonly summary: string;
  /** Session event sequence this signal corresponds to, when applicable. */
  readonly sessionSeq?: number;
  /** Assistant text to append to the task's bounded summary, when applicable. */
  readonly assistantText?: string;
}

/**
 * Narrow an unknown value to a plain record.
 *
 * @param value - Value to test.
 * @returns The record view, or `undefined`.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Extract visible assistant text from one message content array.
 *
 * Only `text` blocks are read; `reasoning`, `tool-call` and `tool-result` blocks
 * are intentionally ignored because they are not caller-facing content.
 *
 * @param content - Message content as stored in the session log.
 * @returns Concatenated visible text.
 */
export function visibleTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record === undefined) continue;
    if (record["type"] === "text" && typeof record["text"] === "string") parts.push(record["text"]);
  }
  return parts.join("");
}

/**
 * Derive task signals from one committed session event.
 *
 * @param event - Structural session event.
 * @returns Zero or more signals; an unrecognized event type yields none.
 */
export function signalsFromSessionEvent(event: SessionEventLike): readonly TaskSignal[] {
  const seq = event.seq;
  switch (event.type) {
    case "turn/start":
      return [{ status: "running", summary: "turn started", sessionSeq: seq }];
    case "assistant/message": {
      const data = asRecord(event.data);
      const message = asRecord(data?.["message"]);
      const text = visibleTextFromContent(message?.["content"]);
      return [
        {
          status: "assistant_message",
          summary: text.length > 0 ? "assistant message" : "assistant message (no visible text)",
          sessionSeq: seq,
          ...(text.length > 0 ? { assistantText: text } : {}),
        },
      ];
    }
    case "turn/end": {
      const data = asRecord(event.data);
      const reason = data?.["reason"];
      return [{ status: "idle", summary: `turn ended (${describeTurnEnd(reason)})`, sessionSeq: seq }];
    }
    default:
      return [];
  }
}

/**
 * Render a turn-end reason without echoing arbitrary host structure.
 *
 * @param reason - Turn end reason value from the session log.
 * @returns A short stable label.
 */
function describeTurnEnd(reason: unknown): string {
  const record = asRecord(reason);
  const kind = record?.["kind"];
  return typeof kind === "string" ? kind : "unknown";
}

/**
 * Derive the task signal for one agent status transition.
 *
 * @param running - Whether the agent is running.
 * @returns The corresponding signal.
 */
export function signalFromAgentStatus(running: boolean): TaskSignal {
  return running
    ? { status: "running", summary: "agent running" }
    : { status: "idle", summary: "agent idle" };
}

/**
 * Derive the task signal for one agent failure.
 *
 * @param message - User-safe failure chain supplied by the host.
 * @returns The corresponding signal.
 */
export function signalFromAgentError(message: string): TaskSignal {
  return { status: "failed", summary: `agent error: ${message.slice(0, 200)}` };
}

/**
 * Append assistant text to a task's bounded summary.
 *
 * The control plane keeps only a bounded tail-accumulated summary; full text
 * always remains readable from the session itself, which is the single source of
 * truth for model-visible content (plan §10.1, §13).
 *
 * @param previous - Summary accumulated so far.
 * @param addition - Newly observed assistant text.
 * @returns The bounded summary and whether it was cut.
 */
export function accumulateAssistantText(
  previous: string | undefined,
  addition: string,
): { text: string; truncated: boolean } {
  const joined = previous === undefined || previous.length === 0 ? addition : `${previous}\n\n${addition}`;
  return boundAssistantText(joined);
}

/** Maximum characters of one event summary kept in the ledger. */
export const MAX_EVENT_SUMMARY_CHARS = 240;

/**
 * Bound a summary before it is written to the ledger.
 *
 * @param summary - Candidate summary.
 * @returns The bounded summary.
 */
export function boundSummary(summary: string): string {
  return summary.length <= MAX_EVENT_SUMMARY_CHARS ? summary : `${summary.slice(0, MAX_EVENT_SUMMARY_CHARS)}…`;
}

/**
 * Whether a session sequence is worth reporting given the last one recorded.
 *
 * Guards against replayed or out-of-order event delivery producing duplicate
 * task events for the same session position.
 *
 * @param lastSessionSeq - Last session sequence already recorded, or `undefined`.
 * @param candidate - Candidate sequence.
 * @returns True when the candidate is new.
 */
export function isNewerSessionSeq(lastSessionSeq: number | undefined, candidate: number | undefined): boolean {
  if (candidate === undefined) return true;
  if (lastSessionSeq === undefined) return true;
  return candidate > lastSessionSeq;
}

/**
 * Map a bounded wait target onto the task status that satisfies it.
 *
 * @param until - Caller-requested wait target.
 * @returns The set of statuses that satisfy the wait.
 */
export function statusesSatisfying(until: string): readonly TaskStatus[] {
  switch (until) {
    case "running":
      return ["running", "assistant_message", "idle", "completed", "failed", "cancelled"];
    case "idle":
      return ["idle", "completed", "failed", "cancelled"];
    case "completed":
      return ["completed"];
    case "failed":
      return ["failed"];
    case "cancelled":
      return ["cancelled"];
    default:
      return [];
  }
}

/** Hard cap re-exported for callers that need to size an event page. */
export const EVENT_PAGE_LIMIT = LIMITS.maxEventPageSize;
