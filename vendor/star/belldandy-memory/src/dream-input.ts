import fs from "node:fs/promises";
import path from "node:path";

import type {
  ExperienceUsageSummary,
  TaskExperienceDetail,
} from "./experience-types.js";
import {
  createTaskWorkSurface,
} from "./task-work-surface.js";
import type {
  DreamConfidenceLevel,
  DreamConversationArtifactFileOptions,
  DreamDurableMemoryItem,
  DreamInputBuildOptions,
  DreamInputSnapshot,
  DreamRuleSkeleton,
  DreamRuleSkeletonSourceSummary,
  DreamSessionDigest,
  DreamSessionMemory,
  DreamWorkItem,
} from "./dream-types.js";
import type { MemorySearchResult, MemorySearchScope, MemoryType, MemoryVisibility } from "./types.js";
import type { TaskStatus } from "./task-types.js";

const INVALID_CONVERSATION_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001F%]/g;
const TRAILING_CONVERSATION_FILENAME_CHARS = /[. ]+$/;
const RESERVED_WINDOWS_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function encodeConversationChar(char: string): string {
  const codePoint = char.codePointAt(0);
  if (typeof codePoint !== "number") return "_";
  return `%${codePoint.toString(16).toUpperCase().padStart(2, "0")}`;
}

function toSafeConversationFileId(id: string): string {
  let safeId = id.replace(INVALID_CONVERSATION_FILENAME_CHARS, encodeConversationChar);
  safeId = safeId.replace(TRAILING_CONVERSATION_FILENAME_CHARS, (match) => Array.from(match).map(encodeConversationChar).join(""));
  if (!safeId) safeId = "_";
  const windowsBasename = safeId.split(".")[0] ?? safeId;
  if (RESERVED_WINDOWS_BASENAME.test(windowsBasename)) {
    safeId = `_${safeId}`;
  }
  return safeId;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized ? normalized : undefined;
}

type DreamInputSnapshotBase = Omit<DreamInputSnapshot, "ruleSkeleton">;

function normalizeCursorValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeDate(input?: Date | number | string): Date {
  if (input instanceof Date && Number.isFinite(input.getTime())) return new Date(input.getTime());
  if (typeof input === "number" && Number.isFinite(input)) return new Date(input);
  if (typeof input === "string") {
    const parsed = Date.parse(input);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  return new Date();
}

function toIso(value: string | number | Date): string {
  return normalizeDate(value).toISOString();
}

function toDateOnlyUtc(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isWithinWindow(value: string | number | undefined, sinceMs: number): boolean {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= sinceMs;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed >= sinceMs : true;
  }
  return true;
}

function compareByLatestTimestamp(
  left: { updatedAt?: string; finishedAt?: string; startedAt?: string },
  right: { updatedAt?: string; finishedAt?: string; startedAt?: string },
): number {
  return readLatestTimestamp(right) - readLatestTimestamp(left);
}

function readLatestTimestamp(value: { updatedAt?: string; finishedAt?: string; startedAt?: string }): number {
  for (const candidate of [value.updatedAt, value.finishedAt, value.startedAt]) {
    if (typeof candidate !== "string") continue;
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function toStatusBucket(status: string | undefined): TaskStatus {
  switch (status) {
    case "running":
    case "failed":
    case "partial":
      return status;
    default:
      return "success";
  }
}

function normalizeDreamWorkItem(task: TaskExperienceDetail): DreamWorkItem {
  return {
    taskId: task.id,
    conversationId: task.conversationId,
    title: task.title,
    objective: task.objective,
    summary: task.summary,
    status: toStatusBucket(task.status),
    source: task.source,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    updatedAt: task.updatedAt,
    agentId: task.agentId,
    toolNames: (task.toolCalls ?? []).map((item) => item.toolName).filter((item): item is string => Boolean(item)),
    artifactPaths: [...(task.artifactPaths ?? [])],
    recentActivityTitles: (task.activities ?? [])
      .slice()
      .reverse()
      .filter((item) => item.kind !== "task_completed")
      .map((item) => item.title || item.summary || "")
      .filter((item) => Boolean(item))
      .slice(0, 3),
    workRecap: task.workRecap,
    resumeContext: task.resumeContext,
  };
}

function normalizeDurableMemoryItem(item: MemorySearchResult): DreamDurableMemoryItem {
  return {
    id: item.id,
    sourcePath: item.sourcePath,
    sourceType: item.sourceType,
    memoryType: item.memoryType,
    category: item.category,
    visibility: item.visibility,
    content: item.content,
    snippet: item.snippet,
    summary: item.summary,
    updatedAt: item.updatedAt,
    metadata: item.metadata as Record<string, unknown> | undefined,
  };
}

function dedupeTasks(tasks: TaskExperienceDetail[]): TaskExperienceDetail[] {
  const result: TaskExperienceDetail[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    if (!task?.id || seen.has(task.id)) continue;
    seen.add(task.id);
    result.push(task);
  }
  return result;
}

function dedupeWorkItems(items: DreamWorkItem[]): DreamWorkItem[] {
  const result: DreamWorkItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item?.taskId || seen.has(item.taskId)) continue;
    seen.add(item.taskId);
    result.push(item);
  }
  return result;
}

function dedupeUsages(items: ExperienceUsageSummary[]): ExperienceUsageSummary[] {
  const result: ExperienceUsageSummary[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = item.usageId || `${item.assetType}:${item.assetKey}:${item.taskId}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function pushUniqueText(target: string[], seen: Set<string>, value: unknown, limit: number, maxLength = 220): void {
  if (target.length >= limit) return;
  const normalized = normalizeText(value);
  if (!normalized) return;
  const truncated = normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 3))}...` : normalized;
  const key = truncated.toLocaleLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  target.push(truncated);
}

function formatTaskLoop(task: TaskExperienceDetail): string | undefined {
  const title = normalizeText(task.title) ?? normalizeText(task.objective) ?? normalizeText(task.summary);
  if (!title) return undefined;
  switch (task.status) {
    case "running":
      return `任务进行中：${title}`;
    case "failed":
      return `任务失败待处理：${title}`;
    case "partial":
      return `任务部分完成待收口：${title}`;
    default:
      return undefined;
  }
}

function buildDreamRuleSkeletonSourceSummary(snapshot: DreamInputSnapshotBase): DreamRuleSkeletonSourceSummary {
  const primarySources = [
    snapshot.focusTask ? "focus_task" : undefined,
    snapshot.sourceCounts.recentWorkCount > 0 ? "recent_work" : undefined,
    snapshot.sourceCounts.sessionDigestAvailable ? "session_digest" : undefined,
    snapshot.sourceCounts.sessionMemoryAvailable ? "session_memory" : undefined,
    snapshot.sourceCounts.recentDurableMemoryCount > 0 ? "durable_memory" : undefined,
    snapshot.sourceCounts.recentExperienceUsageCount > 0 ? "experience_usage" : undefined,
    snapshot.sourceCounts.mindProfileAvailable ? "mind_profile" : undefined,
    snapshot.sourceCounts.learningReviewAvailable ? "learning_review" : undefined,
  ].filter((item): item is string => Boolean(item));
  return {
    primarySources,
    sourceCount: primarySources.length,
    taskCount: snapshot.sourceCounts.recentTaskCount,
    workCount: snapshot.sourceCounts.recentWorkCount,
    durableMemoryCount: snapshot.sourceCounts.recentDurableMemoryCount,
    experienceUsageCount: snapshot.sourceCounts.recentExperienceUsageCount,
    summaryLine: [
      `sources=${primarySources.join("+") || "none"}`,
      `tasks=${snapshot.sourceCounts.recentTaskCount}`,
      `work=${snapshot.sourceCounts.recentWorkCount}`,
      `durable=${snapshot.sourceCounts.recentDurableMemoryCount}`,
      `usages=${snapshot.sourceCounts.recentExperienceUsageCount}`,
    ].join("; "),
  };
}

function resolveDreamConfidence(snapshot: DreamInputSnapshotBase): DreamConfidenceLevel {
  let score = 0;
  if (snapshot.sourceCounts.sessionDigestAvailable) score += 2;
  if (snapshot.sourceCounts.sessionMemoryAvailable) score += 2;
  if (snapshot.sourceCounts.recentWorkRecapCount > 0) score += 2;
  if (snapshot.sourceCounts.recentDurableMemoryCount > 0) score += 1;
  if (snapshot.sourceCounts.recentTaskCount > 0) score += 1;
  if (snapshot.sourceCounts.recentExperienceUsageCount > 0) score += 1;
  if (snapshot.sourceCounts.mindProfileAvailable) score += 1;
  if (snapshot.sourceCounts.learningReviewAvailable) score += 1;
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  return "low";
}

export function buildDreamRuleSkeleton(snapshot: DreamInputSnapshotBase): DreamRuleSkeleton {
  const topicCandidates: string[] = [];
  const confirmedFacts: string[] = [];
  const openLoops: string[] = [];
  const carryForwardCandidates: string[] = [];
  const topicSeen = new Set<string>();
  const factSeen = new Set<string>();
  const loopSeen = new Set<string>();
  const carrySeen = new Set<string>();

  pushUniqueText(topicCandidates, topicSeen, snapshot.focusTask?.title, 3, 120);
  pushUniqueText(topicCandidates, topicSeen, snapshot.focusTask?.objective, 3, 140);
  for (const item of snapshot.recentWorkItems) {
    if (topicCandidates.length >= 3) break;
    pushUniqueText(topicCandidates, topicSeen, item.title, 3, 120);
    pushUniqueText(topicCandidates, topicSeen, item.objective, 3, 140);
  }
  pushUniqueText(topicCandidates, topicSeen, snapshot.sessionMemory?.currentWork, 3, 140);
  pushUniqueText(topicCandidates, topicSeen, snapshot.sessionMemory?.nextStep, 3, 140);

  pushUniqueText(confirmedFacts, factSeen, snapshot.sessionDigest?.rollingSummary, 8, 220);
  pushUniqueText(confirmedFacts, factSeen, snapshot.sessionDigest?.archivalSummary, 8, 220);
  pushUniqueText(confirmedFacts, factSeen, snapshot.sessionMemory?.summary, 8, 220);
  pushUniqueText(confirmedFacts, factSeen, snapshot.sessionMemory?.currentGoal, 8, 180);
  pushUniqueText(confirmedFacts, factSeen, snapshot.sessionMemory?.currentWork, 8, 180);
  for (const item of snapshot.recentWorkItems) {
    if (confirmedFacts.length >= 8) break;
    pushUniqueText(confirmedFacts, factSeen, item.workRecap?.headline, 8, 180);
    for (const fact of item.workRecap?.confirmedFacts ?? []) {
      if (confirmedFacts.length >= 8) break;
      pushUniqueText(confirmedFacts, factSeen, fact, 8, 180);
    }
  }
  for (const item of snapshot.recentDurableMemories) {
    if (confirmedFacts.length >= 8) break;
    pushUniqueText(confirmedFacts, factSeen, item.summary, 8, 180);
    pushUniqueText(confirmedFacts, factSeen, item.snippet, 8, 180);
  }

  pushUniqueText(openLoops, loopSeen, snapshot.sessionMemory?.nextStep, 6, 180);
  for (const pendingTask of snapshot.sessionMemory?.pendingTasks ?? []) {
    if (openLoops.length >= 6) break;
    pushUniqueText(openLoops, loopSeen, pendingTask, 6, 180);
  }
  for (const item of snapshot.recentWorkItems) {
    if (openLoops.length >= 6) break;
    pushUniqueText(openLoops, loopSeen, item.resumeContext?.nextStep, 6, 180);
    pushUniqueText(openLoops, loopSeen, item.resumeContext?.currentStopPoint, 6, 180);
  }
  for (const task of snapshot.recentTasks) {
    if (openLoops.length >= 6) break;
    pushUniqueText(openLoops, loopSeen, formatTaskLoop(task), 6, 180);
  }

  pushUniqueText(carryForwardCandidates, carrySeen, snapshot.learningReviewInput?.summary?.headline, 6, 180);
  for (const line of snapshot.learningReviewInput?.summaryLines ?? []) {
    if (carryForwardCandidates.length >= 6) break;
    pushUniqueText(carryForwardCandidates, carrySeen, line, 6, 180);
  }
  for (const nudge of snapshot.learningReviewInput?.nudges ?? []) {
    if (carryForwardCandidates.length >= 6) break;
    pushUniqueText(carryForwardCandidates, carrySeen, nudge, 6, 180);
  }
  for (const usage of snapshot.recentExperienceUsages) {
    if (carryForwardCandidates.length >= 6) break;
    pushUniqueText(carryForwardCandidates, carrySeen, usage.sourceCandidateTitle, 6, 160);
    pushUniqueText(carryForwardCandidates, carrySeen, usage.assetKey, 6, 160);
  }
  for (const memory of snapshot.recentDurableMemories) {
    if (carryForwardCandidates.length >= 6) break;
    if (memory.visibility === "shared") {
      pushUniqueText(carryForwardCandidates, carrySeen, memory.summary ?? memory.snippet, 6, 180);
    }
  }

  const sourceSummary = buildDreamRuleSkeletonSourceSummary(snapshot);
  return {
    topicCandidates,
    confirmedFacts,
    openLoops,
    carryForwardCandidates,
    sourceSummary,
    confidence: resolveDreamConfidence(snapshot),
  };
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function buildDreamConversationArtifactPath(options: DreamConversationArtifactFileOptions): string {
  return path.join(options.sessionsDir, `${toSafeConversationFileId(options.conversationId)}${options.suffix}`);
}

export async function readDreamSessionDigestFile(input: {
  sessionsDir: string;
  conversationId: string;
}): Promise<DreamSessionDigest | undefined> {
  return readJsonFile<DreamSessionDigest>(buildDreamConversationArtifactPath({
    sessionsDir: input.sessionsDir,
    conversationId: input.conversationId,
    suffix: ".digest.json",
  }));
}

export async function readDreamSessionMemoryFile(input: {
  sessionsDir: string;
  conversationId: string;
}): Promise<DreamSessionMemory | undefined> {
  return readJsonFile<DreamSessionMemory>(buildDreamConversationArtifactPath({
    sessionsDir: input.sessionsDir,
    conversationId: input.conversationId,
    suffix: ".session-memory.json",
  }));
}

function summarizeVisibility(items: DreamDurableMemoryItem[], visibility: MemoryVisibility): number {
  return items.filter((item) => item.visibility === visibility).length;
}

export async function buildDreamInputSnapshot(input: DreamInputBuildOptions): Promise<DreamInputSnapshot> {
  const agentId = normalizeText(input.agentId) ?? "default";
  const conversationId = normalizeText(input.conversationId);
  const now = normalizeDate(input.now);
  const windowHours = Math.max(1, Math.floor(input.inputWindowHours ?? 72));
  const recentTaskLimit = Math.max(1, Math.floor(input.recentTaskLimit ?? 8));
  const recentWorkLimit = Math.max(1, Math.floor(input.recentWorkLimit ?? 6));
  const recentMemoryLimit = Math.max(1, Math.floor(input.recentMemoryLimit ?? 12));
  const windowStartedAt = new Date(now.getTime() - (windowHours * 60 * 60 * 1000));
  const windowStartedAtIso = windowStartedAt.toISOString();
  const taskFilter = { agentId };
  const memoryFilter = {
    agentId,
    scope: "all" as MemorySearchScope,
    memoryType: ["core", "daily"] as MemoryType[],
    dateFrom: toDateOnlyUtc(windowStartedAt),
  };

  const [mindProfileSnapshot, sessionDigest, sessionMemory, taskChangeSeq, memoryChangeSeq] = await Promise.all([
    input.buildMindProfileSnapshot?.({
      agentId,
      conversationId,
      stateDir: input.stateDir,
      now,
    }),
    conversationId
      ? input.getSessionDigest
        ? input.getSessionDigest(conversationId)
        : input.sessionsDir
          ? readDreamSessionDigestFile({
              sessionsDir: input.sessionsDir,
              conversationId,
            })
          : undefined
      : undefined,
    conversationId
      ? input.getSessionMemory
        ? input.getSessionMemory(conversationId)
        : input.sessionsDir
          ? readDreamSessionMemoryFile({
              sessionsDir: input.sessionsDir,
              conversationId,
            })
          : undefined
      : undefined,
    input.getTaskChangeSeq?.(),
    input.getMemoryChangeSeq?.(),
  ]);

  const recentTaskCandidates = input.memoryManager.getRecentTasks(Math.max(recentTaskLimit * 4, 24), taskFilter);
  const recentTasks = dedupeTasks(
    recentTaskCandidates
      .filter((item) => isWithinWindow(item.updatedAt, windowStartedAt.getTime()))
      .map((item) => input.memoryManager.getTaskDetail(item.id))
      .filter((item): item is TaskExperienceDetail => Boolean(item))
      .sort(compareByLatestTimestamp)
      .slice(0, recentTaskLimit),
  );

  const focusTask = conversationId
    ? (() => {
        const direct = input.memoryManager.getTaskByConversation?.(conversationId);
        if (!direct?.id) return recentTasks[0];
        return input.memoryManager.getTaskDetail(direct.id) ?? recentTasks[0];
      })()
    : recentTasks[0];

  const surface = createTaskWorkSurface({
    getRecentWork: input.memoryManager.getRecentWork
      ? (params) => input.memoryManager.getRecentWork!(params)
      : undefined,
    getTaskDetail: (taskId) => input.memoryManager.getTaskDetail(taskId),
  });

  const recentWorkItems = dedupeWorkItems(
    (
      input.memoryManager.getRecentWork
        ? input.memoryManager.getRecentWork({
            limit: Math.max(recentWorkLimit * 4, 20),
            filter: taskFilter,
          }) ?? []
        : recentTasks.map((task) => normalizeDreamWorkItem(task))
    )
      .filter((item) => isWithinWindow(item.updatedAt, windowStartedAt.getTime()))
      .sort(compareByLatestTimestamp)
      .slice(0, recentWorkLimit)
      .map((item) => ({
        ...item,
        sourceExplanation: surface.explainSources({ item }) ?? null,
      })),
  );

  const recentDurableMemories = input.memoryManager
    .getRecent(Math.max(recentMemoryLimit * 4, 24), memoryFilter, true)
    .filter((item) => item.memoryType === "core" || item.memoryType === "daily")
    .filter((item) => isWithinWindow(item.updatedAt, windowStartedAt.getTime()))
    .slice(0, recentMemoryLimit)
    .map((item) => normalizeDurableMemoryItem(item));

  const recentExperienceUsages = dedupeUsages(
    recentTasks.flatMap((task) => [
      ...(task.usedMethods ?? []),
      ...(task.usedSkills ?? []),
    ]),
  ).slice(0, Math.max(recentTaskLimit * 2, 12));

  const learningReviewInput = input.buildLearningReviewInput
    ? await input.buildLearningReviewInput({
        agentId,
        conversationId,
        stateDir: input.stateDir,
        now,
        mindProfileSnapshot: mindProfileSnapshot ?? undefined,
        focusTask,
        recentTasks,
        recentWorkItems,
        recentDurableMemories,
        recentExperienceUsages,
      })
    : undefined;

  const sourceCounts = {
    recentTaskCount: recentTasks.length,
    recentWorkCount: recentWorkItems.length,
    recentWorkRecapCount: recentWorkItems.filter((item) => Boolean(item.workRecap)).length,
    recentResumeContextCount: recentWorkItems.filter((item) => Boolean(item.resumeContext)).length,
    recentDurableMemoryCount: recentDurableMemories.length,
    recentPrivateMemoryCount: summarizeVisibility(recentDurableMemories, "private"),
    recentSharedMemoryCount: summarizeVisibility(recentDurableMemories, "shared"),
    recentExperienceUsageCount: recentExperienceUsages.length,
    sessionDigestAvailable: Boolean(sessionDigest && (sessionDigest.rollingSummary || sessionDigest.archivalSummary || sessionDigest.pendingMessageCount !== undefined)),
    sessionMemoryAvailable: Boolean(sessionMemory && (sessionMemory.summary || sessionMemory.currentWork || sessionMemory.nextStep)),
    mindProfileAvailable: Boolean(mindProfileSnapshot?.summary?.available || mindProfileSnapshot?.profile?.headline),
    learningReviewAvailable: Boolean(learningReviewInput?.summary?.available || (learningReviewInput?.summaryLines?.length ?? 0) > 0 || (learningReviewInput?.nudges?.length ?? 0) > 0),
  };
  const changeCursor = {
    digestGeneration: normalizeCursorValue(sessionDigest?.digestGeneration),
    sessionMemoryMessageCount: normalizeCursorValue(sessionMemory?.lastSummarizedMessageCount),
    sessionMemoryToolCursor: normalizeCursorValue(sessionMemory?.lastSummarizedToolCursor),
    taskChangeSeq: normalizeCursorValue(taskChangeSeq),
    memoryChangeSeq: normalizeCursorValue(memoryChangeSeq),
  };

  const snapshotBase: DreamInputSnapshotBase = {
    agentId,
    collectedAt: now.toISOString(),
    conversationId,
    windowHours,
    windowStartedAt: windowStartedAtIso,
    changeCursor,
    sourceCounts,
    ...(mindProfileSnapshot ? { mindProfileSnapshot } : {}),
    ...(sessionDigest ? { sessionDigest } : {}),
    ...(sessionMemory ? { sessionMemory } : {}),
    ...(focusTask ? { focusTask } : {}),
    recentTasks,
    recentWorkItems,
    recentDurableMemories,
    recentExperienceUsages,
    ...(learningReviewInput ? { learningReviewInput } : {}),
  };
  return {
    ...snapshotBase,
    ruleSkeleton: buildDreamRuleSkeleton(snapshotBase),
  };
}
