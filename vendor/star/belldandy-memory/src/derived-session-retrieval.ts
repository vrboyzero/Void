import fs from "node:fs/promises";

import {
  buildDerivedRetrievalReport,
  hasDerivedRetrievalDeadlinePassed,
  type DerivedRetrievalExecution,
} from "./derived-retrieval-report.js";
import { resolveMemorySourceIdentity } from "./memory-source-registry.js";
import type { DreamSessionDigest, DreamSessionMemory } from "./dream-types.js";
import type {
  SessionArtifactInventoryItem,
  SessionArtifactInventoryProvider,
} from "./session-artifact-inventory.js";
import type { MemorySearchFilter, MemorySearchResult, MemoryType } from "./types.js";

const DERIVED_SESSION_CANDIDATE_LIMIT = 24;
const DERIVED_SESSION_READ_CONCURRENCY = 4;
const DERIVED_SESSION_FILE_BYTE_LIMIT = 64 * 1024;
const DERIVED_SESSION_TOTAL_BYTE_LIMIT = 256 * 1024;

type SessionArtifactCandidate = SessionArtifactInventoryItem;

type SessionDerivedSurfaceKind =
  | "session_memory_resume"
  | "session_memory_summary"
  | "session_digest_summary";

type SessionDerivedSurface = {
  conversationId: string;
  safeConversationId: string;
  kind: SessionDerivedSurfaceKind;
  sourceKind: "session_memory" | "session_digest";
  sourcePath: string;
  summary: string;
  snippet: string;
  content: string;
  updatedAt?: string;
  matchReasons: string[];
  score: number;
};

export async function collectDerivedSessionSearchResults(input: {
  sessionArtifactInventory?: SessionArtifactInventoryProvider;
  query: string;
  limit?: number;
  filter?: MemorySearchFilter;
  includeContent?: boolean;
  signal?: AbortSignal;
  deadlineMs?: number;
}): Promise<DerivedRetrievalExecution> {
  if (hasDerivedRetrievalDeadlinePassed(input.deadlineMs)) {
    return {
      items: [],
      report: buildDerivedRetrievalReport({
        admitted: false,
        skipped: true,
        skipReason: "deadline",
        deadlineExceededBeforeStart: true,
      }),
    };
  }
  input.signal?.throwIfAborted();
  const normalizedQuery = normalizeQuery(input.query);
  if (!normalizedQuery) {
    return {
      items: [],
      report: buildDerivedRetrievalReport({
        admitted: false,
        skipped: true,
        skipReason: "empty_query",
      }),
    };
  }
  if (input.filter?.scope === "shared") {
    return {
      items: [],
      report: buildDerivedRetrievalReport({
        admitted: false,
        skipped: true,
        skipReason: "scope",
      }),
    };
  }
  if (!allowsSessionMemoryType(input.filter?.memoryType)) {
    return {
      items: [],
      report: buildDerivedRetrievalReport({
        admitted: false,
        skipped: true,
        skipReason: "memory_type",
      }),
    };
  }

  const candidatePage = await listSessionArtifactCandidates(input.sessionArtifactInventory, input.limit, input.signal);
  if (candidatePage.unavailable) {
    return {
      items: [],
      report: buildDerivedRetrievalReport({
        admitted: false,
        skipped: true,
        skipReason: "unavailable",
      }),
    };
  }
  const candidates = candidatePage.items;
  if (candidates.length <= 0) {
    return {
      items: [],
      report: buildDerivedRetrievalReport({
        admitted: true,
      }),
    };
  }

  const includeContent = input.includeContent !== false;
  const limit = Math.max(1, Math.min(4, Math.floor(input.limit ?? 3)));
  const readBudget = new SessionArtifactReadBudget(DERIVED_SESSION_TOTAL_BYTE_LIMIT);
  const surfaces = (await mapWithConcurrency(
    candidates.slice(0, Math.min(DERIVED_SESSION_CANDIDATE_LIMIT, Math.max(limit * 6, 8))),
    DERIVED_SESSION_READ_CONCURRENCY,
    (candidate) => buildBestSessionSurface({
      candidate,
      query: normalizedQuery,
      filter: input.filter,
      signal: input.signal,
      readBudget,
    }),
  ))
    .filter((item): item is SessionDerivedSurface => Boolean(item))
    .sort(compareSessionDerivedSurface)
    .slice(0, limit);

  const items = surfaces.map((surface) => {
    const identity = resolveMemorySourceIdentity({
      id: `derived-session:${surface.safeConversationId}:${surface.kind}`,
      sourceKind: surface.sourceKind,
      sourceClass: "derived",
      scope: "private",
      sourcePath: surface.sourcePath,
      updatedAt: surface.updatedAt,
    });
    return {
      id: `derived-session:${surface.safeConversationId}:${surface.kind}`,
      sourcePath: surface.sourcePath,
      sourceType: "session_derived",
      memoryType: "session",
      ...(includeContent ? { content: surface.content } : {}),
      snippet: surface.snippet,
      summary: surface.summary,
      score: surface.score,
      updatedAt: surface.updatedAt,
      metadata: {
        derivedRetrieval: {
          conversationId: surface.conversationId,
          kind: surface.kind,
          sourceKind: surface.sourceKind,
          sourcePath: surface.sourcePath,
          matchReasons: surface.matchReasons,
        },
        memoryTree: {
          sourceClass: "derived",
          sourceKind: surface.sourceKind,
          canonicalSourceKey: identity.canonicalSourceKey,
          sourceFamilyKey: identity.sourceFamilyKey,
          ...(identity.revisionHint ? { revisionHint: identity.revisionHint } : {}),
        },
      },
    } satisfies MemorySearchResult;
  });
  return {
    items,
    report: buildDerivedRetrievalReport({
      admitted: true,
      candidateCount: candidates.length,
      detailCount: readBudget.detailCount,
      readByteCount: readBudget.readByteCount,
      resultCount: items.length,
      deadlineExceededAfterCompletion: hasDerivedRetrievalDeadlinePassed(input.deadlineMs),
    }),
  };
}

async function listSessionArtifactCandidates(
  inventory: SessionArtifactInventoryProvider | undefined,
  requestedLimit: number | undefined,
  signal?: AbortSignal,
): Promise<{ items: SessionArtifactCandidate[]; unavailable: boolean }> {
  signal?.throwIfAborted();
  if (!inventory) {
    return { items: [], unavailable: true };
  }
  const limit = Math.min(
    DERIVED_SESSION_CANDIDATE_LIMIT,
    Math.max(8, Math.floor(requestedLimit ?? 3) * 6),
  );
  const page = await inventory.listPage({ limit });
  signal?.throwIfAborted();
  if (page.status !== "ready") {
    return { items: [], unavailable: true };
  }
  return {
    items: page.items
      .filter((item) => Boolean(item.digestPath || item.sessionMemoryPath))
      .slice(0, DERIVED_SESSION_CANDIDATE_LIMIT),
    unavailable: false,
  };
}

async function buildBestSessionSurface(input: {
  candidate: SessionArtifactCandidate;
  query: string;
  filter?: MemorySearchFilter;
  signal?: AbortSignal;
  readBudget: SessionArtifactReadBudget;
}): Promise<SessionDerivedSurface | null> {
  input.signal?.throwIfAborted();
  const [sessionDigest, sessionMemory] = await Promise.all([
    input.candidate.digestPath
      ? readJsonFile<DreamSessionDigest>(input.candidate.digestPath, input.readBudget, input.signal)
      : Promise.resolve(undefined),
    input.candidate.sessionMemoryPath
      ? readJsonFile<DreamSessionMemory>(input.candidate.sessionMemoryPath, input.readBudget, input.signal)
      : Promise.resolve(undefined),
  ]);
  input.signal?.throwIfAborted();

  const surfaces = buildSessionSurfaces({
    candidate: input.candidate,
    conversationId: input.candidate.conversationId,
    sessionDigest,
    sessionMemory,
  });
  const ranked = surfaces
    .map((surface) => scoreSessionSurface(surface, input.query))
    .filter((surface): surface is SessionDerivedSurface => Boolean(surface))
    .filter((surface) => isWithinDateRange(surface.updatedAt, input.filter));

  return ranked.length > 0
    ? ranked.sort(compareSessionDerivedSurface)[0]
    : null;
}

function buildSessionSurfaces(input: {
  candidate: SessionArtifactCandidate;
  conversationId: string;
  sessionDigest?: DreamSessionDigest;
  sessionMemory?: DreamSessionMemory;
}): Array<SessionDerivedSurface & { scoreFields: Array<{ label: string; values: string[] }>; baseScore: number }> {
  const surfaces: Array<SessionDerivedSurface & { scoreFields: Array<{ label: string; values: string[] }>; baseScore: number }> = [];
  const conversationLabel = truncateText(input.conversationId || input.candidate.safeConversationId, 120);

  if (input.sessionMemory) {
    const updatedAt = toIsoTimestamp(input.sessionMemory.updatedAt) ?? toIsoTimestamp(input.candidate.newestFileMs);
    const sourcePath = input.candidate.sessionMemoryPath;
    if (!sourcePath) {
      return surfaces;
    }
    const summary = compactText(
      `会话续做：${input.sessionMemory.nextStep || input.sessionMemory.currentWork || input.sessionMemory.currentGoal || input.sessionMemory.summary || ""}`,
      220,
    );
    const resumeLines = [
      `Conversation: ${conversationLabel}`,
      input.sessionMemory.summary ? `Summary: ${input.sessionMemory.summary}` : undefined,
      input.sessionMemory.currentGoal ? `Current Goal: ${input.sessionMemory.currentGoal}` : undefined,
      input.sessionMemory.currentWork ? `Current Work: ${input.sessionMemory.currentWork}` : undefined,
      input.sessionMemory.nextStep ? `Next Step: ${input.sessionMemory.nextStep}` : undefined,
      (input.sessionMemory.pendingTasks?.length ?? 0) > 0
        ? `Pending Tasks: ${input.sessionMemory.pendingTasks!.slice(0, 4).join(" | ")}`
        : undefined,
    ].filter((line): line is string => Boolean(line));
    if (resumeLines.length >= 3 && summary) {
      surfaces.push({
        conversationId: input.conversationId,
        safeConversationId: input.candidate.safeConversationId,
        kind: "session_memory_resume",
        sourceKind: "session_memory",
        sourcePath,
        summary,
        snippet: truncateText(input.sessionMemory.nextStep || input.sessionMemory.currentWork || input.sessionMemory.summary || summary, 180),
        content: resumeLines.join("\n"),
        updatedAt,
        matchReasons: [],
        score: 0,
        baseScore: 0.78,
        scoreFields: [
          { label: "续做摘要", values: [input.sessionMemory.summary ?? "", input.sessionMemory.currentGoal ?? ""] },
          { label: "当前工作/下一步", values: [input.sessionMemory.currentWork ?? "", input.sessionMemory.nextStep ?? ""] },
          { label: "待办事项", values: input.sessionMemory.pendingTasks ?? [] },
        ],
      });
    }

    const summaryLines = [
      `Conversation: ${conversationLabel}`,
      input.sessionMemory.summary ? `Summary: ${input.sessionMemory.summary}` : undefined,
      input.sessionMemory.currentGoal ? `Current Goal: ${input.sessionMemory.currentGoal}` : undefined,
      (input.sessionMemory.keyResults?.length ?? 0) > 0
        ? `Key Results: ${input.sessionMemory.keyResults!.slice(0, 4).join(" | ")}`
        : undefined,
      (input.sessionMemory.decisions?.length ?? 0) > 0
        ? `Decisions: ${input.sessionMemory.decisions!.slice(0, 4).join(" | ")}`
        : undefined,
      (input.sessionMemory.errorsAndFixes?.length ?? 0) > 0
        ? `Errors & Fixes: ${input.sessionMemory.errorsAndFixes!.slice(0, 4).join(" | ")}`
        : undefined,
      (input.sessionMemory.filesTouched?.length ?? 0) > 0
        ? `Files Touched: ${input.sessionMemory.filesTouched!.slice(0, 5).join(" | ")}`
        : undefined,
    ].filter((line): line is string => Boolean(line));
    const summaryHeadline = compactText(
      `会话结论：${input.sessionMemory.summary || input.sessionMemory.currentGoal || input.sessionMemory.keyResults?.[0] || ""}`,
      220,
    );
    if (summaryLines.length >= 3 && summaryHeadline) {
      surfaces.push({
        conversationId: input.conversationId,
        safeConversationId: input.candidate.safeConversationId,
        kind: "session_memory_summary",
        sourceKind: "session_memory",
        sourcePath,
        summary: summaryHeadline,
        snippet: truncateText(input.sessionMemory.summary || input.sessionMemory.keyResults?.[0] || summaryHeadline, 180),
        content: summaryLines.join("\n"),
        updatedAt,
        matchReasons: [],
        score: 0,
        baseScore: 0.72,
        scoreFields: [
          { label: "会话总结/目标", values: [input.sessionMemory.summary ?? "", input.sessionMemory.currentGoal ?? ""] },
          { label: "关键结果/决策", values: [...(input.sessionMemory.keyResults ?? []), ...(input.sessionMemory.decisions ?? [])] },
          { label: "问题修复/改动文件", values: [...(input.sessionMemory.errorsAndFixes ?? []), ...(input.sessionMemory.filesTouched ?? [])] },
        ],
      });
    }
  }

  if (input.sessionDigest) {
    const updatedAt = toIsoTimestamp(input.sessionDigest.lastDigestAt) ?? toIsoTimestamp(input.candidate.newestFileMs);
    const sourcePath = input.candidate.digestPath;
    if (!sourcePath) {
      return surfaces;
    }
    const digestSummary = compactText(
      `会话 digest：${input.sessionDigest.rollingSummary || input.sessionDigest.archivalSummary || ""}`,
      220,
    );
    const digestLines = [
      `Conversation: ${conversationLabel}`,
      input.sessionDigest.rollingSummary ? `Rolling Summary: ${input.sessionDigest.rollingSummary}` : undefined,
      input.sessionDigest.archivalSummary ? `Archival Summary: ${input.sessionDigest.archivalSummary}` : undefined,
      typeof input.sessionDigest.pendingMessageCount === "number"
        ? `Pending Message Count: ${input.sessionDigest.pendingMessageCount}`
        : undefined,
    ].filter((line): line is string => Boolean(line));
    if (digestLines.length >= 2 && digestSummary) {
      surfaces.push({
        conversationId: input.conversationId,
        safeConversationId: input.candidate.safeConversationId,
        kind: "session_digest_summary",
        sourceKind: "session_digest",
        sourcePath,
        summary: digestSummary,
        snippet: truncateText(input.sessionDigest.rollingSummary || input.sessionDigest.archivalSummary || digestSummary, 180),
        content: digestLines.join("\n"),
        updatedAt,
        matchReasons: [],
        score: 0,
        baseScore: 0.66,
        scoreFields: [
          { label: "rolling summary", values: [input.sessionDigest.rollingSummary ?? ""] },
          { label: "archival summary", values: [input.sessionDigest.archivalSummary ?? ""] },
        ],
      });
    }
  }

  return surfaces;
}

function scoreSessionSurface(
  surface: SessionDerivedSurface & { scoreFields: Array<{ label: string; values: string[] }>; baseScore: number },
  normalizedQuery: string,
): SessionDerivedSurface | null {
  const queryTokens = tokenizeQuery(normalizedQuery);
  let rawMatchScore = 0;
  const reasons = new Set<string>();

  for (const field of surface.scoreFields) {
    const score = scoreFieldValues(field.values, normalizedQuery, queryTokens);
    if (score <= 0) {
      continue;
    }
    rawMatchScore += score;
    reasons.add(field.label);
  }

  if (rawMatchScore <= 0) {
    return null;
  }

  const normalizedMatchScore = Math.min(rawMatchScore / 40, 0.16);
  const recencyBonus = computeRecencyBonus(surface.updatedAt);
  return {
    ...surface,
    matchReasons: [...reasons],
    score: clampScore(surface.baseScore + normalizedMatchScore + recencyBonus),
  };
}

function scoreFieldValues(values: string[], normalizedQuery: string, queryTokens: string[]): number {
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

function compareSessionDerivedSurface(left: SessionDerivedSurface, right: SessionDerivedSurface): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  return parseIsoTimestamp(right.updatedAt) - parseIsoTimestamp(left.updatedAt);
}

function normalizeQuery(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.replace(/\s+/g, " ").trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

function tokenizeQuery(value: string): string[] {
  return [...new Set(
    value
      .split(/[\s,.;:!?/\\()[\]{}<>|"'`~\-_=+]+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2),
  )];
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength
    ? `${value.slice(0, Math.max(0, maxLength - 3))}...`
    : value;
}

function compactText(value: string, maxLength: number): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return truncateText(normalized, maxLength);
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  if (value < 0.05) return 0.05;
  if (value > 0.99) return 0.99;
  return value;
}

function toIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return new Date(value).toISOString();
}

function computeRecencyBonus(updatedAt?: string): number {
  const timestamp = parseIsoTimestamp(updatedAt);
  if (!Number.isFinite(timestamp)) {
    return 0;
  }
  const ageHours = (Date.now() - timestamp) / (1000 * 60 * 60);
  if (ageHours <= 24) return 0.06;
  if (ageHours <= 24 * 7) return 0.04;
  if (ageHours <= 24 * 30) return 0.02;
  return 0;
}

function parseIsoTimestamp(value?: string): number {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function allowsSessionMemoryType(memoryType: MemoryType | MemoryType[] | undefined): boolean {
  if (!memoryType) {
    return true;
  }
  const values = Array.isArray(memoryType) ? memoryType : [memoryType];
  return values.includes("session");
}

function isWithinDateRange(updatedAt: string | undefined, filter?: MemorySearchFilter): boolean {
  if (!updatedAt) {
    return true;
  }
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) {
    return true;
  }
  if (filter?.dateFrom) {
    const from = Date.parse(`${filter.dateFrom}T00:00:00.000Z`);
    if (Number.isFinite(from) && timestamp < from) {
      return false;
    }
  }
  if (filter?.dateTo) {
    const to = Date.parse(`${filter.dateTo}T23:59:59.999Z`);
    if (Number.isFinite(to) && timestamp > to) {
      return false;
    }
  }
  return true;
}

async function readJsonFile<T>(
  filePath: string,
  readBudget: SessionArtifactReadBudget,
  signal?: AbortSignal,
): Promise<T | undefined> {
  signal?.throwIfAborted();
  const handle = await fs.open(filePath, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > DERIVED_SESSION_FILE_BYTE_LIMIT || !readBudget.tryReserve(stat.size)) {
      return undefined;
    }
    const buffer = Buffer.alloc(Math.max(0, stat.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    readBudget.recordRead(bytesRead);
    signal?.throwIfAborted();
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf-8")) as T;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  } finally {
    await handle.close().catch(() => {});
  }
}

class SessionArtifactReadBudget {
  private remainingBytes: number;
  private readDetails = 0;
  private readBytes = 0;

  constructor(totalBytes: number) {
    this.remainingBytes = totalBytes;
  }

  tryReserve(byteLength: number): boolean {
    const normalized = Number.isFinite(byteLength) ? Math.max(0, Math.floor(byteLength)) : 0;
    if (normalized > this.remainingBytes) {
      return false;
    }
    this.remainingBytes -= normalized;
    return true;
  }

  recordRead(byteLength: number): void {
    const normalized = Number.isFinite(byteLength) ? Math.max(0, Math.floor(byteLength)) : 0;
    this.readDetails += 1;
    this.readBytes += normalized;
  }

  get detailCount(): number {
    return this.readDetails;
  }

  get readByteCount(): number {
    return this.readBytes;
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), values.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]);
    }
  }));
  return results;
}
