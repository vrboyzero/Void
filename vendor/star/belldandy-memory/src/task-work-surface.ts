import type { TaskExperienceDetail } from "./experience-types.js";
import type { TaskActivityRecord, TaskRecord, TaskSearchFilter, TaskSource, TaskStatus } from "./task-types.js";
import type { TaskWorkShortcutItem } from "./manager.js";

export type TaskWorkSourceReferenceKind =
  | "task_summary"
  | "work_recap"
  | "resume_context"
  | "activity_worklog";

export interface TaskWorkSourceReference {
  kind: TaskWorkSourceReferenceKind;
  label: string;
  previews: string[];
  activityIds?: string[];
}

export interface TaskWorkSourceExplanation {
  taskId: string;
  conversationId: string;
  title?: string;
  status: TaskStatus;
  source: TaskSource;
  updatedAt: string;
  recentActivityTitles: string[];
  toolNames: string[];
  artifactPaths: string[];
  sourceRefs: TaskWorkSourceReference[];
}

export interface TaskWorkSurfaceDelegate {
  getRecentWork?(input: {
    query?: string;
    limit?: number;
    filter?: TaskSearchFilter;
  }): TaskWorkShortcutItem[];
  getResumeContext?(input: {
    taskId?: string;
    conversationId?: string;
    query?: string;
    filter?: TaskSearchFilter;
  }): TaskWorkShortcutItem | null;
  findSimilarPastWork?(input: {
    query: string;
    limit?: number;
    filter?: TaskSearchFilter;
  }): TaskWorkShortcutItem[];
  getTaskDetail?(taskId: string): TaskExperienceDetail | null;
  getTaskByConversation?(conversationId: string): TaskRecord | null;
}

export interface TaskWorkSurface {
  recentWork(input?: {
    query?: string;
    limit?: number;
    filter?: TaskSearchFilter;
  }): TaskWorkShortcutItem[];
  resumeContext(input?: {
    taskId?: string;
    conversationId?: string;
    query?: string;
    filter?: TaskSearchFilter;
  }): TaskWorkShortcutItem | null;
  findSimilarWork(input: {
    query: string;
    limit?: number;
    filter?: TaskSearchFilter;
  }): TaskWorkShortcutItem[];
  explainSources(input: {
    taskId?: string;
    conversationId?: string;
    item?: TaskWorkShortcutItem | null;
  }): TaskWorkSourceExplanation | null;
}

export function createTaskWorkSurface(delegate: TaskWorkSurfaceDelegate): TaskWorkSurface {
  return {
    recentWork(input = {}) {
      return delegate.getRecentWork?.(input) ?? [];
    },

    resumeContext(input = {}) {
      return delegate.getResumeContext?.(input) ?? null;
    },

    findSimilarWork(input) {
      return delegate.findSimilarPastWork?.(input) ?? [];
    },

    explainSources(input) {
      const detail = resolveTaskWorkDetail(delegate, input);
      const item = input.item ?? (detail ? toTaskWorkShortcutItem(detail) : null);
      if (!item) return null;
      return buildTaskWorkSourceExplanation(item, detail);
    },
  };
}

function resolveTaskWorkDetail(
  delegate: TaskWorkSurfaceDelegate,
  input: {
    taskId?: string;
    conversationId?: string;
    item?: TaskWorkShortcutItem | null;
  },
): TaskExperienceDetail | null {
  if (typeof delegate.getTaskDetail !== "function") {
    return null;
  }

  const directTaskId = normalizeLookupValue(input.taskId ?? input.item?.taskId);
  if (directTaskId) {
    return delegate.getTaskDetail(directTaskId);
  }

  const conversationId = normalizeLookupValue(input.conversationId ?? input.item?.conversationId);
  if (!conversationId || typeof delegate.getTaskByConversation !== "function") {
    return null;
  }
  const task = delegate.getTaskByConversation(conversationId);
  return task ? delegate.getTaskDetail(task.id) : null;
}

function buildTaskWorkSourceExplanation(
  item: TaskWorkShortcutItem,
  detail: TaskExperienceDetail | null,
): TaskWorkSourceExplanation {
  const recentActivityTitles = item.recentActivityTitles.length
    ? item.recentActivityTitles
    : collectRecentActivityTitles(detail?.activities);
  const activityIds = collectRecentActivityIds(detail?.activities);
  const sourceRefs: TaskWorkSourceReference[] = [];
  const summaryPreview = normalizePreview(item.summary ?? detail?.summary);
  if (summaryPreview) {
    sourceRefs.push({
      kind: "task_summary",
      label: "task.summary",
      previews: [summaryPreview],
    });
  }

  const workRecapPreviews = collectPreviewList([
    item.workRecap?.headline,
    ...(item.workRecap?.confirmedFacts ?? []),
    ...(item.workRecap?.blockers ?? []),
  ], 3);
  if (workRecapPreviews.length > 0) {
    sourceRefs.push({
      kind: "work_recap",
      label: "workRecap",
      previews: workRecapPreviews,
      activityIds: item.workRecap?.derivedFromActivityIds?.length
        ? [...item.workRecap.derivedFromActivityIds]
        : undefined,
    });
  }

  const resumeContextPreviews = collectPreviewList([
    item.resumeContext?.currentStopPoint,
    item.resumeContext?.nextStep,
    ...(item.resumeContext?.blockers ?? []),
  ], 3);
  if (resumeContextPreviews.length > 0) {
    sourceRefs.push({
      kind: "resume_context",
      label: "resumeContext",
      previews: resumeContextPreviews,
      activityIds: item.resumeContext?.derivedFromActivityIds?.length
        ? [...item.resumeContext.derivedFromActivityIds]
        : undefined,
    });
  }

  if (recentActivityTitles.length > 0) {
    sourceRefs.push({
      kind: "activity_worklog",
      label: "Activity / Worklog",
      previews: recentActivityTitles,
      activityIds: activityIds.length > 0 ? activityIds : undefined,
    });
  }

  return {
    taskId: item.taskId,
    conversationId: item.conversationId,
    title: item.title,
    status: item.status,
    source: item.source,
    updatedAt: item.updatedAt,
    recentActivityTitles,
    toolNames: item.toolNames,
    artifactPaths: item.artifactPaths,
    sourceRefs,
  };
}

function toTaskWorkShortcutItem(task: TaskExperienceDetail): TaskWorkShortcutItem {
  return {
    taskId: task.id,
    conversationId: task.conversationId,
    title: task.title,
    objective: task.objective,
    summary: task.summary,
    status: task.status,
    source: task.source,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    updatedAt: task.updatedAt,
    agentId: task.agentId,
    toolNames: (task.toolCalls ?? []).map((item) => item.toolName),
    artifactPaths: task.artifactPaths ?? [],
    workRecap: task.workRecap,
    resumeContext: task.resumeContext,
    recentActivityTitles: collectRecentActivityTitles(task.activities),
  };
}

function collectRecentActivityTitles(activities?: TaskActivityRecord[] | null, limit = 3): string[] {
  if (!Array.isArray(activities) || activities.length === 0) {
    return [];
  }
  const titles: string[] = [];
  for (const activity of [...activities].reverse()) {
    if (activity.kind === "task_completed") continue;
    const preview = normalizePreview(activity.title || activity.summary);
    if (!preview) continue;
    titles.push(preview);
    if (titles.length >= limit) break;
  }
  return titles;
}

function collectRecentActivityIds(activities?: TaskActivityRecord[] | null, limit = 3): string[] {
  if (!Array.isArray(activities) || activities.length === 0) {
    return [];
  }
  const ids: string[] = [];
  for (const activity of [...activities].reverse()) {
    if (activity.kind === "task_completed") continue;
    if (!activity.id) continue;
    ids.push(activity.id);
    if (ids.length >= limit) break;
  }
  return ids;
}

function collectPreviewList(values: Array<string | undefined>, limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const preview = normalizePreview(value);
    if (!preview || seen.has(preview)) continue;
    seen.add(preview);
    result.push(preview);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizePreview(value?: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.length > 160 ? `${trimmed.slice(0, 160)}...` : trimmed;
}

function normalizeLookupValue(value?: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
