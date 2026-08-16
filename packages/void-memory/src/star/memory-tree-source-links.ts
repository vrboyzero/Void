import { createHash } from "node:crypto";

import {
  classifyMemorySource,
  normalizeSourcePathForRegistryMatch,
  resolveMemorySourceAdmission,
  resolveMemorySourceIdentity,
} from "./memory-source-registry.js";
import type { MemorySourceInventoryClass } from "./memory-source-inventory.js";
import type {
  MemoryTreeEdgeRecord,
  MemoryTreeSourceRecord,
} from "./memory-tree-types.js";
import type { MemorySearchResult, MemoryVisibility } from "./types.js";

export type BuildMemoryTreeSourceLinksInput = {
  parentNodeId: string;
  rebuiltAt: string;
  evidenceChunks: MemorySearchResult[];
  existingSources?: MemoryTreeSourceRecord[];
};

export type BuildMemoryTreeSourceLinksResult = {
  sourceRecords: MemoryTreeSourceRecord[];
  sourceEdges: MemoryTreeEdgeRecord[];
  sourceIds: string[];
  sourceKinds: string[];
  sourceClasses: MemorySourceInventoryClass[];
};

type MutableSourceAggregate = {
  sourceId: string;
  sourceKind: string;
  sourceClass: MemorySourceInventoryClass;
  canonicalSourceKey: string;
  sourceFamilyKey: string;
  searchPolicy: string;
  dedupPolicy: string;
  retentionHint: string;
  revisionHint?: string;
  sourcePath?: string;
  sourceRef?: string;
  record?: MemoryTreeSourceRecord;
  missingRecord?: MemoryTreeSourceRecord;
  position: number;
  evidenceChunkIds: Set<string>;
  memoryTypes: Set<string>;
  maxWeight: number;
};

export function buildMemoryTreeSourceLinks(
  input: BuildMemoryTreeSourceLinksInput,
): BuildMemoryTreeSourceLinksResult {
  const existingSources = Array.isArray(input.existingSources) ? input.existingSources : [];
  const aggregates = new Map<string, MutableSourceAggregate>();

  input.evidenceChunks.forEach((chunk, index) => {
    const classification = classifyMemorySource(
      chunk.sourcePath,
      chunk.sourceType,
      chunk.memoryType ? [chunk.memoryType] : undefined,
    );
    const sourceKind = readSourceKind(chunk) || classification.sourceKind;
    const sourceClass = readSourceClass(chunk) || classification.sourceClass;
    const admission = resolveMemorySourceAdmission({
      sourceKind,
      sourceClass,
    });
    const identity = resolveMemorySourceIdentity({
      id: chunk.id,
      sourceKind,
      sourceClass,
      scope: toTreeScope(chunk.visibility),
      sourcePath: chunk.sourcePath,
      sourceRef: chunk.sourceType,
      builtinInventoryId: classification.builtinInventoryId,
      agentId: readAgentId(chunk),
      updatedAt: chunk.updatedAt,
    });
    const matchedRecord = findMatchingSourceRecord(chunk, classification.builtinInventoryId, existingSources);
    const sourceId = matchedRecord?.id
      || classification.builtinInventoryId
      || buildDynamicMemoryTreeSourceId(chunk.sourcePath, chunk.sourceType, readAgentId(chunk));
    const existing = aggregates.get(sourceId);
    if (existing) {
      existing.evidenceChunkIds.add(chunk.id);
      if (chunk.memoryType) {
        existing.memoryTypes.add(chunk.memoryType);
      }
      existing.maxWeight = Math.max(existing.maxWeight, normalizeWeight(chunk.score));
      return;
    }

    const missingRecord = matchedRecord
      ? undefined
      : buildSyntheticSourceRecord({
        sourceId,
        rebuiltAt: input.rebuiltAt,
        chunk,
        sourceKind,
        sourceClass,
        builtinInventoryId: classification.builtinInventoryId,
        admission,
        identity,
      });
    aggregates.set(sourceId, {
      sourceId,
      sourceKind,
      sourceClass,
      canonicalSourceKey: identity.canonicalSourceKey,
      sourceFamilyKey: identity.sourceFamilyKey,
      searchPolicy: admission.searchPolicy,
      dedupPolicy: admission.dedupPolicy,
      retentionHint: admission.retentionHint,
      revisionHint: identity.revisionHint,
      sourcePath: matchedRecord?.sourcePath ?? chunk.sourcePath,
      sourceRef: matchedRecord?.sourceRef ?? chunk.sourceType,
      record: matchedRecord,
      missingRecord,
      position: index,
      evidenceChunkIds: new Set([chunk.id]),
      memoryTypes: new Set(chunk.memoryType ? [chunk.memoryType] : []),
      maxWeight: normalizeWeight(chunk.score),
    });
  });

  const ordered = [...aggregates.values()]
    .sort((a, b) => a.position - b.position)
    .map((item, index) => ({ ...item, position: index }));

  return {
    sourceRecords: ordered
      .map((item) => item.missingRecord)
      .filter((item): item is MemoryTreeSourceRecord => Boolean(item)),
    sourceEdges: ordered.map((item) => ({
      id: `edge:${input.parentNodeId}:source:${item.sourceId}`,
      parentNodeId: input.parentNodeId,
      childType: "source" as const,
      childId: item.sourceId,
      relation: "rolls_up_source",
      position: item.position,
      weight: item.maxWeight,
      metadata: {
        sourcePath: item.sourcePath,
        sourceRef: item.sourceRef,
        sourceKind: item.sourceKind,
        sourceClass: item.sourceClass,
        canonicalSourceKey: item.canonicalSourceKey,
        sourceFamilyKey: item.sourceFamilyKey,
        searchPolicy: item.searchPolicy,
        dedupPolicy: item.dedupPolicy,
        retentionHint: item.retentionHint,
        evidenceChunkIds: [...item.evidenceChunkIds],
        evidenceChunkCount: item.evidenceChunkIds.size,
        memoryTypes: [...item.memoryTypes],
        ...(item.revisionHint ? { revisionHint: item.revisionHint } : {}),
      },
      createdAt: input.rebuiltAt,
    })),
    sourceIds: ordered.map((item) => item.sourceId),
    sourceKinds: dedupeStrings(ordered.map((item) => item.sourceKind)),
    sourceClasses: dedupeSourceClasses(ordered.map((item) => item.sourceClass)),
  };
}

export function buildMemoryTreeSourceRecordFromEdge(edge: MemoryTreeEdgeRecord): MemoryTreeSourceRecord | null {
  const metadata = isRecord(edge.metadata) ? edge.metadata : {};
  const sourceKind = normalizeString(metadata.sourceKind);
  const sourceClass = normalizeSourceClass(metadata.sourceClass);
  if (!sourceKind || !sourceClass) {
    return null;
  }
  return {
    id: edge.childId,
    sourceKind,
    sourceClass,
    scope: "private",
    sourcePath: normalizeString(metadata.sourcePath),
    sourceRef: normalizeString(metadata.sourceRef),
    timeTo: normalizeString(metadata.revisionHint),
    itemCount: Number(metadata.evidenceChunkCount) || undefined,
    metadata: {
      recordType: "tree_source_edge_fallback",
      sourceRegistry: {
        admission: {
          searchPolicy: normalizeString(metadata.searchPolicy),
          dedupPolicy: normalizeString(metadata.dedupPolicy),
          retentionHint: normalizeString(metadata.retentionHint),
        },
        identity: {
          canonicalSourceKey: normalizeString(metadata.canonicalSourceKey),
          sourceFamilyKey: normalizeString(metadata.sourceFamilyKey),
          revisionHint: normalizeString(metadata.revisionHint),
        },
      },
    },
    createdAt: edge.createdAt,
    updatedAt: edge.createdAt,
  };
}

function buildSyntheticSourceRecord(input: {
  sourceId: string;
  rebuiltAt: string;
  chunk: MemorySearchResult;
  sourceKind: string;
  sourceClass: MemorySourceInventoryClass;
  builtinInventoryId?: string;
  admission: ReturnType<typeof resolveMemorySourceAdmission>;
  identity: ReturnType<typeof resolveMemorySourceIdentity>;
}): MemoryTreeSourceRecord {
  return {
    id: input.sourceId,
    sourceKind: input.sourceKind,
    sourceClass: input.sourceClass,
    scope: toTreeScope(input.chunk.visibility),
    agentId: readAgentId(input.chunk),
    sourcePath: input.chunk.sourcePath,
    sourceRef: input.chunk.sourceType,
    contentHash: hashTreeSourcePayload({
      sourceId: input.sourceId,
      sourcePath: input.chunk.sourcePath,
      sourceType: input.chunk.sourceType,
      builtinInventoryId: input.builtinInventoryId ?? null,
      updatedAt: input.chunk.updatedAt ?? null,
      identity: input.identity,
      admission: input.admission,
    }),
    timeFrom: input.chunk.updatedAt,
    timeTo: input.chunk.updatedAt,
    itemCount: 1,
    metadata: {
      recordType: "tree_source_link",
      sourceType: input.chunk.sourceType,
      memoryTypes: input.chunk.memoryType ? [input.chunk.memoryType] : [],
      sourceRegistry: {
        admission: input.admission,
        identity: input.identity,
      },
    },
    createdAt: input.rebuiltAt,
    updatedAt: input.rebuiltAt,
  };
}

function findMatchingSourceRecord(
  chunk: MemorySearchResult,
  builtinInventoryId: string | undefined,
  existingSources: MemoryTreeSourceRecord[],
): MemoryTreeSourceRecord | undefined {
  if (builtinInventoryId) {
    const builtin = existingSources.find((item) => item.id === builtinInventoryId);
    if (builtin) {
      return builtin;
    }
  }
  const normalizedChunkPath = normalizeSourcePathForRegistryMatch(chunk.sourcePath);
  return existingSources.find((item) => {
    const normalizedRecordPath = normalizeSourcePathForRegistryMatch(item.sourcePath);
    if (!normalizedRecordPath) {
      return false;
    }
    if (normalizedChunkPath === normalizedRecordPath) {
      return true;
    }
    if (item.id.startsWith("configured:")) {
      return normalizedChunkPath.startsWith(`${normalizedRecordPath}/`);
    }
    return false;
  });
}

function buildDynamicMemoryTreeSourceId(sourcePath: string, sourceType: string, agentId?: string): string {
  return `dynamic:${hashTreeSourcePayload({
    sourcePath,
    sourceType,
    agentId: agentId ?? null,
  })}`;
}

function hashTreeSourcePayload(payload: unknown): string {
  return createHash("sha1")
    .update(JSON.stringify(payload))
    .digest("hex");
}

function toTreeScope(visibility?: MemoryVisibility): "private" | "shared" {
  return visibility === "shared" ? "shared" : "private";
}

function readAgentId(chunk: MemorySearchResult): string | undefined {
  const metadata = isRecord(chunk.metadata) ? chunk.metadata : {};
  const memoryTree = isRecord(metadata.memoryTree) ? metadata.memoryTree : {};
  return normalizeString(memoryTree.agentId) || normalizeString(metadata.agentId);
}

function readSourceKind(chunk: MemorySearchResult): string | undefined {
  const metadata = isRecord(chunk.metadata) ? chunk.metadata : {};
  const memoryTree = isRecord(metadata.memoryTree) ? metadata.memoryTree : {};
  return normalizeString(memoryTree.sourceKind);
}

function readSourceClass(chunk: MemorySearchResult): MemorySourceInventoryClass | undefined {
  const metadata = isRecord(chunk.metadata) ? chunk.metadata : {};
  const memoryTree = isRecord(metadata.memoryTree) ? metadata.memoryTree : {};
  return normalizeSourceClass(memoryTree.sourceClass);
}

function normalizeSourceClass(value: unknown): MemorySourceInventoryClass | undefined {
  switch (value) {
    case "raw":
    case "derived":
    case "curated":
      return value;
    default:
      return undefined;
  }
}

function normalizeWeight(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 1;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
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

function dedupeSourceClasses(values: MemorySourceInventoryClass[]): MemorySourceInventoryClass[] {
  const seen = new Set<MemorySourceInventoryClass>();
  const results: MemorySourceInventoryClass[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    results.push(value);
  }
  return results;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
