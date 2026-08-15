import type {
  MemoryDedupGovernanceRiskLevel,
  MemoryDedupGovernanceSignal,
  MemoryExactDedupGovernanceGroup,
  MemoryExactDedupGovernanceSummary,
  MemoryExactDedupPreviewGroup,
  MemoryExactDedupPreviewReport,
} from "./memory-dedup.js";

export function decorateMemoryExactDedupReportWithGovernance(
  report: MemoryExactDedupPreviewReport,
  options: {
    topGroupLimit?: number;
  } = {},
): MemoryExactDedupPreviewReport {
  const groups = report.groups.map((group) => ({
    ...group,
    governance: group.governance ?? buildMemoryExactDedupGroupGovernance(group),
  }));
  return {
    ...report,
    groups,
    governance: buildMemoryExactDedupGovernanceSummary({ groups }, options),
  };
}

export function buildMemoryExactDedupGovernanceSummary(
  input: Pick<MemoryExactDedupPreviewReport, "groups">,
  options: {
    topGroupLimit?: number;
  } = {},
): MemoryExactDedupGovernanceSummary {
  const topGroupLimit = normalizeTopGroupLimit(options.topGroupLimit);
  const groups = input.groups.map((group) => ({
    ...group,
    governance: group.governance ?? buildMemoryExactDedupGroupGovernance(group),
  }));

  const suggestedReviewGroupCount = groups.filter((group) => group.governance?.suggestedAction === "review").length;
  const suggestedKeepGroupCount = groups.filter((group) => group.governance?.suggestedAction === "keep").length;
  const suggestedArchiveGroupCount = groups.filter((group) => group.governance?.suggestedAction === "archive").length;
  const taskLinkedGroupCount = groups.filter((group) => (group.affectedTaskLinkCount ?? 0) > 0).length;
  const mixedSourceGroupCount = groups.filter((group) => group.governance?.signals.includes("mixed_reindexable")).length;
  const nonReindexableOnlyGroupCount = groups.filter((group) => group.governance?.signals.includes("non_reindexable_only")).length;

  return {
    headline: buildGovernanceHeadline({
      suggestedReviewGroupCount,
      suggestedKeepGroupCount,
      suggestedArchiveGroupCount,
      groupCount: groups.length,
    }),
    groupCount: groups.length,
    suggestedReviewGroupCount,
    suggestedKeepGroupCount,
    suggestedArchiveGroupCount,
    taskLinkedGroupCount,
    mixedSourceGroupCount,
    nonReindexableOnlyGroupCount,
    topSuggestedGroups: [...groups]
      .sort(compareSuggestedGroups)
      .slice(0, topGroupLimit),
  };
}

export function buildMemoryExactDedupGroupGovernance(
  group: MemoryExactDedupPreviewGroup,
): MemoryExactDedupGovernanceGroup {
  const signals = collectGovernanceSignals(group);
  const suggestedAction = resolveSuggestedAction(signals);
  return {
    suggestedAction,
    riskLevel: resolveRiskLevel(signals, suggestedAction),
    reviewRequired: suggestedAction === "review",
    rationale: buildGroupRationale(signals, suggestedAction),
    signals,
  };
}

function collectGovernanceSignals(group: MemoryExactDedupPreviewGroup): MemoryDedupGovernanceSignal[] {
  const signals: MemoryDedupGovernanceSignal[] = [];
  const sourceIndexing = group.sourceIndexing;
  if (!sourceIndexing) {
    signals.push("indexing_unknown");
  } else if (sourceIndexing.anyAffectedSourcePathReindexable && !sourceIndexing.allAffectedSourcePathsReindexable) {
    signals.push("mixed_reindexable");
  } else if (sourceIndexing.allAffectedSourcePathsReindexable) {
    signals.push("all_reindexable");
  } else if (!sourceIndexing.anyAffectedSourcePathReindexable) {
    signals.push("non_reindexable_only");
  }

  if (hasSharedVisibility(group)) {
    signals.push("shared_visibility");
  }
  if ((group.affectedTaskLinkCount ?? 0) > 0) {
    signals.push("task_linked");
  }
  return dedupeSignals(signals);
}

function resolveSuggestedAction(
  signals: MemoryDedupGovernanceSignal[],
): MemoryExactDedupGovernanceGroup["suggestedAction"] {
  if (
    signals.includes("mixed_reindexable")
    || signals.includes("task_linked")
    || signals.includes("indexing_unknown")
  ) {
    return "review";
  }
  if (signals.includes("all_reindexable")) {
    return "archive";
  }
  if (signals.includes("non_reindexable_only")) {
    return "keep";
  }
  return "review";
}

function resolveRiskLevel(
  signals: MemoryDedupGovernanceSignal[],
  suggestedAction: MemoryExactDedupGovernanceGroup["suggestedAction"],
): MemoryDedupGovernanceRiskLevel {
  if (signals.includes("shared_visibility") || signals.includes("mixed_reindexable")) {
    return "high";
  }
  if (suggestedAction === "review" || signals.includes("task_linked")) {
    return "medium";
  }
  return "low";
}

function buildGroupRationale(
  signals: MemoryDedupGovernanceSignal[],
  suggestedAction: MemoryExactDedupGovernanceGroup["suggestedAction"],
): string {
  if (signals.includes("mixed_reindexable")) {
    return "This duplicate group mixes reindexable and non-reindexable sources, so it should be reviewed before any archive action.";
  }
  if (signals.includes("shared_visibility")) {
    return "This duplicate group touches shared or team-visible memory, so it should be reviewed before any archive action.";
  }
  if (signals.includes("task_linked")) {
    return "This duplicate group still has task links on removable chunks, so it should be reviewed before any archive action.";
  }
  if (suggestedAction === "archive") {
    return "All affected chunks are reindexable and removable duplicates are not task-linked, so metadata archive is a safe first-step cleanup.";
  }
  if (suggestedAction === "keep") {
    return "Affected duplicates are not reindexable from a managed source yet, so keeping them is safer until source-level merge or ingest controls exist.";
  }
  return "Governance signals are incomplete, so this duplicate group should be reviewed manually.";
}

function buildGovernanceHeadline(input: {
  suggestedReviewGroupCount: number;
  suggestedKeepGroupCount: number;
  suggestedArchiveGroupCount: number;
  groupCount: number;
}): string {
  if (input.suggestedReviewGroupCount > 0) {
    return `Memory dedup suggestions need review: review=${input.suggestedReviewGroupCount}, keep=${input.suggestedKeepGroupCount}, archive=${input.suggestedArchiveGroupCount}, groups=${input.groupCount}.`;
  }
  if (input.suggestedKeepGroupCount > 0) {
    return `Memory dedup suggestions are mixed: keep=${input.suggestedKeepGroupCount}, archive=${input.suggestedArchiveGroupCount}, groups=${input.groupCount}.`;
  }
  return `Memory dedup suggestions stable: archive=${input.suggestedArchiveGroupCount}, groups=${input.groupCount}.`;
}

function compareSuggestedGroups(left: MemoryExactDedupPreviewGroup, right: MemoryExactDedupPreviewGroup): number {
  const actionDiff = rankSuggestedAction(right.governance?.suggestedAction) - rankSuggestedAction(left.governance?.suggestedAction);
  if (actionDiff !== 0) {
    return actionDiff;
  }
  const riskDiff = rankRiskLevel(right.governance?.riskLevel) - rankRiskLevel(left.governance?.riskLevel);
  if (riskDiff !== 0) {
    return riskDiff;
  }
  if ((right.affectedTaskLinkCount ?? 0) !== (left.affectedTaskLinkCount ?? 0)) {
    return (right.affectedTaskLinkCount ?? 0) - (left.affectedTaskLinkCount ?? 0);
  }
  if ((right.remove?.length ?? 0) !== (left.remove?.length ?? 0)) {
    return (right.remove?.length ?? 0) - (left.remove?.length ?? 0);
  }
  return String(left.keep?.id ?? "").localeCompare(String(right.keep?.id ?? ""), "zh-CN");
}

function rankSuggestedAction(
  value: MemoryExactDedupGovernanceGroup["suggestedAction"] | undefined,
): number {
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

function rankRiskLevel(value: MemoryDedupGovernanceRiskLevel | undefined): number {
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

function hasSharedVisibility(group: MemoryExactDedupPreviewGroup): boolean {
  return [group.keep, ...group.remove].some((item) => item?.visibility === "shared");
}

function dedupeSignals(signals: MemoryDedupGovernanceSignal[]): MemoryDedupGovernanceSignal[] {
  return [...new Set(signals)];
}

function normalizeTopGroupLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 3;
  }
  return Math.max(1, Math.min(10, Math.floor(value)));
}
