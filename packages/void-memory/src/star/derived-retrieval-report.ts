import type { MemorySearchResult } from "./types.js";

export type DerivedRetrievalSkipReason =
  | "deadline"
  | "empty_query"
  | "scope"
  | "memory_type"
  | "unavailable";

/**
 * 三条派生检索链共用的有界工作报告。readByteCount 仅统计受控正文/文件读取，
 * 不把 SQLite 行投影的内存分配伪装成可计量的正文读取。
 */
export type DerivedRetrievalReport = {
  admitted: boolean;
  candidateCount: number;
  detailCount: number;
  readByteCount: number;
  resultCount: number;
  skipped: boolean;
  skipReason?: DerivedRetrievalSkipReason;
  deadline: {
    exceededBeforeStart: boolean;
    exceededAfterCompletion: boolean;
  };
};

export type DerivedRetrievalExecution = {
  items: MemorySearchResult[];
  report: DerivedRetrievalReport;
};

export function buildDerivedRetrievalReport(input: {
  admitted: boolean;
  candidateCount?: number;
  detailCount?: number;
  readByteCount?: number;
  resultCount?: number;
  skipped?: boolean;
  skipReason?: DerivedRetrievalSkipReason;
  deadlineExceededBeforeStart?: boolean;
  deadlineExceededAfterCompletion?: boolean;
}): DerivedRetrievalReport {
  return {
    admitted: input.admitted,
    candidateCount: normalizeCount(input.candidateCount),
    detailCount: normalizeCount(input.detailCount),
    readByteCount: normalizeCount(input.readByteCount),
    resultCount: normalizeCount(input.resultCount),
    skipped: input.skipped ?? false,
    ...(input.skipReason ? { skipReason: input.skipReason } : {}),
    deadline: {
      exceededBeforeStart: input.deadlineExceededBeforeStart ?? false,
      exceededAfterCompletion: input.deadlineExceededAfterCompletion ?? false,
    },
  };
}

export function buildDeadlineSkippedDerivedRetrievalExecution(): DerivedRetrievalExecution {
  return {
    items: [],
    report: buildDerivedRetrievalReport({
      admitted: false,
      skipped: true,
      skipReason: "deadline",
      deadlineExceededBeforeStart: true,
    }),
  };
}

export function hasDerivedRetrievalDeadlinePassed(deadlineMs: number | undefined): boolean {
  return typeof deadlineMs === "number"
    && Number.isFinite(deadlineMs)
    && Date.now() >= deadlineMs;
}

function normalizeCount(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value!));
}
