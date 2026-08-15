import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { buildDreamRuleSkeleton } from "./dream-input.js";
import { buildDreamIndexPath } from "./dream-store.js";
import type {
  DreamInputSnapshot,
  DreamModelOutput,
  DreamRecord,
  DreamWriterResult,
} from "./dream-types.js";

function truncateText(value: unknown, maxLength = 180): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 3))}...` : normalized;
}

function toRelativePath(baseDir: string, filePath: string): string {
  return path.relative(baseDir, filePath).replace(/\\/g, "/");
}

async function atomicWriteText(targetPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, targetPath);
}

function renderStringList(values: string[]): string[] {
  if (values.length <= 0) return ["- 暂无"];
  return values.map((item) => `- ${item}`);
}

function renderShareCandidates(values: DreamModelOutput["shareCandidates"]): string[] {
  if (values.length <= 0) return ["- 暂无"];
  return values.map((item) => {
    const parts = [
      item.suggestedVisibility ? `[${item.suggestedVisibility}]` : undefined,
      item.title,
      item.reason ? `原因：${item.reason}` : undefined,
      item.evidence ? `证据：${item.evidence}` : undefined,
    ].filter(Boolean);
    return `- ${parts.join(" | ")}`;
  });
}

function buildWriterRuleSkeleton(snapshot: DreamInputSnapshot) {
  return snapshot.ruleSkeleton ?? buildDreamRuleSkeleton(snapshot);
}

function renderDreamMarkdown(input: {
  agentId: string;
  record: DreamRecord;
  draft: DreamModelOutput;
  snapshot: DreamInputSnapshot;
  stateDir: string;
  dreamPath: string;
}): string {
  const relativeDreamPath = toRelativePath(input.stateDir, input.dreamPath);
  const ruleSkeleton = buildWriterRuleSkeleton(input.snapshot);
  const metadataLines = [
    `- Agent: ${input.agentId}`,
    `- Run ID: ${input.record.id}`,
    `- Trigger: ${input.record.triggerMode}`,
    `- Requested At: ${input.record.requestedAt}`,
    `- Finished At: ${input.record.finishedAt ?? input.record.startedAt ?? input.record.requestedAt}`,
    `- Conversation: ${input.record.conversationId ?? input.snapshot.conversationId ?? "-"}`,
    `- Path: ${relativeDreamPath}`,
    `- Input Window: ${input.snapshot.windowHours}h`,
    `- Generation Mode: ${input.record.generationMode ?? input.draft.generationMode ?? "llm"}`,
    `- Fallback Reason: ${input.record.fallbackReason ?? input.draft.fallbackReason ?? "-"}`,
    `- Confidence: ${ruleSkeleton.confidence}`,
    `- Source Summary: ${ruleSkeleton.sourceSummary.summaryLine}`,
  ];
  if ((input.record.generationMode ?? input.draft.generationMode) === "fallback") {
    return [
      "# Agent Dream",
      "",
      ...metadataLines,
      "",
      "## 标题",
      "",
      input.draft.headline || "暂无",
      "",
      "## 本次主题候选",
      "",
      ...renderStringList(ruleSkeleton.topicCandidates),
      "",
      "## 已确认事实",
      "",
      ...renderStringList(ruleSkeleton.confirmedFacts),
      "",
      "## 未闭环事项",
      "",
      ...renderStringList(ruleSkeleton.openLoops),
      "",
      "## 建议继续观察",
      "",
      ...renderStringList(ruleSkeleton.carryForwardCandidates.length > 0 ? ruleSkeleton.carryForwardCandidates : input.draft.nextFocus),
      "",
    ].join("\n");
  }
  const lines = [
    "# Agent Dream",
    "",
    ...metadataLines,
    "",
    "## Headline",
    "",
    input.draft.headline || "暂无",
    "",
    "## Summary",
    "",
    input.draft.summary || "暂无",
    "",
    "## Narrative",
    "",
    input.draft.narrative || "暂无",
    "",
    "## Stable Insights",
    "",
    ...renderStringList(input.draft.stableInsights),
    "",
    "## Corrections",
    "",
    ...renderStringList(input.draft.corrections),
    "",
    "## Open Questions",
    "",
    ...renderStringList(input.draft.openQuestions),
    "",
    "## Share Candidates",
    "",
    ...renderShareCandidates(input.draft.shareCandidates),
    "",
    "## Next Focus",
    "",
    ...renderStringList(input.draft.nextFocus),
    "",
    "## Input Snapshot",
    "",
    `- Source Counts: ${JSON.stringify(input.snapshot.sourceCounts)}`,
    `- Rule Skeleton Source Summary: ${ruleSkeleton.sourceSummary.summaryLine}`,
    input.snapshot.focusTask?.id ? `- Focus Task: ${input.snapshot.focusTask.id}` : "- Focus Task: -",
    input.snapshot.sessionDigest?.rollingSummary
      ? `- Session Digest: ${truncateText(input.snapshot.sessionDigest.rollingSummary, 240)}`
      : "- Session Digest: -",
    input.snapshot.sessionMemory?.summary
      ? `- Session Memory: ${truncateText(input.snapshot.sessionMemory.summary, 240)}`
      : "- Session Memory: -",
    input.snapshot.mindProfileSnapshot?.profile?.headline
      ? `- Mind Profile: ${truncateText(input.snapshot.mindProfileSnapshot.profile.headline, 200)}`
      : "- Mind Profile: -",
    input.snapshot.learningReviewInput?.summary?.headline
      ? `- Learning Review: ${truncateText(input.snapshot.learningReviewInput.summary.headline, 200)}`
      : "- Learning Review: -",
    "",
  ];
  return lines.join("\n");
}

function renderDreamIndex(input: {
  agentId: string;
  stateDir: string;
  updatedAt: string;
  current: DreamRecord;
  previousRuns: DreamRecord[];
}): string {
  const currentAndPrevious = [
    input.current,
    ...input.previousRuns.filter((item) => item.id !== input.current.id),
  ].slice(0, 12);
  const lines = [
    "# DREAM",
    "",
    `- Agent: ${input.agentId}`,
    `- Updated At: ${input.updatedAt}`,
    "",
    "| Time | Run ID | Status | Summary | File |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const item of currentAndPrevious) {
    const relativePath = item.dreamPath ? toRelativePath(input.stateDir, item.dreamPath) : "-";
    lines.push(`| ${item.finishedAt ?? item.startedAt ?? item.requestedAt} | ${item.id} | ${item.status} | ${truncateText(item.summary, 120) ?? "-"} | ${relativePath} |`);
  }

  lines.push("");
  return lines.join("\n");
}

export async function writeDreamArtifacts(input: {
  stateDir: string;
  agentId: string;
  dreamPath: string;
  record: DreamRecord;
  draft: DreamModelOutput;
  snapshot: DreamInputSnapshot;
  previousRuns: DreamRecord[];
}): Promise<DreamWriterResult> {
  const markdown = renderDreamMarkdown({
    agentId: input.agentId,
    record: input.record,
    draft: input.draft,
    snapshot: input.snapshot,
    stateDir: input.stateDir,
    dreamPath: input.dreamPath,
  });
  const indexPath = buildDreamIndexPath(input.stateDir);
  const indexMarkdown = renderDreamIndex({
    agentId: input.agentId,
    stateDir: input.stateDir,
    updatedAt: input.record.finishedAt ?? input.record.startedAt ?? input.record.requestedAt,
    current: input.record,
    previousRuns: input.previousRuns,
  });

  await atomicWriteText(input.dreamPath, markdown);
  await atomicWriteText(indexPath, indexMarkdown);

  return {
    dreamPath: input.dreamPath,
    indexPath,
    markdown,
    indexMarkdown,
    summary: truncateText(input.record.summary, 160),
  };
}
