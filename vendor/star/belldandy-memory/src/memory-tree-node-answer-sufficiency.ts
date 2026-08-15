import type { MemoryTreeNodeSearchResult } from "./memory-tree-types.js";
import type { MemoryTreeNodeRoutingPlan } from "./memory-tree-node-intent.js";

export type MemoryTreeNodeAnswerStage = "high_level" | "evidence";

export type MemoryTreeNodeAnswerSelection = {
  node: MemoryTreeNodeSearchResult;
  nodeIndex: number;
  chunkIndex: number;
  stage: MemoryTreeNodeAnswerStage;
};

export type MemoryTreeNodeAnswerStrategy = {
  answerSufficient: boolean;
  evidenceExpanded: boolean;
  highLevelOnly: boolean;
  evidenceChunkCount: number;
  selectedNodeIds: string[];
  selections: MemoryTreeNodeAnswerSelection[];
};

type BuildMemoryTreeNodeAnswerStrategyInput = {
  limit: number;
  routingPlan: MemoryTreeNodeRoutingPlan;
  nodeResults: MemoryTreeNodeSearchResult[];
};

export function buildMemoryTreeNodeAnswerStrategy(
  input: BuildMemoryTreeNodeAnswerStrategyInput,
): MemoryTreeNodeAnswerStrategy {
  const limit = Number.isFinite(input.limit) ? Math.max(1, Math.floor(input.limit)) : 1;
  const candidates = input.nodeResults.filter((item) => item.chunks.length > 0);
  if (candidates.length <= 0) {
    return {
      answerSufficient: false,
      evidenceExpanded: false,
      highLevelOnly: false,
      evidenceChunkCount: 0,
      selectedNodeIds: [],
      selections: [],
    };
  }

  const answerSufficient = isHighLevelAnswerSufficient(candidates, input.routingPlan);
  if (answerSufficient) {
    return finalizeSelections({
      answerSufficient: true,
      selections: [{
        node: candidates[0]!,
        nodeIndex: 0,
        chunkIndex: 0,
        stage: "high_level",
      }],
    });
  }

  const totalBudget = resolveSelectionBudget(limit, input.routingPlan);
  const selections: MemoryTreeNodeAnswerSelection[] = [];
  const seenChunkIds = new Set<string>();

  for (const [nodeIndex, nodeResult] of candidates.entries()) {
    const nodeBudget = resolveNodeBudget(nodeIndex, input.routingPlan);
    if (nodeBudget <= 0) {
      continue;
    }
    for (let chunkIndex = 0; chunkIndex < Math.min(nodeBudget, nodeResult.chunks.length); chunkIndex += 1) {
      const chunk = nodeResult.chunks[chunkIndex];
      if (!chunk || seenChunkIds.has(chunk.id)) {
        continue;
      }
      selections.push({
        node: nodeResult,
        nodeIndex,
        chunkIndex,
        stage: nodeIndex === 0 && chunkIndex === 0 ? "high_level" : "evidence",
      });
      seenChunkIds.add(chunk.id);
      if (selections.length >= totalBudget) {
        return finalizeSelections({
          answerSufficient: false,
          selections,
        });
      }
    }
  }

  return finalizeSelections({
    answerSufficient: false,
    selections,
  });
}

function finalizeSelections(input: {
  answerSufficient: boolean;
  selections: MemoryTreeNodeAnswerSelection[];
}): MemoryTreeNodeAnswerStrategy {
  const evidenceChunkCount = input.selections.filter((item) => item.stage === "evidence").length;
  return {
    answerSufficient: input.answerSufficient,
    evidenceExpanded: evidenceChunkCount > 0,
    highLevelOnly: input.selections.length > 0 && evidenceChunkCount === 0,
    evidenceChunkCount,
    selectedNodeIds: [...new Set(input.selections.map((item) => item.node.node.id))],
    selections: input.selections,
  };
}

function isHighLevelAnswerSufficient(
  nodeResults: MemoryTreeNodeSearchResult[],
  routingPlan: MemoryTreeNodeRoutingPlan,
): boolean {
  if (!routingPlan.preferHighLevel) {
    return false;
  }
  if (routingPlan.routeClass === "topic_lookup" || routingPlan.routeClass === "evidence_trace" || routingPlan.routeClass === "general") {
    return false;
  }
  const topNode = nodeResults[0];
  if (!topNode || topNode.chunks.length <= 0) {
    return false;
  }

  const preferredKinds = resolvePreferredKinds(routingPlan.routeClass);
  if (preferredKinds.length > 0 && !preferredKinds.includes(topNode.node.kind)) {
    return false;
  }

  const summaryStrength = measureSummaryStrength(topNode.node.summary);
  const strongIntentMatch = topNode.matchReasons.some((reason) => reason.startsWith("intent:"));
  const scoreStrong = topNode.score >= resolveSufficiencyScoreThreshold(routingPlan.routeClass);
  const nextScore = nodeResults[1]?.score ?? 0;
  const dominanceGapStrong = nodeResults.length === 1 || (topNode.score - nextScore) >= 1.25;

  return summaryStrength >= 2 && dominanceGapStrong && (scoreStrong || strongIntentMatch);
}

function resolveSelectionBudget(limit: number, routingPlan: MemoryTreeNodeRoutingPlan): number {
  switch (routingPlan.routeClass) {
    case "evidence_trace":
      return Math.min(Math.max(limit + 1, 4), 6);
    case "topic_lookup":
      return Math.min(Math.max(limit, 3), 4);
    case "project_status":
    case "profile_overview":
    case "global_overview":
      return Math.min(Math.max(limit, 3), 4);
    default:
      return Math.min(Math.max(limit, 2), 3);
  }
}

function resolveNodeBudget(nodeIndex: number, routingPlan: MemoryTreeNodeRoutingPlan): number {
  const perNodeLimit = Math.max(1, routingPlan.chunkLimitPerNode);
  switch (routingPlan.routeClass) {
    case "evidence_trace":
      return nodeIndex === 0 ? Math.min(perNodeLimit, 3) : 1;
    case "topic_lookup":
      return nodeIndex === 0 ? Math.min(perNodeLimit, 3) : 1;
    case "project_status":
    case "profile_overview":
    case "global_overview":
      return nodeIndex === 0 ? Math.min(perNodeLimit, 2) : 1;
    default:
      return nodeIndex === 0 ? Math.min(perNodeLimit, 2) : 1;
  }
}

function resolvePreferredKinds(routeClass: MemoryTreeNodeRoutingPlan["routeClass"]): string[] {
  switch (routeClass) {
    case "profile_overview":
      return ["profile", "agent"];
    case "global_overview":
      return ["global", "project"];
    case "project_status":
      return ["project", "global"];
    default:
      return [];
  }
}

function resolveSufficiencyScoreThreshold(routeClass: MemoryTreeNodeRoutingPlan["routeClass"]): number {
  switch (routeClass) {
    case "global_overview":
      return 10;
    case "profile_overview":
      return 9;
    case "project_status":
      return 8.5;
    default:
      return Number.POSITIVE_INFINITY;
  }
}

function measureSummaryStrength(summary?: string): number {
  const normalized = String(summary ?? "").trim();
  if (!normalized) {
    return 0;
  }
  const parts = normalized
    .split(/[\s|,.;:!?/\\()[\]{}<>-]+/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  let strength = 0;
  if (normalized.length >= 28) {
    strength += 1;
  }
  if (parts.length >= 5) {
    strength += 1;
  }
  if (normalized.includes("|") || normalized.includes("；") || normalized.includes("，")) {
    strength += 1;
  }
  return strength;
}
