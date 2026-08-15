import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  ConversationMemoryExtractionSupport,
  DurableMemoryCandidateType,
  DurableMemoryGuidance,
  DurableMemoryRejectionReasonCode,
  ExtractConversationMemoriesResult,
  ExtractConversationMemoriesOptions,
} from "./manager.js";
import {
  normalizeDurableExtractionRequestSource,
  normalizeDurableExtractionSkipReason,
  normalizeNonEmptyString,
  type DurableExtractionSkipReasonCode,
} from "./durable-extraction-policy.js";
import {
  selectDurableExtractionInput,
  type DurableExtractionInputLimits,
  type DurableExtractionInputSelection,
} from "./durable-extraction-input.js";

export type DurableExtractionStatus = "idle" | "queued" | "running" | "completed" | "failed";

export type DurableExtractionDigestSnapshot = {
  status?: string;
  threshold?: number;
  messageCount?: number;
  digestedMessageCount?: number;
  pendingMessageCount?: number;
  lastDigestAt?: number;
};

export type DurableExtractionRecord = {
  conversationId: string;
  status: DurableExtractionStatus;
  requestSource?: string;
  requestedAt?: number;
  requestedDigestAt?: number;
  requestedMessageCount?: number;
  requestedThreshold?: number;
  requestedDigestStatus?: string;
  startedAt?: number;
  finishedAt?: number;
  lastRunSource?: string;
  lastExtractedAt?: number;
  lastExtractedDigestAt?: number;
  lastExtractedMessageCount?: number;
  lastExtractedMemoryCount?: number;
  lastExtractionKey?: string;
  pending: boolean;
  pendingSource?: string;
  pendingRequestedAt?: number;
  pendingDigestAt?: number;
  pendingMessageCount?: number;
  pendingThreshold?: number;
  pendingDigestStatus?: string;
  runCount: number;
  updatedAt: number;
  consecutiveFailures?: number;
  nextEligibleAt?: number;
  lastExtractionSummary?: string;
  lastAcceptedCandidateTypes?: DurableMemoryCandidateType[];
  lastRejectedCount?: number;
  lastRejectedReasons?: DurableMemoryRejectionReasonCode[];
  error?: string;
  lastSkipReason?: DurableExtractionSkipReasonCode | string;
};

export type DurableExtractionChangeEvent = {
  kind: "updated";
  record: DurableExtractionRecord;
};

export type DurableExtractionRequestOutcome = "queued" | "skipped";

export type DurableExtractionRequestEvent = {
  conversationId: string;
  source: string;
  requestedAt: number;
  digestAt: number;
  messageCount: number;
  threshold?: number;
  digestStatus?: string;
  outcome: DurableExtractionRequestOutcome;
  reason?: DurableExtractionSkipReasonCode | string;
  record: DurableExtractionRecord;
};

export type DurableExtractionRunStartEvent = {
  conversationId: string;
  source: string;
  requestedAt: number;
  digestAt: number;
  messageCount: number;
  threshold?: number;
  digestStatus?: string;
  extractionKey: string;
  projectedRunCount: number;
};

export type DurableExtractionRunDecision = {
  allowed: boolean;
  reason?: DurableExtractionSkipReasonCode | string;
  retryAfterMs?: number;
};

export type DurableExtractionRunResultEvent = {
  conversationId: string;
  source: string;
  requestedAt: number;
  digestAt: number;
  messageCount: number;
  threshold?: number;
  digestStatus?: string;
  extractionKey: string;
  runCount: number;
  extractedCount: number;
  failure?: string;
};

export type DurableExtractionJobClaim = {
  generation: number;
  signal: AbortSignal;
  complete: <T>(commit: () => T | Promise<T>) => Promise<
    | { applied: true; value: T }
    | { applied: false }
  >;
  release: (outcome?: "skipped" | "failed") => Promise<void> | void;
};

export type DurableExtractionJobClaimResult = DurableExtractionJobClaim | {
  reason: string;
  reasonCode?: string;
  retryAfterMs?: number;
};

export type DurableExtractionRuntimeOptions = {
  stateDir: string;
  extractor: {
    extractMemoriesFromConversation(
      sessionKey: string,
      messages: Array<{ role: string; content: string }>,
      options?: ExtractConversationMemoriesOptions,
    ): Promise<number | ExtractConversationMemoriesResult>;
    isConversationMemoryExtractionEnabled(): boolean;
    getConversationMemoryExtractionSupport?(): ConversationMemoryExtractionSupport;
    getDurableMemoryGuidance?(): DurableMemoryGuidance;
    isPaused: boolean;
  };
  getMessages: (conversationId: string) => Promise<Array<{ role: string; content: string }>>;
  getDigest?: (conversationId: string) => Promise<DurableExtractionDigestSnapshot | undefined>;
  inputLimits?: DurableExtractionInputLimits;
  acquireJob?: (input: {
    conversationId: string;
    estimatedTokenUnits: number;
    signal: AbortSignal;
  }) => Promise<DurableExtractionJobClaimResult>;
  closeDeadlineMs?: number;
  retryDelayMs?: number;
  minPendingMessages?: number;
  minMessageDelta?: number;
  successCooldownMs?: number;
  failureBackoffMs?: number;
  failureBackoffMaxMs?: number;
  onRequest?: (event: DurableExtractionRequestEvent) => Promise<void> | void;
  canStartRun?: (event: DurableExtractionRunStartEvent) => Promise<DurableExtractionRunDecision | void> | DurableExtractionRunDecision | void;
  onRunStarted?: (event: DurableExtractionRunStartEvent) => Promise<void> | void;
  onRunFinished?: (event: DurableExtractionRunResultEvent) => Promise<void> | void;
  logger?: {
    debug?: (message: string, data?: unknown) => void;
    warn?: (message: string, data?: unknown) => void;
    error?: (message: string, data?: unknown) => void;
  };
};

type DurableExtractionState = {
  version: 1;
  items: DurableExtractionRecord[];
};

type ExtractionSnapshot = {
  source: string;
  requestedAt: number;
  digestAt: number;
  messageCount: number;
  threshold?: number;
  digestStatus?: string;
  pendingMessageCount?: number;
};

const STATE_VERSION = 1 as const;

function cloneRecord(record: DurableExtractionRecord): DurableExtractionRecord {
  return { ...record };
}

function normalizeSnapshot(
  source: string,
  digest: DurableExtractionDigestSnapshot | undefined,
  requestedAt: number,
): ExtractionSnapshot {
  return {
    source: normalizeDurableExtractionRequestSource(source) ?? normalizeNonEmptyString(source) ?? "manual",
    requestedAt,
    digestAt: Number.isFinite(Number(digest?.lastDigestAt)) ? Math.max(0, Number(digest?.lastDigestAt)) : 0,
    messageCount: Number.isFinite(Number(digest?.messageCount)) ? Math.max(0, Number(digest?.messageCount)) : 0,
    threshold: Number.isFinite(Number(digest?.threshold)) ? Math.max(1, Math.floor(Number(digest?.threshold))) : undefined,
    digestStatus: typeof digest?.status === "string" && digest.status.trim() ? digest.status.trim() : undefined,
    pendingMessageCount: Number.isFinite(Number(digest?.pendingMessageCount)) ? Math.max(0, Number(digest?.pendingMessageCount)) : undefined,
  };
}

function buildIdleRecord(conversationId: string): DurableExtractionRecord {
  const now = Date.now();
  return {
    conversationId,
    status: "idle",
    pending: false,
    runCount: 0,
    updatedAt: now,
    consecutiveFailures: 0,
  };
}

function readQueuedSnapshot(record: DurableExtractionRecord): ExtractionSnapshot | null {
  if (!record.requestSource || !record.requestedAt) {
    return null;
  }
  return {
    source: record.requestSource,
    requestedAt: record.requestedAt,
    digestAt: Math.max(0, Number(record.requestedDigestAt ?? 0)),
    messageCount: Math.max(0, Number(record.requestedMessageCount ?? 0)),
    threshold: record.requestedThreshold,
    digestStatus: record.requestedDigestStatus,
  };
}

function readPendingSnapshot(record: DurableExtractionRecord): ExtractionSnapshot | null {
  if (!record.pending || !record.pendingSource || !record.pendingRequestedAt) {
    return null;
  }
  return {
    source: record.pendingSource,
    requestedAt: record.pendingRequestedAt,
    digestAt: Math.max(0, Number(record.pendingDigestAt ?? 0)),
    messageCount: Math.max(0, Number(record.pendingMessageCount ?? 0)),
    threshold: record.pendingThreshold,
    digestStatus: record.pendingDigestStatus,
    pendingMessageCount: record.pendingMessageCount,
  };
}

function writeQueuedSnapshot(record: DurableExtractionRecord, snapshot: ExtractionSnapshot): void {
  record.requestSource = snapshot.source;
  record.requestedAt = snapshot.requestedAt;
  record.requestedDigestAt = snapshot.digestAt;
  record.requestedMessageCount = snapshot.messageCount;
  record.requestedThreshold = snapshot.threshold;
  record.requestedDigestStatus = snapshot.digestStatus;
}

function writePendingSnapshot(record: DurableExtractionRecord, snapshot: ExtractionSnapshot): void {
  record.pending = true;
  record.pendingSource = snapshot.source;
  record.pendingRequestedAt = snapshot.requestedAt;
  record.pendingDigestAt = snapshot.digestAt;
  record.pendingMessageCount = snapshot.messageCount;
  record.pendingThreshold = snapshot.threshold;
  record.pendingDigestStatus = snapshot.digestStatus;
}

function clearPendingSnapshot(record: DurableExtractionRecord): void {
  record.pending = false;
  record.pendingSource = undefined;
  record.pendingRequestedAt = undefined;
  record.pendingDigestAt = undefined;
  record.pendingMessageCount = undefined;
  record.pendingThreshold = undefined;
  record.pendingDigestStatus = undefined;
}

function isSnapshotNewer(candidate: ExtractionSnapshot, baseline: ExtractionSnapshot | null): boolean {
  if (!baseline) return true;
  if (candidate.digestAt !== baseline.digestAt) {
    return candidate.digestAt > baseline.digestAt;
  }
  if (candidate.messageCount !== baseline.messageCount) {
    return candidate.messageCount > baseline.messageCount;
  }
  return candidate.requestedAt > baseline.requestedAt;
}

async function atomicWriteText(targetPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, targetPath);
}

function normalizeCandidateTypes(value: unknown): DurableMemoryCandidateType[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is DurableMemoryCandidateType => (
    item === "user" || item === "feedback" || item === "project" || item === "reference"
  ));
  return items.length > 0 ? [...new Set(items)] : undefined;
}

function normalizeRejectedReasons(value: unknown): DurableMemoryRejectionReasonCode[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is DurableMemoryRejectionReasonCode => (
    item === "code_pattern"
    || item === "file_path"
    || item === "git_history"
    || item === "debug_recipe"
    || item === "policy_rule"
  ));
  return items.length > 0 ? [...new Set(items)] : undefined;
}

function normalizeExtractionResult(
  value: number | ExtractConversationMemoriesResult,
): ExtractConversationMemoriesResult {
  if (typeof value === "number") {
    return {
      count: value,
      acceptedCandidateTypes: [],
      rejectedCount: 0,
      rejectedReasons: [],
      summary: `accepted=${value}`,
      skipReason: undefined,
    };
  }
  return {
    count: Math.max(0, Number(value.count ?? 0)),
    acceptedCandidateTypes: normalizeCandidateTypes(value.acceptedCandidateTypes) ?? [],
    rejectedCount: Math.max(0, Number(value.rejectedCount ?? 0)),
    rejectedReasons: normalizeRejectedReasons(value.rejectedReasons) ?? [],
    summary: typeof value.summary === "string" && value.summary.trim() ? value.summary.trim() : `accepted=${Math.max(0, Number(value.count ?? 0))}`,
    skipReason: normalizeDurableExtractionSkipReason(value.skipReason) ?? normalizeNonEmptyString(value.skipReason),
  };
}

function isDurableExtractionJobClaim(
  result: DurableExtractionJobClaimResult,
): result is DurableExtractionJobClaim {
  return !("reason" in result);
}

function toAbortError(signal: AbortSignal, fallback: string): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(fallback);
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal, fallback: string): void {
  if (signal.aborted) throw toAbortError(signal, fallback);
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal, fallback: string): Promise<T> {
  throwIfAborted(signal, fallback);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(toAbortError(signal, fallback));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export class DurableExtractionRuntime {
  private readonly runtimeDir: string;
  private readonly statePath: string;
  private readonly extractor: DurableExtractionRuntimeOptions["extractor"];
  private readonly getMessages: DurableExtractionRuntimeOptions["getMessages"];
  private readonly getDigest?: DurableExtractionRuntimeOptions["getDigest"];
  private readonly inputLimits: DurableExtractionInputLimits;
  private readonly acquireJob?: DurableExtractionRuntimeOptions["acquireJob"];
  private readonly closeDeadlineMs: number;
  private readonly retryDelayMs: number;
  private readonly minPendingMessages: number;
  private readonly minMessageDelta: number;
  private readonly successCooldownMs: number;
  private readonly failureBackoffMs: number;
  private readonly failureBackoffMaxMs: number;
  private readonly onRequest?: DurableExtractionRuntimeOptions["onRequest"];
  private readonly canStartRun?: DurableExtractionRuntimeOptions["canStartRun"];
  private readonly onRunStarted?: DurableExtractionRuntimeOptions["onRunStarted"];
  private readonly onRunFinished?: DurableExtractionRuntimeOptions["onRunFinished"];
  private readonly logger?: DurableExtractionRuntimeOptions["logger"];
  private readonly records = new Map<string, DurableExtractionRecord>();
  private readonly listeners = new Set<(event: DurableExtractionChangeEvent) => void>();
  private readonly scheduled = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Set<Promise<void>>();
  private writeChain = Promise.resolve();
  private loadPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private readonly closeController = new AbortController();
  private closed = false;

  constructor(options: DurableExtractionRuntimeOptions) {
    this.runtimeDir = path.join(options.stateDir, "memory-runtime");
    this.statePath = path.join(this.runtimeDir, "durable-extraction.json");
    this.extractor = options.extractor;
    this.getMessages = options.getMessages;
    this.getDigest = options.getDigest;
    this.inputLimits = { ...options.inputLimits };
    this.acquireJob = options.acquireJob;
    this.closeDeadlineMs = Math.max(1, Math.floor(options.closeDeadlineMs ?? 5_000));
    this.retryDelayMs = Math.max(250, options.retryDelayMs ?? 2_000);
    this.minPendingMessages = Math.max(0, Math.floor(options.minPendingMessages ?? 0));
    this.minMessageDelta = Math.max(0, Math.floor(options.minMessageDelta ?? 0));
    this.successCooldownMs = Math.max(0, Math.floor(options.successCooldownMs ?? 0));
    this.failureBackoffMs = Math.max(250, Math.floor(options.failureBackoffMs ?? this.retryDelayMs));
    this.failureBackoffMaxMs = Math.max(this.failureBackoffMs, Math.floor(options.failureBackoffMaxMs ?? 60_000));
    this.onRequest = options.onRequest;
    this.canStartRun = options.canStartRun;
    this.onRunStarted = options.onRunStarted;
    this.onRunFinished = options.onRunFinished;
    this.logger = options.logger;
  }

  async load(): Promise<void> {
    if (this.loadPromise) {
      return this.loadPromise;
    }
    this.loadPromise = (async () => {
      await fs.mkdir(this.runtimeDir, { recursive: true });
      this.records.clear();
      try {
        const raw = await fs.readFile(this.statePath, "utf-8");
        const parsed = JSON.parse(raw) as Partial<DurableExtractionState>;
        for (const item of Array.isArray(parsed.items) ? parsed.items : []) {
          const record = this.normalizeRecord(item);
          if (!record) continue;
          this.records.set(record.conversationId, record);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
          this.logger?.warn?.("Failed to load durable extraction runtime state, starting fresh.", error);
        }
      }
    })();
    return this.loadPromise;
  }

  subscribe(listener: (event: DurableExtractionChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  isAvailable(): boolean {
    const support = this.extractor.getConversationMemoryExtractionSupport?.();
    if (support) {
      return support.available;
    }
    return this.extractor.isConversationMemoryExtractionEnabled();
  }

  getAvailability(): ConversationMemoryExtractionSupport {
    const support = this.extractor.getConversationMemoryExtractionSupport?.();
    if (support) {
      return {
        ...support,
        reasons: support.reasons.map((item) => ({ ...item })),
      };
    }
    return {
      enabled: this.extractor.isConversationMemoryExtractionEnabled(),
      available: this.extractor.isConversationMemoryExtractionEnabled(),
      minMessages: 0,
      hasBaseUrl: true,
      hasApiKey: true,
      reasons: this.extractor.isConversationMemoryExtractionEnabled()
        ? []
        : [{
          code: "gate_disabled",
          message: "Durable extraction is disabled.",
        }],
    };
  }

  getPolicySummary(): DurableMemoryGuidance | undefined {
    const guidance = this.extractor.getDurableMemoryGuidance?.();
    if (!guidance) {
      return undefined;
    }
    return {
      policyVersion: guidance.policyVersion,
      acceptedCandidateTypes: [...guidance.acceptedCandidateTypes],
      rejectedContentTypes: guidance.rejectedContentTypes.map((item) => ({ ...item })),
      summary: guidance.summary,
    };
  }

  async getRecord(conversationId: string): Promise<DurableExtractionRecord> {
    await this.load();
    const normalizedId = conversationId.trim();
    const existing = this.records.get(normalizedId);
    return existing ? cloneRecord(existing) : buildIdleRecord(normalizedId);
  }

  /** 仅汇总运行和待处理数量，供 Core 资源观测读取。 */
  getRuntimeSnapshot(): {
    activeCount: number;
    queuedCount: number;
  } {
    let activeCount = 0;
    let queuedCount = 0;
    for (const record of this.records.values()) {
      if (record.status === "running") {
        activeCount += 1;
      }
      if (record.status === "queued" || record.pending) {
        queuedCount += 1;
      }
    }
    return { activeCount, queuedCount };
  }

  async requestExtraction(input: {
    conversationId: string;
    source: string;
    digest?: DurableExtractionDigestSnapshot;
  }): Promise<DurableExtractionRecord> {
    await this.load();
    const conversationId = input.conversationId.trim();
    const source = input.source.trim() || "manual";
    const digest = input.digest ?? await this.getDigest?.(conversationId);
    const snapshot = normalizeSnapshot(source, digest, Date.now());

    let requestEvent: DurableExtractionRequestEvent | undefined;
    const record = await this.mutate(async () => {
      const current = this.records.get(conversationId) ?? buildIdleRecord(conversationId);
      const queued = readQueuedSnapshot(current);
      const pending = readPendingSnapshot(current);

      const queueDecision = this.evaluateQueueDecision(current, snapshot);
      if (!queueDecision.shouldQueue) {
        current.updatedAt = Date.now();
        current.lastSkipReason = queueDecision.reason;
        this.records.set(conversationId, current);
        this.emitChange(current);
        requestEvent = {
          conversationId,
          source: snapshot.source,
          requestedAt: snapshot.requestedAt,
          digestAt: snapshot.digestAt,
          messageCount: snapshot.messageCount,
          threshold: snapshot.threshold,
          digestStatus: snapshot.digestStatus,
          outcome: "skipped",
          reason: queueDecision.reason,
          record: cloneRecord(current),
        };
        return cloneRecord(current);
      }

      current.updatedAt = Date.now();
      current.error = undefined;
      current.lastSkipReason = undefined;

      if (current.status === "running") {
        if (isSnapshotNewer(snapshot, pending)) {
          writePendingSnapshot(current, snapshot);
        }
      } else if (current.status === "queued") {
        if (isSnapshotNewer(snapshot, queued)) {
          writeQueuedSnapshot(current, snapshot);
        }
      } else {
        current.status = "queued";
        current.startedAt = undefined;
        current.finishedAt = undefined;
        writeQueuedSnapshot(current, snapshot);
      }

      this.records.set(conversationId, current);
      this.emitChange(current);
      requestEvent = {
        conversationId,
        source: snapshot.source,
        requestedAt: snapshot.requestedAt,
        digestAt: snapshot.digestAt,
        messageCount: snapshot.messageCount,
        threshold: snapshot.threshold,
        digestStatus: snapshot.digestStatus,
        outcome: "queued",
        record: cloneRecord(current),
      };
      return cloneRecord(current);
    });

    await this.safeInvoke(this.onRequest, requestEvent);
    this.scheduleRun(conversationId);
    return record;
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (!this.closeController.signal.aborted) {
      this.closeController.abort(new Error("Durable extraction runtime is closing."));
    }
    for (const timer of this.scheduled.values()) {
      clearTimeout(timer);
    }
    this.scheduled.clear();
    this.closePromise = this.drainWithDeadline();
    return this.closePromise;
  }

  private async drainWithDeadline(): Promise<void> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      deadline = setTimeout(() => resolve("timeout"), this.closeDeadlineMs);
      deadline.unref?.();
    });
    const drained = Promise.allSettled([...this.inFlight])
      .then(() => this.writeChain.catch(() => {}))
      .then(() => "drained" as const);
    try {
      const outcome = await Promise.race([drained, timedOut]);
      if (outcome === "timeout") {
        this.logger?.warn?.("Durable extraction close deadline reached.", {
          closeDeadlineMs: this.closeDeadlineMs,
          inFlightCount: this.inFlight.size,
        });
      }
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }

  private evaluateQueueDecision(record: DurableExtractionRecord, snapshot: ExtractionSnapshot): {
    shouldQueue: boolean;
    reason: string;
  } {
    if (snapshot.messageCount <= 0) {
      return { shouldQueue: false, reason: "digest_not_ready" };
    }
    if (this.minPendingMessages > 0
      && typeof snapshot.pendingMessageCount === "number"
      && snapshot.pendingMessageCount > 0
      && snapshot.pendingMessageCount < this.minPendingMessages) {
      return { shouldQueue: false, reason: "pending_below_threshold" };
    }
    if (record.status === "running") {
      return { shouldQueue: true, reason: "running" };
    }
    if (record.pending) {
      return { shouldQueue: true, reason: "pending" };
    }
    if ((record.lastExtractedDigestAt ?? 0) < snapshot.digestAt) {
      const delta = snapshot.messageCount - (record.lastExtractedMessageCount ?? 0);
      if (this.minMessageDelta > 0 && delta > 0 && delta < this.minMessageDelta) {
        return { shouldQueue: false, reason: "message_delta_below_threshold" };
      }
      return { shouldQueue: true, reason: "newer_digest" };
    }
    if ((record.lastExtractedDigestAt ?? 0) > snapshot.digestAt) {
      return { shouldQueue: false, reason: "stale_digest" };
    }
    if ((record.lastExtractedMessageCount ?? 0) < snapshot.messageCount) {
      const delta = snapshot.messageCount - (record.lastExtractedMessageCount ?? 0);
      if (this.minMessageDelta > 0 && delta < this.minMessageDelta) {
        return { shouldQueue: false, reason: "message_delta_below_threshold" };
      }
      return { shouldQueue: true, reason: "newer_message_count" };
    }
    if (record.status === "failed") {
      return { shouldQueue: true, reason: "retry_failed" };
    }
    return { shouldQueue: false, reason: snapshot.digestAt > 0 ? "up_to_date" : "digest_not_ready" };
  }

  private scheduleRun(conversationId: string, delayMs = 0): void {
    if (this.closed) {
      return;
    }
    if (this.scheduled.has(conversationId)) {
      return;
    }
    const timer = setTimeout(() => {
      this.scheduled.delete(conversationId);
      if (this.closed) {
        return;
      }
      const task = this.processConversation(conversationId).catch((error) => {
        this.logger?.error?.("Durable extraction processing crashed.", {
          conversationId,
          error,
        });
      }).finally(() => {
        this.inFlight.delete(task);
      });
      this.inFlight.add(task);
    }, Math.max(0, delayMs));
    this.scheduled.set(conversationId, timer);
  }

  private async processConversation(conversationId: string): Promise<void> {
    while (true) {
      const queued = await this.getRecord(conversationId);
      if (queued.status !== "queued") {
        return;
      }

      if (this.extractor.isPaused) {
        this.logger?.debug?.("Durable extraction waiting for idle window.", { conversationId });
        this.scheduleRun(conversationId, this.retryDelayMs);
        return;
      }

      const now = Date.now();
      if (queued.nextEligibleAt && queued.nextEligibleAt > now) {
        const delayMs = Math.max(1, queued.nextEligibleAt - now);
        await this.mutate(async () => {
          const current = this.records.get(conversationId);
          if (!current || current.status !== "queued") {
            return;
          }
          current.updatedAt = now;
          current.lastSkipReason = current.consecutiveFailures && current.consecutiveFailures > 0
            ? "failure_backoff_active"
            : "cooldown_active";
          this.emitChange(current);
        });
        this.scheduleRun(conversationId, delayMs);
        return;
      }

      const snapshot = await this.mutate(async () => {
        const current = this.records.get(conversationId);
        if (!current || current.status !== "queued") {
          return null;
        }
        const queuedSnapshot = readQueuedSnapshot(current);
        if (!queuedSnapshot) {
          current.status = "idle";
          current.updatedAt = Date.now();
          this.emitChange(current);
          return null;
        }
        return {
          queuedSnapshot,
          projectedRunCount: current.runCount + 1,
        };
      });

      if (!snapshot) {
        return;
      }

      const extractionKey = this.buildExtractionKey(conversationId, snapshot.queuedSnapshot);
      const runStartEvent: DurableExtractionRunStartEvent = {
        conversationId,
        source: snapshot.queuedSnapshot.source,
        requestedAt: snapshot.queuedSnapshot.requestedAt,
        digestAt: snapshot.queuedSnapshot.digestAt,
        messageCount: snapshot.queuedSnapshot.messageCount,
        threshold: snapshot.queuedSnapshot.threshold,
        digestStatus: snapshot.queuedSnapshot.digestStatus,
        extractionKey,
        projectedRunCount: snapshot.projectedRunCount,
      };
      const decision = await this.safeInvoke(this.canStartRun, runStartEvent);
      if (decision && decision.allowed === false) {
        await this.mutate(async () => {
          const current = this.records.get(conversationId);
          if (!current || current.status !== "queued") {
            return;
          }
          current.updatedAt = Date.now();
          current.lastSkipReason = decision.reason;
          this.emitChange(current);
        });
        this.scheduleRun(conversationId, Math.max(this.retryDelayMs, decision.retryAfterMs ?? this.retryDelayMs));
        return;
      }

      let inputSelection: DurableExtractionInputSelection;
      try {
        const sourceMessages = await raceWithAbort(
          this.getMessages(conversationId),
          this.closeController.signal,
          "Durable extraction input collection was aborted.",
        );
        inputSelection = selectDurableExtractionInput(sourceMessages, this.inputLimits);
      } catch (error) {
        if (this.closed || this.closeController.signal.aborted) return;
        await this.recordPreparationFailure(conversationId, error);
        return;
      }

      let jobClaim: DurableExtractionJobClaim | undefined;
      if (this.acquireJob) {
        let admission: DurableExtractionJobClaimResult;
        try {
          admission = await this.acquireJob({
            conversationId,
            estimatedTokenUnits: Math.max(1, inputSelection.inputBytes + 3_000),
            signal: this.closeController.signal,
          });
        } catch (error) {
          if (this.closed || this.closeController.signal.aborted) return;
          await this.recordPreparationFailure(conversationId, error);
          return;
        }
        if (!isDurableExtractionJobClaim(admission)) {
          if (this.closed || this.closeController.signal.aborted) return;
          await this.mutate(async () => {
            const current = this.records.get(conversationId);
            if (!current || current.status !== "queued") return;
            current.updatedAt = Date.now();
            current.lastSkipReason = admission.reasonCode ?? "memory_background_admission_rejected";
            this.emitChange(current);
          });
          this.scheduleRun(
            conversationId,
            Math.max(this.retryDelayMs, admission.retryAfterMs ?? this.retryDelayMs),
          );
          return;
        }
        jobClaim = admission;
      }

      const activeSnapshot = await this.mutate(async () => {
        const current = this.records.get(conversationId);
        if (!current || current.status !== "queued") {
          return null;
        }
        const queuedSnapshot = readQueuedSnapshot(current);
        if (!queuedSnapshot) {
          current.status = "idle";
          current.updatedAt = Date.now();
          this.emitChange(current);
          return null;
        }
        current.status = "running";
        current.startedAt = Date.now();
        current.updatedAt = current.startedAt;
        current.runCount += 1;
        current.lastRunSource = queuedSnapshot.source;
        current.error = undefined;
        current.lastSkipReason = undefined;
        this.emitChange(current);
        return {
          queuedSnapshot,
          runCount: current.runCount,
        };
      });

      if (!activeSnapshot) {
        await jobClaim?.release("skipped");
        return;
      }
      await this.safeInvoke(this.onRunStarted, {
        ...runStartEvent,
        projectedRunCount: activeSnapshot.runCount,
      });

      let extractedCount = 0;
      let extractionSummary: string | undefined;
      let acceptedCandidateTypes: DurableMemoryCandidateType[] | undefined;
      let rejectedCount: number | undefined;
      let rejectedReasons: DurableMemoryRejectionReasonCode[] | undefined;
      let skipReason: DurableExtractionSkipReasonCode | string | undefined;
      let failure: string | undefined;
      const runSignal = jobClaim?.signal ?? this.closeController.signal;

      try {
        throwIfAborted(runSignal, "Durable extraction run was aborted.");
        const extractionResult = await raceWithAbort(
          this.extractor.extractMemoriesFromConversation(
            extractionKey,
            inputSelection.messages,
            {
              markKey: extractionKey,
              sourceConversationId: conversationId,
              sourceLabel: extractionKey,
              signal: runSignal,
            },
          ),
          runSignal,
          "Durable extraction run was aborted.",
        );
        throwIfAborted(runSignal, "Durable extraction run was aborted.");
        const normalized = normalizeExtractionResult(extractionResult);
        extractedCount = normalized.count;
        extractionSummary = normalized.summary;
        acceptedCandidateTypes = normalized.acceptedCandidateTypes;
        rejectedCount = normalized.rejectedCount;
        rejectedReasons = normalized.rejectedReasons;
        skipReason = normalized.skipReason;
      } catch (error) {
        if (runSignal.aborted || this.closed) {
          await jobClaim?.release("skipped");
          await this.recordCancelledRun(conversationId);
          return;
        }
        failure = error instanceof Error ? error.message : String(error);
      }

      let finalRunCount = activeSnapshot.runCount;
      const commitRun = async (): Promise<boolean> => {
        throwIfAborted(runSignal, "Durable extraction completion was aborted.");
        const shouldContinue = await this.mutate(async () => {
          const current = this.records.get(conversationId) ?? buildIdleRecord(conversationId);
          current.finishedAt = Date.now();
          current.updatedAt = current.finishedAt;
          current.lastExtractionKey = extractionKey;
          finalRunCount = current.runCount;

          if (failure) {
            current.status = "failed";
            current.error = failure;
            current.consecutiveFailures = Math.max(0, Number(current.consecutiveFailures ?? 0)) + 1;
            current.nextEligibleAt = current.finishedAt + this.computeFailureBackoffMs(current.consecutiveFailures);
            current.lastExtractionSummary = `failure: ${failure}`;
          } else {
            current.status = "completed";
            current.error = undefined;
            current.lastExtractedAt = current.finishedAt;
            current.lastExtractedDigestAt = activeSnapshot.queuedSnapshot.digestAt;
            current.lastExtractedMessageCount = activeSnapshot.queuedSnapshot.messageCount;
            current.lastExtractedMemoryCount = extractedCount;
            current.lastExtractionSummary = extractionSummary;
            current.lastAcceptedCandidateTypes = acceptedCandidateTypes;
            current.lastRejectedCount = rejectedCount;
            current.lastRejectedReasons = rejectedReasons;
            current.consecutiveFailures = 0;
            current.nextEligibleAt = this.successCooldownMs > 0
              ? current.finishedAt + this.successCooldownMs
              : undefined;
            current.lastSkipReason = extractedCount === 0
              ? skipReason ?? ((rejectedCount ?? 0) > 0 ? "policy_filtered" : undefined)
              : undefined;
          }

          const pendingSnapshot = readPendingSnapshot(current);
          const pendingDecision = pendingSnapshot ? this.evaluateQueueDecision(current, pendingSnapshot) : undefined;
          if (pendingSnapshot && pendingDecision?.shouldQueue) {
            current.status = "queued";
            current.finishedAt = undefined;
            writeQueuedSnapshot(current, pendingSnapshot);
            clearPendingSnapshot(current);
            this.emitChange(current);
            return true;
          }

          clearPendingSnapshot(current);
          if (pendingDecision && !pendingDecision.shouldQueue) {
            current.lastSkipReason = pendingDecision.reason;
          }
          this.emitChange(current);
          return false;
        });
        await this.safeInvoke(this.onRunFinished, {
          conversationId,
          source: activeSnapshot.queuedSnapshot.source,
          requestedAt: activeSnapshot.queuedSnapshot.requestedAt,
          digestAt: activeSnapshot.queuedSnapshot.digestAt,
          messageCount: activeSnapshot.queuedSnapshot.messageCount,
          threshold: activeSnapshot.queuedSnapshot.threshold,
          digestStatus: activeSnapshot.queuedSnapshot.digestStatus,
          extractionKey,
          runCount: finalRunCount,
          extractedCount,
          failure,
        });
        return shouldContinue;
      };

      let shouldContinue: boolean;
      try {
        if (jobClaim) {
          const completion = await jobClaim.complete(commitRun);
          if (!completion.applied) {
            await this.recordCancelledRun(conversationId);
            return;
          }
          shouldContinue = completion.value;
        } else {
          shouldContinue = await commitRun();
        }
      } catch (error) {
        await jobClaim?.release(runSignal.aborted ? "skipped" : "failed");
        if (runSignal.aborted || this.closed) {
          await this.recordCancelledRun(conversationId);
          return;
        }
        throw error;
      }

      if (!shouldContinue) {
        return;
      }
    }
  }

  private async recordPreparationFailure(conversationId: string, error: unknown): Promise<void> {
    const failure = error instanceof Error ? error.message : String(error);
    await this.mutate(async () => {
      const current = this.records.get(conversationId);
      if (!current || current.status !== "queued") return;
      current.status = "failed";
      current.finishedAt = Date.now();
      current.updatedAt = current.finishedAt;
      current.error = failure;
      current.consecutiveFailures = Math.max(0, Number(current.consecutiveFailures ?? 0)) + 1;
      current.nextEligibleAt = current.finishedAt + this.computeFailureBackoffMs(current.consecutiveFailures);
      current.lastExtractionSummary = `failure: ${failure}`;
      this.emitChange(current);
    });
  }

  private async recordCancelledRun(conversationId: string): Promise<void> {
    await this.mutate(async () => {
      const current = this.records.get(conversationId);
      if (!current || current.status !== "running") return;
      current.status = "failed";
      current.finishedAt = Date.now();
      current.updatedAt = current.finishedAt;
      current.error = undefined;
      current.lastSkipReason = "runtime_closed";
      this.emitChange(current);
    });
  }

  private buildExtractionKey(conversationId: string, snapshot: ExtractionSnapshot): string {
    if (snapshot.digestAt > 0) {
      return `${conversationId}@digest:${snapshot.digestAt}:${snapshot.messageCount}`;
    }
    return `${conversationId}@messages:${snapshot.messageCount}`;
  }

  private computeFailureBackoffMs(consecutiveFailures: number): number {
    const exponent = Math.max(0, consecutiveFailures - 1);
    const raw = this.failureBackoffMs * (2 ** exponent);
    return Math.min(this.failureBackoffMaxMs, raw);
  }

  private normalizeRecord(value: unknown): DurableExtractionRecord | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const current = value as Record<string, unknown>;
    const conversationId = typeof current.conversationId === "string" ? current.conversationId.trim() : "";
    if (!conversationId) {
      return null;
    }
    return {
      conversationId,
      status: this.normalizeStatus(current.status),
      requestSource: normalizeDurableExtractionRequestSource(current.requestSource) ?? normalizeNonEmptyString(current.requestSource),
      requestedAt: Number.isFinite(Number(current.requestedAt)) ? Number(current.requestedAt) : undefined,
      requestedDigestAt: Number.isFinite(Number(current.requestedDigestAt)) ? Number(current.requestedDigestAt) : undefined,
      requestedMessageCount: Number.isFinite(Number(current.requestedMessageCount)) ? Number(current.requestedMessageCount) : undefined,
      requestedThreshold: Number.isFinite(Number(current.requestedThreshold)) ? Number(current.requestedThreshold) : undefined,
      requestedDigestStatus: typeof current.requestedDigestStatus === "string" ? current.requestedDigestStatus : undefined,
      startedAt: Number.isFinite(Number(current.startedAt)) ? Number(current.startedAt) : undefined,
      finishedAt: Number.isFinite(Number(current.finishedAt)) ? Number(current.finishedAt) : undefined,
      lastRunSource: normalizeDurableExtractionRequestSource(current.lastRunSource) ?? normalizeNonEmptyString(current.lastRunSource),
      lastExtractedAt: Number.isFinite(Number(current.lastExtractedAt)) ? Number(current.lastExtractedAt) : undefined,
      lastExtractedDigestAt: Number.isFinite(Number(current.lastExtractedDigestAt)) ? Number(current.lastExtractedDigestAt) : undefined,
      lastExtractedMessageCount: Number.isFinite(Number(current.lastExtractedMessageCount)) ? Number(current.lastExtractedMessageCount) : undefined,
      lastExtractedMemoryCount: Number.isFinite(Number(current.lastExtractedMemoryCount)) ? Number(current.lastExtractedMemoryCount) : undefined,
      lastExtractionKey: typeof current.lastExtractionKey === "string" ? current.lastExtractionKey : undefined,
      pending: current.pending === true,
      pendingSource: normalizeDurableExtractionRequestSource(current.pendingSource) ?? normalizeNonEmptyString(current.pendingSource),
      pendingRequestedAt: Number.isFinite(Number(current.pendingRequestedAt)) ? Number(current.pendingRequestedAt) : undefined,
      pendingDigestAt: Number.isFinite(Number(current.pendingDigestAt)) ? Number(current.pendingDigestAt) : undefined,
      pendingMessageCount: Number.isFinite(Number(current.pendingMessageCount)) ? Number(current.pendingMessageCount) : undefined,
      pendingThreshold: Number.isFinite(Number(current.pendingThreshold)) ? Number(current.pendingThreshold) : undefined,
      pendingDigestStatus: typeof current.pendingDigestStatus === "string" ? current.pendingDigestStatus : undefined,
      runCount: Number.isFinite(Number(current.runCount)) ? Number(current.runCount) : 0,
      updatedAt: Number.isFinite(Number(current.updatedAt)) ? Number(current.updatedAt) : Date.now(),
      consecutiveFailures: Number.isFinite(Number(current.consecutiveFailures)) ? Number(current.consecutiveFailures) : 0,
      nextEligibleAt: Number.isFinite(Number(current.nextEligibleAt)) ? Number(current.nextEligibleAt) : undefined,
      lastExtractionSummary: typeof current.lastExtractionSummary === "string" ? current.lastExtractionSummary : undefined,
      lastAcceptedCandidateTypes: normalizeCandidateTypes(current.lastAcceptedCandidateTypes),
      lastRejectedCount: Number.isFinite(Number(current.lastRejectedCount)) ? Number(current.lastRejectedCount) : undefined,
      lastRejectedReasons: normalizeRejectedReasons(current.lastRejectedReasons),
      error: typeof current.error === "string" ? current.error : undefined,
      lastSkipReason: normalizeDurableExtractionSkipReason(current.lastSkipReason) ?? normalizeNonEmptyString(current.lastSkipReason),
    };
  }

  private normalizeStatus(value: unknown): DurableExtractionStatus {
    switch (value) {
      case "queued":
      case "running":
      case "completed":
      case "failed":
        return value;
      default:
        return "idle";
    }
  }

  private emitChange(record: DurableExtractionRecord): void {
    const item = cloneRecord(record);
    for (const listener of this.listeners) {
      try {
        listener({ kind: "updated", record: item });
      } catch (error) {
        this.logger?.warn?.("Failed to emit durable extraction listener event.", error);
      }
    }
  }

  private async mutate<T>(mutator: () => Promise<T>): Promise<T> {
    let result!: T;
    const run = this.writeChain.then(async () => {
      result = await mutator();
      await this.persist();
    });
    this.writeChain = run.catch(() => {});
    await run;
    return result;
  }

  private async safeInvoke<TInput, TResult>(
    callback: ((event: TInput) => Promise<TResult> | TResult) | undefined,
    event: TInput | undefined,
  ): Promise<TResult | undefined> {
    if (!callback || !event) {
      return undefined;
    }
    try {
      return await callback(event);
    } catch (error) {
      this.logger?.warn?.("Durable extraction runtime hook failed.", error);
      return undefined;
    }
  }

  private async persist(): Promise<void> {
    const state: DurableExtractionState = {
      version: STATE_VERSION,
      items: [...this.records.values()]
        .sort((a, b) => a.conversationId.localeCompare(b.conversationId))
        .map((item) => ({ ...item })),
    };
    await atomicWriteText(this.statePath, JSON.stringify(state, null, 2));
  }
}
