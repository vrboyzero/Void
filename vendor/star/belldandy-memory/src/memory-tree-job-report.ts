import type {
  ManagedMemoryTreeNodeKind,
  MemoryTreeNodeLifecycleState,
  MemoryTreeSourceLifecycleState,
} from "./memory-tree-lifecycle.js";
import {
  buildMemoryTreeJobKey,
  type MemoryTreeJobLedgerRecord,
} from "./memory-tree-job-ledger.js";
import type { MemoryTreeReportRecord } from "./memory-tree-types.js";

export type MemoryTreeJobType =
  | "source_rebuild"
  | "derived_materialize"
  | "score_rebuild"
  | "node_rebuild"
  | "dedup_preview"
  | "lifecycle_archive";

export type MemoryTreeJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cooldown";

export type MemoryTreeJobImplementationStage =
  | "runtime_managed"
  | "manual_preview"
  | "planned";

export type MemoryTreeJobDefinition = {
  jobType: MemoryTreeJobType;
  label: string;
  implementationStage: MemoryTreeJobImplementationStage;
  description: string;
  triggerSources: string[];
};

export type MemoryTreeJobView = {
  id: string;
  jobKey: string;
  jobType: MemoryTreeJobType;
  label: string;
  status: MemoryTreeJobStatus;
  implementationStage: MemoryTreeJobImplementationStage;
  targetKey: string;
  targetLabel: string;
  triggerSource: string;
  reasons: string[];
  failureCount: number;
  skipCount: number;
  lastRequestedAt?: string;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastFailureError?: string;
  lastSkippedAt?: string;
  lastSkipReason?: string;
  lastSkippedTriggerSource?: string;
  nextEligibleAt?: string;
  retryAfterMs?: number;
  lastUpdatedAt?: string;
  lastError?: string;
  metadata?: Record<string, unknown>;
};

export type MemoryTreeJobReportCheck = {
  id: string;
  name: string;
  status: "pass" | "warn";
  message: string;
  detail?: Record<string, unknown>;
};

export type MemoryTreeJobReport = {
  generatedAt: string;
  summary: {
    definitionCount: number;
    runtimeManagedDefinitionCount: number;
    manualPreviewDefinitionCount: number;
    plannedDefinitionCount: number;
    visibleJobCount: number;
    queuedCount: number;
    runningCount: number;
    completedCount: number;
    failedCount: number;
    cooldownCount: number;
    skippedCount: number;
  };
  headline: string;
  definitions: MemoryTreeJobDefinition[];
  jobs: MemoryTreeJobView[];
  checks: MemoryTreeJobReportCheck[];
};

export function buildMemoryTreeJobReport(input: {
  checkedAt: string;
  source: MemoryTreeSourceLifecycleState;
  nodes: MemoryTreeNodeLifecycleState[];
  scoreLastRebuiltAt?: string;
  latestDedupPreviewReport?: MemoryTreeReportRecord | null;
  jobLedger?: MemoryTreeJobLedgerRecord[];
}): MemoryTreeJobReport {
  const definitions = buildMemoryTreeJobDefinitions();
  const ledgerByJobKey = new Map(
    (input.jobLedger ?? []).map((record) => [record.jobKey, record] as const),
  );
  const jobs: MemoryTreeJobView[] = [
    buildSourceRebuildJob(input.checkedAt, input.source, ledgerByJobKey.get(buildMemoryTreeJobKey("source_rebuild", "source"))),
    ...input.nodes.map((node) => buildNodeRebuildJob(input.checkedAt, node, ledgerByJobKey.get(buildMemoryTreeJobKey("node_rebuild", node.kind)))),
    buildScoreRebuildJob(input.checkedAt, input.scoreLastRebuiltAt, ledgerByJobKey.get(buildMemoryTreeJobKey("score_rebuild", "chunk_scores"))),
  ];
  const dedupPreviewJob = buildDedupPreviewJob(input.latestDedupPreviewReport);
  if (dedupPreviewJob) {
    jobs.push(dedupPreviewJob);
  }

  const queuedCount = jobs.filter((job) => job.status === "queued").length;
  const runningCount = jobs.filter((job) => job.status === "running").length;
  const completedCount = jobs.filter((job) => job.status === "completed").length;
  const failedCount = jobs.filter((job) => job.status === "failed").length;
  const cooldownCount = jobs.filter((job) => job.status === "cooldown").length;
  const skippedCount = jobs.reduce((total, job) => total + (job.skipCount ?? 0), 0);
  const nextRetry = resolveNextRetryCandidate(jobs, input.checkedAt);

  const headline = buildMemoryTreeJobHeadline({
    jobs,
    queuedCount,
    runningCount,
    failedCount,
    cooldownCount,
    skippedCount,
    nextRetry,
  });

  return {
    generatedAt: input.checkedAt,
    summary: {
      definitionCount: definitions.length,
      runtimeManagedDefinitionCount: definitions.filter((item) => item.implementationStage === "runtime_managed").length,
      manualPreviewDefinitionCount: definitions.filter((item) => item.implementationStage === "manual_preview").length,
      plannedDefinitionCount: definitions.filter((item) => item.implementationStage === "planned").length,
      visibleJobCount: jobs.length,
      queuedCount,
      runningCount,
      completedCount,
      failedCount,
      cooldownCount,
      skippedCount,
    },
    headline,
    definitions,
    jobs,
    checks: [
      {
        id: "memory_tree_jobs",
        name: "Memory Tree Jobs",
        status: queuedCount > 0 || runningCount > 0 || failedCount > 0 || cooldownCount > 0 ? "warn" : "pass",
        message: headline,
        detail: {
          visibleJobCount: jobs.length,
          queuedCount,
          runningCount,
          completedCount,
          failedCount,
          cooldownCount,
          skippedCount,
          ...(nextRetry ? {
            nextRetryJobKey: nextRetry.job.jobKey,
            nextRetryAt: nextRetry.job.nextEligibleAt,
            nextRetryAfterMs: nextRetry.retryAfterMs,
          } : {}),
        },
      },
    ],
  };
}

function buildMemoryTreeJobDefinitions(): MemoryTreeJobDefinition[] {
  return [
    {
      jobType: "source_rebuild",
      label: "Source Rebuild",
      implementationStage: "runtime_managed",
      description: "刷新来源层 inventory / rollup，使 source 身份与树层来源视图保持一致。",
      triggerSources: ["memory.tree.lifecycle.ensure", "memory.tree.source.rebuild", "node-assisted preflight", "external ingest apply"],
    },
    {
      jobType: "node_rebuild",
      label: "Node Rebuild",
      implementationStage: "runtime_managed",
      description: "刷新 topic / profile / global 高层节点，让高层回答与摘要锚点保持新鲜。",
      triggerSources: ["memory.tree.lifecycle.ensure", "memory.tree.node.rebuild", "mind-profile preflight"],
    },
    {
      jobType: "score_rebuild",
      label: "Score Rebuild",
      implementationStage: "runtime_managed",
      description: "刷新 chunk 分数与治理信号，为统一检索面提供排序基线。",
      triggerSources: ["memory.tree.score.rebuild", "external ingest apply"],
    },
    {
      jobType: "dedup_preview",
      label: "Dedup Preview",
      implementationStage: "manual_preview",
      description: "生成去重治理预览与建议报告，供 review / apply 流程消费。",
      triggerSources: ["memory.tree.report.dedup.preview", "memory.dedup.preview"],
    },
    {
      jobType: "derived_materialize",
      label: "Derived Materialize",
      implementationStage: "planned",
      description: "把高价值派生记忆统一沉淀到同一作业流水线。",
      triggerSources: ["session digest", "session memory", "task completion"],
    },
    {
      jobType: "lifecycle_archive",
      label: "Lifecycle Archive",
      implementationStage: "planned",
      description: "对长期失效或低价值的来源/节点做归档、降权和生命周期迁移。",
      triggerSources: ["scheduled governance window", "manual governance review"],
    },
  ];
}

function buildSourceRebuildJob(
  checkedAt: string,
  source: MemoryTreeSourceLifecycleState,
  ledger?: MemoryTreeJobLedgerRecord,
): MemoryTreeJobView {
  const lastSuccessAt = ledger?.lastSuccessAt ?? source.lastRebuiltAt;
  const lastFailureAt = ledger?.lastFailureAt ?? source.governance.lastFailureAt;
  const nextEligibleAt = ledger?.nextEligibleAt ?? source.governance.cooldownUntil;
  const status = resolveManagedRebuildJobStatus({
    checkedAt,
    dirty: source.dirty,
    reasons: source.reasons,
    lastError: source.governance.lastError,
    cooldownActive: source.governance.cooldownActive,
    ledger,
    nextEligibleAt,
  });
  return {
    id: "memory-tree-job:source_rebuild:source",
    jobKey: buildMemoryTreeJobKey("source_rebuild", "source"),
    jobType: "source_rebuild",
    label: "Source Rebuild",
    status,
    implementationStage: "runtime_managed",
    targetKey: "source",
    targetLabel: "Memory Sources",
    triggerSource: ledger?.triggerSource ?? "lifecycle.ensure",
    reasons: [...source.reasons],
    failureCount: ledger?.failureCount ?? source.governance.failureCount,
    skipCount: ledger?.skipCount ?? 0,
    lastRequestedAt: ledger?.lastRequestedAt,
    lastStartedAt: ledger?.lastStartedAt,
    lastCompletedAt: ledger?.lastCompletedAt ?? lastSuccessAt,
    lastSuccessAt,
    lastFailureAt,
    lastFailureError: ledger?.lastFailureError ?? source.governance.lastError,
    lastSkippedAt: ledger?.lastSkippedAt,
    lastSkipReason: ledger?.lastSkipReason,
    lastSkippedTriggerSource: ledger?.lastSkippedTriggerSource,
    nextEligibleAt,
    retryAfterMs: ledger?.retryAfterMs ?? resolveRetryAfterMs(nextEligibleAt, lastFailureAt),
    lastUpdatedAt: resolveLatestTimestamp([ledger?.lastUpdatedAt, lastSuccessAt, lastFailureAt]) ?? checkedAt,
    lastError: source.governance.lastError,
    metadata: {
      currentMemorySeq: source.currentMemorySeq,
      lastMemorySeq: source.lastMemorySeq,
      sourcePresent: source.sourcePresent,
      ...(ledger?.triggerSource ? { lastTriggerSource: ledger?.triggerSource } : {}),
    },
  };
}

function buildNodeRebuildJob(
  checkedAt: string,
  node: MemoryTreeNodeLifecycleState,
  ledger?: MemoryTreeJobLedgerRecord,
): MemoryTreeJobView {
  const lastSuccessAt = ledger?.lastSuccessAt ?? node.lastRebuiltAt;
  const lastFailureAt = ledger?.lastFailureAt ?? node.governance.lastFailureAt;
  const nextEligibleAt = ledger?.nextEligibleAt ?? node.governance.cooldownUntil;
  const status = resolveManagedRebuildJobStatus({
    checkedAt,
    dirty: node.dirty,
    reasons: node.reasons,
    lastError: node.governance.lastError,
    cooldownActive: node.governance.cooldownActive,
    ledger,
    nextEligibleAt,
  });
  return {
    id: `memory-tree-job:node_rebuild:${node.kind}`,
    jobKey: buildMemoryTreeJobKey("node_rebuild", node.kind),
    jobType: "node_rebuild",
    label: "Node Rebuild",
    status,
    implementationStage: "runtime_managed",
    targetKey: node.kind,
    targetLabel: resolveNodeTargetLabel(node.kind),
    triggerSource: ledger?.triggerSource ?? "lifecycle.ensure",
    reasons: [...node.reasons],
    failureCount: ledger?.failureCount ?? node.governance.failureCount,
    skipCount: ledger?.skipCount ?? 0,
    lastRequestedAt: ledger?.lastRequestedAt,
    lastStartedAt: ledger?.lastStartedAt,
    lastCompletedAt: ledger?.lastCompletedAt ?? lastSuccessAt,
    lastSuccessAt,
    lastFailureAt,
    lastFailureError: ledger?.lastFailureError ?? node.governance.lastError,
    lastSkippedAt: ledger?.lastSkippedAt,
    lastSkipReason: ledger?.lastSkipReason,
    lastSkippedTriggerSource: ledger?.lastSkippedTriggerSource,
    nextEligibleAt,
    retryAfterMs: ledger?.retryAfterMs ?? resolveRetryAfterMs(nextEligibleAt, lastFailureAt),
    lastUpdatedAt: resolveLatestTimestamp([ledger?.lastUpdatedAt, lastSuccessAt, lastFailureAt]) ?? checkedAt,
    lastError: node.governance.lastError,
    metadata: {
      currentMemorySeq: node.currentMemorySeq,
      currentTaskSeq: node.currentTaskSeq,
      lastMemorySeq: node.lastMemorySeq,
      lastTaskSeq: node.lastTaskSeq,
      nodePresent: node.nodePresent,
      ...(ledger?.triggerSource ? { lastTriggerSource: ledger?.triggerSource } : {}),
    },
  };
}

function buildScoreRebuildJob(
  checkedAt: string,
  lastRebuiltAt: string | undefined,
  ledger?: MemoryTreeJobLedgerRecord,
): MemoryTreeJobView {
  const lastSuccessAt = ledger?.lastSuccessAt ?? lastRebuiltAt;
  const lastFailureAt = ledger?.lastFailureAt;
  const nextEligibleAt = ledger?.nextEligibleAt;
  const status = resolveScoreRebuildJobStatus(lastRebuiltAt, ledger, checkedAt);
  const reasons = status === "completed"
    ? []
    : status === "cooldown"
      ? ["cooldown_active"]
      : status === "failed"
        ? ["last_error"]
        : status === "running"
          ? ["running"]
          : ["never_rebuilt"];
  return {
    id: "memory-tree-job:score_rebuild:chunk-scores",
    jobKey: buildMemoryTreeJobKey("score_rebuild", "chunk_scores"),
    jobType: "score_rebuild",
    label: "Score Rebuild",
    status,
    implementationStage: "runtime_managed",
    targetKey: "chunk_scores",
    targetLabel: "Chunk Scores",
    triggerSource: ledger?.triggerSource ?? "manual_or_followup",
    reasons,
    failureCount: ledger?.failureCount ?? 0,
    skipCount: ledger?.skipCount ?? 0,
    lastRequestedAt: ledger?.lastRequestedAt,
    lastStartedAt: ledger?.lastStartedAt,
    lastCompletedAt: ledger?.lastCompletedAt ?? lastSuccessAt,
    lastSuccessAt,
    lastFailureAt,
    lastFailureError: ledger?.lastFailureError,
    lastSkippedAt: ledger?.lastSkippedAt,
    lastSkipReason: ledger?.lastSkipReason,
    lastSkippedTriggerSource: ledger?.lastSkippedTriggerSource,
    nextEligibleAt,
    retryAfterMs: ledger?.retryAfterMs ?? resolveRetryAfterMs(nextEligibleAt, lastFailureAt),
    lastUpdatedAt: resolveLatestTimestamp([ledger?.lastUpdatedAt, lastSuccessAt, lastFailureAt]) ?? checkedAt,
    lastError: status === "failed" || status === "cooldown" ? ledger?.lastFailureError : undefined,
    metadata: {
      scoreVersion: "v1_rule_only",
      ...(ledger?.triggerSource ? { lastTriggerSource: ledger?.triggerSource } : {}),
    },
  };
}

function buildDedupPreviewJob(report: MemoryTreeReportRecord | null | undefined): MemoryTreeJobView | null {
  if (!report) {
    return null;
  }
  const completedAt = report.updatedAt ?? report.createdAt;
  const governance = typeof report.summary.governance === "object" && report.summary.governance !== null
    ? report.summary.governance
    : undefined;
  return {
    id: `memory-tree-job:dedup_preview:${report.id}`,
    jobKey: buildMemoryTreeJobKey("dedup_preview", report.id),
    jobType: "dedup_preview",
    label: "Dedup Preview",
    status: "completed",
    implementationStage: "manual_preview",
    targetKey: report.id,
    targetLabel: "Latest Dedup Preview",
    triggerSource: "manual_preview",
    reasons: [],
    failureCount: 0,
    skipCount: 0,
    lastCompletedAt: completedAt,
    lastSuccessAt: completedAt,
    lastUpdatedAt: completedAt,
    metadata: {
      reportId: report.id,
      reportStatus: report.status,
      scope: report.scope,
      ...(governance ? { governance } : {}),
    },
  };
}

function buildMemoryTreeJobHeadline(input: {
  jobs: MemoryTreeJobView[];
  queuedCount: number;
  runningCount: number;
  failedCount: number;
  cooldownCount: number;
  skippedCount: number;
  nextRetry?: MemoryTreeJobRetryCandidate;
}): string {
  if (input.failedCount > 0 || input.cooldownCount > 0) {
    const retryHint = buildNextRetryHint(input.nextRetry);
    return `Memory tree jobs need attention: queued=${input.queuedCount}, running=${input.runningCount}, failed=${input.failedCount}, cooldown=${input.cooldownCount}, skipped=${input.skippedCount}${retryHint ? `; ${retryHint}` : ""}.`;
  }
  if (input.runningCount > 0) {
    return `Memory tree jobs in progress: running=${input.runningCount}, queued=${input.queuedCount}, skipped=${input.skippedCount}, visible=${input.jobs.length}.`;
  }
  if (input.queuedCount > 0) {
    return `Memory tree jobs pending refresh: queued=${input.queuedCount}, skipped=${input.skippedCount}, visible=${input.jobs.length}.`;
  }
  return `Memory tree jobs stable: visible=${input.jobs.length}, queued=0, skipped=${input.skippedCount}.`;
}

type MemoryTreeJobRetryCandidate = {
  job: MemoryTreeJobView;
  retryAfterMs: number;
};

function resolveManagedRebuildJobStatus(input: {
  checkedAt: string;
  dirty: boolean;
  reasons: string[];
  lastError: string | undefined;
  cooldownActive: boolean;
  ledger?: MemoryTreeJobLedgerRecord;
  nextEligibleAt?: string;
}): MemoryTreeJobStatus {
  if (input.ledger?.status === "running") {
    return "running";
  }
  if (isFutureIsoTimestamp(input.nextEligibleAt, input.checkedAt) || input.cooldownActive || input.reasons.includes("cooldown_active")) {
    return "cooldown";
  }
  if (input.ledger?.status === "failed" || input.lastError || input.reasons.includes("last_error")) {
    return "failed";
  }
  if (input.dirty) {
    return "queued";
  }
  return "completed";
}

function resolveNextRetryCandidate(jobs: MemoryTreeJobView[], checkedAt: string): MemoryTreeJobRetryCandidate | undefined {
  const candidates = jobs
    .map((job) => ({
      job,
      retryAfterMs: resolveJobRetryAfterMs(job, checkedAt),
    }))
    .filter((entry) => (entry.job.status === "failed" || entry.job.status === "cooldown") && typeof entry.retryAfterMs === "number" && entry.retryAfterMs > 0)
    .sort((left, right) => (left.retryAfterMs ?? Number.POSITIVE_INFINITY) - (right.retryAfterMs ?? Number.POSITIVE_INFINITY));
  const next = candidates[0];
  if (!next || typeof next.retryAfterMs !== "number") {
    return undefined;
  }
  return {
    job: next.job,
    retryAfterMs: next.retryAfterMs,
  };
}

function buildNextRetryHint(next: MemoryTreeJobRetryCandidate | undefined): string | undefined {
  if (!next) {
    return undefined;
  }
  return `next retry in ${formatMemoryTreeRetryDuration(next.retryAfterMs)} for ${next.job.jobKey}`;
}

function resolveJobRetryAfterMs(job: MemoryTreeJobView, checkedAt: string): number | undefined {
  if (job.nextEligibleAt) {
    const nextEligibleAtMs = Date.parse(job.nextEligibleAt);
    const checkedAtMs = Date.parse(checkedAt);
    if (Number.isFinite(nextEligibleAtMs) && Number.isFinite(checkedAtMs) && nextEligibleAtMs > checkedAtMs) {
      return nextEligibleAtMs - checkedAtMs;
    }
  }
  if (typeof job.retryAfterMs === "number" && job.retryAfterMs > 0) {
    return job.retryAfterMs;
  }
  return undefined;
}

function formatMemoryTreeRetryDuration(value: number): string {
  const normalized = Math.max(0, Math.floor(value));
  if (normalized < 1000) {
    return "under 1s";
  }
  if (normalized < 60_000) {
    return `${Math.ceil(normalized / 1000)}s`;
  }
  const minutes = Math.floor(normalized / 60_000);
  const seconds = Math.ceil((normalized % 60_000) / 1000);
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h${remainingMinutes}m` : `${hours}h`;
}

function resolveScoreRebuildJobStatus(
  lastRebuiltAt: string | undefined,
  ledger: MemoryTreeJobLedgerRecord | undefined,
  checkedAt: string,
): MemoryTreeJobStatus {
  if (ledger?.status === "running") {
    return "running";
  }
  if (isFutureIsoTimestamp(ledger?.nextEligibleAt, checkedAt)) {
    return "cooldown";
  }
  if (ledger?.status === "failed") {
    return "failed";
  }
  if (ledger?.status === "completed" || lastRebuiltAt || ledger?.lastSuccessAt) {
    return "completed";
  }
  return "queued";
}

function resolveNodeTargetLabel(kind: ManagedMemoryTreeNodeKind): string {
  switch (kind) {
    case "topic":
      return "Topic Nodes";
    case "profile":
      return "Profile Nodes";
    case "global":
      return "Global Nodes";
  }
}

function resolveRetryAfterMs(nextEligibleAt: string | undefined, lastFailureAt: string | undefined): number | undefined {
  if (!nextEligibleAt || !lastFailureAt) {
    return undefined;
  }
  const nextMs = Date.parse(nextEligibleAt);
  const failureMs = Date.parse(lastFailureAt);
  if (!Number.isFinite(nextMs) || !Number.isFinite(failureMs) || nextMs <= failureMs) {
    return undefined;
  }
  return nextMs - failureMs;
}

function resolveLatestTimestamp(values: Array<string | undefined>): string | undefined {
  let latest: string | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) {
      continue;
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || parsed <= latestMs) {
      continue;
    }
    latestMs = parsed;
    latest = value;
  }
  return latest;
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
