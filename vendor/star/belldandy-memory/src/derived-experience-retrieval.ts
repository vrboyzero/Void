import path from "node:path";

import { resolveMemorySourceIdentity } from "./memory-source-registry.js";
import type { ExperienceDerivedCandidate } from "./experience-derived-search.js";
import type { MemorySearchFilter, MemorySearchResult } from "./types.js";

type ExperienceDerivedSurface = {
  candidateId: string;
  kind: "experience_candidate_fragment";
  sourcePath: string;
  summary: string;
  snippet: string;
  content: string;
  updatedAt: string;
  score: number;
  sourceClass: "curated";
  matchReasons: string[];
  candidateType: ExperienceDerivedCandidate["type"];
  candidateStatus: ExperienceDerivedCandidate["status"];
  qualityScore?: number;
};

export function buildExperienceDerivedSearchResults(input: {
  query: string;
  candidates: ExperienceDerivedCandidate[];
  limit?: number;
  includeContent?: boolean;
  filter?: MemorySearchFilter;
}): MemorySearchResult[] {
  const normalizedQuery = normalizeQuery(input.query);
  if (!normalizedQuery) {
    return [];
  }
  if (input.filter?.scope === "shared") {
    return [];
  }
  if (!allowsExperienceMemoryType(input.filter)) {
    return [];
  }

  const includeContent = input.includeContent !== false;
  const limit = Math.max(1, Math.min(4, Math.floor(input.limit ?? 3)));
  const ranked = dedupeCandidates(input.candidates)
    .filter(isSearchableExperienceCandidate)
    .map((candidate) => buildExperienceSurface(candidate, normalizedQuery))
    .filter((item): item is ExperienceDerivedSurface => Boolean(item))
    .sort(compareExperienceDerivedSurface)
    .slice(0, limit);

  return ranked.map((surface) => {
    const identity = resolveMemorySourceIdentity({
      id: `derived-experience:${surface.candidateId}`,
      sourceKind: "experience_candidates",
      sourceClass: "curated",
      scope: "private",
      sourcePath: surface.sourcePath,
      sourceRef: surface.candidateId,
      updatedAt: surface.updatedAt,
    });
    return {
      id: `derived-experience:${surface.candidateId}`,
      sourcePath: surface.sourcePath,
      sourceType: "experience_derived",
      memoryType: "other",
      ...(includeContent ? { content: surface.content } : {}),
      snippet: surface.snippet,
      summary: surface.summary,
      score: surface.score,
      updatedAt: surface.updatedAt,
      metadata: {
        derivedRetrieval: {
          kind: surface.kind,
          candidateId: surface.candidateId,
          candidateType: surface.candidateType,
          candidateStatus: surface.candidateStatus,
          qualityScore: surface.qualityScore,
          matchReasons: surface.matchReasons,
        },
        memoryTree: {
          sourceClass: surface.sourceClass,
          sourceKind: "experience_candidates",
          canonicalSourceKey: identity.canonicalSourceKey,
          sourceFamilyKey: identity.sourceFamilyKey,
          ...(identity.revisionHint ? { revisionHint: identity.revisionHint } : {}),
        },
      },
    } satisfies MemorySearchResult;
  });
}

function dedupeCandidates(candidates: ExperienceDerivedCandidate[]): ExperienceDerivedCandidate[] {
  const seen = new Set<string>();
  const results: ExperienceDerivedCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate?.id || seen.has(candidate.id)) {
      continue;
    }
    seen.add(candidate.id);
    results.push(candidate);
  }
  return results;
}

function isSearchableExperienceCandidate(candidate: ExperienceDerivedCandidate): boolean {
  if (!candidate || !candidate.id || !candidate.content) {
    return false;
  }
  return candidate.status === "accepted" || candidate.status === "published";
}

function buildExperienceSurface(candidate: ExperienceDerivedCandidate, normalizedQuery: string): ExperienceDerivedSurface | null {
  const highlights = extractExperienceHighlights(candidate.content, 6);
  const summaryText = compactText(
    `经验${candidate.type === "method" ? "方法" : "技能"} ${candidate.title}：${candidate.summary || highlights[0] || candidate.sourceTaskSummary || ""}`,
    220,
  );
  if (!summaryText) {
    return null;
  }

  const sourcePath = candidate.publishedPath || `experience-candidate://${candidate.id}`;
  const contentLines = [
    `Type: ${candidate.type}`,
    `Title: ${candidate.title}`,
    candidate.summary ? `Summary: ${candidate.summary}` : undefined,
    typeof candidate.qualityScore === "number" ? `Quality Score: ${candidate.qualityScore}` : undefined,
    candidate.sourceTaskTitle ? `Source Task: ${candidate.sourceTaskTitle}` : undefined,
    candidate.sourceTaskSummary ? `Task Summary: ${candidate.sourceTaskSummary}` : undefined,
    ...highlights.map((item) => `Highlight: ${item}`),
  ].filter((line): line is string => Boolean(line));

  const scoreFields = [
    { label: "标题/摘要", values: [candidate.title, candidate.summary] },
    { label: "经验片段", values: highlights },
    {
      label: "来源任务",
      values: [
        candidate.sourceTaskTitle,
        candidate.sourceTaskSummary,
      ],
    },
    {
      label: "发布线索",
      values: [
        candidate.publishedPath ? path.basename(candidate.publishedPath) : "",
      ],
    },
  ];

  const queryTokens = tokenizeQuery(normalizedQuery);
  let rawMatchScore = 0;
  const matchReasons = new Set<string>();
  for (const field of scoreFields) {
    const score = scoreFieldValues(field.values, normalizedQuery, queryTokens);
    if (score <= 0) {
      continue;
    }
    rawMatchScore += score;
    matchReasons.add(field.label);
  }

  if (rawMatchScore <= 0) {
    return null;
  }

  const baseScore = 0.76
    + computeQualityBonus(candidate.qualityScore)
    + (candidate.status === "published" ? 0.03 : 0.01);
  const score = clampScore(baseScore + Math.min(rawMatchScore / 45, 0.14) + computeRecencyBonus(resolveUpdatedAt(candidate)));
  return {
    candidateId: candidate.id,
    kind: "experience_candidate_fragment",
    sourcePath,
    summary: summaryText,
    snippet: truncateText(candidate.summary || highlights[0] || candidate.title, 180),
    content: contentLines.join("\n"),
    updatedAt: resolveUpdatedAt(candidate),
    score,
    sourceClass: "curated",
    matchReasons: [...matchReasons],
    candidateType: candidate.type,
    candidateStatus: candidate.status,
    qualityScore: candidate.qualityScore,
  };
}

function extractExperienceHighlights(content: string, limit: number): string[] {
  const body = stripFrontmatter(content);
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line !== "---" && line !== "```" && !line.startsWith("```"));
  const highlights: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of lines) {
    const normalized = rawLine
      .replace(/^#+\s*/, "")
      .replace(/^[-*+]\s*/, "")
      .replace(/^\d+\.\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    highlights.push(truncateText(normalized, 180));
    if (highlights.length >= limit) {
      break;
    }
  }
  return highlights;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function resolveUpdatedAt(candidate: ExperienceDerivedCandidate): string {
  return candidate.acceptedAt || candidate.reviewedAt || candidate.createdAt;
}

function computeQualityBonus(qualityScore?: number): number {
  if (typeof qualityScore !== "number" || !Number.isFinite(qualityScore)) {
    return 0.02;
  }
  if (qualityScore >= 90) return 0.08;
  if (qualityScore >= 75) return 0.05;
  if (qualityScore >= 60) return 0.03;
  return 0.01;
}

function compareExperienceDerivedSurface(left: ExperienceDerivedSurface, right: ExperienceDerivedSurface): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}

function scoreFieldValues(values: Array<string | undefined>, normalizedQuery: string, queryTokens: string[]): number {
  let best = 0;
  for (const rawValue of values) {
    const normalizedValue = normalizeQuery(rawValue);
    if (!normalizedValue) {
      continue;
    }

    let score = 0;
    if (normalizedValue.includes(normalizedQuery)) {
      score += 10;
    }

    const tokenMatches = queryTokens.filter((token) => normalizedValue.includes(token)).length;
    const minTokenMatches = queryTokens.length >= 3 ? 2 : 1;
    if (tokenMatches >= minTokenMatches) {
      score += tokenMatches * 3;
    }

    if (score > best) {
      best = score;
    }
  }
  return best;
}

function tokenizeQuery(value: string): string[] {
  return [...new Set(
    value
      .split(/[\s,.;:!?/\\()[\]{}<>|"'`~\-_=+]+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2),
  )];
}

function normalizeQuery(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.replace(/\s+/g, " ").trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

function compactText(value: string, maxLength: number): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return truncateText(normalized, maxLength);
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength
    ? `${value.slice(0, Math.max(0, maxLength - 3))}...`
    : value;
}

function computeRecencyBonus(updatedAt: string): number {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) {
    return 0;
  }
  const ageHours = (Date.now() - timestamp) / (1000 * 60 * 60);
  if (ageHours <= 24) return 0.06;
  if (ageHours <= 24 * 7) return 0.04;
  if (ageHours <= 24 * 30) return 0.02;
  return 0;
}

function allowsExperienceMemoryType(filter?: MemorySearchFilter): boolean {
  const memoryType = filter?.memoryType;
  if (!memoryType) {
    return true;
  }
  const values = Array.isArray(memoryType) ? memoryType : [memoryType];
  return values.includes("other");
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  if (value < 0.05) return 0.05;
  if (value > 0.99) return 0.99;
  return value;
}
