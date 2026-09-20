/**
 * Optional outbound webhook for callers that cannot hold an MCP connection
 * (plan §9.2).
 *
 * Scope is deliberately narrow:
 *
 * - the URL comes from user configuration only, never from a request;
 * - the payload carries the task summary and cursor, never a session transcript;
 * - the model-visible assistant summary is opt-in, because it is model output;
 * - every delivery is HMAC-signed over `timestamp.body` so the receiver can
 *   reject replays, and carries a stable `deliveryId` for receiver-side
 *   deduplication;
 * - delivery never blocks the orchestrator, and disposal can drain it.
 *
 * @module @void/void-dsh-control/callback
 */
import { createHmac } from "node:crypto";
import { ControlError, formatCursor } from "./protocol.js";
import type { ControlLedger, TaskEventRecord, TaskRecord } from "./ledger.js";

/** User-configured callback target. */
export interface CallbackTarget {
  /** Master switch. `false` makes the dispatcher inert. */
  readonly enabled: boolean;
  /** Absolute `http(s)` endpoint. Configured by the user; never caller-supplied. */
  readonly url: string;
  /** Environment variable holding the shared HMAC secret. */
  readonly secretEnv: string;
  /** Task statuses worth notifying. */
  readonly events: readonly string[];
  /** Per-attempt timeout. */
  readonly timeoutMs: number;
  /** Total attempts before the delivery is marked failed. */
  readonly maxAttempts: number;
  /**
   * Optional host allowlist. Non-empty means the configured URL's host must be
   * one of these; it is a second pair of eyes on the configuration, not a
   * substitute for configuring a sane URL.
   */
  readonly allowedHosts?: readonly string[];
  /** Whether the payload may include model-produced assistant text. */
  readonly includeAssistantSummary?: boolean;
}

/** One outbound delivery attempt record, as observed by a test or a receiver. */
export interface CallbackAttempt {
  readonly deliveryId: string;
  readonly url: string;
  readonly attempt: number;
  readonly signature: string;
  readonly body: string;
}

/** Options of {@link WebhookCallbackDispatcher}. */
export interface CallbackDispatcherOptions {
  /**
   * Callback target, or a provider for it. Prefer the provider form: the
   * settings panel can retarget or disable the webhook while the endpoint is
   * live, and a fixed object would keep delivering to the url resolved at
   * activation (plan §29.7 P2).
   */
  readonly target: CallbackTarget | (() => CallbackTarget);
  readonly ledger: ControlLedger;
  /** Fixed secret value. Ignored when {@link secretSource} is given. */
  readonly secret?: string;
  /**
   * Secret provider, consulted per delivery so a rotated
   * `target.secretEnv` value is picked up without a restart.
   */
  readonly secretSource?: () => string;
  /** Transport, injectable for tests. Defaults to global `fetch`. */
  readonly send?: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;
  /** Delay primitive, injectable so backoff does not slow tests down. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Clock, injectable for deterministic timestamps. */
  readonly now?: () => number;
}

/** First retry delay; each further attempt doubles it up to the cap. */
export const CALLBACK_BASE_BACKOFF_MS = 1_000;

/** Upper bound on one retry delay. */
export const CALLBACK_MAX_BACKOFF_MS = 60_000;

/**
 * Compute the delay before one retry.
 *
 * @param attempt - Zero-based index of the attempt that just failed.
 * @returns Milliseconds to wait, capped.
 */
export function backoffDelayMs(attempt: number): number {
  return Math.min(CALLBACK_BASE_BACKOFF_MS * 2 ** attempt, CALLBACK_MAX_BACKOFF_MS);
}

/**
 * Validate a configured callback target.
 *
 * @param target - Target as written in configuration.
 * @param secret - Resolved secret value.
 * @returns The resolved URL, or `undefined` when delivery is disabled.
 * @throws ControlError `dsh-control/internal` on an unusable configuration.
 */
export function resolveCallbackUrl(target: CallbackTarget, secret: string): string | undefined {
  if (!target.enabled) return undefined;
  if (secret.length === 0) {
    throw new ControlError("dsh-control/internal", `callback is enabled but ${target.secretEnv} is unset`);
  }
  let url: URL;
  try {
    url = new URL(target.url);
  } catch {
    throw new ControlError("dsh-control/internal", "callback.url is not a valid absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ControlError("dsh-control/internal", "callback.url must use http or https");
  }
  if (target.allowedHosts !== undefined && target.allowedHosts.length > 0 && !target.allowedHosts.includes(url.host)) {
    throw new ControlError("dsh-control/internal", "callback.url host is not in callback.allowedHosts", { host: url.host });
  }
  if (target.maxAttempts < 1) {
    throw new ControlError("dsh-control/internal", "callback.maxAttempts must be at least 1");
  }
  return url.href;
}

/**
 * Build the JSON body of one delivery.
 *
 * Only bounded task facts travel: identity, status, cursor and time. The
 * assistant summary is model-produced text and is therefore opt-in.
 *
 * @param record - Task projection at the moment of the event.
 * @param event - The event that triggered the delivery.
 * @param includeAssistantSummary - Whether model text may be included.
 * @returns The JSON-safe payload.
 */
export function callbackPayload(
  record: TaskRecord,
  event: TaskEventRecord,
  includeAssistantSummary: boolean,
): Record<string, unknown> {
  return {
    deliveryId: `${record.taskId}:${event.seq}`,
    taskId: record.taskId,
    callerId: record.callerId,
    requestId: record.requestId,
    status: event.status,
    eventKind: event.kind,
    time: event.time,
    eventCursor: formatCursor(event.seq),
    summary: event.summary,
    ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
    ...(includeAssistantSummary && record.assistantSummary !== undefined
      ? { assistantSummary: record.assistantSummary }
      : {}),
  };
}

/**
 * Parse a delivery id back into the event it belongs to.
 *
 * @param deliveryId - `<taskId>:<seq>`.
 * @returns The parts, or `undefined` when the id is not in that shape.
 */
export function parseDeliveryId(deliveryId: string): { taskId: string; seq: number } | undefined {
  const separator = deliveryId.lastIndexOf(":");
  if (separator <= 0) return undefined;
  const seq = Number(deliveryId.slice(separator + 1));
  if (!Number.isInteger(seq) || seq < 0) return undefined;
  return { taskId: deliveryId.slice(0, separator), seq };
}

/**
 * Sign one delivery body.
 *
 * The signed string is `timestamp.body`, so a receiver that rejects an old
 * timestamp also rejects a replayed body with a fresh signature.
 *
 * @param secret - Shared secret.
 * @param timestamp - Unix seconds.
 * @param body - Exact serialized body.
 * @returns The `sha256=<hex>` signature value.
 */
export function signCallbackBody(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/**
 * Fire-and-forget webhook dispatcher with retry, backoff and ledger-backed
 * deduplication.
 */
export class WebhookCallbackDispatcher {
  private readonly targetSource: () => CallbackTarget;
  private readonly ledger: ControlLedger;
  private readonly secretSource: () => string;
  private readonly send: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly inflight = new Set<Promise<void>>();
  private stopped = false;

  constructor(options: CallbackDispatcherOptions) {
    this.targetSource = typeof options.target === "function" ? options.target : () => options.target as CallbackTarget;
    this.ledger = options.ledger;
    const fixedSecret = options.secret ?? "";
    this.secretSource = options.secretSource ?? (() => fixedSecret);
    this.send = options.send ?? ((url, init) => fetch(url, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
  }

  /** The target in force right now. */
  private get target(): CallbackTarget {
    return this.targetSource();
  }

  /** The shared secret in force right now. */
  private get secret(): string {
    return this.secretSource();
  }

  /**
   * The delivery URL in force right now.
   *
   * Re-resolved per use rather than cached at construction: `resolveCallbackUrl`
   * is a URL parse plus a host-list check, and caching it would freeze the
   * retarget the settings panel can perform while the endpoint is live.
   */
  private get url(): string | undefined {
    return resolveCallbackUrl(this.target, this.secret);
  }

  /** Whether this dispatcher will actually deliver anything. */
  get active(): boolean {
    return this.url !== undefined;
  }

  /**
   * Consider one committed task event for delivery.
   *
   * Returns as soon as the attempt chain has been **scheduled**; it never awaits
   * the network. The orchestrator calls this from inside its lifecycle write, so
   * awaiting here would let a slow receiver — or a backoff chain of up to
   * `maxAttempts` — stall task progression (plan §9.2, §12).
   *
   * @param record - Task projection after the event.
   * @param event - The committed event.
   */
  onTaskEvent(record: TaskRecord, event: TaskEventRecord): void {
    if (this.url === undefined || this.stopped) return;
    if (!this.target.events.includes(event.status)) return;
    this.schedule(record, event);
  }

  /**
   * Re-schedule deliveries left `pending` by an earlier process.
   *
   * The delivery row stores only `taskId:seq`, so the payload is rebuilt from
   * the ledger — which is exactly why the ledger keeps both the projection and
   * the immutable event trail (plan §10.3).
   *
   * @returns How many deliveries were re-scheduled.
   */
  async resumePending(): Promise<number> {
    if (this.url === undefined) return 0;
    let resumed = 0;
    for (const delivery of this.ledger.listCallbackDeliveries()) {
      if (delivery.status !== "pending") continue;
      const parsed = parseDeliveryId(delivery.deliveryId);
      if (parsed === undefined) continue;
      const record = this.ledger.getTask(parsed.taskId);
      const event = this.ledger.listEvents(parsed.taskId, parsed.seq - 1, 1)[0];
      if (record === undefined || event === undefined || event.seq !== parsed.seq) continue;
      this.schedule(record, event);
      resumed += 1;
    }
    return resumed;
  }

  /**
   * Wait for in-flight delivery chains without refusing new ones.
   *
   * Separate from {@link drain} because the two answer different questions:
   * "has the work I scheduled finished?" versus "stop, and let the work already
   * scheduled finish". Only the latter may truncate a retry chain.
   */
  async settle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  /**
   * Stop accepting new deliveries and wait for in-flight chains to settle.
   *
   * Called during plugin disposal so the orchestrator quiesces before the route
   * and ledger go away (plan §15). A chain that is mid-retry finishes its
   * current attempt and then stops, so shutdown is bounded by one attempt
   * timeout rather than by the whole backoff schedule.
   */
  async drain(): Promise<void> {
    this.stopped = true;
    await this.settle();
  }

  /** Delivery chains still running, for diagnostics. */
  get inflightCount(): number {
    return this.inflight.size;
  }

  /**
   * Start one fire-and-forget delivery chain.
   *
   * @param record - Task projection after the event.
   * @param event - The committed event.
   */
  private schedule(record: TaskRecord, event: TaskEventRecord): void {
    const deliveryId = `${record.taskId}:${event.seq}`;
    // Deduplication is ledger-backed, so a retry after a restart does not
    // re-notify a receiver that already accepted the event.
    if (this.ledger.findCallbackDelivery(deliveryId)?.status === "delivered") return;

    const chain = this.deliver(record, event, deliveryId).catch(() => {
      // Delivery failures are already recorded in the ledger; never let one
      // escape as an unhandled rejection.
    });
    this.inflight.add(chain);
    void chain.then(
      () => this.inflight.delete(chain),
      () => this.inflight.delete(chain),
    );
  }

  private async deliver(record: TaskRecord, event: TaskEventRecord, deliveryId: string): Promise<void> {
    const url = this.url;
    if (url === undefined) return;

    const body = JSON.stringify(callbackPayload(record, event, this.target.includeAssistantSummary === true));

    for (let attempt = 0; attempt < this.target.maxAttempts; attempt += 1) {
      if (this.stopped) return;
      if (attempt > 0) await this.sleep(backoffDelayMs(attempt - 1));

      const timestamp = Math.floor(this.now() / 1000);
      const signature = signCallbackBody(this.secret, timestamp, body);
      const updatedAt = new Date(this.now()).toISOString();

      try {
        const response = await this.send(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-dsh-control-delivery": deliveryId,
            "x-dsh-control-event": event.status,
            "x-dsh-control-timestamp": String(timestamp),
            "x-dsh-control-signature": signature,
          },
          body,
          signal: AbortSignal.timeout(this.target.timeoutMs),
        });

        if (response.ok) {
          await this.ledger.putCallbackDelivery({
            deliveryId,
            taskId: record.taskId,
            event: event.status,
            attempts: attempt + 1,
            status: "delivered",
            updatedAt,
          });
          return;
        }

        await this.ledger.putCallbackDelivery({
          deliveryId,
          taskId: record.taskId,
          event: event.status,
          attempts: attempt + 1,
          status: attempt + 1 >= this.target.maxAttempts ? "failed" : "pending",
          // The status code is a protocol fact, not receiver content.
          lastError: `HTTP ${response.status}`,
          updatedAt,
        });
      } catch (error) {
        await this.ledger.putCallbackDelivery({
          deliveryId,
          taskId: record.taskId,
          event: event.status,
          attempts: attempt + 1,
          status: attempt + 1 >= this.target.maxAttempts ? "failed" : "pending",
          // The transport error message is summarized: it may embed the URL.
          lastError: error instanceof Error ? error.name : "unknown transport failure",
          updatedAt,
        });
      }
    }
  }
}
