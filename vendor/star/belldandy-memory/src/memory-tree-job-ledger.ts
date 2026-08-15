import { resolveMemoryTreeLifecycleFailureCooldownMs } from "./memory-tree-lifecycle.js";
import type { MemoryTreeJobStatus, MemoryTreeJobType } from "./memory-tree-job-report.js";

export type MemoryTreeJobLedgerStore = {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
};

export type MemoryTreeJobLedgerTarget = {
  jobType: MemoryTreeJobType;
  targetKey: string;
};

export type MemoryTreeJobLedgerRecord = MemoryTreeJobLedgerTarget & {
  jobKey: string;
  status: MemoryTreeJobStatus;
  lastRequestedAt?: string;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastFailureError?: string;
  failureCount: number;
  skipCount: number;
  lastSkippedAt?: string;
  lastSkipReason?: string;
  lastSkippedTriggerSource?: string;
  nextEligibleAt?: string;
  retryAfterMs?: number;
  lastUpdatedAt?: string;
  triggerSource?: string;
};

export type MemoryTreeJobSkipReason = "cooldown_active" | "reentry_blocked";

const MEMORY_TREE_JOB_LEDGER_META_PREFIX = "memory_tree_job_ledger";

export function buildMemoryTreeJobKey(jobType: MemoryTreeJobType, targetKey: string): string {
  return `${jobType}:${targetKey}`;
}

export function buildMemoryTreeJobLedgerMetaKey(jobType: MemoryTreeJobType, targetKey: string): string {
  return `${MEMORY_TREE_JOB_LEDGER_META_PREFIX}:${normalizeMetaKeyPart(jobType)}:${normalizeMetaKeyPart(targetKey)}`;
}

export function readMemoryTreeJobLedgerRecord(
  store: MemoryTreeJobLedgerStore,
  jobType: MemoryTreeJobType,
  targetKey: string,
): MemoryTreeJobLedgerRecord | undefined {
  const raw = store.getMeta(buildMemoryTreeJobLedgerMetaKey(jobType, targetKey));
  if (!raw) {
    return undefined;
  }
  const parsed = safeParseJson(raw);
  if (!isRecord(parsed)) {
    return undefined;
  }
  return normalizeMemoryTreeJobLedgerRecord(parsed, { jobType, targetKey });
}

export function listMemoryTreeJobLedgerRecords(
  store: MemoryTreeJobLedgerStore,
  targets: MemoryTreeJobLedgerTarget[],
): MemoryTreeJobLedgerRecord[] {
  const records: MemoryTreeJobLedgerRecord[] = [];
  for (const target of targets) {
    const record = readMemoryTreeJobLedgerRecord(store, target.jobType, target.targetKey);
    if (record) {
      records.push(record);
    }
  }
  return records;
}

export function recordMemoryTreeJobLedgerStart(
  store: MemoryTreeJobLedgerStore,
  input: MemoryTreeJobLedgerTarget & {
    startedAt: string;
    triggerSource?: string;
  },
): MemoryTreeJobLedgerRecord {
  const current = readMemoryTreeJobLedgerRecord(store, input.jobType, input.targetKey);
  const next = normalizeMemoryTreeJobLedgerRecord({
    ...(current ?? {}),
    jobType: input.jobType,
    targetKey: input.targetKey,
    jobKey: buildMemoryTreeJobKey(input.jobType, input.targetKey),
    status: "running",
    lastRequestedAt: input.startedAt,
    lastStartedAt: input.startedAt,
    lastUpdatedAt: input.startedAt,
    ...(input.triggerSource ? { triggerSource: input.triggerSource } : {}),
  }, input);
  writeMemoryTreeJobLedgerRecord(store, next);
  return next;
}

export function recordMemoryTreeJobLedgerSuccess(
  store: MemoryTreeJobLedgerStore,
  input: MemoryTreeJobLedgerTarget & {
    completedAt: string;
    triggerSource?: string;
  },
): MemoryTreeJobLedgerRecord {
  const current = readMemoryTreeJobLedgerRecord(store, input.jobType, input.targetKey);
  const next = normalizeMemoryTreeJobLedgerRecord({
    ...(current ?? {}),
    jobType: input.jobType,
    targetKey: input.targetKey,
    jobKey: buildMemoryTreeJobKey(input.jobType, input.targetKey),
    status: "completed",
    lastRequestedAt: current?.lastRequestedAt ?? input.completedAt,
    lastStartedAt: current?.lastStartedAt ?? input.completedAt,
    lastCompletedAt: input.completedAt,
    lastSuccessAt: input.completedAt,
    failureCount: 0,
    nextEligibleAt: undefined,
    retryAfterMs: undefined,
    lastUpdatedAt: input.completedAt,
    ...(input.triggerSource ? { triggerSource: input.triggerSource } : {}),
  }, input);
  writeMemoryTreeJobLedgerRecord(store, next);
  return next;
}

export function recordMemoryTreeJobLedgerFailure(
  store: MemoryTreeJobLedgerStore,
  input: MemoryTreeJobLedgerTarget & {
    failedAt: string;
    error: unknown;
    triggerSource?: string;
  },
): MemoryTreeJobLedgerRecord {
  const current = readMemoryTreeJobLedgerRecord(store, input.jobType, input.targetKey);
  const failureCount = Math.max(1, (current?.failureCount ?? 0) + 1);
  const retryAfterMs = resolveMemoryTreeLifecycleFailureCooldownMs(failureCount);
  const failedAtMs = Date.parse(input.failedAt);
  const nextEligibleAt = Number.isFinite(failedAtMs)
    ? new Date(failedAtMs + retryAfterMs).toISOString()
    : new Date(Date.now() + retryAfterMs).toISOString();
  const next = normalizeMemoryTreeJobLedgerRecord({
    ...(current ?? {}),
    jobType: input.jobType,
    targetKey: input.targetKey,
    jobKey: buildMemoryTreeJobKey(input.jobType, input.targetKey),
    status: "failed",
    lastRequestedAt: current?.lastRequestedAt ?? input.failedAt,
    lastStartedAt: current?.lastStartedAt ?? input.failedAt,
    lastFailureAt: input.failedAt,
    lastFailureError: normalizeJobErrorMessage(input.error),
    failureCount,
    nextEligibleAt,
    retryAfterMs,
    lastUpdatedAt: input.failedAt,
    ...(input.triggerSource ? { triggerSource: input.triggerSource } : {}),
  }, input);
  writeMemoryTreeJobLedgerRecord(store, next);
  return next;
}

export function recordMemoryTreeJobLedgerSkip(
  store: MemoryTreeJobLedgerStore,
  input: MemoryTreeJobLedgerTarget & {
    skippedAt: string;
    reason: MemoryTreeJobSkipReason | string;
    triggerSource?: string;
  },
): MemoryTreeJobLedgerRecord {
  const current = readMemoryTreeJobLedgerRecord(store, input.jobType, input.targetKey);
  const status = current?.status === "cooldown" || input.reason === "cooldown_active"
    ? "cooldown"
    : current?.status === "running" || input.reason === "reentry_blocked"
      ? "running"
      : current?.status ?? "queued";
  const next = normalizeMemoryTreeJobLedgerRecord({
    ...(current ?? {}),
    jobType: input.jobType,
    targetKey: input.targetKey,
    jobKey: buildMemoryTreeJobKey(input.jobType, input.targetKey),
    status,
    lastRequestedAt: input.skippedAt,
    lastUpdatedAt: input.skippedAt,
    skipCount: (current?.skipCount ?? 0) + 1,
    lastSkippedAt: input.skippedAt,
    lastSkipReason: input.reason,
    ...(input.triggerSource ? { lastSkippedTriggerSource: input.triggerSource } : {}),
  }, input);
  writeMemoryTreeJobLedgerRecord(store, next);
  return next;
}

function writeMemoryTreeJobLedgerRecord(store: MemoryTreeJobLedgerStore, record: MemoryTreeJobLedgerRecord): void {
  store.setMeta(buildMemoryTreeJobLedgerMetaKey(record.jobType, record.targetKey), JSON.stringify(record));
}

function normalizeMemoryTreeJobLedgerRecord(
  input: Record<string, unknown>,
  fallback: MemoryTreeJobLedgerTarget,
): MemoryTreeJobLedgerRecord {
  const jobType = isMemoryTreeJobType(input.jobType) ? input.jobType : fallback.jobType;
  const targetKey = normalizeNonEmptyText(input.targetKey) ?? fallback.targetKey;
  const jobKey = normalizeNonEmptyText(input.jobKey) ?? buildMemoryTreeJobKey(jobType, targetKey);
  const status = isMemoryTreeJobStatus(input.status) ? input.status : "queued";
  const lastRequestedAt = normalizeNonEmptyText(input.lastRequestedAt);
  const lastStartedAt = normalizeNonEmptyText(input.lastStartedAt);
  const lastCompletedAt = normalizeNonEmptyText(input.lastCompletedAt);
  const lastSuccessAt = normalizeNonEmptyText(input.lastSuccessAt);
  const lastFailureAt = normalizeNonEmptyText(input.lastFailureAt);
  const lastFailureError = normalizeNonEmptyText(input.lastFailureError);
  const lastSkippedAt = normalizeNonEmptyText(input.lastSkippedAt);
  const lastSkipReason = normalizeNonEmptyText(input.lastSkipReason);
  const lastSkippedTriggerSource = normalizeNonEmptyText(input.lastSkippedTriggerSource);
  const nextEligibleAt = normalizeNonEmptyText(input.nextEligibleAt);
  const lastUpdatedAt = normalizeNonEmptyText(input.lastUpdatedAt);
  const triggerSource = normalizeNonEmptyText(input.triggerSource);
  const retryAfterMs = normalizePositiveInteger(input.retryAfterMs);
  return {
    jobType,
    targetKey,
    jobKey,
    status,
    ...(lastRequestedAt ? { lastRequestedAt } : {}),
    ...(lastStartedAt ? { lastStartedAt } : {}),
    ...(lastCompletedAt ? { lastCompletedAt } : {}),
    ...(lastSuccessAt ? { lastSuccessAt } : {}),
    ...(lastFailureAt ? { lastFailureAt } : {}),
    ...(lastFailureError ? { lastFailureError } : {}),
    failureCount: normalizeNonNegativeInteger(input.failureCount),
    skipCount: normalizeNonNegativeInteger(input.skipCount),
    ...(lastSkippedAt ? { lastSkippedAt } : {}),
    ...(lastSkipReason ? { lastSkipReason } : {}),
    ...(lastSkippedTriggerSource ? { lastSkippedTriggerSource } : {}),
    ...(nextEligibleAt ? { nextEligibleAt } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(lastUpdatedAt ? { lastUpdatedAt } : {}),
    ...(triggerSource ? { triggerSource } : {}),
  };
}

function normalizeJobErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.trim() || "Unknown job failure";
  return normalized.length > 280 ? `${normalized.slice(0, 277)}...` : normalized;
}

function normalizeMetaKeyPart(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return normalized.replace(/^_+|_+$/g, "") || "default";
}

function normalizeNonEmptyText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeNonNegativeInteger(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }
  return 0;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const normalized = normalizeNonNegativeInteger(value);
  return normalized > 0 ? normalized : undefined;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMemoryTreeJobStatus(value: unknown): value is MemoryTreeJobStatus {
  return value === "queued" || value === "running" || value === "completed" || value === "failed" || value === "cooldown";
}

function isMemoryTreeJobType(value: unknown): value is MemoryTreeJobType {
  return value === "source_rebuild"
    || value === "derived_materialize"
    || value === "score_rebuild"
    || value === "node_rebuild"
    || value === "dedup_preview"
    || value === "lifecycle_archive";
}
