import type {
  ResumeContextSnapshot,
  TaskActivityRecord,
  TaskRecord,
  TaskWorkRecapSnapshot,
} from "./task-types.js";

export function buildTaskRecapArtifacts(input: {
  task: Pick<TaskRecord, "id" | "conversationId" | "sessionKey" | "agentId" | "status" | "objective" | "summary" | "source">;
  activities: TaskActivityRecord[];
  updatedAt?: string;
}): {
  workRecap: TaskWorkRecapSnapshot;
  resumeContext: ResumeContextSnapshot;
} {
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const factActivities = buildFactActivities(input.activities);
  const confirmedFacts = factActivities.map((item) => item.text);
  const blockers = buildBlockers(input.activities);
  const lastMeaningfulActivity = findLastMeaningfulActivity(input.activities);
  const currentStopPoint = buildCurrentStopPoint({
    status: input.task.status,
    lastActivity: lastMeaningfulActivity,
    summary: input.task.summary,
    objective: input.task.objective,
  });
  const nextStep = buildNextStep({
    status: input.task.status,
    lastActivity: lastMeaningfulActivity,
    blockers,
  });
  const derivedFromActivityIds = uniqueStrings([
    ...factActivities.map((item) => item.id),
    ...(lastMeaningfulActivity ? [lastMeaningfulActivity.id] : []),
    ...collectBlockerActivityIds(input.activities),
  ]);

  return {
    workRecap: {
      taskId: input.task.id,
      conversationId: input.task.conversationId,
      sessionKey: input.task.sessionKey,
      agentId: input.task.agentId,
      headline: buildWorkRecapHeadline({
        status: input.task.status,
        confirmedFactCount: confirmedFacts.length,
        currentStopPoint,
      }),
      confirmedFacts,
      pendingActions: nextStep ? [nextStep] : undefined,
      blockers: blockers.length > 0 ? blockers : undefined,
      derivedFromActivityIds,
      updatedAt,
    },
    resumeContext: {
      taskId: input.task.id,
      conversationId: input.task.conversationId,
      sessionKey: input.task.sessionKey,
      agentId: input.task.agentId,
      currentStopPoint,
      nextStep,
      blockers: blockers.length > 0 ? blockers : undefined,
      openQuestions: undefined,
      derivedFromActivityIds,
      updatedAt,
    },
  };
}

function buildFactActivities(activities: TaskActivityRecord[]): Array<{ id: string; text: string }> {
  const candidates = activities.filter((item) => item.kind !== "task_completed");
  const includeStarted = candidates.length <= 1;
  const seen = new Set<string>();
  const facts: Array<{ id: string; text: string }> = [];

  for (const activity of candidates) {
    if (activity.kind === "task_started" && !includeStarted) {
      continue;
    }
    const text = sanitizeLine(activity.title || activity.summary);
    if (!text) continue;
    const key = normalizeTextKey(text);
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({ id: activity.id, text });
  }

  const sliced = facts.slice(-5);
  if (sliced.length > 0) return sliced;
  const fallback = sanitizeLine(activities.at(-1)?.title);
  return fallback && activities.at(-1) ? [{ id: activities.at(-1)!.id, text: fallback }] : [];
}

function buildBlockers(activities: TaskActivityRecord[]): string[] {
  const seen = new Set<string>();
  const blockers: string[] = [];
  for (const activity of activities) {
    if (activity.state !== "blocked" && activity.state !== "failed" && activity.kind !== "error_observed") {
      continue;
    }
    const text = sanitizeLine(
      activity.error
      || activity.metadata?.blockReason
      || activity.summary
      || activity.title,
    );
    if (!text) continue;
    const key = normalizeTextKey(text);
    if (seen.has(key)) continue;
    seen.add(key);
    blockers.push(text);
  }
  return blockers.slice(-3);
}

function collectBlockerActivityIds(activities: TaskActivityRecord[]): string[] {
  return activities
    .filter((item) => item.state === "blocked" || item.state === "failed" || item.kind === "error_observed")
    .map((item) => item.id);
}

function findLastMeaningfulActivity(activities: TaskActivityRecord[]): TaskActivityRecord | undefined {
  return [...activities].reverse().find((item) => item.kind !== "task_completed");
}

function buildCurrentStopPoint(input: {
  status: TaskRecord["status"];
  lastActivity?: TaskActivityRecord;
  summary?: string;
  objective?: string;
}): string | undefined {
  if (input.status === "success") {
    return "任务已完成。";
  }
  const summaryText = sanitizeLine(input.summary);
  if (summaryText) return summaryText;
  const activityText = sanitizeLine(
    input.lastActivity?.error
    || input.lastActivity?.summary
    || input.lastActivity?.title,
  );
  if (activityText) return activityText;
  return sanitizeLine(input.objective);
}

function buildNextStep(input: {
  status: TaskRecord["status"];
  lastActivity?: TaskActivityRecord;
  blockers: string[];
}): string | undefined {
  if (input.status === "success") {
    return undefined;
  }
  if (input.lastActivity?.state === "blocked") {
    return "先解除当前阻塞，再继续后续动作。";
  }
  if (input.lastActivity?.state === "failed" || input.blockers.length > 0) {
    return "先处理最近失败原因，再决定是否重试最近动作。";
  }
  switch (input.lastActivity?.kind) {
    case "file_changed":
    case "artifact_generated":
      return "先验证最近变更或产物，再继续后续动作。";
    case "memory_recalled":
      return "先基于最近召回的记忆继续当前任务。";
    case "tool_called":
      return "先检查最近工具结果，再继续当前任务。";
    default:
      return "从当前停点继续推进当前任务。";
  }
}

function buildWorkRecapHeadline(input: {
  status: TaskRecord["status"];
  confirmedFactCount: number;
  currentStopPoint?: string;
}): string {
  if (input.status === "success") {
    return `任务已完成；已确认 ${input.confirmedFactCount} 条执行事实。`;
  }
  if (input.currentStopPoint) {
    return `已确认 ${input.confirmedFactCount} 条执行事实；当前停在：${truncateText(input.currentStopPoint, 80)}。`;
  }
  return `已确认 ${input.confirmedFactCount} 条执行事实。`;
}

function sanitizeLine(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return truncateText(trimmed, 180);
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function normalizeTextKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
