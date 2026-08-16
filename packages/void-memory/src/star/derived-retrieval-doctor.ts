import type { DerivedRetrievalReport } from "./derived-retrieval-report.js";

export type DerivedRetrievalRuntimeSnapshot = {
  observedAt: string;
  reports: {
    session: DerivedRetrievalReport;
    task: DerivedRetrievalReport;
    experience: DerivedRetrievalReport;
  };
};

type DerivedRetrievalDoctorBudget = {
  candidateLimit?: number;
  concurrency?: number;
  fileByteLimit?: number;
  totalReadByteLimit?: number;
  referenceRequestLimit?: number;
  recentCandidateLimit?: number;
  searchCandidateLimit?: number;
  maxDistinctDetailCount?: number;
  recentActivityPerTaskLimit?: number;
  detailLimit?: number;
  bodyByteLimit?: number;
  totalBodyByteLimit?: number;
};

export type DerivedRetrievalDoctorCheck = {
  id: "memory_derived_retrieval";
  name: "Memory Derived Retrieval";
  status: "pass" | "warn";
  message: string;
  detail: Record<string, unknown>;
};

export type DerivedRetrievalDoctorReport = {
  generatedAt: string;
  headline: string;
  summary: {
    available: boolean;
    observedAt?: string;
    observedRunCount: 0 | 1;
    chainCount: 3;
    admittedChainCount: number;
    skippedChainCount: number;
    deadlineExceededBeforeStartCount: number;
    deadlineExceededAfterCompletionCount: number;
    candidateCount: number;
    detailCount: number;
    readByteCount: number;
    resultCount: number;
    budgets: Record<"session" | "task" | "experience", DerivedRetrievalDoctorBudget>;
  };
  latestRun?: DerivedRetrievalRuntimeSnapshot;
  checks: DerivedRetrievalDoctorCheck[];
};

const DERIVED_RETRIEVAL_BUDGETS: Record<"session" | "task" | "experience", DerivedRetrievalDoctorBudget> = {
  session: {
    candidateLimit: 24,
    concurrency: 4,
    fileByteLimit: 64 * 1024,
    totalReadByteLimit: 256 * 1024,
  },
  task: {
    // This is the fixed benchmark/default search limit, not a new runtime limit.
    referenceRequestLimit: 5,
    recentCandidateLimit: 36,
    searchCandidateLimit: 25,
    maxDistinctDetailCount: 61,
    recentActivityPerTaskLimit: 3,
  },
  experience: {
    candidateLimit: 24,
    detailLimit: 12,
    bodyByteLimit: 8 * 1024,
    totalBodyByteLimit: 96 * 1024,
  },
};

export function createDerivedRetrievalRuntimeSnapshot(input: {
  observedAt?: string;
  reports: DerivedRetrievalRuntimeSnapshot["reports"];
}): DerivedRetrievalRuntimeSnapshot {
  return {
    observedAt: input.observedAt ?? new Date().toISOString(),
    reports: {
      session: cloneReport(input.reports.session),
      task: cloneReport(input.reports.task),
      experience: cloneReport(input.reports.experience),
    },
  };
}

export function buildDerivedRetrievalDoctorReport(
  latestRun?: DerivedRetrievalRuntimeSnapshot,
): DerivedRetrievalDoctorReport {
  const reports = latestRun ? Object.values(latestRun.reports) : [];
  const summary = {
    available: Boolean(latestRun),
    ...(latestRun ? { observedAt: latestRun.observedAt } : {}),
    observedRunCount: latestRun ? 1 as const : 0 as const,
    chainCount: 3 as const,
    admittedChainCount: reports.filter((report) => report.admitted).length,
    skippedChainCount: reports.filter((report) => report.skipped).length,
    deadlineExceededBeforeStartCount: reports.filter((report) => report.deadline.exceededBeforeStart).length,
    deadlineExceededAfterCompletionCount: reports.filter((report) => report.deadline.exceededAfterCompletion).length,
    candidateCount: sumReports(reports, "candidateCount"),
    detailCount: sumReports(reports, "detailCount"),
    readByteCount: sumReports(reports, "readByteCount"),
    resultCount: sumReports(reports, "resultCount"),
    budgets: DERIVED_RETRIEVAL_BUDGETS,
  };
  const deadlineObserved = summary.deadlineExceededBeforeStartCount > 0
    || summary.deadlineExceededAfterCompletionCount > 0;
  const headline = latestRun
    ? `Derived retrieval latest run: admitted=${summary.admittedChainCount}/3, skipped=${summary.skippedChainCount}, deadlineBeforeStart=${summary.deadlineExceededBeforeStartCount}, deadlineAfterCompletion=${summary.deadlineExceededAfterCompletionCount}, candidates=${summary.candidateCount}, details=${summary.detailCount}, readBytes=${summary.readByteCount}, results=${summary.resultCount}.`
    : "No derived retrieval run has been observed since this memory manager started.";

  return {
    generatedAt: new Date().toISOString(),
    headline,
    summary,
    ...(latestRun ? { latestRun: cloneSnapshot(latestRun) } : {}),
    checks: [{
      id: "memory_derived_retrieval",
      name: "Memory Derived Retrieval",
      status: deadlineObserved ? "warn" : "pass",
      message: headline,
      detail: {
        observedRunCount: summary.observedRunCount,
        admittedChainCount: summary.admittedChainCount,
        skippedChainCount: summary.skippedChainCount,
        deadlineExceededBeforeStartCount: summary.deadlineExceededBeforeStartCount,
        deadlineExceededAfterCompletionCount: summary.deadlineExceededAfterCompletionCount,
        budgets: DERIVED_RETRIEVAL_BUDGETS,
      },
    }],
  };
}

function cloneSnapshot(snapshot: DerivedRetrievalRuntimeSnapshot): DerivedRetrievalRuntimeSnapshot {
  return createDerivedRetrievalRuntimeSnapshot({
    observedAt: snapshot.observedAt,
    reports: snapshot.reports,
  });
}

function cloneReport(report: DerivedRetrievalReport): DerivedRetrievalReport {
  return {
    admitted: report.admitted,
    candidateCount: report.candidateCount,
    detailCount: report.detailCount,
    readByteCount: report.readByteCount,
    resultCount: report.resultCount,
    skipped: report.skipped,
    ...(report.skipReason ? { skipReason: report.skipReason } : {}),
    deadline: {
      exceededBeforeStart: report.deadline.exceededBeforeStart,
      exceededAfterCompletion: report.deadline.exceededAfterCompletion,
    },
  };
}

function sumReports(reports: DerivedRetrievalReport[], field: "candidateCount" | "detailCount" | "readByteCount" | "resultCount"): number {
  return reports.reduce((total, report) => total + report[field], 0);
}
