import type { MemorySearchResult } from "./types.js";
import type {
  ResumeContextSnapshot,
  TaskRecord,
  TaskSource,
  TaskStatus,
  TaskWorkRecapSnapshot,
} from "./task-types.js";

type TaskDerivedSearchItem = {
  taskId: string;
  conversationId: string;
  title?: string;
  objective?: string;
  summary?: string;
  status: TaskStatus;
  source: TaskSource;
  startedAt: string;
  finishedAt?: string;
  updatedAt: string;
  agentId?: string;
  workRecap?: TaskWorkRecapSnapshot;
  resumeContext?: ResumeContextSnapshot;
  recentActivityTitles: string[];
  matchReasons?: string[];
};

type DerivedTaskSurface = {
  kind: "task_resume_context" | "task_work_recap";
  sourcePath: string;
  sourceKind: string;
  summary: string;
  snippet: string;
  content: string;
  updatedAt?: string;
};

export function buildTaskDerivedSearchResults(input: {
  items: TaskDerivedSearchItem[];
  limit?: number;
  includeContent?: boolean;
}): MemorySearchResult[] {
  const limit = Math.max(1, Math.floor(input.limit ?? 3));
  const includeContent = input.includeContent !== false;
  const results: MemorySearchResult[] = [];

  for (const [index, item] of input.items.entries()) {
    const surface = buildPreferredTaskSurface(item);
    if (!surface) continue;
    results.push({
      id: `derived-task:${item.taskId}:${surface.kind}`,
      sourcePath: surface.sourcePath,
      sourceType: "task_derived",
      memoryType: "other",
      ...(includeContent ? { content: surface.content } : {}),
      snippet: surface.snippet,
      summary: surface.summary,
      score: computeDerivedTaskScore(item, surface.kind, index),
      updatedAt: surface.updatedAt ?? item.updatedAt,
      metadata: {
        derivedRetrieval: {
          taskId: item.taskId,
          conversationId: item.conversationId,
          kind: surface.kind,
          status: item.status,
          source: item.source,
          matchReasons: item.matchReasons ?? [],
        },
        memoryTree: {
          sourceClass: "derived",
          sourceKind: surface.sourceKind,
        },
      },
    });
    if (results.length >= limit) break;
  }

  return results;
}

function buildPreferredTaskSurface(item: TaskDerivedSearchItem): DerivedTaskSurface | null {
  const title = compactText(item.title || item.objective || item.summary || item.taskId, 140) || item.taskId;
  const recapHeadline = compactText(item.workRecap?.headline, 180);
  const stopPoint = compactText(item.resumeContext?.currentStopPoint, 220);
  const nextStep = compactText(item.resumeContext?.nextStep, 220);
  const blockers = compactList(item.resumeContext?.blockers ?? item.workRecap?.blockers ?? [], 3, 120);
  const confirmedFacts = compactList(item.workRecap?.confirmedFacts ?? [], 3, 140);
  const pendingActions = compactList(item.workRecap?.pendingActions ?? [], 3, 140);
  const recentActivities = compactList(item.recentActivityTitles ?? [], 3, 120);

  if (stopPoint || nextStep) {
    const summary = compactText(
      `继续任务 ${title}：${stopPoint || nextStep || recapHeadline || item.summary || "已生成续做上下文"}`,
      220,
    ) ?? `继续任务 ${title}`;
    const snippet = stopPoint || nextStep || recapHeadline || summary;
    const lines = [
      `Task: ${title}`,
      `Status: ${item.status}`,
      stopPoint ? `Stop Point: ${stopPoint}` : undefined,
      nextStep ? `Next Step: ${nextStep}` : undefined,
      recapHeadline ? `Work Recap: ${recapHeadline}` : undefined,
      blockers.length > 0 ? `Blockers: ${blockers.join(" | ")}` : undefined,
      recentActivities.length > 0 ? `Recent Activity: ${recentActivities.join(" | ")}` : undefined,
    ].filter((line): line is string => Boolean(line));
    return {
      kind: "task_resume_context",
      sourcePath: `task://${item.taskId}/resume-context`,
      sourceKind: "task_resume_context",
      summary,
      snippet: truncateText(snippet, 180) ?? summary,
      content: lines.join("\n"),
      updatedAt: item.resumeContext?.updatedAt ?? item.updatedAt,
    };
  }

  if (recapHeadline || confirmedFacts.length > 0 || pendingActions.length > 0) {
    const summary = compactText(
      `任务复盘 ${title}：${recapHeadline || confirmedFacts[0] || item.summary || "已生成任务复盘"}`,
      220,
    ) ?? `任务复盘 ${title}`;
    const snippet = recapHeadline || confirmedFacts[0] || summary;
    const lines = [
      `Task: ${title}`,
      `Status: ${item.status}`,
      recapHeadline ? `Work Recap: ${recapHeadline}` : undefined,
      confirmedFacts.length > 0 ? `Confirmed Facts: ${confirmedFacts.join(" | ")}` : undefined,
      pendingActions.length > 0 ? `Pending Actions: ${pendingActions.join(" | ")}` : undefined,
      blockers.length > 0 ? `Blockers: ${blockers.join(" | ")}` : undefined,
      recentActivities.length > 0 ? `Recent Activity: ${recentActivities.join(" | ")}` : undefined,
    ].filter((line): line is string => Boolean(line));
    return {
      kind: "task_work_recap",
      sourcePath: `task://${item.taskId}/work-recap`,
      sourceKind: "task_work_recap",
      summary,
      snippet: truncateText(snippet, 180) ?? summary,
      content: lines.join("\n"),
      updatedAt: item.workRecap?.updatedAt ?? item.updatedAt,
    };
  }

  return null;
}

function computeDerivedTaskScore(
  item: TaskDerivedSearchItem,
  kind: DerivedTaskSurface["kind"],
  index: number,
): number {
  let score = kind === "task_resume_context" ? 0.84 : 0.76;
  if (item.status === "partial") score += 0.06;
  if (item.status === "success") score += 0.02;
  score += Math.min((item.matchReasons?.length ?? 0) * 0.02, 0.06);
  score -= index * 0.05;
  return clampScore(score);
}

function compactList(values: string[], limit: number, maxLength: number): string[] {
  return values
    .map((item) => compactText(item, maxLength))
    .filter((item): item is string => Boolean(item))
    .slice(0, limit);
}

function compactText(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return truncateText(normalized, maxLength);
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength
    ? `${value.slice(0, Math.max(0, maxLength - 3))}...`
    : value;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  if (value < 0.05) return 0.05;
  if (value > 0.99) return 0.99;
  return value;
}
