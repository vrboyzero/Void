import {
  classifyMemorySource,
  resolveMemorySourceAdmission,
  resolveMemorySourceIdentity,
} from "./memory-source-registry.js";
import type { MemorySourceInventoryClass } from "./memory-source-inventory.js";
import type { MemorySearchResult, MemoryVisibility } from "./types.js";

export function applySearchResultSourceRegistryHints(results: MemorySearchResult[]): MemorySearchResult[] {
  return (Array.isArray(results) ? results : []).map((result) => applySearchResultSourceRegistryHint(result));
}

function applySearchResultSourceRegistryHint(result: MemorySearchResult): MemorySearchResult {
  const metadata = isRecord(result.metadata) ? result.metadata : {};
  const currentMemoryTree = isRecord(metadata.memoryTree) ? metadata.memoryTree : {};
  const currentSourceKind = normalizeString(currentMemoryTree.sourceKind);
  const currentSourceClass = normalizeSourceClass(currentMemoryTree.sourceClass);

  const classification = classifyMemorySource(
    result.sourcePath,
    result.sourceType,
    result.memoryType ? [result.memoryType] : undefined,
  );
  const sourceKind = currentSourceKind || classification.sourceKind;
  const sourceClass = currentSourceClass || classification.sourceClass;
  const identity = resolveMemorySourceIdentity({
    id: result.id,
    sourceKind,
    sourceClass,
    scope: toInventoryScope(result.visibility),
    sourcePath: result.sourcePath,
    sourceRef: result.id,
    updatedAt: result.updatedAt,
  });
  const admission = resolveMemorySourceAdmission({
    sourceKind,
    sourceClass,
  });

  return {
    ...result,
    metadata: {
      ...metadata,
      memoryTree: {
        ...currentMemoryTree,
        sourceKind,
        sourceClass,
        sourceFamilyKey: normalizeString(currentMemoryTree.sourceFamilyKey) || identity.sourceFamilyKey,
        canonicalSourceKey: normalizeString(currentMemoryTree.canonicalSourceKey) || identity.canonicalSourceKey,
        revisionHint: normalizeString(currentMemoryTree.revisionHint) || identity.revisionHint,
        sourceRegistry: {
          sourceKind,
          sourceClass,
          sourceFamilyKey: normalizeString(currentMemoryTree.sourceFamilyKey) || identity.sourceFamilyKey,
          canonicalSourceKey: normalizeString(currentMemoryTree.canonicalSourceKey) || identity.canonicalSourceKey,
          searchPolicy: admission.searchPolicy,
          dedupPolicy: admission.dedupPolicy,
          retentionHint: admission.retentionHint,
        },
      },
    },
  };
}

function toInventoryScope(visibility?: MemoryVisibility): "private" | "shared" {
  return visibility === "shared" ? "shared" : "private";
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
