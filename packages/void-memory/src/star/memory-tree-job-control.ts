import {
  buildMemoryTreeJobKey,
  readMemoryTreeJobLedgerRecord,
  recordMemoryTreeJobLedgerSkip,
  recordMemoryTreeJobLedgerStart,
  type MemoryTreeJobLedgerRecord,
  type MemoryTreeJobLedgerStore,
  type MemoryTreeJobSkipReason,
} from "./memory-tree-job-ledger.js";
import type { MemoryTreeJobType } from "./memory-tree-job-report.js";

const memoryTreeJobInflight = new Map<string, { startedAt: string; triggerSource: string }>();

export type MemoryTreeJobControlTarget = {
  jobType: MemoryTreeJobType;
  targetKey: string;
};

export type MemoryTreeJobControlClaimStarted = {
  started: true;
  ledger: MemoryTreeJobLedgerRecord;
  release: () => void;
};

export type MemoryTreeJobControlClaimSkipped = {
  started: false;
  skipped: MemoryTreeJobLedgerRecord;
  reason: MemoryTreeJobSkipReason;
};

export type MemoryTreeJobControlClaimResult = MemoryTreeJobControlClaimStarted | MemoryTreeJobControlClaimSkipped;

export function claimMemoryTreeJobRun(
  store: MemoryTreeJobLedgerStore,
  input: MemoryTreeJobControlTarget & {
    startedAt: string;
    triggerSource?: string;
  },
): MemoryTreeJobControlClaimResult {
  const jobKey = buildMemoryTreeJobKey(input.jobType, input.targetKey);
  const current = readMemoryTreeJobLedgerRecord(store, input.jobType, input.targetKey);

  if (isFutureIsoTimestamp(current?.nextEligibleAt, input.startedAt)) {
    return {
      started: false,
      skipped: recordMemoryTreeJobLedgerSkip(store, {
        jobType: input.jobType,
        targetKey: input.targetKey,
        skippedAt: input.startedAt,
        reason: "cooldown_active",
        ...(input.triggerSource ? { triggerSource: input.triggerSource } : {}),
      }),
      reason: "cooldown_active",
    };
  }

  if (current?.status === "running" || memoryTreeJobInflight.has(jobKey)) {
    return {
      started: false,
      skipped: recordMemoryTreeJobLedgerSkip(store, {
        jobType: input.jobType,
        targetKey: input.targetKey,
        skippedAt: input.startedAt,
        reason: "reentry_blocked",
        ...(input.triggerSource ? { triggerSource: input.triggerSource } : {}),
      }),
      reason: "reentry_blocked",
    };
  }

  memoryTreeJobInflight.set(jobKey, {
    startedAt: input.startedAt,
    triggerSource: typeof input.triggerSource === "string" && input.triggerSource.trim().length > 0
      ? input.triggerSource.trim()
      : input.jobType,
  });

  try {
    const ledger = recordMemoryTreeJobLedgerStart(store, {
      jobType: input.jobType,
      targetKey: input.targetKey,
      startedAt: input.startedAt,
      ...(input.triggerSource ? { triggerSource: input.triggerSource } : {}),
    });
    return {
      started: true,
      ledger,
      release: () => {
        memoryTreeJobInflight.delete(jobKey);
      },
    };
  } catch (error) {
    memoryTreeJobInflight.delete(jobKey);
    throw error;
  }
}

export function clearMemoryTreeJobInflightForTest(): void {
  memoryTreeJobInflight.clear();
}

function isFutureIsoTimestamp(value: string | undefined, checkedAt: string): boolean {
  if (!value) {
    return false;
  }
  const futureMs = Date.parse(value);
  const checkedMs = Date.parse(checkedAt);
  if (!Number.isFinite(futureMs) || !Number.isFinite(checkedMs)) {
    return false;
  }
  return futureMs > checkedMs;
}
