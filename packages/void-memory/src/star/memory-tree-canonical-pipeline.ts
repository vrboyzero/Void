import { classifyMemorySource, resolveMemorySourceAdmission, resolveMemorySourceIdentity } from "./memory-source-registry.js";
import type { MemoryTreeEdgeRecord, MemoryTreeNodeRecord } from "./memory-tree-types.js";
import type { MemorySearchResult, MemoryVisibility } from "./types.js";

export type MemoryTreeCanonicalLifecycleState = "admitted" | "buffered" | "sealed";

type MemoryTreeCanonicalNodeKind = "topic" | "profile" | "global";

type CanonicalTreeSourceDescriptor = {
  sourceKind: string;
  sourceClass: "raw" | "derived" | "curated";
  canonicalSourceKey: string;
  sourceFamilyKey: string;
  revisionHint?: string;
  searchPolicy: string;
  dedupPolicy: string;
  retentionHint: string;
};

export type BuildCanonicalMemoryTreeNodeInput = {
  nodeId: string;
  level: number;
  kind: MemoryTreeCanonicalNodeKind;
  scope: "private" | "shared";
  agentId?: string;
  topicKey: string;
  title: string;
  summary: string;
  summaryVersion: string;
  timeFrom?: string;
  timeTo?: string;
  rebuiltAt: string;
  evidenceChunks: MemorySearchResult[];
  sourceClassMix: Record<string, number>;
  metadata?: Record<string, unknown>;
  edgeMetadataByChunkId?: Map<string, Record<string, unknown>>;
  canonical: {
    canonicalNodeKey: string;
    nodeFamilyKey: string;
    reasons?: string[];
  };
};

export type BuildCanonicalMemoryTreeNodeResult = {
  node: MemoryTreeNodeRecord;
  edges: MemoryTreeEdgeRecord[];
  lifecycleState: MemoryTreeCanonicalLifecycleState;
};

export function buildCanonicalMemoryTreeNode(
  input: BuildCanonicalMemoryTreeNodeInput,
): BuildCanonicalMemoryTreeNodeResult {
  const sourceDescriptors = input.evidenceChunks.map((chunk) => resolveCanonicalTreeSourceDescriptor(chunk));
  const sourceCanonicalKeys = dedupeStrings(sourceDescriptors.map((item) => item.canonicalSourceKey));
  const sourceFamilyKeys = dedupeStrings(sourceDescriptors.map((item) => item.sourceFamilyKey));
  const sourceKinds = dedupeStrings(sourceDescriptors.map((item) => item.sourceKind));
  const sourceClasses = dedupeStrings(sourceDescriptors.map((item) => item.sourceClass));
  const searchPolicies = dedupeStrings(sourceDescriptors.map((item) => item.searchPolicy));
  const dedupPolicies = dedupeStrings(sourceDescriptors.map((item) => item.dedupPolicy));
  const retentionHints = dedupeStrings(sourceDescriptors.map((item) => item.retentionHint));
  const revisionHints = dedupeStrings(sourceDescriptors.map((item) => item.revisionHint));
  const revisionHint = revisionHints[revisionHints.length - 1];
  const lifecycle = resolveCanonicalMemoryTreeLifecycle(input.kind, {
    evidenceChunkCount: input.evidenceChunks.length,
    sourceCanonicalCount: sourceCanonicalKeys.length,
    sourceFamilyCount: sourceFamilyKeys.length,
    metadata: input.metadata,
  });

  const metadata = {
    ...(input.metadata ?? {}),
    treePipeline: {
      pipelineVersion: "p21-tree-canonical-v1",
      canonical: {
        nodeKind: input.kind,
        canonicalNodeKey: input.canonical.canonicalNodeKey,
        nodeFamilyKey: input.canonical.nodeFamilyKey,
        sourceCanonicalKeys,
        sourceFamilyKeys,
        sourceKinds,
        sourceClasses,
        ...(revisionHint ? { revisionHint } : {}),
        reasons: dedupeStrings(input.canonical.reasons ?? []),
      },
      ingest: {
        stage: "ingested",
        ingestedAt: input.rebuiltAt,
        evidenceChunkCount: input.evidenceChunks.length,
        sourceCanonicalCount: sourceCanonicalKeys.length,
        sourceFamilyCount: sourceFamilyKeys.length,
        searchPolicies,
        dedupPolicies,
        retentionHints,
      },
      lifecycle: {
        state: lifecycle.state,
        reasons: lifecycle.reasons,
        updatedAt: input.rebuiltAt,
        stable: lifecycle.state === "sealed",
      },
    },
  };

  const node: MemoryTreeNodeRecord = {
    id: input.nodeId,
    level: input.level,
    kind: input.kind,
    scope: input.scope,
    agentId: input.agentId,
    topicKey: input.topicKey,
    title: input.title,
    summary: input.summary,
    summaryVersion: input.summaryVersion,
    timeFrom: input.timeFrom,
    timeTo: input.timeTo,
    sourceClassMix: input.sourceClassMix,
    metadata,
    createdAt: input.rebuiltAt,
    updatedAt: input.rebuiltAt,
  };

  const edges = input.evidenceChunks.map((chunk, index) => {
    const sourceDescriptor = sourceDescriptors[index];
    return {
      id: `edge:${input.nodeId}:chunk:${chunk.id}`,
      parentNodeId: input.nodeId,
      childType: "chunk" as const,
      childId: chunk.id,
      relation: "contains",
      position: index,
      weight: Number.isFinite(chunk.score) ? chunk.score : undefined,
      metadata: {
        sourcePath: chunk.sourcePath,
        memoryType: chunk.memoryType,
        visibility: chunk.visibility,
        sourceKind: sourceDescriptor.sourceKind,
        sourceClass: sourceDescriptor.sourceClass,
        canonicalSourceKey: sourceDescriptor.canonicalSourceKey,
        sourceFamilyKey: sourceDescriptor.sourceFamilyKey,
        ...(sourceDescriptor.revisionHint ? { revisionHint: sourceDescriptor.revisionHint } : {}),
        ...(input.edgeMetadataByChunkId?.get(chunk.id) ?? {}),
      },
      createdAt: input.rebuiltAt,
    };
  });

  return {
    node,
    edges,
    lifecycleState: lifecycle.state,
  };
}

export function buildCanonicalTreeNodeKey(input: {
  kind: MemoryTreeCanonicalNodeKind;
  scope: "private" | "shared";
  topicKey: string;
  agentId?: string;
}): string {
  const agentKey = normalizeString(input.agentId) || "-";
  return `tree:${input.kind}:${input.scope}:${agentKey}:${input.topicKey}`;
}

function resolveCanonicalTreeSourceDescriptor(chunk: MemorySearchResult): CanonicalTreeSourceDescriptor {
  const memoryTree = isRecord(chunk.metadata?.memoryTree) ? chunk.metadata.memoryTree : {};
  const sourceKind = normalizeString(memoryTree.sourceKind)
    || classifyMemorySource(chunk.sourcePath, chunk.sourceType, chunk.memoryType ? [chunk.memoryType] : undefined).sourceKind;
  const sourceClass = normalizeSourceClass(memoryTree.sourceClass)
    || classifyMemorySource(chunk.sourcePath, chunk.sourceType, chunk.memoryType ? [chunk.memoryType] : undefined).sourceClass;
  const identity = resolveMemorySourceIdentity({
    id: chunk.id,
    sourceKind,
    sourceClass,
    scope: toInventoryScope(chunk.visibility),
    sourcePath: chunk.sourcePath,
    sourceRef: chunk.id,
    updatedAt: chunk.updatedAt,
  });
  const admission = resolveMemorySourceAdmission({
    sourceKind,
    sourceClass,
  });
  return {
    sourceKind,
    sourceClass,
    canonicalSourceKey: normalizeString(memoryTree.canonicalSourceKey) || identity.canonicalSourceKey,
    sourceFamilyKey: normalizeString(memoryTree.sourceFamilyKey) || identity.sourceFamilyKey,
    revisionHint: normalizeString(memoryTree.revisionHint) || identity.revisionHint,
    searchPolicy: admission.searchPolicy,
    dedupPolicy: admission.dedupPolicy,
    retentionHint: admission.retentionHint,
  };
}

function resolveCanonicalMemoryTreeLifecycle(
  kind: MemoryTreeCanonicalNodeKind,
  input: {
    evidenceChunkCount: number;
    sourceCanonicalCount: number;
    sourceFamilyCount: number;
    metadata?: Record<string, unknown>;
  },
): {
  state: MemoryTreeCanonicalLifecycleState;
  reasons: string[];
} {
  const taskCount = readNumericMetadata(input.metadata, "taskCount");
  const aliasKeyCount = readArrayLength(input.metadata, "aliasKeys");
  const reasonCount = readArrayLength(input.metadata, "reasons");
  const enoughEvidence = input.evidenceChunkCount >= 3;
  const multiSourceFamily = input.sourceFamilyCount >= 2;
  const multiCanonicalSource = input.sourceCanonicalCount >= 2;
  const multiTask = taskCount >= 2;
  const stableTopicGrouping = aliasKeyCount >= 2 || reasonCount >= 2;

  if (kind === "topic") {
    if (enoughEvidence && (multiSourceFamily || stableTopicGrouping)) {
      return {
        state: "sealed",
        reasons: dedupeStrings(["enough_evidence", multiSourceFamily ? "multi_source_family" : undefined, stableTopicGrouping ? "stable_grouping" : undefined]),
      };
    }
    if (input.evidenceChunkCount >= 2 || multiCanonicalSource || stableTopicGrouping) {
      return {
        state: "buffered",
        reasons: dedupeStrings(["partial_evidence", multiCanonicalSource ? "multi_canonical_source" : undefined, stableTopicGrouping ? "stable_grouping" : undefined]),
      };
    }
    return {
      state: "admitted",
      reasons: ["single_evidence"],
    };
  }

  if (enoughEvidence && multiTask && multiSourceFamily) {
    return {
      state: "sealed",
      reasons: ["enough_evidence", "multi_task", "multi_source_family"],
    };
  }
  if (input.evidenceChunkCount >= 2 || multiTask || multiCanonicalSource) {
    return {
      state: "buffered",
      reasons: dedupeStrings(["partial_evidence", multiTask ? "multi_task" : undefined, multiCanonicalSource ? "multi_canonical_source" : undefined]),
    };
  }
  return {
    state: "admitted",
    reasons: ["single_evidence"],
  };
}

function toInventoryScope(visibility?: MemoryVisibility): "private" | "shared" {
  return visibility === "shared" ? "shared" : "private";
}

function normalizeSourceClass(value: unknown): "raw" | "derived" | "curated" | undefined {
  switch (value) {
    case "raw":
    case "derived":
    case "curated":
      return value;
    default:
      return undefined;
  }
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeString(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    results.push(normalized);
  }
  return results;
}

function readNumericMetadata(metadata: Record<string, unknown> | undefined, key: string): number {
  const value = Number(metadata?.[key]);
  return Number.isFinite(value) ? value : 0;
}

function readArrayLength(metadata: Record<string, unknown> | undefined, key: string): number {
  const value = metadata?.[key];
  return Array.isArray(value) ? value.length : 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
