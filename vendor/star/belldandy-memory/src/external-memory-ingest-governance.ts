import type { ExternalMemoryIngestPreview } from "./external-memory-ingest.js";
import type {
  MemorySourceInventoryClass,
  MemorySourceInventoryScope,
} from "./memory-source-inventory.js";
import type { MemorySourceSearchPolicy } from "./memory-source-registry.js";

export type ExternalMemoryIngestGovernanceSuggestedAction = "review" | "keep" | "archive";
export type ExternalMemoryIngestGovernanceRiskLevel = "low" | "medium" | "high";
export type ExternalMemoryIngestGovernanceSuggestionCategory =
  | "external_import_duplicate"
  | "external_import_root_overlap"
  | "external_rescan_replace";
export type ExternalMemoryIngestGovernanceSignal =
  | "exact_path_conflict"
  | "root_path_overlap"
  | "same_source_rescan"
  | "searchable_conflict"
  | "shared_scope_conflict"
  | "mixed_source_lineage";

export type ExternalMemoryIngestGovernanceIndexedSource = {
  sourcePath: string;
  sourceKind: string;
  sourceClass: MemorySourceInventoryClass;
  scope: MemorySourceInventoryScope;
  searchPolicy: MemorySourceSearchPolicy;
  externalSourceId?: string;
};

export type ExternalMemoryIngestGovernanceSuggestion = {
  category: ExternalMemoryIngestGovernanceSuggestionCategory;
  suggestedAction: ExternalMemoryIngestGovernanceSuggestedAction;
  riskLevel: ExternalMemoryIngestGovernanceRiskLevel;
  reviewRequired: boolean;
  rationale: string;
  signals: ExternalMemoryIngestGovernanceSignal[];
  fileCount: number;
  samplePaths: string[];
  conflictingSourceKinds: string[];
  conflictingExternalSourceIds: string[];
};

export type ExternalMemoryIngestGovernanceSummary = {
  headline: string;
  reviewSuggestionCount: number;
  keepSuggestionCount: number;
  archiveSuggestionCount: number;
  duplicateFileCount: number;
  rootOverlapFileCount: number;
  sameSourceRescanFileCount: number;
  topSuggestions: ExternalMemoryIngestGovernanceSuggestion[];
};

export function buildExternalMemoryIngestGovernanceSummary(
  preview: ExternalMemoryIngestPreview,
  input: {
    indexedSources: ExternalMemoryIngestGovernanceIndexedSource[];
    topSuggestionLimit?: number;
  },
): ExternalMemoryIngestGovernanceSummary {
  const topSuggestionLimit = normalizeTopSuggestionLimit(input.topSuggestionLimit);
  const eligibleFiles = preview.fileManifest.filter((file) => file.status === "eligible");
  const indexedSources = Array.isArray(input.indexedSources) ? input.indexedSources : [];
  const indexedByPath = new Map<string, ExternalMemoryIngestGovernanceIndexedSource[]>();
  for (const source of indexedSources) {
    const normalizedPath = normalizePath(source.sourcePath);
    if (!normalizedPath) {
      continue;
    }
    const entries = indexedByPath.get(normalizedPath) ?? [];
    entries.push(source);
    indexedByPath.set(normalizedPath, entries);
  }

  const normalizedRootPath = normalizePath(preview.rootPath);
  const sameSourceRescanPaths = new Set<string>();
  const exactConflictPaths = new Set<string>();
  const rootOverlapPaths = new Set<string>();
  const exactConflicts: ExternalMemoryIngestGovernanceIndexedSource[] = [];
  const rootConflicts: ExternalMemoryIngestGovernanceIndexedSource[] = [];

  for (const file of eligibleFiles) {
    const normalizedFilePath = normalizePath(file.path);
    const exactMatches = indexedByPath.get(normalizedFilePath) ?? [];
    const sameSourceMatches = exactMatches.filter((item) => item.externalSourceId === preview.sourceId);
    const conflictingMatches = exactMatches.filter((item) => item.externalSourceId !== preview.sourceId);
    if (sameSourceMatches.length > 0) {
      sameSourceRescanPaths.add(file.path);
    }
    if (conflictingMatches.length > 0) {
      exactConflictPaths.add(file.path);
      exactConflicts.push(...conflictingMatches);
    }
  }

  for (const source of indexedSources) {
    const normalizedSourcePath = normalizePath(source.sourcePath);
    if (!normalizedSourcePath || !normalizedRootPath) {
      continue;
    }
    if (!normalizedSourcePath.startsWith(`${normalizedRootPath}/`) && normalizedSourcePath !== normalizedRootPath) {
      continue;
    }
    if (source.externalSourceId === preview.sourceId) {
      continue;
    }
    rootOverlapPaths.add(source.sourcePath);
    rootConflicts.push(source);
  }

  const suggestions: ExternalMemoryIngestGovernanceSuggestion[] = [];
  if (exactConflictPaths.size > 0) {
    const signals = collectSignals(exactConflicts, ["exact_path_conflict"]);
    suggestions.push({
      category: "external_import_duplicate",
      suggestedAction: "review",
      riskLevel: resolveRiskLevel(signals),
      reviewRequired: true,
      rationale: buildRationale("external_import_duplicate", signals),
      signals,
      fileCount: exactConflictPaths.size,
      samplePaths: [...exactConflictPaths].sort((left, right) => left.localeCompare(right, "en-US")).slice(0, 5),
      conflictingSourceKinds: uniqueStrings(exactConflicts.map((item) => item.sourceKind)),
      conflictingExternalSourceIds: uniqueStrings(exactConflicts.map((item) => item.externalSourceId).filter(isTruthy)),
    });
  }
  if (rootOverlapPaths.size > 0) {
    const signals = collectSignals(rootConflicts, ["root_path_overlap"]);
    suggestions.push({
      category: "external_import_root_overlap",
      suggestedAction: "review",
      riskLevel: resolveRiskLevel(signals),
      reviewRequired: true,
      rationale: buildRationale("external_import_root_overlap", signals),
      signals,
      fileCount: rootOverlapPaths.size,
      samplePaths: [...rootOverlapPaths].sort((left, right) => left.localeCompare(right, "en-US")).slice(0, 5),
      conflictingSourceKinds: uniqueStrings(rootConflicts.map((item) => item.sourceKind)),
      conflictingExternalSourceIds: uniqueStrings(rootConflicts.map((item) => item.externalSourceId).filter(isTruthy)),
    });
  }
  if (sameSourceRescanPaths.size > 0 && exactConflictPaths.size === 0) {
    suggestions.push({
      category: "external_rescan_replace",
      suggestedAction: "keep",
      riskLevel: "low",
      reviewRequired: false,
      rationale: "These files already belong to the same external source lineage, so the rescan behaves like a source refresh instead of introducing a new duplicate family.",
      signals: ["same_source_rescan"],
      fileCount: sameSourceRescanPaths.size,
      samplePaths: [...sameSourceRescanPaths].sort((left, right) => left.localeCompare(right, "en-US")).slice(0, 5),
      conflictingSourceKinds: ["configured_external"],
      conflictingExternalSourceIds: [preview.sourceId],
    });
  }

  const summary: ExternalMemoryIngestGovernanceSummary = {
    headline: "",
    reviewSuggestionCount: suggestions.filter((item) => item.suggestedAction === "review").length,
    keepSuggestionCount: suggestions.filter((item) => item.suggestedAction === "keep").length,
    archiveSuggestionCount: suggestions.filter((item) => item.suggestedAction === "archive").length,
    duplicateFileCount: exactConflictPaths.size,
    rootOverlapFileCount: rootOverlapPaths.size,
    sameSourceRescanFileCount: sameSourceRescanPaths.size,
    topSuggestions: [...suggestions]
      .sort(compareSuggestions)
      .slice(0, topSuggestionLimit),
  };
  summary.headline = buildHeadline(summary);
  return summary;
}

function collectSignals(
  conflicts: ExternalMemoryIngestGovernanceIndexedSource[],
  baseSignals: ExternalMemoryIngestGovernanceSignal[],
): ExternalMemoryIngestGovernanceSignal[] {
  const signals = [...baseSignals];
  if (conflicts.some((item) => item.searchPolicy === "searchable")) {
    signals.push("searchable_conflict");
  }
  if (conflicts.some((item) => item.scope === "shared" || item.scope === "team")) {
    signals.push("shared_scope_conflict");
  }
  const distinctLineages = new Set(
    conflicts.map((item) => item.externalSourceId ? `external:${item.externalSourceId}` : `source:${item.sourceKind}`),
  );
  if (distinctLineages.size > 1) {
    signals.push("mixed_source_lineage");
  }
  return uniqueStrings(signals) as ExternalMemoryIngestGovernanceSignal[];
}

function resolveRiskLevel(
  signals: ExternalMemoryIngestGovernanceSignal[],
): ExternalMemoryIngestGovernanceRiskLevel {
  if (
    signals.includes("shared_scope_conflict")
    || signals.includes("searchable_conflict")
    || signals.includes("exact_path_conflict")
  ) {
    return "high";
  }
  if (
    signals.includes("root_path_overlap")
    || signals.includes("mixed_source_lineage")
  ) {
    return "medium";
  }
  return "low";
}

function buildRationale(
  category: ExternalMemoryIngestGovernanceSuggestionCategory,
  signals: ExternalMemoryIngestGovernanceSignal[],
): string {
  if (category === "external_import_duplicate") {
    if (signals.includes("shared_scope_conflict")) {
      return "At least one preview file already exists in shared or team-visible memory, so the external import should be reviewed before creating another copy.";
    }
    if (signals.includes("searchable_conflict")) {
      return "At least one preview file is already present in a searchable source lineage, so importing it again would likely duplicate what retrieval already sees.";
    }
    return "At least one preview file already exists in another source lineage, so the external import should be reviewed before creating another copy.";
  }
  if (category === "external_import_root_overlap") {
    return "This root already contains indexed files from another source lineage, so the import boundary should be reviewed before expanding the external source.";
  }
  return "This preview mostly refreshes files that already belong to the same external source lineage, so it can stay in the normal rescan path instead of being treated as a new duplicate.";
}

function buildHeadline(summary: ExternalMemoryIngestGovernanceSummary): string {
  if (summary.reviewSuggestionCount > 0) {
    return `External ingest governance needs review: review=${summary.reviewSuggestionCount}, keep=${summary.keepSuggestionCount}, duplicateFiles=${summary.duplicateFileCount}, rootOverlapFiles=${summary.rootOverlapFileCount}.`;
  }
  if (summary.keepSuggestionCount > 0) {
    return `External ingest governance stable: keep=${summary.keepSuggestionCount}, sameSourceRescanFiles=${summary.sameSourceRescanFileCount}.`;
  }
  return "External ingest governance stable: no overlap suggestions detected.";
}

function compareSuggestions(
  left: ExternalMemoryIngestGovernanceSuggestion,
  right: ExternalMemoryIngestGovernanceSuggestion,
): number {
  const actionDiff = rankSuggestedAction(right.suggestedAction) - rankSuggestedAction(left.suggestedAction);
  if (actionDiff !== 0) {
    return actionDiff;
  }
  const riskDiff = rankRiskLevel(right.riskLevel) - rankRiskLevel(left.riskLevel);
  if (riskDiff !== 0) {
    return riskDiff;
  }
  if (right.fileCount !== left.fileCount) {
    return right.fileCount - left.fileCount;
  }
  return left.category.localeCompare(right.category, "en-US");
}

function rankSuggestedAction(value: ExternalMemoryIngestGovernanceSuggestedAction): number {
  switch (value) {
    case "review":
      return 3;
    case "keep":
      return 2;
    case "archive":
      return 1;
    default:
      return 0;
  }
}

function rankRiskLevel(value: ExternalMemoryIngestGovernanceRiskLevel): number {
  switch (value) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

function normalizeTopSuggestionLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 3;
  }
  return Math.max(1, Math.min(10, Math.floor(value)));
}

function normalizePath(value?: string): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
}

function isTruthy<T>(value: T | null | undefined | false | ""): value is T {
  return Boolean(value);
}
