import path from "node:path";

import type { TaskExperienceDetail } from "./experience-types.js";
import type { MemorySearchResult, MemoryVisibility } from "./types.js";
import { normalizeStableTopicAliasKey, resolveStableTopicAlias } from "./memory-tree-topic-aliases.js";

export type StableTopicSeed = {
  topic: string;
  agentId?: string;
  scope: "private" | "shared";
  chunks: MemorySearchResult[];
  timeFrom?: string;
  timeTo?: string;
  memoryTypes?: string[];
};

export type StableTopicGroup = {
  key: string;
  label: string;
  scope: "private" | "shared";
  agentId?: string;
  chunks: MemorySearchResult[];
  timeFrom?: string;
  timeTo?: string;
  memoryTypes: string[];
  metadata: {
    originKinds: string[];
    reasons: string[];
    taskIds: string[];
    goalIds: string[];
    sourcePaths: string[];
    aliasKeys: string[];
    mergedSourceKeys: string[];
  };
};

type BuildStableTopicGroupsInput = {
  limit: number;
  explicitTopics: StableTopicSeed[];
  tasks: TaskExperienceDetail[];
  resolveChunk: (chunkId: string) => MemorySearchResult | null;
  rankChunks: (chunks: MemorySearchResult[]) => MemorySearchResult[];
};

type MutableStableTopicGroup = {
  key: string;
  label: string;
  scope: "private" | "shared";
  agentId?: string;
  chunks: Map<string, MemorySearchResult>;
  timeFrom?: string;
  timeTo?: string;
  memoryTypes: Set<string>;
  originKinds: Set<string>;
  reasons: Set<string>;
  taskIds: Set<string>;
  goalIds: Set<string>;
  sourcePaths: Set<string>;
  aliasKeys: Set<string>;
  mergedSourceKeys: Set<string>;
};

const GENERIC_FILE_SUFFIXES = new Set([
  "outline",
  "summary",
  "summaries",
  "notes",
  "note",
  "recap",
  "final",
  "draft",
  "checklist",
  "plan",
  "review",
  "memory",
  "digest",
  "session",
  "transcript",
  "report",
  "result",
  "results",
]);

const TASK_TITLE_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "that",
  "this",
  "check",
  "review",
  "finish",
  "ship",
  "整理",
  "检查",
  "完成",
  "继续",
  "实现",
]);

export function buildStableTopicGroups(input: BuildStableTopicGroupsInput): StableTopicGroup[] {
  const groups = new Map<string, MutableStableTopicGroup>();

  for (const seed of input.explicitTopics) {
    const topicAlias = resolveStableTopicAlias(seed.topic);
    if (!topicAlias) {
      continue;
    }
    for (const chunk of seed.chunks) {
      addChunkToGroup(groups, {
        key: topicAlias.canonicalKey,
        label: seed.topic.trim() || topicAlias.canonicalKey,
        scope: seed.scope,
        agentId: seed.agentId,
        chunk,
        reason: "explicit_topic",
        originKind: "explicit_topic",
        aliasKey: topicAlias.normalizedKey,
        mergedSourceKey: topicAlias.normalizedKey,
      });
    }
    updateGroupTime(
      groups,
      buildGroupIdentity(topicAlias.canonicalKey, seed.scope, seed.agentId),
      seed.timeFrom,
      seed.timeTo,
    );
  }

  for (const task of input.tasks) {
    const goalId = readTaskGoalId(task);
    const titleKey = deriveTaskTitleKey(task);
    for (const link of task.memoryLinks ?? []) {
      const chunk = input.resolveChunk(link.chunkId);
      if (!chunk) {
        continue;
      }
      const descriptor = deriveStableTopicDescriptor({
        chunk,
        goalId,
        taskTitleKey: titleKey,
      });
      if (!descriptor) {
        continue;
      }
      addChunkToGroup(groups, {
        key: descriptor.key,
        label: descriptor.label,
        scope: toTopicScope(chunk.visibility),
        agentId: task.agentId?.trim() || undefined,
        chunk,
        reason: descriptor.reason,
        originKind: descriptor.originKind,
        taskId: task.id,
        goalId,
        aliasKey: descriptor.normalizedKey,
        mergedSourceKey: descriptor.normalizedKey,
      });
      updateGroupTime(
        groups,
        buildGroupIdentity(descriptor.key, toTopicScope(chunk.visibility), task.agentId?.trim() || undefined),
        task.startedAt,
        task.finishedAt ?? task.updatedAt ?? task.startedAt,
      );
    }
  }

  const normalizedGroups = [...groups.values()]
    .map((group) => ({
      key: group.key,
      label: group.label,
      scope: group.scope,
      agentId: group.agentId,
      chunks: input.rankChunks([...group.chunks.values()]),
      timeFrom: group.timeFrom,
      timeTo: group.timeTo,
      memoryTypes: [...group.memoryTypes],
      metadata: {
        originKinds: [...group.originKinds],
        reasons: [...group.reasons],
        taskIds: [...group.taskIds],
        goalIds: [...group.goalIds],
        sourcePaths: [...group.sourcePaths],
        aliasKeys: [...group.aliasKeys],
        mergedSourceKeys: [...group.mergedSourceKeys],
      },
    }))
    .filter((group) => group.chunks.length > 0)
    .sort((a, b) => {
      const timestampDiff = resolveTopicGroupTimestamp(b) - resolveTopicGroupTimestamp(a);
      if (timestampDiff !== 0) {
        return timestampDiff;
      }
      if (b.chunks.length !== a.chunks.length) {
        return b.chunks.length - a.chunks.length;
      }
      return a.key.localeCompare(b.key);
    });

  return normalizedGroups.slice(0, Math.max(1, input.limit));
}

function deriveStableTopicDescriptor(input: {
  chunk: MemorySearchResult;
  goalId?: string;
  taskTitleKey?: string;
}): {
  key: string;
  label: string;
  normalizedKey: string;
  reason: string;
  originKind: string;
} | null {
  const explicitTopic = resolveStableTopicAlias(input.chunk.topic);
  if (explicitTopic) {
    return {
      key: explicitTopic.canonicalKey,
      label: input.chunk.topic?.trim() || explicitTopic.canonicalKey,
      normalizedKey: explicitTopic.normalizedKey,
      reason: "explicit_topic",
      originKind: "explicit_topic",
    };
  }

  const goalKey = resolveStableTopicAlias(input.goalId);
  if (goalKey) {
    return {
      key: goalKey.canonicalKey,
      label: input.goalId?.trim() || goalKey.canonicalKey,
      normalizedKey: goalKey.normalizedKey,
      reason: "task_goal",
      originKind: "task_goal",
    };
  }

  const sourceStem = deriveStableSourceStem(input.chunk.sourcePath);
  if (sourceStem) {
    return {
      key: sourceStem,
      label: sourceStem,
      normalizedKey: sourceStem,
      reason: "source_stem",
      originKind: "source_path",
    };
  }

  if (input.taskTitleKey) {
    return {
      key: input.taskTitleKey,
      label: input.taskTitleKey,
      normalizedKey: input.taskTitleKey,
      reason: "task_title",
      originKind: "task_title",
    };
  }

  return null;
}

function deriveStableSourceStem(sourcePath: string): string | undefined {
  const normalizedPath = String(sourcePath ?? "").trim();
  if (!normalizedPath) {
    return undefined;
  }

  const filename = path.basename(normalizedPath);
  const stem = normalizeStableTopicKey(stripGenericSuffixes(stripFileExtension(filename)));
  if (stem) {
    return stem;
  }

  const parent = path.basename(path.dirname(normalizedPath));
  return normalizeStableTopicKey(stripGenericSuffixes(stripFileExtension(parent)));
}

function deriveTaskTitleKey(task: TaskExperienceDetail): string | undefined {
  const raw = [
    task.title,
    task.summary,
    task.objective,
  ].find((item) => typeof item === "string" && item.trim().length > 0);
  if (!raw) {
    return undefined;
  }
  const tokens = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !TASK_TITLE_STOPWORDS.has(item))
    .slice(0, 4);
  return normalizeStableTopicKey(tokens.join("-"));
}

function normalizeStableTopicKey(value: unknown): string | undefined {
  return normalizeStableTopicAliasKey(value);
}

function stripFileExtension(value: string): string {
  return value.replace(/\.[^.]+$/g, "");
}

function stripGenericSuffixes(value: string): string {
  let normalized = value
    .replace(/\.session-memory$/i, "")
    .replace(/\.digest$/i, "")
    .replace(/\.transcript$/i, "")
    .replace(/\.meta$/i, "");
  let parts = normalized.split(/[-_.]+/).filter(Boolean);
  while (parts.length > 1 && GENERIC_FILE_SUFFIXES.has(parts[parts.length - 1]!.toLowerCase())) {
    parts = parts.slice(0, -1);
  }
  normalized = parts.join("-");
  return normalized;
}

function addChunkToGroup(
  groups: Map<string, MutableStableTopicGroup>,
  input: {
    key: string;
    label: string;
    scope: "private" | "shared";
    agentId?: string;
    chunk: MemorySearchResult;
    reason: string;
    originKind: string;
    taskId?: string;
    goalId?: string;
    aliasKey?: string;
    mergedSourceKey?: string;
  },
): void {
  const identity = buildGroupIdentity(input.key, input.scope, input.agentId);
  let group = groups.get(identity);
  if (!group) {
    group = {
      key: input.key,
      label: input.label,
      scope: input.scope,
      agentId: input.agentId,
      chunks: new Map<string, MemorySearchResult>(),
      memoryTypes: new Set<string>(),
      originKinds: new Set<string>(),
      reasons: new Set<string>(),
      taskIds: new Set<string>(),
      goalIds: new Set<string>(),
      sourcePaths: new Set<string>(),
      aliasKeys: new Set<string>(),
      mergedSourceKeys: new Set<string>(),
    };
    groups.set(identity, group);
  }

  group.label = preferLongerLabel(group.label, input.label);
  group.chunks.set(input.chunk.id, input.chunk);
  group.aliasKeys.add(input.key);
  if (input.chunk.memoryType) {
    group.memoryTypes.add(input.chunk.memoryType);
  }
  group.originKinds.add(input.originKind);
  group.reasons.add(input.reason);
  if (input.taskId) {
    group.taskIds.add(input.taskId);
  }
  if (input.goalId) {
    group.goalIds.add(input.goalId);
  }
  group.sourcePaths.add(input.chunk.sourcePath);
  if (input.aliasKey) {
    group.aliasKeys.add(input.aliasKey);
  }
  if (input.mergedSourceKey) {
    group.mergedSourceKeys.add(input.mergedSourceKey);
  }
  updateGroupTime(groups, identity, input.chunk.updatedAt, input.chunk.updatedAt);
}

function updateGroupTime(
  groups: Map<string, MutableStableTopicGroup>,
  identity: string,
  timeFrom?: string,
  timeTo?: string,
): void {
  const group = groups.get(identity);
  if (!group) {
    return;
  }
  if (timeFrom && isEarlierTimestamp(timeFrom, group.timeFrom)) {
    group.timeFrom = timeFrom;
  }
  if (timeTo && isLaterTimestamp(timeTo, group.timeTo)) {
    group.timeTo = timeTo;
  }
}

function readTaskGoalId(task: TaskExperienceDetail): string | undefined {
  const raw = task.metadata && typeof task.metadata === "object" && !Array.isArray(task.metadata)
    ? (task.metadata as Record<string, unknown>).goalId
    : undefined;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function buildGroupIdentity(key: string, scope: "private" | "shared", agentId?: string): string {
  return `${scope}:${agentId ?? "-"}:${key}`;
}

function resolveTopicGroupTimestamp(group: StableTopicGroup): number {
  const timestamp = Date.parse(group.timeTo ?? group.timeFrom ?? "");
  if (Number.isFinite(timestamp)) {
    return timestamp;
  }
  return group.chunks.reduce((latest, chunk) => {
    const chunkTimestamp = Date.parse(String(chunk.updatedAt ?? ""));
    return Number.isFinite(chunkTimestamp) ? Math.max(latest, chunkTimestamp) : latest;
  }, Number.NEGATIVE_INFINITY);
}

function preferLongerLabel(current: string, next: string): string {
  return next.length > current.length ? next : current;
}

function toTopicScope(visibility?: MemoryVisibility): "private" | "shared" {
  return visibility === "shared" ? "shared" : "private";
}

function isEarlierTimestamp(next: string, current?: string): boolean {
  if (!current) {
    return true;
  }
  const nextValue = Date.parse(next);
  const currentValue = Date.parse(current);
  if (!Number.isFinite(nextValue)) {
    return false;
  }
  if (!Number.isFinite(currentValue)) {
    return true;
  }
  return nextValue < currentValue;
}

function isLaterTimestamp(next: string, current?: string): boolean {
  if (!current) {
    return true;
  }
  const nextValue = Date.parse(next);
  const currentValue = Date.parse(current);
  if (!Number.isFinite(nextValue)) {
    return false;
  }
  if (!Number.isFinite(currentValue)) {
    return true;
  }
  return nextValue > currentValue;
}
