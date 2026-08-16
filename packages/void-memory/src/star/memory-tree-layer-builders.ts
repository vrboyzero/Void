import { createHash } from "node:crypto";

import type { TaskExperienceDetail } from "./experience-types.js";
import { buildCanonicalMemoryTreeNode, buildCanonicalTreeNodeKey } from "./memory-tree-canonical-pipeline.js";
import { classifyMemorySource } from "./memory-source-registry.js";
import { buildMemoryTreeSourceLinks } from "./memory-tree-source-links.js";
import { buildStableTopicGroups, type StableTopicSeed } from "./memory-tree-topic-stability.js";
import type { MemoryTreeEdgeRecord, MemoryTreeNodeRecord, MemoryTreeSourceRecord } from "./memory-tree-types.js";
import type { MemorySearchResult } from "./types.js";

type BuildMemoryTreeLayerInput = {
  limit: number;
  rebuiltAt: string;
  tasks: TaskExperienceDetail[];
  resolveChunk: (chunkId: string) => MemorySearchResult | null;
  rankChunks: (chunks: MemorySearchResult[]) => MemorySearchResult[];
  existingSources?: MemoryTreeSourceRecord[];
};

type BuildTopicMemoryTreeLayerInput = BuildMemoryTreeLayerInput & {
  explicitTopics: StableTopicSeed[];
};

type BuildMemoryTreeLayerResult = {
  nodes: MemoryTreeNodeRecord[];
  edges: MemoryTreeEdgeRecord[];
  inputDetails: Record<string, unknown>;
  sourceRecords?: MemoryTreeSourceRecord[];
};

type AggregatedChunk = {
  chunk: MemorySearchResult;
  taskIds: Set<string>;
  relations: Set<string>;
};

type ChunkBundle = {
  edgeMetadataByChunkId: Map<string, Record<string, unknown>>;
  evidenceChunks: MemorySearchResult[];
  linkedChunkCount: number;
  sourceClassMix: Record<string, number>;
};

const HIGH_LEVEL_EVIDENCE_LIMIT = 8;

export function buildTopicMemoryTreeNodes(input: BuildTopicMemoryTreeLayerInput): BuildMemoryTreeLayerResult {
  const stableGroups = buildStableTopicGroups({
    limit: input.limit,
    explicitTopics: input.explicitTopics,
    tasks: input.tasks,
    resolveChunk: input.resolveChunk,
    rankChunks: input.rankChunks,
  });
  const nodes: MemoryTreeNodeRecord[] = [];
  const edges: MemoryTreeEdgeRecord[] = [];
  const sourceRecords = new Map<string, MemoryTreeSourceRecord>();

  for (const group of stableGroups) {
    const chunks = group.chunks;
    if (chunks.length <= 0) {
      continue;
    }
    const nodeId = buildTopicNodeId(group.key, group.agentId, group.scope);
    const sourceLinks = buildMemoryTreeSourceLinks({
      parentNodeId: nodeId,
      rebuiltAt: input.rebuiltAt,
      evidenceChunks: chunks,
      existingSources: input.existingSources,
    });
    const canonicalNodeKey = buildCanonicalTreeNodeKey({
      kind: "topic",
      scope: group.scope,
      topicKey: group.key,
      agentId: group.agentId,
    });
    const { node, edges: nodeEdges } = buildCanonicalMemoryTreeNode({
      nodeId,
      level: 2,
      kind: "topic",
      scope: group.scope,
      agentId: group.agentId,
      topicKey: group.key,
      title: `Topic: ${group.label}`,
      summary: buildTopicSummary(group.label, chunks),
      summaryVersion: "p20-topic-node-v1",
      timeFrom: group.timeFrom,
      timeTo: group.timeTo,
      rebuiltAt: input.rebuiltAt,
      evidenceChunks: chunks,
      sourceClassMix: buildSourceClassMix(chunks),
      metadata: {
        topic: group.label,
        stableTopicKey: group.key,
        chunkCount: chunks.length,
        totalChunkCount: chunks.length,
        evidenceChunkCount: chunks.length,
        memoryTypes: group.memoryTypes,
        originKinds: group.metadata.originKinds,
        reasons: group.metadata.reasons,
        taskIds: group.metadata.taskIds,
        goalIds: group.metadata.goalIds,
        aliasKeys: group.metadata.aliasKeys,
        mergedSourceKeys: group.metadata.mergedSourceKeys,
        sourcePaths: group.metadata.sourcePaths,
        signalCategories: collectSignalCategories(chunks),
        rolledUpSourceCount: sourceLinks.sourceIds.length,
        rolledUpSourceIds: sourceLinks.sourceIds,
        rolledUpSourceKinds: sourceLinks.sourceKinds,
        rolledUpSourceClasses: sourceLinks.sourceClasses,
      },
      canonical: {
        canonicalNodeKey,
        nodeFamilyKey: buildCanonicalTreeNodeKey({
          kind: "topic",
          scope: group.scope,
          topicKey: group.key,
        }),
        reasons: group.metadata.reasons,
      },
    });
    nodes.push(node);
    edges.push(...nodeEdges);
    edges.push(...sourceLinks.sourceEdges);
    sourceLinks.sourceRecords.forEach((record) => {
      sourceRecords.set(record.id, record);
    });
  }

  return {
    nodes,
    edges,
    inputDetails: {
      topicLimit: input.limit,
      explicitTopicSeedCount: input.explicitTopics.length,
      stableTopicCount: stableGroups.length,
    },
    sourceRecords: [...sourceRecords.values()],
  };
}

export function buildProfileMemoryTreeNodes(input: BuildMemoryTreeLayerInput): BuildMemoryTreeLayerResult {
  const groups = new Map<string, TaskExperienceDetail[]>();
  for (const task of input.tasks) {
    const key = normalizeText(task.agentId) || "default";
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(task);
    } else {
      groups.set(key, [task]);
    }
  }

  const rankedGroups = [...groups.entries()]
    .map(([key, tasks]) => ({
      key,
      tasks,
      latestTimestamp: resolveLatestTaskTimestamp(tasks),
    }))
    .sort((a, b) => {
      if (b.latestTimestamp !== a.latestTimestamp) {
        return b.latestTimestamp - a.latestTimestamp;
      }
      return a.key.localeCompare(b.key);
    })
    .slice(0, input.limit);

  const nodes: MemoryTreeNodeRecord[] = [];
  const edges: MemoryTreeEdgeRecord[] = [];
  const sourceRecords = new Map<string, MemoryTreeSourceRecord>();
  for (const group of rankedGroups) {
    const nodeId = buildProfileNodeId(group.key);
    const bundle = buildChunkBundle(group.tasks, input);
    if (bundle.evidenceChunks.length <= 0) {
      continue;
    }
    const timeRange = resolveTaskTimeRange(group.tasks);
    const sourceLinks = buildMemoryTreeSourceLinks({
      parentNodeId: nodeId,
      rebuiltAt: input.rebuiltAt,
      evidenceChunks: bundle.evidenceChunks,
      existingSources: input.existingSources,
    });
    const { node, edges: nodeEdges } = buildCanonicalMemoryTreeNode({
      nodeId,
      level: 3,
      kind: "profile",
      scope: "private",
      agentId: group.key,
      topicKey: group.key,
      title: `Profile: ${group.key}`,
      summary: buildProfileSummary(group.key, group.tasks, bundle.evidenceChunks),
      summaryVersion: "p18-profile-node-v1",
      timeFrom: timeRange.timeFrom,
      timeTo: timeRange.timeTo,
      rebuiltAt: input.rebuiltAt,
      evidenceChunks: bundle.evidenceChunks,
      sourceClassMix: bundle.sourceClassMix,
      metadata: {
        agentId: group.key,
        taskCount: group.tasks.length,
        linkedChunkCount: bundle.linkedChunkCount,
        evidenceChunkCount: bundle.evidenceChunks.length,
        activityCount: group.tasks.reduce((total, task) => total + (task.activities?.length ?? 0), 0),
        conversationCount: collectConversationIds(group.tasks).length,
        goalIds: collectGoalIds(group.tasks),
        statusCounts: buildTaskStatusCounts(group.tasks),
        signalCategories: collectSignalCategories(bundle.evidenceChunks),
        rolledUpSourceCount: sourceLinks.sourceIds.length,
        rolledUpSourceIds: sourceLinks.sourceIds,
        rolledUpSourceKinds: sourceLinks.sourceKinds,
        rolledUpSourceClasses: sourceLinks.sourceClasses,
      },
      edgeMetadataByChunkId: bundle.edgeMetadataByChunkId,
      canonical: {
        canonicalNodeKey: buildCanonicalTreeNodeKey({
          kind: "profile",
          scope: "private",
          topicKey: group.key,
          agentId: group.key,
        }),
        nodeFamilyKey: buildCanonicalTreeNodeKey({
          kind: "profile",
          scope: "private",
          topicKey: group.key,
        }),
        reasons: ["task_aggregate", "agent_profile"],
      },
    });
    nodes.push(node);
    edges.push(...nodeEdges);
    edges.push(...sourceLinks.sourceEdges);
    sourceLinks.sourceRecords.forEach((record) => {
      sourceRecords.set(record.id, record);
    });
  }

  return {
    nodes,
    edges,
    inputDetails: {
      taskCandidateCount: input.tasks.length,
      agentGroupCount: groups.size,
      returnedNodeCount: nodes.length,
    },
    sourceRecords: [...sourceRecords.values()],
  };
}

export function buildGlobalMemoryTreeNodes(input: BuildMemoryTreeLayerInput): BuildMemoryTreeLayerResult {
  if (input.tasks.length <= 0) {
    return {
      nodes: [],
      edges: [],
      inputDetails: {
        taskCandidateCount: 0,
        returnedNodeCount: 0,
      },
    };
  }

  const nodeId = buildGlobalNodeId();
  const bundle = buildChunkBundle(input.tasks, input);
  if (bundle.evidenceChunks.length <= 0) {
    return {
      nodes: [],
      edges: [],
      inputDetails: {
        taskCandidateCount: input.tasks.length,
        returnedNodeCount: 0,
      },
    };
  }

  const timeRange = resolveTaskTimeRange(input.tasks);
  const sourceLinks = buildMemoryTreeSourceLinks({
    parentNodeId: nodeId,
    rebuiltAt: input.rebuiltAt,
    evidenceChunks: bundle.evidenceChunks,
    existingSources: input.existingSources,
  });
  const { node, edges } = buildCanonicalMemoryTreeNode({
    nodeId,
    level: 3,
    kind: "global",
    scope: "private",
    topicKey: "workspace",
    title: "Global: workspace",
    summary: buildGlobalSummary(input.tasks, bundle.evidenceChunks),
    summaryVersion: "p18-global-node-v1",
    timeFrom: timeRange.timeFrom,
    timeTo: timeRange.timeTo,
    rebuiltAt: input.rebuiltAt,
    evidenceChunks: bundle.evidenceChunks,
    sourceClassMix: bundle.sourceClassMix,
    metadata: {
      taskCount: input.tasks.length,
      linkedChunkCount: bundle.linkedChunkCount,
      evidenceChunkCount: bundle.evidenceChunks.length,
      activityCount: input.tasks.reduce((total, task) => total + (task.activities?.length ?? 0), 0),
      conversationCount: collectConversationIds(input.tasks).length,
      goalIds: collectGoalIds(input.tasks),
      agentIds: collectAgentIds(input.tasks),
      statusCounts: buildTaskStatusCounts(input.tasks),
      signalCategories: collectSignalCategories(bundle.evidenceChunks),
      rolledUpSourceCount: sourceLinks.sourceIds.length,
      rolledUpSourceIds: sourceLinks.sourceIds,
      rolledUpSourceKinds: sourceLinks.sourceKinds,
      rolledUpSourceClasses: sourceLinks.sourceClasses,
    },
    edgeMetadataByChunkId: bundle.edgeMetadataByChunkId,
    canonical: {
      canonicalNodeKey: buildCanonicalTreeNodeKey({
        kind: "global",
        scope: "private",
        topicKey: "workspace",
      }),
      nodeFamilyKey: buildCanonicalTreeNodeKey({
        kind: "global",
        scope: "private",
        topicKey: "workspace",
      }),
      reasons: ["task_aggregate", "workspace_global"],
    },
  });

  return {
    nodes: [node],
    edges: [...edges, ...sourceLinks.sourceEdges],
    inputDetails: {
      taskCandidateCount: input.tasks.length,
      uniqueGoalCount: collectGoalIds(input.tasks).length,
      uniqueAgentCount: collectAgentIds(input.tasks).length,
      returnedNodeCount: 1,
    },
    sourceRecords: sourceLinks.sourceRecords,
  };
}

function buildChunkBundle(
  tasks: TaskExperienceDetail[],
  input: BuildMemoryTreeLayerInput,
): ChunkBundle {
  const chunkMap = new Map<string, AggregatedChunk>();
  const links: Array<{ sourcePath?: string; memoryType?: string }> = [];

  for (const task of tasks) {
    for (const link of task.memoryLinks ?? []) {
      links.push({
        sourcePath: link.sourcePath,
        memoryType: link.memoryType,
      });
      const chunk = input.resolveChunk(link.chunkId);
      if (!chunk) {
        continue;
      }
      const existing = chunkMap.get(link.chunkId);
      if (existing) {
        existing.taskIds.add(task.id);
        existing.relations.add(link.relation);
        continue;
      }
      chunkMap.set(link.chunkId, {
        chunk,
        taskIds: new Set([task.id]),
        relations: new Set([link.relation]),
      });
    }
  }

  const rankedChunks = rankHighLevelChunks(
    input.rankChunks([...chunkMap.values()].map((item) => item.chunk)),
  ).slice(0, HIGH_LEVEL_EVIDENCE_LIMIT);
  const edgeMetadataByChunkId = new Map<string, Record<string, unknown>>();
  rankedChunks.forEach((chunk) => {
    const aggregate = chunkMap.get(chunk.id);
    edgeMetadataByChunkId.set(chunk.id, {
      taskIds: aggregate ? [...aggregate.taskIds] : [],
      linkRelations: aggregate ? [...aggregate.relations] : [],
    });
  });

  return {
    edgeMetadataByChunkId,
    evidenceChunks: rankedChunks,
    linkedChunkCount: chunkMap.size,
    sourceClassMix: buildSourceClassMix(links),
  };
}

function rankHighLevelChunks(chunks: MemorySearchResult[]): MemorySearchResult[] {
  return [...chunks].sort((a, b) => {
    const diff = computeHighLevelChunkWeight(b) - computeHighLevelChunkWeight(a);
    if (diff !== 0) {
      return diff;
    }
    return String(a.id).localeCompare(String(b.id));
  });
}

function computeHighLevelChunkWeight(chunk: MemorySearchResult): number {
  const sourceClass = readSourceClass(chunk);
  const sourceBonus = sourceClass === "curated"
    ? 0.4
    : sourceClass === "derived"
      ? 0.2
      : 0;
  const categoryBonus = isStableCategory(chunk.category) ? 0.25 : 0;
  const rawSessionPenalty = sourceClass === "raw" && chunk.memoryType === "session" ? 0.15 : 0;
  const baseScore = Number.isFinite(chunk.score) ? chunk.score : 0;
  return baseScore + sourceBonus + categoryBonus - rawSessionPenalty;
}

export function rankMemoryTreeTopicChunks(chunks: MemorySearchResult[]): MemorySearchResult[] {
  return [...chunks].sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    const aUpdatedAt = Date.parse(String(a.updatedAt ?? ""));
    const bUpdatedAt = Date.parse(String(b.updatedAt ?? ""));
    if (Number.isFinite(aUpdatedAt) && Number.isFinite(bUpdatedAt) && bUpdatedAt !== aUpdatedAt) {
      return bUpdatedAt - aUpdatedAt;
    }
    return a.id.localeCompare(b.id);
  });
}

function buildProfileSummary(agentId: string, tasks: TaskExperienceDetail[], chunks: MemorySearchResult[]): string {
  const goals = collectGoalIds(tasks).slice(0, 3);
  const taskTitles = collectTaskTitles(tasks).slice(0, 2);
  const signals = collectChunkSignals(chunks).slice(0, 3);
  const categories = collectSignalCategories(chunks).slice(0, 3);
  return [
    `Agent ${agentId} long-term profile`,
    goals.length > 0 ? `Goals: ${goals.join(", ")}` : undefined,
    taskTitles.length > 0 ? `Tasks: ${taskTitles.join("; ")}` : undefined,
    categories.length > 0 ? `Signal mix: ${categories.join(", ")}` : undefined,
    signals.length > 0 ? `Evidence: ${signals.join("; ")}` : undefined,
  ].filter((item): item is string => Boolean(item)).join(" | ");
}

function buildGlobalSummary(tasks: TaskExperienceDetail[], chunks: MemorySearchResult[]): string {
  const goals = collectGoalIds(tasks).slice(0, 4);
  const recentTaskTitles = [...tasks]
    .sort((a, b) => resolveTaskTimestamp(b) - resolveTaskTimestamp(a))
    .map((task) => normalizeText(task.title) || normalizeText(task.summary) || normalizeText(task.objective))
    .filter((item): item is string => Boolean(item))
    .slice(0, 3);
  const signals = collectChunkSignals(chunks).slice(0, 4);
  const categories = collectSignalCategories(chunks).slice(0, 4);
  return [
    "Global workspace focus",
    goals.length > 0 ? `Goals: ${goals.join(", ")}` : undefined,
    recentTaskTitles.length > 0 ? `Recent tasks: ${recentTaskTitles.join("; ")}` : undefined,
    categories.length > 0 ? `Signal mix: ${categories.join(", ")}` : undefined,
    signals.length > 0 ? `Evidence: ${signals.join("; ")}` : undefined,
  ].filter((item): item is string => Boolean(item)).join(" | ");
}

function collectChunkSignals(chunks: MemorySearchResult[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const chunk of chunks) {
    const signal = readChunkSignal(chunk);
    if (!signal || seen.has(signal)) {
      continue;
    }
    seen.add(signal);
    results.push(signal);
  }
  return results;
}

function collectSignalCategories(chunks: MemorySearchResult[]): string[] {
  const categories = chunks
    .map((chunk) => normalizeText(chunk.category) || normalizeText(chunk.memoryType) || readSourceClass(chunk))
    .filter((item): item is string => Boolean(item));
  return dedupeStrings(categories);
}

function readChunkSignal(chunk: MemorySearchResult): string | undefined {
  return truncateText(
    normalizeText(chunk.summary)
      || normalizeText(chunk.snippet)
      || normalizeText(chunk.content),
    120,
  );
}

function readSourceClass(chunk: MemorySearchResult): "raw" | "derived" | "curated" {
  const metadata = isRecord(chunk.metadata) ? chunk.metadata : undefined;
  const memoryTree = isRecord(metadata?.memoryTree) ? metadata.memoryTree : undefined;
  const sourceClass = typeof memoryTree?.sourceClass === "string" ? memoryTree.sourceClass.trim() : "";
  if (sourceClass === "raw" || sourceClass === "derived" || sourceClass === "curated") {
    return sourceClass;
  }
  return classifyMemorySource(
    chunk.sourcePath,
    chunk.sourceType,
    chunk.memoryType ? [chunk.memoryType] : undefined,
  ).sourceClass;
}

function buildSourceClassMix(links: Array<{ sourcePath?: string; memoryType?: string }>): Record<string, number> {
  const mix: Record<string, number> = {};
  for (const link of links) {
    const classification = classifyMemorySource(
      link.sourcePath ?? "",
      "file",
      link.memoryType ? [link.memoryType] : undefined,
    );
    mix[classification.sourceClass] = (mix[classification.sourceClass] ?? 0) + 1;
  }
  return mix;
}

function buildProfileNodeId(agentId: string): string {
  return `profile:${agentId.toLowerCase()}`;
}

function buildGlobalNodeId(): string {
  return "global:workspace";
}

function buildTopicNodeId(topic: string, agentId: string | undefined, scope: string): string {
  return `topic:${hashTreeNodeKey({
    topic,
    agentId: agentId ?? null,
    scope,
  })}`;
}

function buildTaskStatusCounts(tasks: TaskExperienceDetail[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    const key = normalizeText(task.status) || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function collectGoalIds(tasks: TaskExperienceDetail[]): string[] {
  return dedupeStrings(tasks.map((task) => {
    const goalId = isRecord(task.metadata) && typeof task.metadata.goalId === "string"
      ? task.metadata.goalId
      : "";
    return normalizeText(goalId);
  }).filter((item): item is string => Boolean(item)));
}

function collectAgentIds(tasks: TaskExperienceDetail[]): string[] {
  return dedupeStrings(tasks.map((task) => normalizeText(task.agentId)).filter((item): item is string => Boolean(item)));
}

function collectConversationIds(tasks: TaskExperienceDetail[]): string[] {
  return dedupeStrings(tasks.map((task) => normalizeText(task.conversationId)).filter((item): item is string => Boolean(item)));
}

function collectTaskTitles(tasks: TaskExperienceDetail[]): string[] {
  return dedupeStrings(tasks.map((task) => (
    normalizeText(task.title)
      || normalizeText(task.summary)
      || normalizeText(task.objective)
  )).filter((item): item is string => Boolean(item)));
}

function resolveLatestTaskTimestamp(tasks: TaskExperienceDetail[]): number {
  return tasks.reduce((latest, task) => Math.max(latest, resolveTaskTimestamp(task)), Number.NEGATIVE_INFINITY);
}

function resolveTaskTimeRange(tasks: TaskExperienceDetail[]): { timeFrom?: string; timeTo?: string } {
  let minTime: string | undefined;
  let maxTime: string | undefined;
  let minTimestamp = Number.POSITIVE_INFINITY;
  let maxTimestamp = Number.NEGATIVE_INFINITY;

  for (const task of tasks) {
    const from = normalizeText(task.startedAt) || normalizeText(task.createdAt);
    const to = normalizeText(task.finishedAt) || normalizeText(task.updatedAt) || from;
    if (from) {
      const fromTimestamp = Date.parse(from);
      if (Number.isFinite(fromTimestamp) && fromTimestamp < minTimestamp) {
        minTimestamp = fromTimestamp;
        minTime = from;
      }
    }
    if (to) {
      const toTimestamp = Date.parse(to);
      if (Number.isFinite(toTimestamp) && toTimestamp > maxTimestamp) {
        maxTimestamp = toTimestamp;
        maxTime = to;
      }
    }
  }

  return {
    timeFrom: minTime,
    timeTo: maxTime,
  };
}

function resolveTaskTimestamp(task: TaskExperienceDetail): number {
  const timestamp = Date.parse(
    task.finishedAt
      || task.updatedAt
      || task.startedAt
      || task.createdAt
      || "",
  );
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function isStableCategory(value: unknown): boolean {
  return value === "preference" || value === "fact" || value === "decision" || value === "experience";
}

function truncateText(value: string | undefined, maxLength: number): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed : undefined;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    results.push(normalized);
  }
  return results;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildTopicSummary(topic: string, chunks: MemorySearchResult[]): string {
  const highlights = dedupeStrings(
    chunks
      .map((chunk) => truncateText(
        normalizeText(chunk.summary)
          || normalizeText(chunk.snippet)
          || normalizeText(chunk.content),
        120,
      ))
      .filter((item): item is string => Boolean(item)),
  ).slice(0, 2);
  return [
    `Topic ${topic}`,
    ...highlights,
  ].join(" | ");
}

function hashTreeNodeKey(value: Record<string, unknown>): string {
  return createHash("sha1")
    .update(JSON.stringify(value))
    .digest("hex");
}
