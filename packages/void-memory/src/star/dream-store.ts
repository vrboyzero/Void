import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  DreamConsolidationSummary,
  DreamAutoSignalGateCode,
  DreamAutoSignalSummary,
  DreamAutoStats,
  DreamAutoTriggerModeStats,
  DreamAutoTriggerState,
  DreamChangeCursor,
  DreamFallbackReason,
  DreamGenerationMode,
  DreamInputSourceCounts,
  DreamInputSnapshot,
  DreamRecord,
  DreamRuntimeSettings,
  DreamRuntimeState,
  DreamStatus,
} from "./dream-types.js";
import type { ProfileStateValue } from "./profile-state-types.js";

const DREAM_RUNTIME_FILENAME = "dream-runtime.json";
const DREAM_INDEX_FILENAME = "DREAM.md";
const DREAMS_DIRNAME = "dreams";
const STATE_VERSION = 1 as const;
const ATOMIC_RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200] as const;

export interface DreamStoreOptions {
  stateDir: string;
  agentId: string;
  settings?: Partial<DreamRuntimeSettings>;
}

export interface BuildDreamFilePathOptions {
  stateDir: string;
  occurredAt?: Date | number | string;
  dreamId?: string;
}

function normalizePositiveInteger(value: unknown, fallback: number, min = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.floor(value));
}

function normalizePositiveCountRecord(
  value: Record<string, unknown> | null,
): Record<string, number> | undefined {
  if (!value) return undefined;
  const entries = Object.entries(value)
    .map(([key, count]) => {
      const normalizedCount = normalizePositiveInteger(count, 0, 0);
      return normalizedCount > 0 ? [key, normalizedCount] as const : null;
    })
    .filter((entry): entry is readonly [string, number] => Boolean(entry));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeDreamRuntimeSettings(value?: Partial<DreamRuntimeSettings>): DreamRuntimeSettings {
  return {
    inputWindowHours: normalizePositiveInteger(value?.inputWindowHours, 72),
    cooldownHours: normalizePositiveInteger(value?.cooldownHours, 12),
    failureBackoffMinutes: normalizePositiveInteger(value?.failureBackoffMinutes, 30),
    maxRecentRuns: normalizePositiveInteger(value?.maxRecentRuns, 20),
  };
}

function normalizeText(value: unknown, maxLength = 400): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function normalizeIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function normalizeDreamStatus(value: unknown): DreamStatus {
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

function normalizeGenerationMode(value: unknown): DreamGenerationMode | undefined {
  return value === "llm" || value === "fallback" ? value : undefined;
}

function normalizeFallbackReason(value: unknown): DreamFallbackReason | undefined {
  return value === "missing_model_config" || value === "llm_call_failed" ? value : undefined;
}

function normalizeCursor(value: unknown): DreamChangeCursor | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  return {
    digestGeneration: normalizePositiveInteger(source.digestGeneration, 0, 0),
    sessionMemoryMessageCount: normalizePositiveInteger(source.sessionMemoryMessageCount, 0, 0),
    sessionMemoryToolCursor: normalizePositiveInteger(source.sessionMemoryToolCursor, 0, 0),
    taskChangeSeq: normalizePositiveInteger(source.taskChangeSeq, 0, 0),
    memoryChangeSeq: normalizePositiveInteger(source.memoryChangeSeq, 0, 0),
  };
}

function cloneCursor(cursor: DreamChangeCursor | undefined): DreamChangeCursor | undefined {
  return cursor ? { ...cursor } : undefined;
}

function cloneSignal(signal: DreamAutoSignalSummary | undefined): DreamAutoSignalSummary | undefined {
  if (!signal) return undefined;
  return {
    ...signal,
    ...(signal.lastDreamCursor ? { lastDreamCursor: cloneCursor(signal.lastDreamCursor) } : {}),
    ...(signal.currentCursor ? { currentCursor: cloneCursor(signal.currentCursor) } : {}),
  };
}

function cloneAutoStats(stats: DreamRuntimeState["autoStats"]): DreamRuntimeState["autoStats"] {
  if (!stats) return undefined;
  return {
    attemptedCount: stats.attemptedCount,
    executedCount: stats.executedCount,
    skippedCount: stats.skippedCount,
    ...(stats.skipCodeCounts ? { skipCodeCounts: { ...stats.skipCodeCounts } } : {}),
    ...(stats.signalGateCounts ? { signalGateCounts: { ...stats.signalGateCounts } } : {}),
    ...(stats.byTriggerMode
      ? {
          byTriggerMode: Object.fromEntries(
            Object.entries(stats.byTriggerMode).map(([key, value]) => [key, {
              attemptedCount: value?.attemptedCount ?? 0,
              executedCount: value?.executedCount ?? 0,
              skippedCount: value?.skippedCount ?? 0,
              ...(value?.skipCodeCounts ? { skipCodeCounts: { ...value.skipCodeCounts } } : {}),
              ...(value?.signalGateCounts ? { signalGateCounts: { ...value.signalGateCounts } } : {}),
            }]),
          ) as DreamAutoStats["byTriggerMode"],
        }
      : {}),
  };
}

function normalizeAutoTriggerModeStats(value: unknown): DreamAutoTriggerModeStats | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const skipCodeCounts = source.skipCodeCounts && typeof source.skipCodeCounts === "object" && !Array.isArray(source.skipCodeCounts)
    ? source.skipCodeCounts as Record<string, unknown>
    : null;
  const signalGateCounts = source.signalGateCounts && typeof source.signalGateCounts === "object" && !Array.isArray(source.signalGateCounts)
    ? source.signalGateCounts as Record<string, unknown>
    : null;
  const normalizedSkipCodeCounts = normalizePositiveCountRecord(skipCodeCounts) as NonNullable<DreamAutoTriggerModeStats["skipCodeCounts"]> | undefined;
  const normalizedSignalGateCounts = normalizePositiveCountRecord(signalGateCounts) as NonNullable<DreamAutoTriggerModeStats["signalGateCounts"]> | undefined;
  return {
    attemptedCount: normalizePositiveInteger(source.attemptedCount, 0, 0),
    executedCount: normalizePositiveInteger(source.executedCount, 0, 0),
    skippedCount: normalizePositiveInteger(source.skippedCount, 0, 0),
    ...(normalizedSkipCodeCounts && Object.keys(normalizedSkipCodeCounts).length > 0 ? { skipCodeCounts: normalizedSkipCodeCounts } : {}),
    ...(normalizedSignalGateCounts && Object.keys(normalizedSignalGateCounts).length > 0 ? { signalGateCounts: normalizedSignalGateCounts } : {}),
  };
}

function normalizeAutoStats(value: unknown): DreamAutoStats | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const skipCodeCounts = source.skipCodeCounts && typeof source.skipCodeCounts === "object" && !Array.isArray(source.skipCodeCounts)
    ? source.skipCodeCounts as Record<string, unknown>
    : null;
  const signalGateCounts = source.signalGateCounts && typeof source.signalGateCounts === "object" && !Array.isArray(source.signalGateCounts)
    ? source.signalGateCounts as Record<string, unknown>
    : null;
  const normalizedSkipCodeCounts = normalizePositiveCountRecord(skipCodeCounts) as NonNullable<DreamAutoStats["skipCodeCounts"]> | undefined;
  const normalizedSignalGateCounts = normalizePositiveCountRecord(signalGateCounts) as NonNullable<DreamAutoStats["signalGateCounts"]> | undefined;
  const byTriggerModeValue = source.byTriggerMode && typeof source.byTriggerMode === "object" && !Array.isArray(source.byTriggerMode)
    ? source.byTriggerMode as Record<string, unknown>
    : null;
  const normalizedByTriggerMode = byTriggerModeValue
    ? Object.fromEntries(
        Object.entries(byTriggerModeValue)
          .filter(([key]) => key === "heartbeat" || key === "cron")
          .map(([key, stats]) => [key, normalizeAutoTriggerModeStats(stats)])
          .filter(([, stats]) => Boolean(stats)),
      ) as NonNullable<DreamAutoStats["byTriggerMode"]>
    : undefined;
  return {
    attemptedCount: normalizePositiveInteger(source.attemptedCount, 0, 0),
    executedCount: normalizePositiveInteger(source.executedCount, 0, 0),
    skippedCount: normalizePositiveInteger(source.skippedCount, 0, 0),
    ...(normalizedSkipCodeCounts && Object.keys(normalizedSkipCodeCounts).length > 0 ? { skipCodeCounts: normalizedSkipCodeCounts } : {}),
    ...(normalizedSignalGateCounts && Object.keys(normalizedSignalGateCounts).length > 0 ? { signalGateCounts: normalizedSignalGateCounts } : {}),
    ...(normalizedByTriggerMode && Object.keys(normalizedByTriggerMode).length > 0 ? { byTriggerMode: normalizedByTriggerMode } : {}),
  };
}

function bumpMappedCount<T extends string>(current: Partial<Record<T, number>> | undefined, key: T | undefined): Partial<Record<T, number>> | undefined {
  if (!key) return current;
  return {
    ...(current ?? {}),
    [key]: Math.max(1, ((current?.[key] ?? 0) + 1)),
  };
}

function bumpModeStats(
  current: DreamAutoTriggerModeStats | undefined,
  trigger: DreamAutoTriggerState,
): DreamAutoTriggerModeStats {
  return {
    attemptedCount: Math.max(0, (current?.attemptedCount ?? 0) + 1),
    executedCount: Math.max(0, (current?.executedCount ?? 0) + (trigger.executed ? 1 : 0)),
    skippedCount: Math.max(0, (current?.skippedCount ?? 0) + (trigger.executed ? 0 : 1)),
    ...(bumpMappedCount(current?.skipCodeCounts, trigger.executed ? undefined : trigger.skipCode)
      ? { skipCodeCounts: bumpMappedCount(current?.skipCodeCounts, trigger.executed ? undefined : trigger.skipCode) }
      : {}),
    ...(bumpMappedCount(current?.signalGateCounts, trigger.signalGateCode)
      ? { signalGateCounts: bumpMappedCount(current?.signalGateCounts, trigger.signalGateCode) }
      : {}),
  };
}

function cloneInputMeta(state: DreamRuntimeState["lastInput"]): DreamRuntimeState["lastInput"] {
  if (!state) return undefined;
  return {
    collectedAt: state.collectedAt,
    windowHours: state.windowHours,
    conversationId: state.conversationId,
    focusTaskId: state.focusTaskId,
    sourceCounts: {
      ...state.sourceCounts,
    },
  };
}

function cloneAutoTrigger(state: DreamRuntimeState["lastAutoTrigger"]): DreamRuntimeState["lastAutoTrigger"] {
  if (!state) return undefined;
  return {
    ...state,
    ...(state.signalGateCode ? { signalGateCode: state.signalGateCode } : {}),
    ...(state.signal ? { signal: cloneSignal(state.signal) } : {}),
  };
}

function cloneRun(run: DreamRecord): DreamRecord {
  return {
    ...run,
    ...(run.generationMode ? { generationMode: run.generationMode } : {}),
    ...(run.fallbackReason ? { fallbackReason: run.fallbackReason } : {}),
    ...(run.input ? { input: cloneInputMeta(run.input) } : {}),
    ...(run.consolidation ? { consolidation: cloneConsolidation(run.consolidation) } : {}),
    ...(run.obsidianSync ? { obsidianSync: { ...run.obsidianSync } } : {}),
  };
}

function cloneConsolidation(value: DreamConsolidationSummary): DreamConsolidationSummary {
  return {
    ...value,
    profilePatchCandidates: Array.isArray(value.profilePatchCandidates)
      ? value.profilePatchCandidates.map((item) => ({ ...item }))
      : [],
    staleCandidates: Array.isArray(value.staleCandidates)
      ? value.staleCandidates.map((item) => ({ ...item }))
      : [],
    contradictionCandidates: Array.isArray(value.contradictionCandidates)
      ? value.contradictionCandidates.map((item) => ({ ...item }))
      : [],
    ...(value.review
      ? {
          review: {
            ...value.review,
            ...(Array.isArray(value.review.approvedCandidatePaths)
              ? { approvedCandidatePaths: [...value.review.approvedCandidatePaths] }
              : {}),
          },
        }
      : {}),
    ...(value.apply
      ? {
          apply: {
            ...value.apply,
            ...(Array.isArray(value.apply.appliedPatches)
              ? {
                  appliedPatches: value.apply.appliedPatches.map((item) => ({ ...item })),
                }
              : {}),
          },
        }
      : {}),
  };
}

function cloneState(state: DreamRuntimeState): DreamRuntimeState {
  return {
    ...state,
    settings: { ...state.settings },
    ...(state.lastDreamCursor ? { lastDreamCursor: cloneCursor(state.lastDreamCursor) } : {}),
    ...(state.lastAutoTrigger ? { lastAutoTrigger: cloneAutoTrigger(state.lastAutoTrigger) } : {}),
    ...(state.autoStats ? { autoStats: cloneAutoStats(state.autoStats) } : {}),
    ...(state.lastInput ? { lastInput: cloneInputMeta(state.lastInput) } : {}),
    ...(state.lastObsidianSync ? { lastObsidianSync: { ...state.lastObsidianSync } } : {}),
    recentRuns: state.recentRuns.map((item) => cloneRun(item)),
  };
}

function normalizeRun(input: unknown): DreamRecord | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const id = normalizeText(record.id, 120);
  const agentId = normalizeText(record.agentId, 120);
  const status = normalizeDreamStatus(record.status);
  const requestedAt = normalizeIsoTimestamp(record.requestedAt);
  if (!id || !agentId || status === "idle" || !requestedAt) return null;
  return {
    id,
    agentId,
    status,
    triggerMode: record.triggerMode === "heartbeat" || record.triggerMode === "cron" || record.triggerMode === "recovery"
      ? record.triggerMode
      : "manual",
    requestedAt,
    ...(normalizeIsoTimestamp(record.startedAt) ? { startedAt: normalizeIsoTimestamp(record.startedAt) } : {}),
    ...(normalizeIsoTimestamp(record.finishedAt) ? { finishedAt: normalizeIsoTimestamp(record.finishedAt) } : {}),
    ...(typeof record.durationMs === "number" && Number.isFinite(record.durationMs) ? { durationMs: Math.max(0, Math.floor(record.durationMs)) } : {}),
    ...(normalizeText(record.conversationId, 160) ? { conversationId: normalizeText(record.conversationId, 160) } : {}),
    ...(normalizeText(record.summary) ? { summary: normalizeText(record.summary) } : {}),
    ...(normalizeText(record.reason) ? { reason: normalizeText(record.reason) } : {}),
    ...(normalizeText(record.error) ? { error: normalizeText(record.error) } : {}),
    ...(normalizeText(record.dreamPath, 320) ? { dreamPath: normalizeText(record.dreamPath, 320) } : {}),
    ...(normalizeText(record.indexPath, 320) ? { indexPath: normalizeText(record.indexPath, 320) } : {}),
    ...(normalizeGenerationMode(record.generationMode) ? { generationMode: normalizeGenerationMode(record.generationMode) } : {}),
    ...(normalizeFallbackReason(record.fallbackReason) ? { fallbackReason: normalizeFallbackReason(record.fallbackReason) } : {}),
    ...(record.input && typeof record.input === "object" && !Array.isArray(record.input)
      ? {
          input: {
            collectedAt: normalizeIsoTimestamp((record.input as Record<string, unknown>).collectedAt) ?? requestedAt,
            windowHours: normalizePositiveInteger((record.input as Record<string, unknown>).windowHours, 72),
            ...(normalizeText((record.input as Record<string, unknown>).conversationId, 160)
              ? { conversationId: normalizeText((record.input as Record<string, unknown>).conversationId, 160) }
              : {}),
            ...(normalizeText((record.input as Record<string, unknown>).focusTaskId, 160)
              ? { focusTaskId: normalizeText((record.input as Record<string, unknown>).focusTaskId, 160) }
              : {}),
            sourceCounts: normalizeSourceCounts((record.input as Record<string, unknown>).sourceCounts),
          },
        }
      : {}),
    ...(record.consolidation && typeof record.consolidation === "object" && !Array.isArray(record.consolidation)
      ? { consolidation: normalizeConsolidation(record.consolidation as Record<string, unknown>) }
      : {}),
    ...(record.obsidianSync && typeof record.obsidianSync === "object" && !Array.isArray(record.obsidianSync)
      ? {
          obsidianSync: normalizeObsidianSync(record.obsidianSync as Record<string, unknown>),
        }
      : {}),
  };
}

function normalizeConsolidation(value: Record<string, unknown>): DreamConsolidationSummary {
  const profilePatchCandidates = Array.isArray(value.profilePatchCandidates)
    ? value.profilePatchCandidates
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .map((item): DreamConsolidationSummary["profilePatchCandidates"][number] => ({
        field: normalizeText(item.field, 120) ?? "profile.field",
        valueSummary: normalizeText(item.valueSummary, 160) ?? "-",
        source: item.source === "mind_profile"
          || item.source === "learning_review"
          || item.source === "recent_work"
          || item.source === "durable_memory"
          ? item.source
          : "mind_profile",
        confidence: item.confidence === "high" || item.confidence === "medium" || item.confidence === "low"
          ? item.confidence
          : "medium",
        reason: normalizeText(item.reason, 220) ?? "Dream consolidation profile patch candidate.",
        ...(normalizeText(item.profilePath, 160) ? { profilePath: normalizeText(item.profilePath, 160) } : {}),
        ...(item.profileValue !== undefined ? { profileValue: item.profileValue as ProfileStateValue } : {}),
      }))
      .slice(0, 8)
    : [];
  const staleCandidates = Array.isArray(value.staleCandidates)
    ? value.staleCandidates
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .map((item): DreamConsolidationSummary["staleCandidates"][number] => ({
        memoryClass: item.memoryClass === "profile_semantic"
          || item.memoryClass === "episodic_task"
          || item.memoryClass === "procedural_experience"
          || item.memoryClass === "governance"
          ? item.memoryClass
          : "profile_semantic",
        reason: normalizeText(item.reason, 220) ?? "Dream consolidation stale candidate.",
        ...(normalizeText(item.evidence, 220) ? { evidence: normalizeText(item.evidence, 220) } : {}),
      }))
      .slice(0, 8)
    : [];
  const contradictionCandidates = Array.isArray(value.contradictionCandidates)
    ? value.contradictionCandidates
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .map((item) => ({
        topic: normalizeText(item.topic, 120) ?? "profile inconsistency",
        left: normalizeText(item.left, 180) ?? "-",
        right: normalizeText(item.right, 180) ?? "-",
        reason: normalizeText(item.reason, 220) ?? "Dream consolidation contradiction candidate.",
      }))
      .slice(0, 6)
    : [];
  const headline = normalizeText(value.headline, 220)
    ?? `Dream consolidation surfaced ${profilePatchCandidates.length} profile patch, ${staleCandidates.length} stale, and ${contradictionCandidates.length} contradiction candidates.`;
  const summary = normalizeText(value.summary, 240) ?? headline;
  const reviewValue = value.review && typeof value.review === "object" && !Array.isArray(value.review)
    ? value.review as Record<string, unknown>
    : null;
  const applyValue = value.apply && typeof value.apply === "object" && !Array.isArray(value.apply)
    ? value.apply as Record<string, unknown>
    : null;
  return {
    headline,
    summary,
    profilePatchCandidates,
    staleCandidates,
    contradictionCandidates,
    ...(reviewValue
      ? {
          review: {
            status: reviewValue.status === "approved"
              || reviewValue.status === "rejected"
              || reviewValue.status === "superseded"
              ? reviewValue.status
              : "pending",
            ...(normalizeIsoTimestamp(reviewValue.reviewedAt) ? { reviewedAt: normalizeIsoTimestamp(reviewValue.reviewedAt) } : {}),
            ...(normalizeText(reviewValue.reviewedBy, 120) ? { reviewedBy: normalizeText(reviewValue.reviewedBy, 120) } : {}),
            ...(normalizeText(reviewValue.note, 240) ? { note: normalizeText(reviewValue.note, 240) } : {}),
            ...(Array.isArray(reviewValue.approvedCandidatePaths)
              ? {
                  approvedCandidatePaths: reviewValue.approvedCandidatePaths
                    .map((item) => normalizeText(item, 160))
                    .filter((item): item is string => Boolean(item))
                    .slice(0, 16),
                }
              : {}),
          },
        }
      : {}),
    ...(applyValue
      ? {
          apply: {
            status: applyValue.status === "applied" ? "applied" : "not_applied",
            ...(normalizeIsoTimestamp(applyValue.appliedAt) ? { appliedAt: normalizeIsoTimestamp(applyValue.appliedAt) } : {}),
            ...(normalizeText(applyValue.appliedBy, 120) ? { appliedBy: normalizeText(applyValue.appliedBy, 120) } : {}),
            ...(normalizeText(applyValue.note, 240) ? { note: normalizeText(applyValue.note, 240) } : {}),
            ...(typeof applyValue.appliedPatchCount === "number" && Number.isFinite(applyValue.appliedPatchCount)
              ? { appliedPatchCount: Math.max(0, Math.floor(applyValue.appliedPatchCount)) }
              : {}),
            ...(Array.isArray(applyValue.appliedPatches)
              ? {
                  appliedPatches: applyValue.appliedPatches
                    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
                    .map((item): DreamConsolidationSummary["apply"] extends infer T
                      ? T extends { appliedPatches?: infer P }
                        ? P extends Array<infer U>
                          ? U
                          : never
                        : never
                      : never => ({
                      profilePath: normalizeText(item.profilePath, 160) ?? "profile.path",
                      profileValue: (item.profileValue ?? null) as ProfileStateValue,
                      ...(normalizeText(item.entryId, 160) ? { entryId: normalizeText(item.entryId, 160) } : {}),
                      action: item.action === "create" || item.action === "confirm" ? item.action : "update",
                      changed: item.changed === true,
                    }))
                    .slice(0, 16),
                }
              : {}),
          },
        }
      : {}),
  };
}

function normalizeSourceCounts(value: unknown): DreamInputSourceCounts {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    recentTaskCount: normalizePositiveInteger(source.recentTaskCount, 0, 0),
    recentWorkCount: normalizePositiveInteger(source.recentWorkCount, 0, 0),
    recentWorkRecapCount: normalizePositiveInteger(source.recentWorkRecapCount, 0, 0),
    recentResumeContextCount: normalizePositiveInteger(source.recentResumeContextCount, 0, 0),
    recentDurableMemoryCount: normalizePositiveInteger(source.recentDurableMemoryCount, 0, 0),
    recentPrivateMemoryCount: normalizePositiveInteger(source.recentPrivateMemoryCount, 0, 0),
    recentSharedMemoryCount: normalizePositiveInteger(source.recentSharedMemoryCount, 0, 0),
    recentExperienceUsageCount: normalizePositiveInteger(source.recentExperienceUsageCount, 0, 0),
    sessionDigestAvailable: source.sessionDigestAvailable === true,
    sessionMemoryAvailable: source.sessionMemoryAvailable === true,
    mindProfileAvailable: source.mindProfileAvailable === true,
    learningReviewAvailable: source.learningReviewAvailable === true,
  };
}

function normalizeObsidianSync(value: Record<string, unknown>): NonNullable<DreamRuntimeState["lastObsidianSync"]> {
  return {
    enabled: value.enabled === true,
    stage: value.stage === "pending" || value.stage === "synced" || value.stage === "failed" || value.stage === "skipped"
      ? value.stage
      : "idle",
    ...(normalizeText(value.targetPath, 320) ? { targetPath: normalizeText(value.targetPath, 320) } : {}),
    ...(normalizeIsoTimestamp(value.lastAttemptAt) ? { lastAttemptAt: normalizeIsoTimestamp(value.lastAttemptAt) } : {}),
    ...(normalizeIsoTimestamp(value.lastSuccessAt) ? { lastSuccessAt: normalizeIsoTimestamp(value.lastSuccessAt) } : {}),
    ...(normalizeText(value.error) ? { error: normalizeText(value.error) } : {}),
  };
}

function normalizeAutoTrigger(value: unknown): DreamAutoTriggerState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const triggerMode = record.triggerMode === "cron" ? "cron" : record.triggerMode === "heartbeat" ? "heartbeat" : undefined;
  const attemptedAt = normalizeIsoTimestamp(record.attemptedAt);
  if (!triggerMode || !attemptedAt || typeof record.executed !== "boolean") {
    return undefined;
  }
  const status = normalizeDreamStatus(record.status);
  const signalValue = record.signal && typeof record.signal === "object" && !Array.isArray(record.signal)
    ? record.signal as Record<string, unknown>
    : null;
  return {
    triggerMode,
    attemptedAt,
    executed: record.executed,
    ...(normalizeText(record.runId, 120) ? { runId: normalizeText(record.runId, 120) } : {}),
    ...(status !== "idle" ? { status } : {}),
    ...(normalizeText(record.skipCode, 80) ? {
      skipCode: normalizeText(record.skipCode, 80) as DreamAutoTriggerState["skipCode"],
    } : {}),
    ...(normalizeText(record.signalGateCode, 80) ? {
      signalGateCode: normalizeText(record.signalGateCode, 80) as DreamAutoSignalGateCode,
    } : {}),
    ...(normalizeText(record.skipReason) ? { skipReason: normalizeText(record.skipReason) } : {}),
    ...(signalValue
      ? {
          signal: {
            ...(normalizeIsoTimestamp(signalValue.baselineAt) ? { baselineAt: normalizeIsoTimestamp(signalValue.baselineAt) } : {}),
            recentWorkCount: normalizePositiveInteger(signalValue.recentWorkCount, 0, 0),
            recentWorkRecapCount: normalizePositiveInteger(signalValue.recentWorkRecapCount, 0, 0),
            completedTaskCount: normalizePositiveInteger(signalValue.completedTaskCount, 0, 0),
            recentDurableMemoryCount: normalizePositiveInteger(signalValue.recentDurableMemoryCount, 0, 0),
            sessionDigestAvailable: signalValue.sessionDigestAvailable === true,
            ...(typeof signalValue.sessionMemoryAvailable === "boolean" ? { sessionMemoryAvailable: signalValue.sessionMemoryAvailable === true } : {}),
            ...(normalizeCursor(signalValue.lastDreamCursor) ? { lastDreamCursor: normalizeCursor(signalValue.lastDreamCursor) } : {}),
            ...(normalizeCursor(signalValue.currentCursor) ? { currentCursor: normalizeCursor(signalValue.currentCursor) } : {}),
            ...(typeof signalValue.digestGenerationDelta === "number" && Number.isFinite(signalValue.digestGenerationDelta) ? {
              digestGenerationDelta: normalizePositiveInteger(signalValue.digestGenerationDelta, 0, 0),
            } : {}),
            ...(typeof signalValue.sessionMemoryMessageDelta === "number" && Number.isFinite(signalValue.sessionMemoryMessageDelta) ? {
              sessionMemoryMessageDelta: normalizePositiveInteger(signalValue.sessionMemoryMessageDelta, 0, 0),
            } : {}),
            ...(typeof signalValue.sessionMemoryToolDelta === "number" && Number.isFinite(signalValue.sessionMemoryToolDelta) ? {
              sessionMemoryToolDelta: normalizePositiveInteger(signalValue.sessionMemoryToolDelta, 0, 0),
            } : {}),
            ...(typeof signalValue.sessionMemoryRevisionDelta === "number" && Number.isFinite(signalValue.sessionMemoryRevisionDelta) ? {
              sessionMemoryRevisionDelta: normalizePositiveInteger(signalValue.sessionMemoryRevisionDelta, 0, 0),
            } : {}),
            ...(typeof signalValue.taskChangeSeqDelta === "number" && Number.isFinite(signalValue.taskChangeSeqDelta) ? {
              taskChangeSeqDelta: normalizePositiveInteger(signalValue.taskChangeSeqDelta, 0, 0),
            } : {}),
            ...(typeof signalValue.memoryChangeSeqDelta === "number" && Number.isFinite(signalValue.memoryChangeSeqDelta) ? {
              memoryChangeSeqDelta: normalizePositiveInteger(signalValue.memoryChangeSeqDelta, 0, 0),
            } : {}),
            ...(typeof signalValue.changeBudget === "number" && Number.isFinite(signalValue.changeBudget) ? {
              changeBudget: normalizePositiveInteger(signalValue.changeBudget, 0, 0),
            } : {}),
            ...(normalizeIsoTimestamp(signalValue.latestWorkAt) ? { latestWorkAt: normalizeIsoTimestamp(signalValue.latestWorkAt) } : {}),
            ...(normalizeIsoTimestamp(signalValue.latestWorkRecapAt) ? { latestWorkRecapAt: normalizeIsoTimestamp(signalValue.latestWorkRecapAt) } : {}),
            ...(normalizeIsoTimestamp(signalValue.latestResumeContextAt) ? { latestResumeContextAt: normalizeIsoTimestamp(signalValue.latestResumeContextAt) } : {}),
            ...(normalizeIsoTimestamp(signalValue.latestCompletedTaskAt) ? { latestCompletedTaskAt: normalizeIsoTimestamp(signalValue.latestCompletedTaskAt) } : {}),
            ...(normalizeIsoTimestamp(signalValue.latestDurableMemoryAt) ? { latestDurableMemoryAt: normalizeIsoTimestamp(signalValue.latestDurableMemoryAt) } : {}),
            ...(normalizeIsoTimestamp(signalValue.sessionDigestAt) ? { sessionDigestAt: normalizeIsoTimestamp(signalValue.sessionDigestAt) } : {}),
            ...(normalizeIsoTimestamp(signalValue.sessionMemoryAt) ? { sessionMemoryAt: normalizeIsoTimestamp(signalValue.sessionMemoryAt) } : {}),
            ...(typeof signalValue.freshWorkSinceBaseline === "boolean" ? { freshWorkSinceBaseline: signalValue.freshWorkSinceBaseline === true } : {}),
            ...(typeof signalValue.freshWorkRecapSinceBaseline === "boolean" ? { freshWorkRecapSinceBaseline: signalValue.freshWorkRecapSinceBaseline === true } : {}),
            ...(typeof signalValue.freshResumeContextSinceBaseline === "boolean" ? { freshResumeContextSinceBaseline: signalValue.freshResumeContextSinceBaseline === true } : {}),
            ...(typeof signalValue.freshCompletedTaskSinceBaseline === "boolean" ? { freshCompletedTaskSinceBaseline: signalValue.freshCompletedTaskSinceBaseline === true } : {}),
            ...(typeof signalValue.freshDurableMemorySinceBaseline === "boolean" ? { freshDurableMemorySinceBaseline: signalValue.freshDurableMemorySinceBaseline === true } : {}),
            ...(typeof signalValue.freshSessionDigestSinceBaseline === "boolean" ? { freshSessionDigestSinceBaseline: signalValue.freshSessionDigestSinceBaseline === true } : {}),
            ...(typeof signalValue.freshSessionMemorySinceBaseline === "boolean" ? { freshSessionMemorySinceBaseline: signalValue.freshSessionMemorySinceBaseline === true } : {}),
          },
        }
      : {}),
  };
}

function normalizeState(
  agentId: string,
  raw: unknown,
  defaults: DreamRuntimeSettings,
): DreamRuntimeState {
  const normalizedAgentId = normalizeText(agentId, 120) ?? "default";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return createDefaultDreamRuntimeState({
      agentId: normalizedAgentId,
      settings: defaults,
    });
  }

  const value = raw as Record<string, unknown>;
  const settings = normalizeDreamRuntimeSettings({
    ...defaults,
    ...(value.settings && typeof value.settings === "object" && !Array.isArray(value.settings)
      ? value.settings as Partial<DreamRuntimeSettings>
      : {}),
  });

  const recentRuns = Array.isArray(value.recentRuns)
    ? value.recentRuns.map((item) => normalizeRun(item)).filter((item): item is DreamRecord => Boolean(item)).slice(0, settings.maxRecentRuns)
    : [];

  return {
    version: STATE_VERSION,
    agentId: normalizeText(value.agentId, 120) ?? normalizedAgentId,
    status: normalizeDreamStatus(value.status),
    updatedAt: normalizeIsoTimestamp(value.updatedAt) ?? new Date().toISOString(),
    ...(normalizeText(value.lastRunId, 120) ? { lastRunId: normalizeText(value.lastRunId, 120) } : {}),
    ...(normalizeIsoTimestamp(value.lastDreamAt) ? { lastDreamAt: normalizeIsoTimestamp(value.lastDreamAt) } : {}),
    ...(normalizeIsoTimestamp(value.lastFailedAt) ? { lastFailedAt: normalizeIsoTimestamp(value.lastFailedAt) } : {}),
    ...(normalizeIsoTimestamp(value.cooldownUntil) ? { cooldownUntil: normalizeIsoTimestamp(value.cooldownUntil) } : {}),
    ...(normalizeIsoTimestamp(value.failureBackoffUntil) ? { failureBackoffUntil: normalizeIsoTimestamp(value.failureBackoffUntil) } : {}),
    ...(normalizeCursor(value.lastDreamCursor) ? { lastDreamCursor: normalizeCursor(value.lastDreamCursor) } : {}),
    ...(normalizeAutoTrigger(value.lastAutoTrigger) ? { lastAutoTrigger: normalizeAutoTrigger(value.lastAutoTrigger) } : {}),
    ...(normalizeAutoStats(value.autoStats) ? { autoStats: normalizeAutoStats(value.autoStats) } : {}),
    ...(value.lastInput && typeof value.lastInput === "object" && !Array.isArray(value.lastInput)
      ? {
          lastInput: {
            collectedAt: normalizeIsoTimestamp((value.lastInput as Record<string, unknown>).collectedAt) ?? new Date().toISOString(),
            windowHours: normalizePositiveInteger((value.lastInput as Record<string, unknown>).windowHours, settings.inputWindowHours),
            ...(normalizeText((value.lastInput as Record<string, unknown>).conversationId, 160)
              ? { conversationId: normalizeText((value.lastInput as Record<string, unknown>).conversationId, 160) }
              : {}),
            ...(normalizeText((value.lastInput as Record<string, unknown>).focusTaskId, 160)
              ? { focusTaskId: normalizeText((value.lastInput as Record<string, unknown>).focusTaskId, 160) }
              : {}),
            sourceCounts: normalizeSourceCounts((value.lastInput as Record<string, unknown>).sourceCounts),
          },
        }
      : {}),
    ...(value.lastObsidianSync && typeof value.lastObsidianSync === "object" && !Array.isArray(value.lastObsidianSync)
      ? { lastObsidianSync: normalizeObsidianSync(value.lastObsidianSync as Record<string, unknown>) }
      : {}),
    settings,
    recentRuns,
  };
}

async function atomicWriteJson(filePath: string, value: DreamRuntimeState): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(value, null, 2), "utf-8");
    await renameWithRetry(tmpPath, filePath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }
}

function isRetriableAtomicRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameWithRetry(sourcePath: string, destinationPath: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(sourcePath, destinationPath);
      return;
    } catch (error) {
      if (!isRetriableAtomicRenameError(error) || attempt >= ATOMIC_RENAME_RETRY_DELAYS_MS.length) {
        throw error;
      }
      await sleep(ATOMIC_RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function normalizeDate(value?: Date | number | string): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return new Date(value.getTime());
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return new Date(parsed);
    }
  }
  return new Date();
}

function addHours(value: string, hours: number): string | undefined {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed + (hours * 60 * 60 * 1000)).toISOString();
}

function addMinutes(value: string, minutes: number): string | undefined {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed + (minutes * 60 * 1000)).toISOString();
}

function formatDatePart(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeDreamBasename(value?: string): string {
  const normalized = String(value ?? "dream")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "dream";
}

export function buildDreamRuntimePath(stateDir: string): string {
  return path.join(stateDir, DREAM_RUNTIME_FILENAME);
}

export function buildDreamIndexPath(stateDir: string): string {
  return path.join(stateDir, DREAM_INDEX_FILENAME);
}

export function buildDreamsDirPath(stateDir: string): string {
  return path.join(stateDir, DREAMS_DIRNAME);
}

export function buildDreamFilePath(options: BuildDreamFilePathOptions): string {
  const date = normalizeDate(options.occurredAt);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const datePart = formatDatePart(date);
  const slug = normalizeDreamBasename(options.dreamId);
  return path.join(options.stateDir, DREAMS_DIRNAME, year, month, `${datePart}--${slug}.md`);
}

export function createDefaultDreamRuntimeState(input: {
  agentId: string;
  now?: Date | number | string;
  settings?: Partial<DreamRuntimeSettings>;
}): DreamRuntimeState {
  const settings = normalizeDreamRuntimeSettings(input.settings);
  return {
    version: STATE_VERSION,
    agentId: normalizeText(input.agentId, 120) ?? "default",
    status: "idle",
    updatedAt: normalizeDate(input.now).toISOString(),
    settings,
    autoStats: {
      attemptedCount: 0,
      executedCount: 0,
      skippedCount: 0,
    },
    recentRuns: [],
  };
}

export function toDreamInputMeta(snapshot: DreamInputSnapshot): DreamRuntimeState["lastInput"] {
  return {
    collectedAt: snapshot.collectedAt,
    windowHours: snapshot.windowHours,
    ...(snapshot.conversationId ? { conversationId: snapshot.conversationId } : {}),
    ...(snapshot.focusTask?.id ? { focusTaskId: snapshot.focusTask.id } : {}),
    sourceCounts: { ...snapshot.sourceCounts },
  };
}

export class DreamStore {
  private readonly stateDir: string;
  private readonly agentId: string;
  private readonly statePath: string;
  private readonly defaultSettings: DreamRuntimeSettings;
  private writeChain: Promise<void> = Promise.resolve();
  private loadPromise: Promise<void> | null = null;
  private state: DreamRuntimeState | null = null;

  constructor(options: DreamStoreOptions) {
    this.stateDir = path.resolve(options.stateDir);
    this.agentId = normalizeText(options.agentId, 120) ?? "default";
    this.statePath = buildDreamRuntimePath(this.stateDir);
    this.defaultSettings = normalizeDreamRuntimeSettings(options.settings);
  }

  async load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      await fs.mkdir(this.stateDir, { recursive: true });
      try {
        const raw = await fs.readFile(this.statePath, "utf-8");
        this.state = normalizeState(this.agentId, JSON.parse(raw), this.defaultSettings);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code !== "ENOENT") {
          // ignore malformed state and rebuild from defaults
        }
        this.state = createDefaultDreamRuntimeState({
          agentId: this.agentId,
          settings: this.defaultSettings,
        });
      }
    })();
    return this.loadPromise;
  }

  async getState(): Promise<DreamRuntimeState> {
    await this.load();
    return cloneState(this.state ?? createDefaultDreamRuntimeState({
      agentId: this.agentId,
      settings: this.defaultSettings,
    }));
  }

  async replaceState(next: DreamRuntimeState): Promise<DreamRuntimeState> {
    await this.load();
    const normalized = normalizeState(this.agentId, next, this.defaultSettings);
    await this.enqueueWrite(async () => {
      this.state = normalized;
      await atomicWriteJson(this.statePath, normalized);
    });
    return cloneState(normalized);
  }

  async mutate(mutator: (current: DreamRuntimeState) => DreamRuntimeState): Promise<DreamRuntimeState> {
    await this.load();
    let next!: DreamRuntimeState;
    await this.enqueueWrite(async () => {
      const current = cloneState(this.state ?? createDefaultDreamRuntimeState({
        agentId: this.agentId,
        settings: this.defaultSettings,
      }));
      next = normalizeState(this.agentId, mutator(current), this.defaultSettings);
      this.state = next;
      await atomicWriteJson(this.statePath, next);
    });
    return cloneState(next);
  }

  async setStatus(status: DreamStatus, patch: Partial<DreamRuntimeState> = {}): Promise<DreamRuntimeState> {
    return this.mutate((current) => ({
      ...current,
      ...patch,
      status,
      updatedAt: new Date().toISOString(),
      settings: {
        ...current.settings,
        ...(patch.settings ?? {}),
      },
      recentRuns: (patch.recentRuns ?? current.recentRuns).map((item) => cloneRun(item)).slice(0, current.settings.maxRecentRuns),
    }));
  }

  async updateLastInput(snapshot?: DreamInputSnapshot): Promise<DreamRuntimeState> {
    return this.mutate((current) => ({
      ...current,
      updatedAt: new Date().toISOString(),
      ...(snapshot ? { lastInput: toDreamInputMeta(snapshot) } : {}),
    }));
  }

  async recordAutoTrigger(trigger: DreamAutoTriggerState): Promise<DreamRuntimeState> {
    return this.mutate((current) => ({
      ...current,
      updatedAt: new Date().toISOString(),
      lastAutoTrigger: cloneAutoTrigger(trigger),
      autoStats: {
        attemptedCount: Math.max(0, (current.autoStats?.attemptedCount ?? 0) + 1),
        executedCount: Math.max(0, (current.autoStats?.executedCount ?? 0) + (trigger.executed ? 1 : 0)),
        skippedCount: Math.max(0, (current.autoStats?.skippedCount ?? 0) + (trigger.executed ? 0 : 1)),
        ...(bumpMappedCount(current.autoStats?.skipCodeCounts, trigger.executed ? undefined : trigger.skipCode)
          ? { skipCodeCounts: bumpMappedCount(current.autoStats?.skipCodeCounts, trigger.executed ? undefined : trigger.skipCode) }
          : {}),
        ...(bumpMappedCount(current.autoStats?.signalGateCounts, trigger.signalGateCode)
          ? { signalGateCounts: bumpMappedCount(current.autoStats?.signalGateCounts, trigger.signalGateCode) }
          : {}),
        byTriggerMode: {
          ...(current.autoStats?.byTriggerMode ?? {}),
          [trigger.triggerMode]: bumpModeStats(current.autoStats?.byTriggerMode?.[trigger.triggerMode], trigger),
        },
      },
    }));
  }

  async recordRun(record: DreamRecord, patch: { lastDreamCursor?: DreamChangeCursor } = {}): Promise<DreamRuntimeState> {
    return this.mutate((current) => {
      const recentRuns = [
        cloneRun(record),
        ...current.recentRuns.filter((item) => item.id !== record.id),
      ].slice(0, current.settings.maxRecentRuns);
      const finishedAt = record.finishedAt ?? record.startedAt ?? record.requestedAt;
      const cooldownUntil = record.status === "completed"
        ? addHours(finishedAt, current.settings.cooldownHours)
        : undefined;
      const failureBackoffUntil = record.status === "failed"
        ? addMinutes(finishedAt, current.settings.failureBackoffMinutes)
        : undefined;
      return {
        ...current,
        status: record.status,
        updatedAt: new Date().toISOString(),
        lastRunId: record.id,
        ...(record.input ? { lastInput: cloneInputMeta(record.input) } : {}),
        ...(record.obsidianSync ? { lastObsidianSync: { ...record.obsidianSync } } : {}),
        ...(record.status === "completed" ? { lastDreamAt: finishedAt } : {}),
        ...(record.status === "completed" && patch.lastDreamCursor ? { lastDreamCursor: cloneCursor(patch.lastDreamCursor) } : {}),
        ...(record.status === "failed" ? { lastFailedAt: finishedAt } : {}),
        ...(cooldownUntil ? { cooldownUntil } : {}),
        ...(!cooldownUntil ? { cooldownUntil: undefined } : {}),
        ...(failureBackoffUntil ? { failureBackoffUntil } : {}),
        ...(!failureBackoffUntil ? { failureBackoffUntil: undefined } : {}),
        recentRuns,
      };
    });
  }

  async updateRun(runId: string, mutator: (record: DreamRecord) => DreamRecord): Promise<DreamRuntimeState> {
    const normalizedRunId = normalizeText(runId, 120);
    if (!normalizedRunId) {
      throw new Error("dream run id is required");
    }
    return this.mutate((current) => {
      const target = current.recentRuns.find((item) => item.id === normalizedRunId);
      if (!target) {
        throw new Error(`Dream run not found: ${normalizedRunId}`);
      }
      const nextRecord = cloneRun(mutator(cloneRun(target)));
      return {
        ...current,
        updatedAt: new Date().toISOString(),
        recentRuns: current.recentRuns.map((item) => item.id === normalizedRunId ? nextRecord : cloneRun(item)),
        ...(current.lastRunId === normalizedRunId ? { lastRunId: nextRecord.id } : {}),
      };
    });
  }

  getRuntimePath(): string {
    return this.statePath;
  }

  getStateDir(): string {
    return this.stateDir;
  }

  getDreamsDirPath(): string {
    return buildDreamsDirPath(this.stateDir);
  }

  getDreamIndexPath(): string {
    return buildDreamIndexPath(this.stateDir);
  }

  buildDreamFilePath(options: Omit<BuildDreamFilePathOptions, "stateDir"> = {}): string {
    return buildDreamFilePath({
      stateDir: this.stateDir,
      ...options,
    });
  }

  private async enqueueWrite(task: () => Promise<void>): Promise<void> {
    const next = this.writeChain.catch(() => undefined).then(task);
    this.writeChain = next;
    await next;
  }
}
