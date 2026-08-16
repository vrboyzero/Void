import { buildDreamRuleSkeleton } from "./dream-input.js";
import type {
  DreamInputSnapshot,
  DreamModelOutput,
  DreamPromptBundle,
  DreamShareCandidate,
  DreamShareCandidateVisibility,
} from "./dream-types.js";

function truncateText(value: unknown, maxLength = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 3))}...` : normalized;
}

function stripMarkdownFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function stripReasoningArtifacts(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .trim();
}

function extractFirstJsonObject(value: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (start < 0) {
      if (char === "{") {
        start = index;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, index + 1);
      }
    }
  }

  return null;
}

function normalizeDreamJsonCandidate(raw: string): string {
  const direct = stripMarkdownFence(stripReasoningArtifacts(raw));
  if (direct.startsWith("{") && direct.endsWith("}")) {
    return direct;
  }

  const fencedMatches = Array.from(raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi));
  for (const match of fencedMatches) {
    const candidate = stripReasoningArtifacts(match[1] ?? "");
    const extracted = extractFirstJsonObject(candidate);
    if (extracted) {
      return extracted;
    }
  }

  const extracted = extractFirstJsonObject(direct);
  if (extracted) {
    return extracted;
  }

  throw new Error(`Dream model did not return a valid JSON object. Preview: ${truncateText(raw, 160) ?? "(empty)"}`);
}

function normalizeStringArray(value: unknown, maxItems: number, maxLength = 200): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => truncateText(item, maxLength))
    .filter((item): item is string => Boolean(item))
    .slice(0, maxItems);
}

function normalizeVisibility(value: unknown): DreamShareCandidateVisibility | undefined {
  switch (value) {
    case "private":
    case "shared_candidate":
    case "unclear":
      return value;
    default:
      return undefined;
  }
}

function normalizeShareCandidates(value: unknown): DreamShareCandidate[] {
  if (!Array.isArray(value)) return [];
  const result: DreamShareCandidate[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const candidate = item as Record<string, unknown>;
    const title = truncateText(candidate.title, 120);
    if (!title) continue;
    result.push({
      title,
      ...(truncateText(candidate.reason, 240) ? { reason: truncateText(candidate.reason, 240) } : {}),
      ...(truncateText(candidate.evidence, 240) ? { evidence: truncateText(candidate.evidence, 240) } : {}),
      ...(normalizeVisibility(candidate.suggestedVisibility)
        ? { suggestedVisibility: normalizeVisibility(candidate.suggestedVisibility) }
        : {}),
    });
    if (result.length >= 6) break;
  }
  return result;
}

function compactPromptInput(snapshot: DreamInputSnapshot): Record<string, unknown> {
  const ruleSkeleton = snapshot.ruleSkeleton ?? buildDreamRuleSkeleton(snapshot);
  return {
    meta: {
      agentId: snapshot.agentId,
      conversationId: snapshot.conversationId,
      collectedAt: snapshot.collectedAt,
      windowStartedAt: snapshot.windowStartedAt,
      windowHours: snapshot.windowHours,
      sourceCounts: snapshot.sourceCounts,
    },
    ruleSkeleton: {
      topicCandidates: normalizeStringArray(ruleSkeleton.topicCandidates, 3, 160),
      confirmedFacts: normalizeStringArray(ruleSkeleton.confirmedFacts, 8, 200),
      openLoops: normalizeStringArray(ruleSkeleton.openLoops, 6, 180),
      carryForwardCandidates: normalizeStringArray(ruleSkeleton.carryForwardCandidates, 6, 180),
      sourceSummary: {
        primarySources: normalizeStringArray(ruleSkeleton.sourceSummary.primarySources, 8, 60),
        sourceCount: ruleSkeleton.sourceSummary.sourceCount,
        taskCount: ruleSkeleton.sourceSummary.taskCount,
        workCount: ruleSkeleton.sourceSummary.workCount,
        durableMemoryCount: ruleSkeleton.sourceSummary.durableMemoryCount,
        experienceUsageCount: ruleSkeleton.sourceSummary.experienceUsageCount,
        summaryLine: truncateText(ruleSkeleton.sourceSummary.summaryLine, 240),
      },
      confidence: ruleSkeleton.confidence,
    },
    anchors: {
      focusTaskTitle: truncateText(snapshot.focusTask?.title, 120),
      focusTaskStatus: snapshot.focusTask?.status,
      digestStatus: snapshot.sessionDigest?.status,
      pendingMessageCount: snapshot.sessionDigest?.pendingMessageCount,
      currentWork: truncateText(snapshot.sessionMemory?.currentWork, 160),
      nextStep: truncateText(snapshot.sessionMemory?.nextStep, 160),
    },
  };
}

export function buildDreamPromptBundle(snapshot: DreamInputSnapshot): DreamPromptBundle {
  const inputView = compactPromptInput(snapshot);
  return {
    system: [
      "你是 Star Sanctuary 的 dream 整理器。",
      "你的任务是基于已经抽取好的规则骨架，产出一份面向该 Agent 私有记忆空间的 dream 结构化结果。",
      "规则骨架已经给出了 topicCandidates、confirmedFacts、openLoops、carryForwardCandidates、sourceSummary 和 confidence。",
      "请严格以规则骨架为事实边界：你可以重组、压缩、润色，但不要创造新事实，不要自行扩展输入范围，不要重新决定 source priority。",
      "输出必须是 JSON 对象，不要输出 Markdown，不要输出解释。",
      "字段必须包含：headline, summary, narrative, stableInsights, corrections, openQuestions, shareCandidates, nextFocus。",
      "stableInsights / corrections / openQuestions / nextFocus 必须是字符串数组。",
      "shareCandidates 必须是对象数组，字段为 title, reason, evidence, suggestedVisibility。",
      "suggestedVisibility 只能是 private / shared_candidate / unclear。",
      "如果某个字段没有内容，返回空字符串或空数组，不要省略字段。",
    ].join(" "),
    user: [
      `agentId: ${snapshot.agentId}`,
      `conversationId: ${snapshot.conversationId ?? "unknown"}`,
      `collectedAt: ${snapshot.collectedAt}`,
      `windowHours: ${snapshot.windowHours}`,
      "",
      "请根据以下 dream 规则骨架与锚点信息，输出一份面向该 Agent 私有 dream 的结构化 JSON：",
      "",
      JSON.stringify(inputView, null, 2),
    ].join("\n"),
    inputView,
  };
}

export function parseDreamModelOutput(raw: string): DreamModelOutput {
  const sanitized = normalizeDreamJsonCandidate(raw);
  const parsed = JSON.parse(sanitized) as Record<string, unknown>;
  return {
    headline: truncateText(parsed.headline, 140),
    summary: truncateText(parsed.summary, 260),
    narrative: truncateText(parsed.narrative, 800),
    stableInsights: normalizeStringArray(parsed.stableInsights, 8),
    corrections: normalizeStringArray(parsed.corrections, 6),
    openQuestions: normalizeStringArray(parsed.openQuestions, 6),
    shareCandidates: normalizeShareCandidates(parsed.shareCandidates),
    nextFocus: normalizeStringArray(parsed.nextFocus, 6),
  };
}

export function summarizeDreamModelOutput(output: DreamModelOutput): string | undefined {
  return truncateText(output.headline || output.summary, 160);
}
