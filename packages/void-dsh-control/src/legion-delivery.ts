/**
 * Optional legion run-terminal delivery adapter (plan §16.2 L9).
 *
 * The control plane already knows how to sign, retry and time out one HTTP
 * delivery; legion already knows which runs reached a terminal state and keeps
 * that record on disk. This module is the seam between the two, and it keeps
 * the two halves of the boundary apart on purpose:
 *
 * - the transport ({@link CallbackTransport}) owns signature, timeout,
 *   allowlist, backoff and attempt accounting, and knows nothing about legion;
 * - the store is legion's own notification file, keyed by `eventId`, which is
 *   also the delivery id a receiver deduplicates by.
 *
 * Legion runs are not control-plane tasks, so nothing here fabricates a
 * `TaskRecord` and nothing imports legion's source: the host surface is
 * restated structurally, exactly like legion restates the entry's view
 * contract. A run that finishes while the endpoint is down is retried from the
 * file after a restart; the network stays at-least-once, and a receiver that
 * wants exactly-once must deduplicate by `eventId`.
 */

import { CallbackDeliveryQueue, CallbackTransport } from "./callback.js";
import type { CallbackDeliveryStore, CallbackTarget } from "./callback.js";

/**
 * Legion's terminal event name.
 *
 * Restated here rather than imported: the control plane never depends on
 * legion's package, and the two never share a compilation unit — legion
 * declares the same event on its side, which is what keeps both ends honest
 * about the payload shape.
 */
export const LEGION_RUN_TERMINAL_EVENT = "legion/run-terminal";

declare module "@deepseek-ai/cordis" {
  interface Events {
    /** A legion run reached a terminal state; carries {@link LegionRunEvent}. */
    "legion/run-terminal"(event: LegionRunEvent): void;
  }
}

/** Delivery bookkeeping legion keeps on the notification record itself. */
export interface LegionDeliveryState {
  /** Attempts spent across every process that tried to deliver this event. */
  readonly attempts: number;
  /** Set once a receiver accepted the event; the adapter's dedupe source. */
  readonly deliveredAt?: string;
  readonly lastError?: string;
}

/**
 * One legion run-terminal notification, as far as delivery needs to see it.
 *
 * Structurally identical to legion's `LegionRunFinished` plus its optional
 * `delivery` field — declared here rather than imported so the control plane
 * never depends on legion's package.
 */
export interface LegionRunEvent {
  readonly eventId: string;
  readonly runId: string;
  readonly teamId: string;
  readonly status: string;
  readonly finishedAt: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly resultRef: string;
  readonly delivery?: LegionDeliveryState;
}

/** The legion surface this adapter uses: its durable notification file. */
export interface LegionNotificationHost {
  /** Every recorded terminal event, newest first. */
  list(): Promise<readonly LegionRunEvent[]>;
  /**
   * Replace the delivery bookkeeping of one event.
   *
   * @returns Whether the event exists; a pruned event has nothing to write.
   */
  markDelivery(eventId: string, patch: LegionDeliveryState): Promise<boolean>;
}

/**
 * The legion service as this plugin sees it: only whether it publishes a
 * notification store. The store — not the service — implements
 * {@link LegionNotificationHost}, because the store owns the durable file and
 * the `delivery` bookkeeping. A legion installed without a data root publishes
 * no store, so there is nowhere to record a delivery and the adapter stays off.
 */
export interface LegionServiceLike {
  readonly notifications?: LegionNotificationHost | undefined;
}

/** Options of {@link LegionRunDelivery}. */
export interface LegionRunDeliveryOptions {
  readonly target: CallbackTarget | (() => CallbackTarget);
  readonly host: LegionNotificationHost;
  readonly secret?: string;
  readonly secretSource?: () => string;
  readonly send?: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /**
   * Whether legion delivery is wanted right now; defaults to always.
   *
   * Read per event rather than captured at mount, so flipping the panel switch
   * takes effect on the next terminal state instead of at the next restart.
   */
  readonly enabled?: () => boolean;
  /** Where an unreadable backlog is reported; defaults to staying silent. */
  readonly log?: { warn(message: string): void };
}

/**
 * The body of one legion delivery.
 *
 * Status and a controlled result link only: no member output, no SOUL body, no
 * session text. The receiver follows `resultRef` itself, under its own access
 * rules.
 */
export interface LegionCallbackPayload {
  readonly deliveryId: string;
  readonly eventId: string;
  readonly runId: string;
  readonly teamId: string;
  readonly status: string;
  readonly finishedAt: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly resultRef: string;
}

/**
 * Build the JSON body of one legion delivery.
 *
 * @param event - The terminal notification to deliver.
 * @returns The JSON-safe payload, whose `deliveryId` is legion's `eventId`.
 */
export function legionCallbackPayload(event: LegionRunEvent): LegionCallbackPayload {
  return {
    deliveryId: event.eventId,
    eventId: event.eventId,
    runId: event.runId,
    teamId: event.teamId,
    status: event.status,
    finishedAt: event.finishedAt,
    counts: event.counts,
    resultRef: event.resultRef,
  };
}

/**
 * Deliver legion run-terminal events through the shared callback transport.
 *
 * Mounted only when legion is present and the operator turned the adapter on.
 * The adapter is fire-and-forget in the same way the task dispatcher is: it
 * never blocks the run that just finished, and it never changes a run outcome.
 */
export class LegionRunDelivery {
  private readonly host: LegionNotificationHost;
  private readonly log: { warn(message: string): void } | undefined;
  private readonly enabled: () => boolean;
  private readonly transport: CallbackTransport;
  private readonly queue: CallbackDeliveryQueue;
  /** Events a receiver already accepted, seeded from the file on start. */
  private readonly delivered = new Set<string>();
  /** Cumulative attempts per event, seeded from the file on start. */
  private readonly attempts = new Map<string, number>();

  constructor(options: LegionRunDeliveryOptions) {
    this.host = options.host;
    this.log = options.log;
    this.enabled = options.enabled ?? (() => true);

    const store: CallbackDeliveryStore = {
      isDelivered: (deliveryId) => this.delivered.has(deliveryId),
      attemptsBefore: (deliveryId) => this.attempts.get(deliveryId) ?? 0,
      save: async (state) => {
        this.attempts.set(state.deliveryId, state.attempts);
        if (state.status === "delivered") this.delivered.add(state.deliveryId);
        await this.host.markDelivery(state.deliveryId, {
          attempts: state.attempts,
          ...(state.status === "delivered" ? { deliveredAt: state.updatedAt } : {}),
          ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
        });
      },
    };

    this.transport = new CallbackTransport({
      target: options.target,
      store,
      ...(options.secret === undefined ? {} : { secret: options.secret }),
      ...(options.secretSource === undefined ? {} : { secretSource: options.secretSource }),
      ...(options.send === undefined ? {} : { send: options.send }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.now === undefined ? {} : { now: options.now }),
      isStopped: () => this.queue.stopped,
    });
    this.queue = new CallbackDeliveryQueue({ transport: this.transport, store });
  }

  /** Whether the adapter has somewhere to deliver to right now. */
  get active(): boolean {
    return this.transport.active;
  }

  /** Delivery chains still running, for diagnostics. */
  get inflightCount(): number {
    return this.queue.inflightCount;
  }

  /**
   * Deliver one terminal event.
   *
   * Called from legion's event hook, so it must return immediately: the run
   * record is already committed, and the caller is the run's own write path.
   *
   * @param event - The terminal notification.
   * @returns Whether a delivery chain was started.
   */
  onTerminal(event: LegionRunEvent): boolean {
    if (this.transport.url === undefined || this.queue.stopped) return false;
    if (!this.enabled()) return false;
    if (!this.transport.target.events.includes(event.status)) return false;
    const body = JSON.stringify(legionCallbackPayload(event));
    return this.queue.schedule(event.eventId, event.status, body);
  }

  /**
   * Catch up on the terminal events that were never delivered.
   *
   * Run when the adapter mounts and again whenever it remounts (a legion
   * restart, or an endpoint that was unavailable earlier), so a finished run is
   * not lost just because nobody was listening. Oldest first, so the receiver
   * sees runs in the order they finished.
   *
   * @returns How many delivery chains were started.
   */
  async start(): Promise<number> {
    let records: readonly LegionRunEvent[];
    try {
      records = await this.host.list();
    } catch (error) {
      // A damaged notification file must not stop the control plane from
      // mounting; the adapter just has no backlog to catch up on.
      const detail = error instanceof Error ? error.message : "unknown error";
      this.log?.warn(`legion notification backlog unreadable: ${detail}`);
      return 0;
    }

    let scheduled = 0;
    for (const record of [...records].reverse()) {
      if (record.delivery?.deliveredAt !== undefined) {
        this.delivered.add(record.eventId);
        continue;
      }
      this.attempts.set(record.eventId, record.delivery?.attempts ?? 0);
      if (this.onTerminal(record)) scheduled += 1;
    }
    return scheduled;
  }

  /** Wait for in-flight delivery chains without refusing new ones. */
  async settle(): Promise<void> {
    await this.queue.settle();
  }

  /** Stop accepting new deliveries and wait for in-flight chains to settle. */
  async drain(): Promise<void> {
    await this.queue.drain();
  }
}
