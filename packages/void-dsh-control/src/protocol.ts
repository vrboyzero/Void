/**
 * Wire vocabulary for the Lingbang control plane: MCP tool input shapes,
 * stable error codes, event/status types, cursor rules and hard limits.
 *
 * This module is pure data + pure functions. It must stay free of Cordis, DSH
 * and Node dependencies so the protocol can be unit-tested and reused by any
 * carrier (MCP tools today, another transport later).
 *
 * @module @void/void-dsh-control/protocol
 */
import { z } from "zod";

/** MCP-facing protocol version. Bumped when tool shapes change incompatibly. */
export const CONTROL_PROTOCOL_VERSION = "1.0";

/** Hard bounds applied before any host call. Callers cannot raise these. */
export const LIMITS = {
  /** Maximum characters in one message `text`. */
  maxMessageChars: 32_000,
  /** Maximum messages in one dispatch request. */
  maxMessagesPerRequest: 16,
  /** Maximum document references in one message. */
  maxDocumentRefs: 8,
  /** Maximum bytes read from one `inline` document reference. */
  maxInlineDocumentBytes: 256 * 1024,
  /** Maximum bytes read across all `inline` references of one message. */
  maxInlineTotalBytes: 1024 * 1024,
  /** Maximum `wait.timeoutMs` a caller may request. */
  maxWaitMs: 120_000,
  /** Maximum events returned by one `dsh_get_task` / `dsh_wait_task` page. */
  maxEventPageSize: 200,
  /** Maximum characters of assistant text surfaced through the control plane. */
  maxAssistantSummaryChars: 2_000,
  /** Maximum accepted HTTP body size for the MCP endpoint. */
  maxRequestBodyBytes: 1024 * 1024,
  /** Maximum simultaneously non-terminal tasks owned by one caller. */
  maxConcurrentTasksPerCaller: 8,
  /** Maximum characters accepted in a caller-supplied `requestId`. */
  maxRequestIdChars: 200,
} as const;

/**
 * Stable, caller-facing error codes. These are contract: they are documented in
 * the plugin README, returned to MCP callers and asserted by tests. Never
 * renumber or reuse a code for a different meaning.
 */
export const CONTROL_ERROR_CODES = [
  "dsh-control/invalid-request",
  "dsh-control/unauthorized",
  "dsh-control/forbidden-operation",
  "dsh-control/policy-required-field",
  "dsh-control/policy-document-missing",
  "dsh-control/policy-document-invalid",
  "dsh-control/policy-forbidden-content",
  "dsh-control/workspace-path-invalid",
  "dsh-control/workspace-not-allowed",
  "dsh-control/workspace-not-found",
  "dsh-control/session-not-found",
  "dsh-control/session-workspace-mismatch",
  "dsh-control/session-locked",
  "dsh-control/task-not-found",
  "dsh-control/limit-exceeded",
  "dsh-control/host-unavailable",
  "dsh-control/capability-unavailable",
  "dsh-control/internal",
] as const;

/** One stable control-plane error code. */
export type ControlErrorCode = (typeof CONTROL_ERROR_CODES)[number];

/**
 * A failure that is safe to hand to an external caller: a stable code, a
 * human-readable message and non-sensitive structured details. Internal stack
 * traces and host error chains must be summarized, never forwarded verbatim.
 */
export class ControlError extends Error {
  readonly code: ControlErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: ControlErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ControlError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  /** Serialize to the caller-facing MCP tool error payload. */
  toPayload(): { code: ControlErrorCode; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: { ...this.details } };
  }
}

/**
 * Task lifecycle vocabulary published to callers (plan §9.2). `accepted` through
 * `prompt_queued` are admission phases, `running`/`assistant_message`/`idle` are
 * observation phases, and `completed`/`failed`/`cancelled` are terminal.
 */
export const TASK_STATUSES = [
  "accepted",
  "workspace_resolved",
  "session_created",
  "session_resumed",
  "prompt_queued",
  "running",
  "assistant_message",
  "idle",
  "completed",
  "failed",
  "cancelled",
] as const;

/** One task lifecycle status. */
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses after which no further transition is legal. */
export const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const satisfies readonly TaskStatus[];

/** Task event kinds recorded in the ledger. Status events reuse {@link TaskStatus}. */
export const TASK_EVENT_KINDS = [
  ...TASK_STATUSES,
  "policy_rejected",
  "idempotent_replay",
] as const;

/** One recorded task event kind. */
export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];

/** Delivery modes accepted by `dsh_dispatch_session_task` / `dsh_send_message`. */
export const MESSAGE_MODES = ["queue", "steer", "inject"] as const;

/** One message delivery mode. */
export type MessageMode = (typeof MESSAGE_MODES)[number];

/** Document reference modes (plan §8.2). */
export const DOCUMENT_REF_MODES = ["reference", "inline"] as const;

/** One document reference mode. */
export type DocumentRefMode = (typeof DOCUMENT_REF_MODES)[number];

/**
 * Operations a token may be granted (plan §11 security requirement 4). These are
 * deliberately finer-grained than MCP tools so read-only callers can be
 * separated from callers allowed to steer or cancel.
 */
export const CONTROL_OPERATIONS = [
  "workspace.read",
  "workspace.open",
  "session.list",
  "session.create",
  "session.prompt",
  "session.plan",
  "session.inject",
  "session.steer",
  "session.observe",
  "task.read",
  "task.cancel",
] as const;

/** One grantable control-plane operation. */
export type ControlOperation = (typeof CONTROL_OPERATIONS)[number];

/** Operations implied by a granted operation; grants are transitive downward. */
const OPERATION_IMPLICATIONS: Readonly<Record<ControlOperation, readonly ControlOperation[]>> = {
  "workspace.read": [],
  "workspace.open": ["workspace.read"],
  "session.list": [],
  "session.create": ["workspace.read"],
  "session.prompt": ["session.create"],
  "session.plan": ["session.create"],
  "session.inject": ["session.create"],
  "session.steer": ["session.create"],
  "session.observe": [],
  "task.read": [],
  "task.cancel": ["task.read", "session.observe"],
};

/**
 * Expand a granted operation set with its implied operations.
 *
 * @param granted - Operations named by configuration.
 * @returns A frozen set containing every granted operation plus implications.
 */
export function expandOperations(granted: readonly ControlOperation[]): ReadonlySet<ControlOperation> {
  const out = new Set<ControlOperation>();
  const visit = (op: ControlOperation): void => {
    if (out.has(op)) return;
    out.add(op);
    for (const implied of OPERATION_IMPLICATIONS[op]) visit(implied);
  };
  for (const op of granted) visit(op);
  return out;
}

/** Zod enum of every grantable operation, for config validation. */
export const controlOperationSchema = z.enum(CONTROL_OPERATIONS);

/** Zod enum of every task status. */
export const taskStatusSchema = z.enum(TASK_STATUSES);

/** Zod enum of every message mode. */
export const messageModeSchema = z.enum(MESSAGE_MODES);

/** Zod enum of every document reference mode. */
export const documentRefModeSchema = z.enum(DOCUMENT_REF_MODES);

/** Workspace addressing: by registry identity, or by absolute host path. */
export const workspaceTargetShape = {
  workspaceId: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
};

/**
 * Strict workspace target for direct validation.
 *
 * The MCP tool shape deliberately does NOT use this refined form: some MCP SDK
 * versions convert `.refine()` into a protocol-level `-32602` error, which would
 * replace our stable `dsh-control/invalid-request` code with the SDK's own
 * message. The tool shape stays permissive and the cross-field rule is enforced
 * in the handler, so the caller always gets a published error code.
 */
export const workspaceTargetSchema = z
  .object(workspaceTargetShape)
  .refine((value) => (value.workspaceId === undefined) !== (value.path === undefined), {
    message: "workspace target must set exactly one of workspaceId or path",
  });

/** Permissive workspace target used inside MCP tool input shapes. */
export const workspaceTargetInputSchema = z.object(workspaceTargetShape);

/** Session addressing: new, existing, or fork from an existing session. */
export const sessionTargetSchema = z.union([
  z.literal("new"),
  z.object({ sessionId: z.string().min(1) }),
  z.object({ forkFrom: z.string().min(1), atSeq: z.number().int().nonnegative().optional() }),
]);

/** One document reference attached to a message. */
export const documentRefShape = {
  path: z.string().min(1),
  mode: documentRefModeSchema.default("reference"),
};

/** Zod object for {@link documentRefShape}. */
export const documentRefSchema = z.object(documentRefShape);

/** One message to deliver into a session. */
export const messageShape = {
  text: z.string().min(1).max(LIMITS.maxMessageChars),
  mode: messageModeSchema.default("queue"),
  documentRefs: z.array(documentRefSchema).max(LIMITS.maxDocumentRefs).default([]),
};

/** Zod object for {@link messageShape}. */
export const messageSchema = z.object(messageShape);

/** Wait strategy for a tool call; controls only the MCP response, never the agent. */
export const waitShape = {
  until: z.enum(["accepted", "session_created", "session_resumed", "prompt_queued", "running", "idle", "completed", "failed", "cancelled"]).default("accepted"),
  timeoutMs: z.number().int().min(0).max(LIMITS.maxWaitMs).default(10_000),
};

/** Zod object for {@link waitShape}. */
export const waitSchema = z.object(waitShape);

/**
 * Caller-supplied audit metadata. Free-form JSON, validated against the user's
 * `requiredFields` policy. It never becomes model-visible content by itself
 * (plan §6.1): anything the model must see has to travel in `messages[].text`.
 */
export const metadataSchema = z.record(z.string(), z.unknown());

/** Input shape of `dsh_dispatch_session_task`. */
export const dispatchInputShape = {
  requestId: z.string().min(1).max(LIMITS.maxRequestIdChars).describe("Caller-generated idempotency key, unique per caller."),
  target: z
    .object({
      workspace: workspaceTargetInputSchema,
      session: sessionTargetSchema,
    })
    .describe("Workspace plus session addressing. `session: 'new'` creates a fresh session."),
  messages: z.array(messageSchema).min(1).max(LIMITS.maxMessagesPerRequest),
  wait: waitSchema.optional(),
  metadata: metadataSchema.optional(),
};

/** Zod object for {@link dispatchInputShape}. */
export const dispatchInputSchema = z.object(dispatchInputShape);

/** Native planning shares dispatch targeting and policy, but fixes delivery to /plan. */
export const dispatchPlanInputShape = {
  requestId: dispatchInputShape.requestId,
  target: dispatchInputShape.target,
  task: z.string().trim().min(1).max(LIMITS.maxMessageChars)
    .refine((text) => text !== "off", "off is reserved by the native /plan command")
    .describe("Task to plan. The agent submits its plan for approval in the native Web review card."),
  documentRefs: messageShape.documentRefs,
  wait: dispatchInputShape.wait,
  metadata: dispatchInputShape.metadata,
};

/** Validated native plan dispatch input. */
export const dispatchPlanInputSchema = z.object(dispatchPlanInputShape);

/** Input shape of `dsh_send_message`. */
export const sendMessageInputShape = {
  requestId: z.string().min(1).max(LIMITS.maxRequestIdChars),
  sessionId: z.string().min(1),
  message: messageSchema,
  metadata: metadataSchema.optional(),
};

/** Zod object for {@link sendMessageInputShape}. */
export const sendMessageInputSchema = z.object(sendMessageInputShape);

/** Input shape of `dsh_inject_context`. */
export const injectContextInputShape = {
  requestId: z.string().min(1).max(LIMITS.maxRequestIdChars),
  sessionId: z.string().min(1),
  text: z.string().min(1).max(LIMITS.maxMessageChars),
  documentRefs: z.array(documentRefSchema).max(LIMITS.maxDocumentRefs).default([]),
};

/** Zod object for {@link injectContextInputShape}. */
export const injectContextInputSchema = z.object(injectContextInputShape);

/** Input shape of `dsh_list_workspaces`. */
export const listWorkspacesInputShape = {
  pathPrefix: z.string().min(1).optional().describe("Optional absolute path prefix filter."),
};

/** Zod object for {@link listWorkspacesInputShape}. */
export const listWorkspacesInputSchema = z.object(listWorkspacesInputShape);

/** Input shape of `dsh_list_sessions`. */
export const listSessionsInputShape = {
  workspaceId: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  includeArchived: z.boolean().default(false),
};

/** Zod object for {@link listSessionsInputShape}. */
export const listSessionsInputSchema = z.object(listSessionsInputShape);

/** Input shape of `dsh_get_task`. */
export const getTaskInputShape = {
  taskId: z.string().min(1),
  afterCursor: z.string().regex(/^\d+$/).optional().describe("Return only events after this cursor."),
  limit: z.number().int().min(1).max(LIMITS.maxEventPageSize).default(50),
};

/** Zod object for {@link getTaskInputShape}. */
export const getTaskInputSchema = z.object(getTaskInputShape);

/** Input shape of `dsh_wait_task`. */
export const waitTaskInputShape = {
  taskId: z.string().min(1),
  afterCursor: z.string().regex(/^\d+$/).optional(),
  until: z.enum(["running", "idle", "completed", "failed", "cancelled"]).default("completed"),
  timeoutMs: z.number().int().min(0).max(LIMITS.maxWaitMs).default(30_000),
  limit: z.number().int().min(1).max(LIMITS.maxEventPageSize).default(50),
};

/** Zod object for {@link waitTaskInputShape}. */
export const waitTaskInputSchema = z.object(waitTaskInputShape);

/** Input shape of `dsh_cancel_task`. */
export const cancelTaskInputShape = {
  taskId: z.string().min(1),
  requestId: z.string().min(1).max(LIMITS.maxRequestIdChars).optional(),
};

/** Zod object for {@link cancelTaskInputShape}. */
export const cancelTaskInputSchema = z.object(cancelTaskInputShape);

/**
 * Parse a caller-supplied cursor.
 *
 * Cursors are decimal strings of the highest task-event sequence the caller has
 * already observed. They are opaque to callers but deliberately readable in
 * logs; `undefined` means "from the beginning".
 *
 * @param raw - Cursor string as received on the wire.
 * @returns The numeric position, or `-1` when absent (meaning "all events").
 */
export function parseCursor(raw: string | undefined): number {
  if (raw === undefined) return -1;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : -1;
}

/**
 * Render an event sequence as a caller-facing cursor.
 *
 * @param seq - Highest observed task-event sequence, or `-1` when none.
 * @returns The decimal cursor string.
 */
export function formatCursor(seq: number): string {
  return String(seq < 0 ? 0 : seq);
}

/** One bounded projection of a task event handed to external callers. */
export interface TaskEventView {
  readonly seq: number;
  readonly kind: TaskEventKind;
  readonly status: TaskStatus;
  readonly time: string;
  readonly summary: string;
  readonly sessionSeq?: number;
}

/** Bounded task projection handed to external callers. */
export interface TaskView {
  readonly taskId: string;
  readonly callerId: string;
  readonly requestId: string;
  readonly status: TaskStatus;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly eventCursor: string;
  readonly error?: { readonly code: ControlErrorCode; readonly message: string };
  readonly assistantSummary?: string;
  readonly assistantSummaryTruncated?: boolean;
}

/** Workspace projection returned by `dsh_list_workspaces` / dispatch. */
export interface WorkspaceProjection {
  readonly workspaceId: string;
  readonly path: string;
  readonly title: string;
  readonly sessionCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Session projection returned by `dsh_list_sessions`. */
export interface SessionProjection {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly running: boolean;
  readonly blank: boolean;
  readonly updatedAt: string;
  readonly resumable: boolean;
  readonly parentSessionId?: string;
}

/** Result of one accepted dispatch, as returned to the MCP caller. */
export interface DispatchResult {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly status: TaskStatus;
  readonly eventCursor: string;
  readonly callerInstructions: string;
  readonly instructionsVersion: number;
  readonly events?: readonly TaskEventView[];
}

/**
 * Truncate assistant text to the control-plane bound, reporting whether the
 * value was cut so callers know to read the session itself for the full text.
 *
 * @param text - Raw assistant text accumulated for the task.
 * @returns The bounded text and a truncation flag.
 */
export function boundAssistantText(text: string): { text: string; truncated: boolean } {
  const limit = LIMITS.maxAssistantSummaryChars;
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}
