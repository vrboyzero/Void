import type { TaskRecord } from "./task-types.js";

export type AutomaticExperiencePromotionTaskGate = {
  allowed: boolean;
  reason?: string;
};

function hasEmailConversationPrefix(value: string | undefined): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized.startsWith("channel=email:");
}

export function isEmailConversationTask(task: Pick<TaskRecord, "conversationId" | "sessionKey">): boolean {
  return hasEmailConversationPrefix(task.sessionKey) || hasEmailConversationPrefix(task.conversationId);
}

export function hasEmailToolCalls(task: Pick<TaskRecord, "toolCalls">): boolean {
  return (task.toolCalls ?? []).some((item) => {
    const toolName = String(item?.toolName ?? "").trim().toLowerCase();
    return toolName === "send_email" || toolName.startsWith("email_");
  });
}

export function resolveAutomaticExperiencePromotionTaskGate(
  task: Pick<TaskRecord, "status" | "source" | "summary" | "reflection" | "objective" | "toolCalls" | "artifactPaths" | "conversationId" | "sessionKey">,
): AutomaticExperiencePromotionTaskGate {
  if (task.status !== "success" && task.status !== "partial") {
    return { allowed: false, reason: "task is not completed successfully" };
  }

  if (isEmailConversationTask(task)) {
    return { allowed: false, reason: "email thread tasks are excluded from automatic experience promotion" };
  }

  if (hasEmailToolCalls(task)) {
    return { allowed: false, reason: "email send/receive tasks are excluded from automatic experience promotion" };
  }

  const hasTools = (task.toolCalls?.length ?? 0) > 0;
  const hasArtifacts = (task.artifactPaths?.length ?? 0) > 0;
  if (task.source === "chat") {
    return hasTools || hasArtifacts
      ? { allowed: true }
      : { allowed: false, reason: "chat task has no execution evidence" };
  }

  const hasSummary = Boolean(task.summary?.trim());
  const hasReflection = Boolean(task.reflection?.trim());
  const hasObjective = Boolean(task.objective?.trim());
  return hasSummary || hasReflection || hasTools || hasArtifacts || hasObjective
    ? { allowed: true }
    : { allowed: false, reason: "task signal is below automatic promotion threshold" };
}

export function shouldAutoPromoteTaskByPolicy(
  task: Pick<TaskRecord, "status" | "source" | "summary" | "reflection" | "objective" | "toolCalls" | "artifactPaths" | "conversationId" | "sessionKey">,
): boolean {
  return resolveAutomaticExperiencePromotionTaskGate(task).allowed;
}
