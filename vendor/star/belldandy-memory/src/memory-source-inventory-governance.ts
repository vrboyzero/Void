import type {
  MemorySourceInventoryClass,
  MemorySourceInventoryDuplicateRiskLevel,
  MemorySourceInventoryFamily,
  MemorySourceInventoryReport,
} from "./memory-source-inventory.js";
import type { MemorySourceSearchPolicy } from "./memory-source-registry.js";
import {
  buildMemorySourceCoveragePolicyExplanations,
  type MemorySourceCoveragePolicyExplanation,
} from "./memory-source-coverage-explanations.js";

export type MemorySourceInventoryGovernanceSuggestedAction = "review" | "keep" | "archive";
export type MemorySourceInventoryGovernanceRiskLevel = "low" | "medium" | "high";
export type MemorySourceInventoryGovernanceCategory = "source_duplicate" | "derived_overlap";
export type MemorySourceInventoryGovernanceSignal =
  | "mixed_source_classes"
  | "multi_searchable"
  | "summary_overlay"
  | "inventory_only_support"
  | "configured_external_member"
  | "derived_only_stack";

export type MemorySourceInventoryGovernanceFamilySummary = {
  sourceFamilyKey: string;
  memberCount: number;
  presentMemberCount: number;
  sourceClasses: MemorySourceInventoryClass[];
  searchPolicies: MemorySourceSearchPolicy[];
  duplicateRiskLevel: MemorySourceInventoryDuplicateRiskLevel;
  duplicateRiskRationale: string;
};

export type MemorySourceInventoryGovernanceFamilySuggestion = MemorySourceInventoryGovernanceFamilySummary & {
  category: MemorySourceInventoryGovernanceCategory;
  suggestedAction: MemorySourceInventoryGovernanceSuggestedAction;
  riskLevel: MemorySourceInventoryGovernanceRiskLevel;
  reviewRequired: boolean;
  rationale: string;
  signals: MemorySourceInventoryGovernanceSignal[];
  searchableMemberCount: number;
  summaryInputOnlyMemberCount: number;
  inventoryOnlyMemberCount: number;
  presentMemberLabels: string[];
};

export type MemorySourceInventoryGovernanceSummary = {
  headline: string;
  sourceKinds: number;
  presentSourceKinds: number;
  sourceFamilyCount: number;
  multiMemberFamilyCount: number;
  highRiskFamilyCount: number;
  suggestedReviewFamilyCount: number;
  suggestedKeepFamilyCount: number;
  suggestedArchiveFamilyCount: number;
  sourceDuplicateFamilyCount: number;
  derivedOverlapFamilyCount: number;
  searchableItemCount: number;
  summaryInputOnlyItemCount: number;
  inventoryOnlyItemCount: number;
  searchPolicyExplanations: MemorySourceCoveragePolicyExplanation[];
  topHighRiskFamilies: MemorySourceInventoryGovernanceFamilySummary[];
  topSuggestedFamilies: MemorySourceInventoryGovernanceFamilySuggestion[];
};

export type MemorySourceInventoryDoctorCheck = {
  id: string;
  name: string;
  status: "pass" | "warn";
  message: string;
  detail?: Record<string, unknown>;
};

export type MemorySourceInventoryDoctorReport = {
  generatedAt: string;
  headline: string;
  summary: MemorySourceInventoryGovernanceSummary;
  checks: MemorySourceInventoryDoctorCheck[];
};

export function buildMemorySourceInventoryGovernanceSummary(
  report: MemorySourceInventoryReport,
  options: {
    topFamilyLimit?: number;
  } = {},
): MemorySourceInventoryGovernanceSummary {
  const topFamilyLimit = normalizeTopFamilyLimit(options.topFamilyLimit);
  const governedFamilies = report.families
    .filter((family) => family.memberCount > 1)
    .map(buildGovernanceSuggestion);
  const topHighRiskFamilies = report.families
    .filter((family) => family.duplicateRisk.level === "high")
    .sort(compareInventoryFamilyRisk)
    .slice(0, topFamilyLimit)
    .map(summarizeInventoryFamily);
  const suggestedReviewFamilyCount = governedFamilies.filter((family) => family.suggestedAction === "review").length;
  const suggestedKeepFamilyCount = governedFamilies.filter((family) => family.suggestedAction === "keep").length;
  const suggestedArchiveFamilyCount = governedFamilies.filter((family) => family.suggestedAction === "archive").length;
  const sourceDuplicateFamilyCount = governedFamilies.filter((family) => family.category === "source_duplicate").length;
  const derivedOverlapFamilyCount = governedFamilies.filter((family) => family.category === "derived_overlap").length;
  const summary: MemorySourceInventoryGovernanceSummary = {
    headline: "",
    sourceKinds: report.totals.sourceKinds,
    presentSourceKinds: report.totals.presentSourceKinds,
    sourceFamilyCount: report.totals.sourceFamilyCount,
    multiMemberFamilyCount: report.totals.multiMemberFamilyCount,
    highRiskFamilyCount: report.totals.highRiskFamilyCount,
    suggestedReviewFamilyCount,
    suggestedKeepFamilyCount,
    suggestedArchiveFamilyCount,
    sourceDuplicateFamilyCount,
    derivedOverlapFamilyCount,
    searchableItemCount: report.totals.bySearchPolicy.searchable,
    summaryInputOnlyItemCount: report.totals.bySearchPolicy["summary-input-only"],
    inventoryOnlyItemCount: report.totals.bySearchPolicy["inventory-only"],
    searchPolicyExplanations: buildMemorySourceCoveragePolicyExplanations(),
    topHighRiskFamilies,
    topSuggestedFamilies: [...governedFamilies]
      .sort(compareSuggestedFamilies)
      .slice(0, topFamilyLimit),
  };
  summary.headline = buildMemorySourceInventoryHeadline(summary);
  return summary;
}

export function buildMemorySourceInventoryDoctorReport(
  report: MemorySourceInventoryReport,
  options: {
    topFamilyLimit?: number;
  } = {},
): MemorySourceInventoryDoctorReport {
  const summary = buildMemorySourceInventoryGovernanceSummary(report, options);
  const headline = summary.headline;
  return {
    generatedAt: report.generatedAt,
    headline,
    summary,
    checks: [
      {
        id: "memory_source_inventory",
        name: "Memory Source Inventory",
        status: summary.highRiskFamilyCount > 0 ? "warn" : "pass",
        message: headline,
        detail: {
          sourceKinds: summary.sourceKinds,
          presentSourceKinds: summary.presentSourceKinds,
          sourceFamilyCount: summary.sourceFamilyCount,
          multiMemberFamilyCount: summary.multiMemberFamilyCount,
          highRiskFamilyCount: summary.highRiskFamilyCount,
          suggestedReviewFamilyCount: summary.suggestedReviewFamilyCount,
          suggestedKeepFamilyCount: summary.suggestedKeepFamilyCount,
          suggestedArchiveFamilyCount: summary.suggestedArchiveFamilyCount,
          sourceDuplicateFamilyCount: summary.sourceDuplicateFamilyCount,
          derivedOverlapFamilyCount: summary.derivedOverlapFamilyCount,
          searchableItemCount: summary.searchableItemCount,
          summaryInputOnlyItemCount: summary.summaryInputOnlyItemCount,
          inventoryOnlyItemCount: summary.inventoryOnlyItemCount,
          searchPolicyExplanations: summary.searchPolicyExplanations,
          topHighRiskFamilies: summary.topHighRiskFamilies,
          topSuggestedFamilies: summary.topSuggestedFamilies,
        },
      },
    ],
  };
}

function buildMemorySourceInventoryHeadline(summary: MemorySourceInventoryGovernanceSummary): string {
  if (summary.suggestedReviewFamilyCount > 0) {
    return `Memory source families need review: review=${summary.suggestedReviewFamilyCount}, keep=${summary.suggestedKeepFamilyCount}, archive=${summary.suggestedArchiveFamilyCount}, derivedOverlap=${summary.derivedOverlapFamilyCount}, sourceDuplicate=${summary.sourceDuplicateFamilyCount}, searchable=${summary.searchableItemCount}, summaryInputOnly=${summary.summaryInputOnlyItemCount}, inventoryOnly=${summary.inventoryOnlyItemCount}; top=${formatTopSuggestedFamilies(summary.topSuggestedFamilies)}.`;
  }
  if (summary.highRiskFamilyCount > 0) {
    return `Memory source families need review: families=${summary.sourceFamilyCount}, highRisk=${summary.highRiskFamilyCount}, multiMember=${summary.multiMemberFamilyCount}, searchable=${summary.searchableItemCount}, summaryInputOnly=${summary.summaryInputOnlyItemCount}, inventoryOnly=${summary.inventoryOnlyItemCount}; top=${formatTopInventoryFamilies(summary.topHighRiskFamilies)}.`;
  }
  if (summary.suggestedKeepFamilyCount > 0 || summary.suggestedArchiveFamilyCount > 0) {
    return `Memory source families layered: keep=${summary.suggestedKeepFamilyCount}, archive=${summary.suggestedArchiveFamilyCount}, multiMember=${summary.multiMemberFamilyCount}, searchable=${summary.searchableItemCount}, summaryInputOnly=${summary.summaryInputOnlyItemCount}, inventoryOnly=${summary.inventoryOnlyItemCount}.`;
  }
  if (summary.multiMemberFamilyCount > 0) {
    return `Memory source families stable: families=${summary.sourceFamilyCount}, multiMember=${summary.multiMemberFamilyCount}, highRisk=0, searchable=${summary.searchableItemCount}, summaryInputOnly=${summary.summaryInputOnlyItemCount}, inventoryOnly=${summary.inventoryOnlyItemCount}.`;
  }
  return `Memory source families stable: families=${summary.sourceFamilyCount}, highRisk=0, searchable=${summary.searchableItemCount}, summaryInputOnly=${summary.summaryInputOnlyItemCount}, inventoryOnly=${summary.inventoryOnlyItemCount}.`;
}

function formatTopInventoryFamilies(families: MemorySourceInventoryGovernanceFamilySummary[]): string {
  if (families.length <= 0) {
    return "none";
  }
  return families
    .map((family) => `${family.sourceFamilyKey}(${family.memberCount}, ${family.sourceClasses.join("+")})`)
    .join(", ");
}

function formatTopSuggestedFamilies(families: MemorySourceInventoryGovernanceFamilySuggestion[]): string {
  if (families.length <= 0) {
    return "none";
  }
  return families
    .map((family) => `${family.sourceFamilyKey}(${family.category}, ${family.suggestedAction})`)
    .join(", ");
}

function summarizeInventoryFamily(family: MemorySourceInventoryFamily): MemorySourceInventoryGovernanceFamilySummary {
  return {
    sourceFamilyKey: family.sourceFamilyKey,
    memberCount: family.memberCount,
    presentMemberCount: family.presentMemberCount,
    sourceClasses: [...family.sourceClasses],
    searchPolicies: [...family.searchPolicies],
    duplicateRiskLevel: family.duplicateRisk.level,
    duplicateRiskRationale: family.duplicateRisk.rationale,
  };
}

function buildGovernanceSuggestion(
  family: MemorySourceInventoryFamily,
): MemorySourceInventoryGovernanceFamilySuggestion {
  const summary = summarizeInventoryFamily(family);
  const searchableMemberCount = family.members.filter((member) => member.searchPolicy === "searchable").length;
  const summaryInputOnlyMemberCount = family.members.filter((member) => member.searchPolicy === "summary-input-only").length;
  const inventoryOnlyMemberCount = family.members.filter((member) => member.searchPolicy === "inventory-only").length;
  const signals = collectGovernanceSignals(family, {
    searchableMemberCount,
    summaryInputOnlyMemberCount,
    inventoryOnlyMemberCount,
  });
  const category = resolveGovernanceCategory(signals);
  const suggestedAction = resolveSuggestedAction(signals);
  return {
    ...summary,
    category,
    suggestedAction,
    riskLevel: resolveRiskLevel(signals, suggestedAction),
    reviewRequired: suggestedAction === "review",
    rationale: buildSuggestionRationale(signals, suggestedAction),
    signals,
    searchableMemberCount,
    summaryInputOnlyMemberCount,
    inventoryOnlyMemberCount,
    presentMemberLabels: family.members
      .filter((member) => member.status === "present")
      .map((member) => member.label),
  };
}

function collectGovernanceSignals(
  family: MemorySourceInventoryFamily,
  counts: {
    searchableMemberCount: number;
    summaryInputOnlyMemberCount: number;
    inventoryOnlyMemberCount: number;
  },
): MemorySourceInventoryGovernanceSignal[] {
  const signals: MemorySourceInventoryGovernanceSignal[] = [];
  if (family.sourceClasses.length > 1) {
    signals.push("mixed_source_classes");
  }
  if (counts.searchableMemberCount > 1) {
    signals.push("multi_searchable");
  }
  if (counts.searchableMemberCount > 0 && counts.summaryInputOnlyMemberCount > 0) {
    signals.push("summary_overlay");
  }
  if (counts.inventoryOnlyMemberCount > 0) {
    signals.push("inventory_only_support");
  }
  if (family.members.some((member) => member.sourceKind === "configured_external")) {
    signals.push("configured_external_member");
  }
  if (
    family.sourceClasses.length === 1
    && family.sourceClasses[0] === "derived"
    && family.memberCount > 1
  ) {
    signals.push("derived_only_stack");
  }
  return [...new Set(signals)];
}

function resolveGovernanceCategory(
  signals: MemorySourceInventoryGovernanceSignal[],
): MemorySourceInventoryGovernanceCategory {
  if (
    signals.includes("mixed_source_classes")
    || signals.includes("derived_only_stack")
  ) {
    return "derived_overlap";
  }
  return "source_duplicate";
}

function resolveSuggestedAction(
  signals: MemorySourceInventoryGovernanceSignal[],
): MemorySourceInventoryGovernanceSuggestedAction {
  if (
    signals.includes("mixed_source_classes")
    || signals.includes("multi_searchable")
    || signals.includes("configured_external_member")
  ) {
    return "review";
  }
  if (
    signals.includes("derived_only_stack")
    && !signals.includes("summary_overlay")
    && !signals.includes("inventory_only_support")
  ) {
    return "archive";
  }
  return "keep";
}

function resolveRiskLevel(
  signals: MemorySourceInventoryGovernanceSignal[],
  suggestedAction: MemorySourceInventoryGovernanceSuggestedAction,
): MemorySourceInventoryGovernanceRiskLevel {
  if (
    signals.includes("mixed_source_classes")
    || signals.includes("multi_searchable")
  ) {
    return "high";
  }
  if (
    suggestedAction === "review"
    || signals.includes("configured_external_member")
    || signals.includes("derived_only_stack")
  ) {
    return "medium";
  }
  return "low";
}

function buildSuggestionRationale(
  signals: MemorySourceInventoryGovernanceSignal[],
  suggestedAction: MemorySourceInventoryGovernanceSuggestedAction,
): string {
  if (signals.includes("mixed_source_classes")) {
    return "This family mixes raw and derived layers, so the overlap should be reviewed before treating the layering as stable.";
  }
  if (signals.includes("multi_searchable")) {
    return "This family has more than one searchable member, so the same evidence may surface repeatedly in retrieval and should be reviewed.";
  }
  if (signals.includes("configured_external_member")) {
    return "This family already includes a configured external source alongside other members, so source-level overlap should be reviewed before import or merge.";
  }
  if (suggestedAction === "archive") {
    return "This family is made of derived-only support layers, so it is a candidate for later compaction once a canonical layer is confirmed.";
  }
  return "This family already looks split by role, so it can be kept as a layered source set and tracked in governance instead of treated as an immediate duplicate.";
}

function compareInventoryFamilyRisk(left: MemorySourceInventoryFamily, right: MemorySourceInventoryFamily): number {
  if (right.memberCount !== left.memberCount) {
    return right.memberCount - left.memberCount;
  }
  if (right.presentMemberCount !== left.presentMemberCount) {
    return right.presentMemberCount - left.presentMemberCount;
  }
  return left.sourceFamilyKey.localeCompare(right.sourceFamilyKey, "zh-CN");
}

function compareSuggestedFamilies(
  left: MemorySourceInventoryGovernanceFamilySuggestion,
  right: MemorySourceInventoryGovernanceFamilySuggestion,
): number {
  const actionDiff = rankSuggestedAction(right.suggestedAction) - rankSuggestedAction(left.suggestedAction);
  if (actionDiff !== 0) {
    return actionDiff;
  }
  const riskDiff = rankRiskLevel(right.riskLevel) - rankRiskLevel(left.riskLevel);
  if (riskDiff !== 0) {
    return riskDiff;
  }
  if (right.memberCount !== left.memberCount) {
    return right.memberCount - left.memberCount;
  }
  return left.sourceFamilyKey.localeCompare(right.sourceFamilyKey, "zh-CN");
}

function rankSuggestedAction(value: MemorySourceInventoryGovernanceSuggestedAction): number {
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

function rankRiskLevel(value: MemorySourceInventoryGovernanceRiskLevel): number {
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

function normalizeTopFamilyLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 3;
  }
  return Math.max(1, Math.min(10, Math.floor(value)));
}
