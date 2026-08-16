import crypto from "node:crypto";

import { syncDreamToObsidian } from "./dream-obsidian-sync.js";
import { isAllowedDurableProfileStatePath } from "./durable-profile-state.js";
import { buildDreamRuleSkeleton } from "./dream-input.js";
import { requestDreamModel } from "./dream-model-request.js";
import type { MemoryModelPrivacyRuntime } from "./memory-model-privacy.js";
import { buildDreamPromptBundle, parseDreamModelOutput, summarizeDreamModelOutput } from "./dream-prompt.js";
import { DreamStore, toDreamInputMeta } from "./dream-store.js";
import type {
  DreamConsolidationApplyInput,
  DreamConsolidationApplyState,
  DreamConsolidationReviewDecision,
  DreamConsolidationReviewInput,
  DreamConsolidationReviewState,
  DreamConsolidationSummary,
  DreamConsolidationProfilePatchCandidate,
  DreamConsolidationStaleCandidate,
  DreamConsolidationContradictionCandidate,
  DreamAutoRunResult,
  DreamAutoSignalGateCode,
  DreamAutoSignalSummary,
  DreamAutoTriggerState,
  DreamChangeCursor,
  DreamFallbackReason,
  DreamGenerationMode,
  DreamModelOutput,
  DreamObsidianMirrorOptions,
  DreamRecord,
  DreamRunOptions,
  DreamRunResult,
  DreamRuntimeLogger,
  DreamRuntimeOptions,
  DreamRuntimeState,
} from "./dream-types.js";
import type { ProfileStateValue } from "./profile-state-types.js";
import { writeDreamArtifacts } from "./dream-writer.js";

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function truncateText(value: unknown, maxLength = 240): string | undefined {
  const normalized = normalizeText(value);
  if (!normalized) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 3))}...` : normalized;
}

function applyOpenAICompatibleReasoningConfig(
  payload: Record<string, unknown>,
  profile: Pick<DreamRuntimeOptions, "thinking" | "reasoningEffort">,
): void {
  if (profile.thinking) {
    payload.thinking = profile.thinking;
  }
  if (profile.reasoningEffort) {
    payload.reasoning_effort = profile.reasoningEffort;
  }
}

function formatDateOnlyUtc(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildDreamRunId(now: Date): string {
  const datePart = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `dream-${datePart}-${crypto.randomUUID().slice(0, 8)}`;
}

function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return truncateText(error.message, 240) ?? error.name;
  }
  return truncateText(String(error), 240) ?? "Unknown dream runtime error";
}

function throwIfDreamRunAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Dream run was aborted.");
  error.name = "AbortError";
  throw error;
}

class DreamEmptyContentError extends Error {
  readonly finishReason?: string;
  readonly hasReasoningContent: boolean;
  readonly reasoningContentLength: number;
  readonly maxTokens: number;

  constructor(input: {
    finishReason?: string;
    hasReasoningContent: boolean;
    reasoningContentLength: number;
    maxTokens: number;
  }) {
    const diagnostics = [
      `finish_reason=${input.finishReason ?? "unknown"}`,
      `reasoning_content=${input.hasReasoningContent ? "present" : "absent"}`,
    ];
    if (input.finishReason === "length") {
      diagnostics.push(`max_tokens=${input.maxTokens}`);
    }
    super(`Dream LLM returned empty content (${diagnostics.join(", ")}).`);
    this.name = "DreamEmptyContentError";
    this.finishReason = input.finishReason;
    this.hasReasoningContent = input.hasReasoningContent;
    this.reasoningContentLength = input.reasoningContentLength;
    this.maxTokens = input.maxTokens;
  }
}

function toIsoMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isFutureIso(value: string | undefined, nowMs: number): boolean {
  const parsed = toIsoMs(value);
  return parsed !== null && parsed > nowMs;
}

function toIsoFromMs(value: number | undefined): string | undefined {
  if (!Number.isFinite(value)) return undefined;
  return new Date(Number(value)).toISOString();
}

function readLatestIso(values: Array<string | number | undefined>): string | undefined {
  let latestMs = Number.NaN;
  for (const value of values) {
    const parsed = typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
    if (!Number.isFinite(parsed)) continue;
    if (!Number.isFinite(latestMs) || parsed > latestMs) {
      latestMs = parsed;
    }
  }
  return Number.isFinite(latestMs) ? new Date(latestMs).toISOString() : undefined;
}

function isFreshSinceBaseline(value: string | undefined, baselineMs: number): boolean {
  const parsed = toIsoMs(value);
  return parsed !== null && parsed > baselineMs;
}

function createZeroCursor(): DreamChangeCursor {
  return {
    digestGeneration: 0,
    sessionMemoryMessageCount: 0,
    sessionMemoryToolCursor: 0,
    taskChangeSeq: 0,
    memoryChangeSeq: 0,
  };
}

function normalizeCursor(cursor: DreamChangeCursor | undefined): DreamChangeCursor {
  return {
    digestGeneration: typeof cursor?.digestGeneration === "number" && Number.isFinite(cursor.digestGeneration)
      ? Math.max(0, Math.floor(cursor.digestGeneration))
      : 0,
    sessionMemoryMessageCount: typeof cursor?.sessionMemoryMessageCount === "number" && Number.isFinite(cursor.sessionMemoryMessageCount)
      ? Math.max(0, Math.floor(cursor.sessionMemoryMessageCount))
      : 0,
    sessionMemoryToolCursor: typeof cursor?.sessionMemoryToolCursor === "number" && Number.isFinite(cursor.sessionMemoryToolCursor)
      ? Math.max(0, Math.floor(cursor.sessionMemoryToolCursor))
      : 0,
    taskChangeSeq: typeof cursor?.taskChangeSeq === "number" && Number.isFinite(cursor.taskChangeSeq)
      ? Math.max(0, Math.floor(cursor.taskChangeSeq))
      : 0,
    memoryChangeSeq: typeof cursor?.memoryChangeSeq === "number" && Number.isFinite(cursor.memoryChangeSeq)
      ? Math.max(0, Math.floor(cursor.memoryChangeSeq))
      : 0,
  };
}

function hasMeaningfulCursor(cursor: DreamChangeCursor | undefined): boolean {
  if (!cursor) return false;
  return cursor.digestGeneration > 0
    || cursor.sessionMemoryMessageCount > 0
    || cursor.sessionMemoryToolCursor > 0
    || cursor.taskChangeSeq > 0
    || cursor.memoryChangeSeq > 0;
}

function hasCursorSignal(signal: DreamAutoSignalSummary): boolean {
  return hasMeaningfulCursor(signal.currentCursor) || hasMeaningfulCursor(signal.lastDreamCursor);
}

function buildAutoSignalSummary(
  snapshot: Parameters<typeof toDreamInputMeta>[0],
  baselineAt?: string,
  lastDreamCursor?: DreamChangeCursor,
): DreamAutoSignalSummary {
  const baselineMs = toIsoMs(baselineAt) ?? Date.parse(snapshot.windowStartedAt);
  const latestWorkAt = readLatestIso(snapshot.recentWorkItems.map((item) => item.updatedAt || item.finishedAt || item.startedAt));
  const latestWorkRecapAt = readLatestIso(snapshot.recentWorkItems.map((item) => item.workRecap?.updatedAt));
  const latestResumeContextAt = readLatestIso(snapshot.recentWorkItems.map((item) => item.resumeContext?.updatedAt));
  const latestCompletedTaskAt = readLatestIso(snapshot.recentTasks
    .filter((item) => item.status === "success")
    .map((item) => item.finishedAt || item.updatedAt || item.startedAt));
  const latestDurableMemoryAt = readLatestIso(snapshot.recentDurableMemories.map((item) => item.updatedAt));
  const sessionDigestAt = toIsoFromMs(snapshot.sessionDigest?.lastDigestAt);
  const sessionMemoryAt = toIsoFromMs(snapshot.sessionMemory?.updatedAt);
  const currentCursor = normalizeCursor(snapshot.changeCursor);
  const previousCursor = normalizeCursor(lastDreamCursor);
  const digestGenerationDelta = Math.max(0, currentCursor.digestGeneration - previousCursor.digestGeneration);
  const sessionMemoryMessageDelta = Math.max(0, currentCursor.sessionMemoryMessageCount - previousCursor.sessionMemoryMessageCount);
  const sessionMemoryToolDelta = Math.max(0, currentCursor.sessionMemoryToolCursor - previousCursor.sessionMemoryToolCursor);
  const sessionMemoryRevisionDelta = (sessionMemoryMessageDelta > 0 ? 1 : 0) + (sessionMemoryToolDelta > 0 ? 1 : 0);
  const taskChangeSeqDelta = Math.max(0, currentCursor.taskChangeSeq - previousCursor.taskChangeSeq);
  const memoryChangeSeqDelta = Math.max(0, currentCursor.memoryChangeSeq - previousCursor.memoryChangeSeq);
  const changeBudget = (digestGenerationDelta * 4)
    + (sessionMemoryRevisionDelta * 3)
    + taskChangeSeqDelta
    + memoryChangeSeqDelta;
  return {
    ...(baselineAt ? { baselineAt } : {}),
    ...(snapshot.changeCursor || lastDreamCursor ? { lastDreamCursor: previousCursor, currentCursor } : {}),
    recentWorkCount: snapshot.sourceCounts.recentWorkCount,
    recentWorkRecapCount: snapshot.sourceCounts.recentWorkRecapCount,
    completedTaskCount: snapshot.recentTasks.filter((item) => item.status === "success").length,
    recentDurableMemoryCount: snapshot.sourceCounts.recentDurableMemoryCount,
    sessionDigestAvailable: snapshot.sourceCounts.sessionDigestAvailable,
    sessionMemoryAvailable: snapshot.sourceCounts.sessionMemoryAvailable,
    digestGenerationDelta,
    sessionMemoryMessageDelta,
    sessionMemoryToolDelta,
    sessionMemoryRevisionDelta,
    taskChangeSeqDelta,
    memoryChangeSeqDelta,
    changeBudget,
    ...(latestWorkAt ? { latestWorkAt } : {}),
    ...(latestWorkRecapAt ? { latestWorkRecapAt } : {}),
    ...(latestResumeContextAt ? { latestResumeContextAt } : {}),
    ...(latestCompletedTaskAt ? { latestCompletedTaskAt } : {}),
    ...(latestDurableMemoryAt ? { latestDurableMemoryAt } : {}),
    ...(sessionDigestAt ? { sessionDigestAt } : {}),
    ...(sessionMemoryAt ? { sessionMemoryAt } : {}),
    freshWorkSinceBaseline: isFreshSinceBaseline(latestWorkAt, baselineMs),
    freshWorkRecapSinceBaseline: isFreshSinceBaseline(latestWorkRecapAt, baselineMs),
    freshResumeContextSinceBaseline: isFreshSinceBaseline(latestResumeContextAt, baselineMs),
    freshCompletedTaskSinceBaseline: isFreshSinceBaseline(latestCompletedTaskAt, baselineMs),
    freshDurableMemorySinceBaseline: isFreshSinceBaseline(latestDurableMemoryAt, baselineMs),
    freshSessionDigestSinceBaseline: isFreshSinceBaseline(sessionDigestAt, baselineMs),
    freshSessionMemorySinceBaseline: isFreshSinceBaseline(sessionMemoryAt, baselineMs),
  };
}

function resolveSignalGate(signal: DreamAutoSignalSummary): { ok: boolean; reason: string; code: DreamAutoSignalGateCode } {
  if (hasCursorSignal(signal)) {
    if ((signal.digestGenerationDelta ?? 0) >= 1) {
      return { ok: true, reason: "digest_generation_advanced", code: "digest_generation" };
    }
    if ((signal.sessionMemoryRevisionDelta ?? 0) >= 1) {
      return { ok: true, reason: "session_memory_revision_advanced", code: "session_memory_revision" };
    }
    if ((signal.changeBudget ?? 0) >= 4) {
      return { ok: true, reason: "change_budget_reached", code: "change_budget" };
    }
    return {
      ok: false,
      reason: "change budget below threshold and no digest/session-memory revision advanced",
      code: "insufficient_signal",
    };
  }
  if (signal.freshWorkRecapSinceBaseline) {
    return { ok: true, reason: "work_recap_updated_since_last_dream", code: "fresh_work_recap" };
  }
  if (signal.freshSessionDigestSinceBaseline && (signal.freshWorkSinceBaseline || signal.freshResumeContextSinceBaseline || signal.freshCompletedTaskSinceBaseline)) {
    return { ok: true, reason: "session_digest_and_work_updated_since_last_dream", code: "fresh_digest_and_work" };
  }
  if (signal.freshSessionMemorySinceBaseline && (signal.freshWorkSinceBaseline || signal.freshResumeContextSinceBaseline)) {
    return { ok: true, reason: "session_memory_and_work_updated_since_last_dream", code: "fresh_session_memory_and_work" };
  }
  if (signal.freshCompletedTaskSinceBaseline) {
    return { ok: true, reason: "completed_task_updated_since_last_dream", code: "fresh_completed_task" };
  }
  if (signal.freshResumeContextSinceBaseline) {
    return { ok: true, reason: "resume_context_updated_since_last_dream", code: "fresh_resume_context" };
  }
  if (signal.freshDurableMemorySinceBaseline) {
    return { ok: true, reason: "durable_memory_updated_since_last_dream", code: "fresh_durable_memory" };
  }
  return {
    ok: false,
    reason: "requires fresh work recap, or fresh digest/session-memory plus fresh work update, or fresh completed task/resume context/durable memory since last dream",
    code: "insufficient_signal",
  };
}

function buildAutoTriggerState(input: DreamAutoTriggerState): DreamAutoTriggerState {
  return {
    ...input,
    ...(input.signal ? { signal: { ...input.signal } } : {}),
  };
}

function buildFallbackNarrative(input: {
  agentId: string;
  reason: DreamFallbackReason;
  confidence: string;
  sourceSummaryLine: string;
}): string {
  const reasonText = input.reason === "missing_model_config"
    ? "当前缺少可用的 dream 模型配置。"
    : "本次 dream 的 LLM 调用失败，已回退到规则骨架输出。";
  return [
    `${reasonText} 本次产物直接基于规则骨架生成。`,
    `confidence=${input.confidence}; ${input.sourceSummaryLine}.`,
    `agent=${input.agentId}.`,
  ].join(" ");
}

function buildFallbackDreamOutput(input: {
  agentId: string;
  snapshot: Awaited<ReturnType<DreamRuntimeOptions["buildInputSnapshot"]>>;
  fallbackReason: DreamFallbackReason;
  occurredAt: Date;
}): DreamModelOutput {
  const ruleSkeleton = input.snapshot.ruleSkeleton ?? buildDreamRuleSkeleton(input.snapshot);
  const dateLabel = formatDateOnlyUtc(input.occurredAt);
  const topicSummary = ruleSkeleton.topicCandidates.slice(0, 3).join(" / ");
  return {
    headline: `Dream Fallback - ${input.agentId} - ${dateLabel}`,
    summary: truncateText(
      topicSummary
        ? `fallback dream generated from rule skeleton: ${topicSummary}`
        : `fallback dream generated from rule skeleton for ${input.agentId}`,
      260,
    ),
    narrative: truncateText(buildFallbackNarrative({
      agentId: input.agentId,
      reason: input.fallbackReason,
      confidence: ruleSkeleton.confidence,
      sourceSummaryLine: ruleSkeleton.sourceSummary.summaryLine,
    }), 800),
    generationMode: "fallback",
    fallbackReason: input.fallbackReason,
    stableInsights: ruleSkeleton.confirmedFacts.slice(0, 8),
    corrections: [],
    openQuestions: ruleSkeleton.openLoops.slice(0, 6),
    shareCandidates: [],
    nextFocus: (ruleSkeleton.carryForwardCandidates.length > 0
      ? ruleSkeleton.carryForwardCandidates
      : ruleSkeleton.openLoops).slice(0, 6),
  };
}

function dedupeByKey<T>(items: T[], keyOf: (item: T) => string): T[] {
  const result: T[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = keyOf(item).trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function buildDreamConsolidationSummary(input: {
  snapshot: Awaited<ReturnType<DreamRuntimeOptions["buildInputSnapshot"]>>;
  draft: DreamModelOutput;
}): DreamConsolidationSummary | undefined {
  const { snapshot, draft } = input;
  const profilePatchCandidates: DreamConsolidationProfilePatchCandidate[] = [];
  const staleCandidates: DreamConsolidationStaleCandidate[] = [];
  const contradictionCandidates: DreamConsolidationContradictionCandidate[] = [];

  const stateEntries = Array.isArray(snapshot.mindProfileSnapshot?.profile?.stateEntries)
    ? snapshot.mindProfileSnapshot.profile.stateEntries
    : [];
  for (const entry of stateEntries.slice(0, 4)) {
    const profilePath = truncateText(entry?.path, 160);
    const profileValue = truncateText(entry?.valueText, 160);
    if (!profilePath || !profileValue || !isAllowedDurableProfileStatePath(profilePath)) continue;
    profilePatchCandidates.push({
      field: `profile_state.${profilePath}`,
      valueSummary: profileValue,
      source: "mind_profile",
      confidence: typeof entry?.confidence === "number" && entry.confidence >= 0.95
        ? "high"
        : typeof entry?.confidence === "number" && entry.confidence < 0.8
          ? "low"
          : "medium",
      reason: "Canonical profile state already exposes this low-risk field in the current dream input snapshot.",
      profilePath,
      profileValue,
    });
  }
  const profileHeadline = normalizeText(snapshot.mindProfileSnapshot?.profile?.headline);
  for (const line of snapshot.mindProfileSnapshot?.profile?.summaryLines?.slice(0, 2) ?? []) {
    const normalized = normalizeText(line);
    if (!normalized) continue;
    profilePatchCandidates.push({
      field: "profile.summary_line",
      valueSummary: truncateText(normalized, 140) ?? normalized,
      source: "mind_profile",
      confidence: "medium",
      reason: "Profile summary line is repeatedly surfaced in the current mind/profile snapshot.",
    });
  }
  for (const line of snapshot.learningReviewInput?.summaryLines?.slice(0, 2) ?? []) {
    const normalized = normalizeText(line);
    if (!normalized || !/^Mind snapshot:|^Profile anchor:/i.test(normalized)) continue;
    profilePatchCandidates.push({
      field: "profile.review_anchor",
      valueSummary: truncateText(normalized, 140) ?? normalized,
      source: "learning_review",
      confidence: "medium",
      reason: "Learning/review input promotes this line as a current profile anchor.",
    });
  }

  const memoryFreshness = snapshot.learningReviewInput?.memoryFreshness as {
    summary?: { staleCount?: number; reviewRequiredCount?: number; headline?: string };
    items?: Array<{ memoryClass?: string; status?: string; freshnessHeadline?: string; note?: string }>;
  } | undefined;
  for (const item of memoryFreshness?.items ?? []) {
    const memoryClass = item?.memoryClass;
    const status = item?.status;
    if (
      (memoryClass === "profile_semantic" || memoryClass === "episodic_task" || memoryClass === "procedural_experience" || memoryClass === "governance")
      && (status === "stale" || status === "review_required" || status === "superseded")
    ) {
      staleCandidates.push({
        memoryClass,
        reason: item.freshnessHeadline || `${memoryClass} is currently ${status}.`,
        evidence: normalizeText(item.note),
      });
    }
  }

  const profileLines = [
    ...(snapshot.mindProfileSnapshot?.profile?.summaryLines ?? []),
    ...(snapshot.mindProfileSnapshot?.profile?.treeSummaryLines ?? []),
    ...(snapshot.learningReviewInput?.summaryLines ?? []),
  ]
    .map((line) => normalizeText(line))
    .filter((line): line is string => Boolean(line));
  const contradictionHints = [
    ...draft.corrections,
    ...draft.openQuestions,
  ]
    .map((line) => normalizeText(line))
    .filter((line): line is string => Boolean(line));
  for (const hint of contradictionHints.slice(0, 3)) {
    const anchor = profileLines.find((line) => line !== hint) ?? profileHeadline;
    if (!anchor) continue;
    contradictionCandidates.push({
      topic: truncateText(hint.split("：")[0] || hint.split(":")[0] || "profile inconsistency", 60) ?? "profile inconsistency",
      left: truncateText(anchor, 140) ?? anchor,
      right: truncateText(hint, 140) ?? hint,
      reason: "Dream output still marks this area as correction/open question while profile anchors already contain a competing statement.",
    });
  }

  const dedupedProfilePatchCandidates = dedupeByKey(profilePatchCandidates, (item) => `${item.field}:${item.valueSummary}`);
  const dedupedStaleCandidates = dedupeByKey(staleCandidates, (item) => `${item.memoryClass}:${item.reason}`);
  const dedupedContradictionCandidates = dedupeByKey(contradictionCandidates, (item) => `${item.topic}:${item.left}:${item.right}`);
  const totalCount = dedupedProfilePatchCandidates.length + dedupedStaleCandidates.length + dedupedContradictionCandidates.length;
  if (totalCount <= 0) {
    return undefined;
  }
  return {
    headline: `Dream consolidation surfaced ${dedupedProfilePatchCandidates.length} profile patch, ${dedupedStaleCandidates.length} stale, and ${dedupedContradictionCandidates.length} contradiction candidates.`,
    summary: truncateText(
      draft.summary
        || draft.headline
        || memoryFreshness?.summary?.headline
        || "Dream consolidation candidates are available for readonly inspection.",
      220,
    ) ?? "Dream consolidation candidates are available for readonly inspection.",
    profilePatchCandidates: dedupedProfilePatchCandidates.slice(0, 4),
    staleCandidates: dedupedStaleCandidates.slice(0, 4),
    contradictionCandidates: dedupedContradictionCandidates.slice(0, 3),
    review: {
      status: "pending",
    },
    apply: {
      status: "not_applied",
      appliedPatchCount: 0,
      appliedPatches: [],
    },
  };
}

function normalizeCandidatePathList(values: string[] | undefined, consolidation: DreamConsolidationSummary): string[] {
  const allowed = new Set(
    consolidation.profilePatchCandidates
      .map((item) => truncateText(item.profilePath, 160))
      .filter((item): item is string => Boolean(item)),
  );
  const selected = Array.isArray(values) && values.length > 0
    ? values
    : [...allowed];
  return selected
    .map((item) => truncateText(item, 160))
    .filter((item): item is string => {
      if (!item) return false;
      return allowed.has(item);
    });
}

function buildDreamConsolidationSourceRefs(record: DreamRecord, candidate: DreamConsolidationProfilePatchCandidate) {
  return [
    {
      kind: "system" as const,
      id: record.id,
      sourcePath: record.dreamPath,
      note: `Dream consolidation candidate (${candidate.source})`,
      excerpt: candidate.valueSummary,
    },
  ];
}

async function resolveDreamDraft(input: {
  availability: ReturnType<DreamRuntime["getAvailability"]>;
  agentId: string;
  snapshot: Awaited<ReturnType<DreamRuntimeOptions["buildInputSnapshot"]>>;
  requestedAtDate: Date;
  logger?: DreamRuntimeLogger;
  signal?: AbortSignal;
  callModel: (system: string, user: string) => Promise<string>;
}): Promise<{
  draft: DreamModelOutput;
  generationMode: DreamGenerationMode;
  fallbackReason?: DreamFallbackReason;
}> {
  if (!input.availability.available) {
    return {
      draft: buildFallbackDreamOutput({
        agentId: input.agentId,
        snapshot: input.snapshot,
        fallbackReason: "missing_model_config",
        occurredAt: input.requestedAtDate,
      }),
      generationMode: "fallback",
      fallbackReason: "missing_model_config",
    };
  }

  try {
    const prompt = buildDreamPromptBundle(input.snapshot);
    const rawOutput = await input.callModel(prompt.system, prompt.user);
    return {
      draft: {
        ...parseDreamModelOutput(rawOutput),
        generationMode: "llm",
      },
      generationMode: "llm",
    };
  } catch (error) {
    throwIfDreamRunAborted(input.signal);
    input.logger?.warn?.("dream llm generation failed, using fallback", {
      agentId: input.agentId,
      error: serializeError(error),
    });
    return {
      draft: buildFallbackDreamOutput({
        agentId: input.agentId,
        snapshot: input.snapshot,
        fallbackReason: "llm_call_failed",
        occurredAt: input.requestedAtDate,
      }),
      generationMode: "fallback",
      fallbackReason: "llm_call_failed",
    };
  }
}

export class DreamRuntime {
  private readonly store: DreamStore;
  private readonly agentId: string;
  private readonly enabled: boolean;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly thinking?: Record<string, unknown>;
  private readonly reasoningEffort?: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly temperature: number;
  private readonly modelPrivacyRuntime?: MemoryModelPrivacyRuntime;
  private readonly obsidianMirror?: DreamObsidianMirrorOptions;
  private readonly buildInputSnapshot: DreamRuntimeOptions["buildInputSnapshot"];
  private readonly profileStateDelegate?: DreamRuntimeOptions["profileStateDelegate"];
  private readonly logger?: DreamRuntimeOptions["logger"];
  private readonly nowProvider: () => Date;
  private runReserved = false;

  constructor(options: DreamRuntimeOptions) {
    this.agentId = normalizeText(options.agentId) ?? "default";
    this.store = new DreamStore({
      stateDir: options.stateDir,
      agentId: this.agentId,
    });
    this.enabled = options.enabled ?? true;
    this.model = normalizeText(options.model) ?? "";
    this.baseUrl = (normalizeText(options.baseUrl) ?? "").replace(/\/+$/, "");
    this.apiKey = normalizeText(options.apiKey) ?? "";
    this.thinking = options.thinking && typeof options.thinking === "object" ? { ...options.thinking } : undefined;
    this.reasoningEffort = normalizeText(options.reasoningEffort);
    this.maxTokens = Math.max(400, Math.floor(options.maxTokens ?? 1_000));
    this.timeoutMs = Math.max(1_000, Math.floor(options.timeoutMs ?? 120_000));
    this.temperature = Math.max(0, Math.min(1, Number.isFinite(options.temperature) ? Number(options.temperature) : 0.3));
    this.modelPrivacyRuntime = options.modelPrivacyRuntime;
    if (this.baseUrl) {
      this.modelPrivacyRuntime?.registerEndpoint("dream", this.baseUrl);
    }
    this.obsidianMirror = options.obsidianMirror
      ? {
          enabled: options.obsidianMirror.enabled === true,
          vaultPath: normalizeText(options.obsidianMirror.vaultPath),
          rootDir: normalizeText(options.obsidianMirror.rootDir),
        }
      : undefined;
    this.buildInputSnapshot = options.buildInputSnapshot;
    this.profileStateDelegate = options.profileStateDelegate;
    this.logger = options.logger;
    this.nowProvider = options.now ?? (() => new Date());
  }

  get runtimeAgentId(): string {
    return this.agentId;
  }

  get modelName(): string | undefined {
    return this.model || undefined;
  }

  getBackgroundJobTokenEstimate(): number {
    return this.maxTokens + 4_096;
  }

  getAvailability(): {
    enabled: boolean;
    available: boolean;
    model?: string;
    reason?: string;
  } {
    if (!this.enabled) {
      return {
        enabled: false,
        available: false,
        model: this.model || undefined,
        reason: "dream runtime disabled",
      };
    }
    if (!this.model || !this.baseUrl || !this.apiKey) {
      return {
        enabled: true,
        available: false,
        model: this.model || undefined,
        reason: "missing model/baseUrl/apiKey",
      };
    }
    return {
      enabled: true,
      available: true,
      model: this.model,
    };
  }

  async load(): Promise<void> {
    await this.store.load();
  }

  async getState(): Promise<DreamRuntimeState> {
    await this.store.load();
    return this.store.getState();
  }

  async listHistory(limit = 10): Promise<DreamRuntimeState["recentRuns"]> {
    const state = await this.getState();
    return state.recentRuns.slice(0, Math.max(1, Math.floor(limit)));
  }

  async getDream(input: { dreamId?: string } = {}): Promise<{ record: DreamRecord; content?: string } | null> {
    const state = await this.getState();
    const record = input.dreamId
      ? state.recentRuns.find((item) => item.id === input.dreamId)
      : state.recentRuns[0];
    if (!record) return null;
    if (!record.dreamPath) {
      return { record };
    }
    try {
      const fs = await import("node:fs/promises");
      const content = await fs.readFile(record.dreamPath, "utf-8");
      return { record, content };
    } catch {
      return { record };
    }
  }

  async run(input: DreamRunOptions = {}): Promise<DreamRunResult> {
    throwIfDreamRunAborted(input.signal);
    if (!this.tryReserveRun()) {
      const state = await this.getState();
      const runningRecord = state.recentRuns.find((item) => item.id === state.lastRunId);
      return {
        record: runningRecord ?? {
          id: state.lastRunId ?? "dream-running",
          agentId: this.agentId,
          status: "running",
          triggerMode: input.triggerMode ?? "manual",
          requestedAt: this.nowProvider().toISOString(),
          conversationId: input.conversationId,
          reason: input.reason,
        },
        state,
      };
    }
    try {
      return await this.runInternal(input);
    } finally {
      this.releaseRunReservation();
    }
  }

  async maybeAutoRun(input: DreamRunOptions = {}): Promise<DreamAutoRunResult> {
    throwIfDreamRunAborted(input.signal);
    const triggerMode = input.triggerMode === "cron" ? "cron" : "heartbeat";
    const availability = this.getAvailability();
    const now = this.nowProvider();
    const nowMs = now.getTime();
    const attemptedAt = now.toISOString();
    if (!availability.enabled) {
      const state = await this.getState();
      const nextState = await this.store.recordAutoTrigger(buildAutoTriggerState({
        triggerMode,
        attemptedAt,
        executed: false,
        skipCode: "runtime_unavailable",
        skipReason: availability.reason ?? "dream runtime unavailable",
      }));
      return {
        executed: false,
        triggerMode,
        state: nextState,
        skipCode: "runtime_unavailable",
        skipReason: availability.reason ?? "dream runtime unavailable",
      };
    }
    if (!this.tryReserveRun()) {
      const state = await this.getState();
      const nextState = await this.store.recordAutoTrigger(buildAutoTriggerState({
        triggerMode,
        attemptedAt,
        executed: false,
        skipCode: "already_running",
        skipReason: "dream runtime already running",
      }));
      return {
        executed: false,
        triggerMode,
        state: nextState,
        skipCode: "already_running",
        skipReason: "dream runtime already running",
      };
    }
    try {
      const state = await this.getState();
      if (state.status === "running") {
        const nextState = await this.store.recordAutoTrigger(buildAutoTriggerState({
          triggerMode,
          attemptedAt,
          executed: false,
          skipCode: "already_running",
          skipReason: "dream runtime already running",
        }));
        return {
          executed: false,
          triggerMode,
          state: nextState,
          skipCode: "already_running",
          skipReason: "dream runtime already running",
        };
      }
      if (isFutureIso(state.failureBackoffUntil, nowMs)) {
        const nextState = await this.store.recordAutoTrigger(buildAutoTriggerState({
          triggerMode,
          attemptedAt,
          executed: false,
          skipCode: "failure_backoff_active",
          skipReason: `failure backoff active until ${state.failureBackoffUntil}`,
        }));
        return {
          executed: false,
          triggerMode,
          state: nextState,
          skipCode: "failure_backoff_active",
          skipReason: `failure backoff active until ${state.failureBackoffUntil}`,
        };
      }
      if (isFutureIso(state.cooldownUntil, nowMs)) {
        const nextState = await this.store.recordAutoTrigger(buildAutoTriggerState({
          triggerMode,
          attemptedAt,
          executed: false,
          skipCode: "cooldown_active",
          skipReason: `cooldown active until ${state.cooldownUntil}`,
        }));
        return {
          executed: false,
          triggerMode,
          state: nextState,
          skipCode: "cooldown_active",
          skipReason: `cooldown active until ${state.cooldownUntil}`,
        };
      }

      const snapshot = await this.buildInputSnapshot({
        agentId: this.agentId,
        conversationId: normalizeText(input.conversationId),
        now,
      });
      throwIfDreamRunAborted(input.signal);
      await this.store.updateLastInput(snapshot);
      const baselineAt = state.lastDreamAt || snapshot.windowStartedAt;
      const signal = buildAutoSignalSummary(snapshot, baselineAt, state.lastDreamCursor);
      const gate = resolveSignalGate(signal);
      if (!gate.ok) {
        this.logger?.debug?.("dream auto-run skipped", {
          agentId: this.agentId,
          triggerMode,
          reason: gate.reason,
          signal,
        });
        const skippedState = await this.store.recordAutoTrigger(buildAutoTriggerState({
          triggerMode,
          attemptedAt,
          executed: false,
          skipCode: "insufficient_signal",
          signalGateCode: gate.code,
          skipReason: gate.reason,
          signal,
        }));
        return {
          executed: false,
          triggerMode,
          state: skippedState,
          skipCode: "insufficient_signal",
          skipReason: gate.reason,
          signal,
        };
      }

      const result = await this.runInternal({
        ...input,
        triggerMode,
      }, {
        now,
        snapshot,
      });
      const executedState = await this.store.recordAutoTrigger(buildAutoTriggerState({
        triggerMode,
        attemptedAt,
        executed: true,
        runId: result.record.id,
        status: result.record.status,
        signalGateCode: gate.code,
        signal,
      }));
      return {
        executed: true,
        triggerMode,
        state: executedState,
        record: result.record,
        draft: result.draft,
        markdown: result.markdown,
        indexMarkdown: result.indexMarkdown,
        signal,
      };
    } finally {
      this.releaseRunReservation();
    }
  }

  private tryReserveRun(): boolean {
    if (this.runReserved) {
      return false;
    }
    this.runReserved = true;
    return true;
  }

  private releaseRunReservation(): void {
    this.runReserved = false;
  }

  private async runInternal(
    input: DreamRunOptions,
    prepared?: { now: Date; snapshot: Awaited<ReturnType<DreamRuntimeOptions["buildInputSnapshot"]>> },
  ): Promise<DreamRunResult> {
    throwIfDreamRunAborted(input.signal);
    await this.store.load();
    throwIfDreamRunAborted(input.signal);
    const availability = this.getAvailability();
    const requestedAtDate = prepared?.now ?? this.nowProvider();
    const requestedAt = requestedAtDate.toISOString();
    const runId = buildDreamRunId(requestedAtDate);
    const triggerMode = input.triggerMode ?? "manual";
    const conversationId = normalizeText(input.conversationId);

    await this.store.setStatus("running");
    if (input.signal?.aborted) {
      await this.store.setStatus("idle");
      throwIfDreamRunAborted(input.signal);
    }

    if (!availability.enabled) {
      const failedRecord: DreamRecord = {
        id: runId,
        agentId: this.agentId,
        status: "failed",
        triggerMode,
        requestedAt,
        startedAt: requestedAt,
        finishedAt: requestedAt,
        durationMs: 0,
        conversationId,
        reason: input.reason,
        error: availability.reason,
        obsidianSync: {
          enabled: false,
          stage: "skipped",
        },
      };
      await this.store.recordRun(failedRecord);
      await this.store.setStatus("idle");
      const state = await this.store.getState();
      return {
        record: failedRecord,
        state,
      };
    }

    let lastDraft: DreamModelOutput | undefined;
    try {
      const snapshot = prepared?.snapshot ?? await this.buildInputSnapshot({
        agentId: this.agentId,
        conversationId,
        now: requestedAtDate,
      });
      throwIfDreamRunAborted(input.signal);
      await this.store.updateLastInput(snapshot);
      throwIfDreamRunAborted(input.signal);

      const draftResult = await resolveDreamDraft({
        availability,
        agentId: this.agentId,
        snapshot,
        requestedAtDate,
        logger: this.logger,
        signal: input.signal,
        callModel: (system, user) => this.callModel(system, user, input.signal),
      });
      throwIfDreamRunAborted(input.signal);
      lastDraft = draftResult.draft;

      const startedAt = requestedAtDate.toISOString();
      const finishedAt = this.nowProvider().toISOString();
      const summary = summarizeDreamModelOutput(lastDraft);
      const consolidation = buildDreamConsolidationSummary({
        snapshot,
        draft: lastDraft,
      });
      const previewRecord: DreamRecord = {
        id: runId,
        agentId: this.agentId,
        status: "completed",
        triggerMode,
        requestedAt,
        startedAt,
        finishedAt,
        durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(requestedAt)),
        conversationId: snapshot.conversationId ?? conversationId,
        reason: input.reason,
        summary,
        generationMode: draftResult.generationMode,
        ...(draftResult.fallbackReason ? { fallbackReason: draftResult.fallbackReason } : {}),
        input: toDreamInputMeta(snapshot),
        ...(consolidation ? { consolidation } : {}),
        obsidianSync: {
          enabled: false,
          stage: "skipped",
        },
      };
      const stateBeforeWrite = await this.store.getState();
      throwIfDreamRunAborted(input.signal);
      const dreamPath = this.store.buildDreamFilePath({
        occurredAt: finishedAt,
        dreamId: runId,
      });
      const written = await writeDreamArtifacts({
        stateDir: this.store.getStateDir(),
        agentId: this.agentId,
        dreamPath,
        record: {
          ...previewRecord,
          dreamPath,
          indexPath: this.store.getDreamIndexPath(),
        },
        draft: lastDraft,
        snapshot,
        previousRuns: stateBeforeWrite.recentRuns,
      });
      throwIfDreamRunAborted(input.signal);
      const obsidianSync = await syncDreamToObsidian({
        mirror: this.obsidianMirror,
        agentId: this.agentId,
        record: {
          ...previewRecord,
          dreamPath: written.dreamPath,
          indexPath: written.indexPath,
        },
        markdown: written.markdown,
        indexMarkdown: written.indexMarkdown,
        now: this.nowProvider,
        logger: this.logger,
      });
      throwIfDreamRunAborted(input.signal);
      const completedRecord: DreamRecord = {
        ...previewRecord,
        dreamPath: written.dreamPath,
        indexPath: written.indexPath,
        obsidianSync,
      };
      await this.store.recordRun(completedRecord, {
        lastDreamCursor: snapshot.changeCursor ?? createZeroCursor(),
      });
      await this.store.setStatus("idle");
      const state = await this.store.getState();
      this.logger?.debug?.("dream run completed", {
        agentId: this.agentId,
        runId,
        conversationId: completedRecord.conversationId,
        generationMode: completedRecord.generationMode,
        fallbackReason: completedRecord.fallbackReason,
      });
      return {
        record: completedRecord,
        state,
        draft: lastDraft,
        markdown: written.markdown,
        indexMarkdown: written.indexMarkdown,
      };
    } catch (error) {
      if (input.signal?.aborted) {
        await this.store.setStatus("idle");
        throwIfDreamRunAborted(input.signal);
      }
      const finishedAt = this.nowProvider().toISOString();
      const failedRecord: DreamRecord = {
        id: runId,
        agentId: this.agentId,
        status: "failed",
        triggerMode,
        requestedAt,
        startedAt: requestedAt,
        finishedAt,
        durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(requestedAt)),
        conversationId,
        reason: input.reason,
        error: serializeError(error),
        ...(lastDraft ? { summary: summarizeDreamModelOutput(lastDraft) } : {}),
        obsidianSync: {
          enabled: false,
          stage: "skipped",
        },
      };
      await this.store.recordRun(failedRecord);
      await this.store.setStatus("idle");
      const state = await this.store.getState();
      this.logger?.error?.("dream run failed", {
        agentId: this.agentId,
        runId,
        conversationId,
        error: failedRecord.error,
      });
      return {
        record: failedRecord,
        state,
        draft: lastDraft,
      };
    }
  }

  async reviewConsolidation(
    runId: string,
    decision: DreamConsolidationReviewDecision,
    input: DreamConsolidationReviewInput = {},
  ): Promise<{ record: DreamRecord; state: DreamRuntimeState }> {
    if (decision !== "approved" && decision !== "rejected" && decision !== "superseded") {
      throw new Error("dream consolidation decision must be approved, rejected, or superseded");
    }
    const reviewedAt = this.nowProvider().toISOString();
    const state = await this.store.updateRun(runId, (record) => {
      if (!record.consolidation) {
        throw new Error("Dream run has no consolidation suggestions.");
      }
      const approvedCandidatePaths = decision === "approved"
        ? normalizeCandidatePathList(input.approvedCandidatePaths, record.consolidation)
        : [];
      const nextReview: DreamConsolidationReviewState = {
        status: decision,
        reviewedAt,
        ...(truncateText(input.reviewedBy, 120) ? { reviewedBy: truncateText(input.reviewedBy, 120) } : {}),
        ...(truncateText(input.note, 240) ? { note: truncateText(input.note, 240) } : {}),
        ...(approvedCandidatePaths.length > 0 ? { approvedCandidatePaths } : {}),
      };
      return {
        ...record,
        consolidation: {
          ...record.consolidation,
          review: nextReview,
          apply: decision === "approved"
            ? {
                ...(record.consolidation.apply ?? { status: "not_applied", appliedPatchCount: 0, appliedPatches: [] }),
                status: record.consolidation.apply?.status === "applied" ? "applied" : "not_applied",
              }
            : {
                status: "not_applied",
                appliedPatchCount: 0,
                appliedPatches: [],
              },
        },
      };
    });
    const record = state.recentRuns.find((item) => item.id === runId);
    if (!record) {
      throw new Error(`Dream run not found: ${runId}`);
    }
    return { record, state };
  }

  async applyConsolidation(
    runId: string,
    input: DreamConsolidationApplyInput = {},
  ): Promise<{ record: DreamRecord; state: DreamRuntimeState; appliedPatchCount: number }> {
    if (!this.profileStateDelegate) {
      throw new Error("Dream consolidation apply is unavailable because profile state delegate is missing.");
    }
    let appliedPatchCount = 0;
    const appliedAt = this.nowProvider().toISOString();
    const state = await this.store.updateRun(runId, (record) => {
      const consolidation = record.consolidation;
      if (!consolidation) {
        throw new Error("Dream run has no consolidation suggestions.");
      }
      if (consolidation.review?.status !== "approved") {
        throw new Error("Dream consolidation must be reviewed and approved before apply.");
      }
      const approvedCandidatePaths = normalizeCandidatePathList(consolidation.review.approvedCandidatePaths, consolidation);
      const candidates = consolidation.profilePatchCandidates.filter((candidate) => {
        const profilePath = truncateText(candidate.profilePath, 160);
        return Boolean(profilePath && approvedCandidatePaths.includes(profilePath));
      });
      if (candidates.length <= 0) {
        throw new Error("No approved low-risk profile patch candidates are available to apply.");
      }
      const appliedPatches: NonNullable<DreamConsolidationApplyState["appliedPatches"]> = [];
      for (const candidate of candidates) {
        const profilePath = truncateText(candidate.profilePath, 160);
        if (!profilePath || !isAllowedDurableProfileStatePath(profilePath)) continue;
        const value: ProfileStateValue = candidate.profileValue ?? candidate.valueSummary;
        const entry = this.profileStateDelegate!.upsertProfileStateEntry({
          agentId: this.agentId,
          scope: "user",
          path: profilePath,
          value,
          confidence: candidate.confidence === "high" ? 0.96 : candidate.confidence === "low" ? 0.72 : 0.88,
          sourceRefs: buildDreamConsolidationSourceRefs(record, candidate),
          lastConfirmedAt: appliedAt,
          reason: truncateText(input.note, 240) ?? `Dream consolidation apply for ${profilePath}.`,
          createdBy: truncateText(input.appliedBy, 120) ?? "dream.apply",
        });
        appliedPatches.push({
          profilePath,
          profileValue: value,
          entryId: entry.id,
          action: entry.createdAt === entry.updatedAt ? "create" : "update",
          changed: true,
        });
      }
      appliedPatchCount = appliedPatches.length;
      return {
        ...record,
        consolidation: {
          ...consolidation,
          apply: {
            status: "applied",
            appliedAt,
            ...(truncateText(input.appliedBy, 120) ? { appliedBy: truncateText(input.appliedBy, 120) } : {}),
            ...(truncateText(input.note, 240) ? { note: truncateText(input.note, 240) } : {}),
            appliedPatchCount,
            appliedPatches,
          },
        },
      };
    });
    const record = state.recentRuns.find((item) => item.id === runId);
    if (!record) {
      throw new Error(`Dream run not found: ${runId}`);
    }
    return { record, state, appliedPatchCount };
  }

  private async callModel(system: string, user: string, signal?: AbortSignal): Promise<string> {
    throwIfDreamRunAborted(signal);
    try {
      return await this.callModelOnce(system, user, this.maxTokens, signal);
    } catch (error) {
      if (
        error instanceof DreamEmptyContentError
        && error.finishReason === "length"
        && error.hasReasoningContent
      ) {
        const retryMaxTokens = Math.min(Math.max(error.maxTokens * 2, 4_000), 8_000);
        if (retryMaxTokens > error.maxTokens) {
          this.logger?.warn?.("dream llm exhausted token budget on reasoning, retrying with larger budget", {
            model: this.model,
            previousMaxTokens: error.maxTokens,
            retryMaxTokens,
            finishReason: error.finishReason ?? null,
            reasoningContentLength: error.reasoningContentLength,
            thinkingType: normalizeText((this.thinking as { type?: unknown } | undefined)?.type) ?? null,
            reasoningEffort: this.reasoningEffort ?? null,
          });
          throwIfDreamRunAborted(signal);
          return this.callModelOnce(system, user, retryMaxTokens, signal);
        }
      }
      throw error;
    }
  }

  private async callModelOnce(
    system: string,
    user: string,
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<string> {
    throwIfDreamRunAborted(signal);
    const payload: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
      temperature: this.temperature,
    };
    applyOpenAICompatibleReasoningConfig(payload, {
      thinking: this.thinking,
      reasoningEffort: this.reasoningEffort,
    });

    const data = await requestDreamModel({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      payload,
      timeoutMs: this.timeoutMs,
      ...(this.modelPrivacyRuntime ? { privacyRuntime: this.modelPrivacyRuntime } : {}),
      ...(signal ? { signal } : {}),
    });
    const choice = data.choices?.[0];
    const content = normalizeText(choice?.message?.content);
    const reasoningContent = normalizeText(choice?.message?.reasoning_content);
    const finishReason = normalizeText(choice?.finish_reason);
    if (!content) {
      this.logger?.warn?.("dream llm returned empty assistant content", {
        model: this.model,
        finishReason: finishReason ?? null,
        hasReasoningContent: Boolean(reasoningContent),
        reasoningContentLength: reasoningContent?.length ?? 0,
        maxTokens,
        thinkingType: normalizeText((this.thinking as { type?: unknown } | undefined)?.type) ?? null,
        reasoningEffort: this.reasoningEffort ?? null,
      });
      throw new DreamEmptyContentError({
        finishReason,
        hasReasoningContent: Boolean(reasoningContent),
        reasoningContentLength: reasoningContent?.length ?? 0,
        maxTokens,
      });
    }
    return content;
  }
}
