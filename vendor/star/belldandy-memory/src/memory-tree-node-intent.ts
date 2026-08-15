import type { MemoryTreeNodeKind, MemoryTreeNodeRecord } from "./memory-tree-types.js";
import type { MemorySearchFilter } from "./types.js";

export type MemoryTreeNodeRouteClass =
  | "profile_overview"
  | "global_overview"
  | "project_status"
  | "topic_lookup"
  | "evidence_trace"
  | "general";

export type MemoryTreeNodeRoutingPlan = {
  routeClass: MemoryTreeNodeRouteClass;
  routeReasons: string[];
  includeKinds: MemoryTreeNodeKind[];
  scoreBoostByKind: Partial<Record<MemoryTreeNodeKind, number>>;
  reasonByKind: Partial<Record<MemoryTreeNodeKind, string>>;
  preferHighLevel: boolean;
  chunkLimitPerNode: number;
};

export type MemoryTreeNodeIntentHint = MemoryTreeNodeRoutingPlan;

const DEFAULT_NODE_KINDS: MemoryTreeNodeKind[] = [
  "project",
  "conversation",
  "topic",
  "day",
  "agent",
  "task",
];

const PROFILE_TERMS = [
  "profile",
  "persona",
  "preference",
  "preferences",
  "habit",
  "style",
  "偏好",
  "习惯",
  "画像",
  "长期风格",
  "长期特征",
  "做事风格",
  "原则",
];

const GLOBAL_TERMS = [
  "global",
  "overall",
  "workspace",
  "roadmap",
  "priority",
  "priorities",
  "project status",
  "global focus",
  "全局",
  "总体",
  "项目状态",
  "整体状态",
  "当前重点",
  "优先级",
  "进展",
];

const PROJECT_TERMS = [
  "goal",
  "project",
  "milestone",
  "release",
  "rollout",
  "delivery",
  "项目",
  "目标",
  "里程碑",
  "发布",
  "交付",
];

const EVIDENCE_TERMS = [
  "why",
  "how",
  "evidence",
  "proof",
  "trace",
  "details",
  "具体",
  "细节",
  "出处",
  "根据",
  "日志",
  "链路",
  "为什么",
  "哪一步",
];

export function resolveMemoryTreeNodeRoutingPlan(
  query: string,
  filter?: Pick<MemorySearchFilter, "topic" | "agentId" | "scope">,
): MemoryTreeNodeRoutingPlan {
  const normalized = String(query ?? "").trim().toLowerCase();
  const includeKinds = [...DEFAULT_NODE_KINDS];
  const scoreBoostByKind: Partial<Record<MemoryTreeNodeKind, number>> = {};
  const reasonByKind: Partial<Record<MemoryTreeNodeKind, string>> = {};
  const routeReasons: string[] = [];

  const hasProfileIntent = matchesAnyIntentTerm(normalized, PROFILE_TERMS);
  const hasGlobalIntent = matchesAnyIntentTerm(normalized, GLOBAL_TERMS);
  const hasProjectIntent = matchesAnyIntentTerm(normalized, PROJECT_TERMS);
  const hasEvidenceIntent = matchesAnyIntentTerm(normalized, EVIDENCE_TERMS);
  const hasTopicFilter = typeof filter?.topic === "string" && filter.topic.trim().length > 0;

  let routeClass: MemoryTreeNodeRouteClass = "general";
  let preferHighLevel = false;
  let chunkLimitPerNode = 2;

  if (hasTopicFilter) {
    routeClass = "topic_lookup";
    preferHighLevel = false;
    chunkLimitPerNode = 3;
    includeKinds.unshift("topic");
    scoreBoostByKind.topic = 5;
    scoreBoostByKind.project = 1.5;
    reasonByKind.topic = "intent:topic";
    reasonByKind.project = "intent:topic";
    routeReasons.push("filter:topic");
  } else if (hasProfileIntent && !hasGlobalIntent) {
    routeClass = "profile_overview";
    preferHighLevel = true;
    chunkLimitPerNode = 2;
    includeKinds.unshift("profile");
    scoreBoostByKind.profile = 5;
    scoreBoostByKind.agent = 1.5;
    reasonByKind.profile = "intent:profile";
    reasonByKind.agent = "intent:profile";
    routeReasons.push("term:profile");
  } else if (hasGlobalIntent) {
    routeClass = "global_overview";
    preferHighLevel = true;
    chunkLimitPerNode = 3;
    includeKinds.unshift("global");
    if (hasProfileIntent) {
      includeKinds.unshift("profile");
      scoreBoostByKind.profile = 3;
      reasonByKind.profile = "intent:profile";
      routeReasons.push("term:profile");
    }
    scoreBoostByKind.global = 7;
    scoreBoostByKind.project = 3;
    scoreBoostByKind.topic = 1;
    scoreBoostByKind.day = 0.5;
    reasonByKind.global = "intent:global";
    reasonByKind.project = "intent:global";
    reasonByKind.topic = "intent:global";
    reasonByKind.day = "intent:global";
    routeReasons.push("term:global");
  } else if (hasEvidenceIntent) {
    routeClass = "evidence_trace";
    preferHighLevel = false;
    chunkLimitPerNode = 4;
    scoreBoostByKind.task = 2;
    scoreBoostByKind.conversation = 1.5;
    scoreBoostByKind.topic = 0.5;
    reasonByKind.task = "intent:evidence";
    reasonByKind.conversation = "intent:evidence";
    reasonByKind.topic = "intent:evidence";
    routeReasons.push("term:evidence");
  } else if (hasProjectIntent) {
    routeClass = "project_status";
    preferHighLevel = true;
    chunkLimitPerNode = 3;
    scoreBoostByKind.project = 4;
    scoreBoostByKind.global = 1.5;
    scoreBoostByKind.topic = 0.75;
    reasonByKind.project = "intent:project";
    reasonByKind.global = "intent:project";
    reasonByKind.topic = "intent:project";
    includeKinds.unshift("global");
    routeReasons.push("term:project");
  }

  return {
    routeClass,
    routeReasons,
    includeKinds: dedupeKinds(includeKinds),
    scoreBoostByKind,
    reasonByKind,
    preferHighLevel,
    chunkLimitPerNode,
  };
}

export function resolveMemoryTreeNodeIntentHint(query: string): MemoryTreeNodeIntentHint {
  return resolveMemoryTreeNodeRoutingPlan(query);
}

export function applyMemoryTreeNodeRoutingBoost(
  node: MemoryTreeNodeRecord,
  baseScore: number,
  matchReasons: string[],
  plan: MemoryTreeNodeRoutingPlan,
): {
  score: number;
  matchReasons: string[];
} {
  const boost = plan.scoreBoostByKind[node.kind] ?? 0;
  if (boost <= 0) {
    return {
      score: baseScore,
      matchReasons,
    };
  }
  const reason = plan.reasonByKind[node.kind];
  return {
    score: baseScore + boost,
    matchReasons: reason && !matchReasons.includes(reason)
      ? [...matchReasons, reason]
      : matchReasons,
  };
}

export function applyMemoryTreeNodeIntentBoost(
  node: MemoryTreeNodeRecord,
  baseScore: number,
  matchReasons: string[],
  hint: MemoryTreeNodeIntentHint,
): {
  score: number;
  matchReasons: string[];
} {
  return applyMemoryTreeNodeRoutingBoost(node, baseScore, matchReasons, hint);
}

function matchesAnyIntentTerm(query: string, terms: string[]): boolean {
  return terms.some((term) => query.includes(term));
}

function dedupeKinds(values: MemoryTreeNodeKind[]): MemoryTreeNodeKind[] {
  const seen = new Set<MemoryTreeNodeKind>();
  const result: MemoryTreeNodeKind[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}
