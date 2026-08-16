import path from "node:path";

import type {
  MemorySourceInventoryClass,
  MemorySourceInventoryScope,
  MemorySourceInventoryStorage,
} from "./memory-source-inventory.js";

export type MemorySourceSearchPolicy = "inventory-only" | "searchable" | "summary-input-only";
export type MemorySourceDedupPolicy = "preserve-authoritative" | "family-aware" | "derived-overlay";
export type MemorySourceRetentionHint = "keep-authoritative" | "refresh-from-source" | "promote-and-compact";

export type MemorySourceAdmissionPolicy = {
  searchPolicy: MemorySourceSearchPolicy;
  dedupPolicy: MemorySourceDedupPolicy;
  retentionHint: MemorySourceRetentionHint;
  rationale: string;
  explicit: boolean;
};

export type MemorySourceIdentity = {
  canonicalSourceKey: string;
  sourceFamilyKey: string;
  revisionHint?: string;
};

export type MemorySourceClassification = {
  sourceKind: string;
  sourceClass: MemorySourceInventoryClass;
  builtinInventoryId?: string;
};

type MemorySourcePolicyRule = {
  searchPolicy: MemorySourceSearchPolicy;
  dedupPolicy: MemorySourceDedupPolicy;
  retentionHint: MemorySourceRetentionHint;
  rationale: string;
};

const SOURCE_POLICY_BY_KIND: Record<string, MemorySourcePolicyRule> = {
  session_messages: {
    searchPolicy: "searchable",
    dedupPolicy: "preserve-authoritative",
    retentionHint: "keep-authoritative",
    rationale: "原始会话正文是主证据层，允许直接进入统一检索面。",
  },
  session_transcripts: {
    searchPolicy: "searchable",
    dedupPolicy: "derived-overlay",
    retentionHint: "refresh-from-source",
    rationale: "transcript 属于可搜索派生层，但应与同会话原文做同源抑重。",
  },
  session_meta: {
    searchPolicy: "summary-input-only",
    dedupPolicy: "family-aware",
    retentionHint: "refresh-from-source",
    rationale: "session meta 更适合作为状态与摘要输入，不宜直接作为主证据层。",
  },
  session_digest: {
    searchPolicy: "summary-input-only",
    dedupPolicy: "derived-overlay",
    retentionHint: "refresh-from-source",
    rationale: "digest 适合作为高层摘要输入，应避免与原文同权进入主检索面。",
  },
  session_memory: {
    searchPolicy: "summary-input-only",
    dedupPolicy: "derived-overlay",
    retentionHint: "refresh-from-source",
    rationale: "session memory 主要服务续做恢复，应保留为可回放的派生整理层。",
  },
  memory_core_note: {
    searchPolicy: "searchable",
    dedupPolicy: "preserve-authoritative",
    retentionHint: "keep-authoritative",
    rationale: "核心 MEMORY.md 属于长期整理资产，可直接参与统一检索。",
  },
  memory_notes: {
    searchPolicy: "searchable",
    dedupPolicy: "preserve-authoritative",
    retentionHint: "keep-authoritative",
    rationale: "memory 日记资产属于原始长期笔记，可直接进入统一检索。",
  },
  dream_runtime: {
    searchPolicy: "inventory-only",
    dedupPolicy: "family-aware",
    retentionHint: "refresh-from-source",
    rationale: "dream runtime 主要是运行状态快照，应保留为盘点与治理材料。",
  },
  dream_index: {
    searchPolicy: "summary-input-only",
    dedupPolicy: "family-aware",
    retentionHint: "refresh-from-source",
    rationale: "DREAM.md 更偏高层索引，优先作为摘要输入而非直接证据。",
  },
  dream_notes: {
    searchPolicy: "searchable",
    dedupPolicy: "preserve-authoritative",
    retentionHint: "promote-and-compact",
    rationale: "dream 笔记属于整理后的长期资产，可直接参与统一检索。",
  },
  tasks: {
    searchPolicy: "summary-input-only",
    dedupPolicy: "family-aware",
    retentionHint: "promote-and-compact",
    rationale: "任务记录更适合作为工作总结与恢复输入，而非直接 chunk 检索正文。",
  },
  task_activities: {
    searchPolicy: "inventory-only",
    dedupPolicy: "family-aware",
    retentionHint: "refresh-from-source",
    rationale: "任务活动流水偏审计与诊断，应先停留在盘点与治理层。",
  },
  experience_candidates: {
    searchPolicy: "summary-input-only",
    dedupPolicy: "family-aware",
    retentionHint: "promote-and-compact",
    rationale: "经验候选属于整理资产，适合做摘要输入与后续发布决策。",
  },
  experience_usages: {
    searchPolicy: "inventory-only",
    dedupPolicy: "family-aware",
    retentionHint: "refresh-from-source",
    rationale: "经验消费记录更偏溯源与统计，不作为统一检索正文。",
  },
  configured_external: {
    searchPolicy: "inventory-only",
    dedupPolicy: "family-aware",
    retentionHint: "refresh-from-source",
    rationale: "configured 外来源默认先做声明与盘点，后续通过 ingest/lifecycle 决定是否进入搜索面。",
  },
  manual_memory: {
    searchPolicy: "searchable",
    dedupPolicy: "preserve-authoritative",
    retentionHint: "keep-authoritative",
    rationale: "手工记忆默认视为显式录入的正文来源，可参与统一检索。",
  },
  workspace_file: {
    searchPolicy: "searchable",
    dedupPolicy: "preserve-authoritative",
    retentionHint: "keep-authoritative",
    rationale: "工作区文件属于原始证据层，可直接进入统一检索。",
  },
  other_source: {
    searchPolicy: "inventory-only",
    dedupPolicy: "family-aware",
    retentionHint: "refresh-from-source",
    rationale: "未知来源先保守停留在盘点层，待明确准入规则后再开放。",
  },
};

const SOURCE_POLICY_BY_CLASS: Record<MemorySourceInventoryClass, MemorySourcePolicyRule> = {
  raw: {
    searchPolicy: "searchable",
    dedupPolicy: "preserve-authoritative",
    retentionHint: "keep-authoritative",
    rationale: "raw 来源默认作为可检索正文层处理。",
  },
  derived: {
    searchPolicy: "summary-input-only",
    dedupPolicy: "derived-overlay",
    retentionHint: "refresh-from-source",
    rationale: "derived 来源默认先作为摘要输入层处理。",
  },
  curated: {
    searchPolicy: "searchable",
    dedupPolicy: "family-aware",
    retentionHint: "promote-and-compact",
    rationale: "curated 来源默认作为整理资产层，可进入统一检索。",
  },
};

export function isMemorySourceSearchPolicy(value: string | undefined): value is MemorySourceSearchPolicy {
  return value === "inventory-only" || value === "searchable" || value === "summary-input-only";
}

export function normalizeSourcePathForRegistryMatch(value?: string): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

export function classifyMemorySource(
  sourcePath: string,
  sourceType: string,
  memoryTypes?: string[],
): MemorySourceClassification {
  const normalizedPath = normalizeSourcePathForRegistryMatch(sourcePath);
  const basename = path.basename(sourcePath).toLowerCase();
  const hasMemoryType = (name: string) => Array.isArray(memoryTypes) && memoryTypes.includes(name);
  if (basename.endsWith(".transcript.jsonl")) {
    return { sourceKind: "session_transcripts", sourceClass: "derived", builtinInventoryId: "builtin:sessions:transcripts" };
  }
  if (basename.endsWith(".meta.json")) {
    return { sourceKind: "session_meta", sourceClass: "derived", builtinInventoryId: "builtin:sessions:meta" };
  }
  if (basename.endsWith(".digest.json")) {
    return { sourceKind: "session_digest", sourceClass: "derived", builtinInventoryId: "builtin:sessions:digest" };
  }
  if (basename.endsWith(".session-memory.json")) {
    return { sourceKind: "session_memory", sourceClass: "derived", builtinInventoryId: "builtin:sessions:session-memory" };
  }
  if (basename.endsWith(".jsonl") || sourceType === "session") {
    return { sourceKind: "session_messages", sourceClass: "raw", builtinInventoryId: "builtin:sessions:messages" };
  }
  if (basename === "memory.md" || hasMemoryType("core")) {
    return { sourceKind: "memory_core_note", sourceClass: "curated", builtinInventoryId: "builtin:memory:core-note" };
  }
  if ((/(^|\/)memory\/.+\.md$/).test(normalizedPath) || hasMemoryType("daily")) {
    return { sourceKind: "memory_notes", sourceClass: "raw", builtinInventoryId: "builtin:memory:daily-notes" };
  }
  if (basename === "dream-runtime.json") {
    return { sourceKind: "dream_runtime", sourceClass: "derived", builtinInventoryId: "builtin:dream:runtime" };
  }
  if (basename === "dream.md" || hasMemoryType("dream_index")) {
    return { sourceKind: "dream_index", sourceClass: "derived", builtinInventoryId: "builtin:dream:index" };
  }
  if ((/(^|\/)dreams\/.+\.md$/).test(normalizedPath) || hasMemoryType("dream_note")) {
    return { sourceKind: "dream_notes", sourceClass: "curated", builtinInventoryId: "builtin:dream:notes" };
  }
  if (sourceType === "manual") {
    return { sourceKind: "manual_memory", sourceClass: "raw" };
  }
  if (sourceType === "file") {
    return { sourceKind: "workspace_file", sourceClass: "raw" };
  }
  return { sourceKind: "other_source", sourceClass: "derived" };
}

export function resolveMemorySourceAdmission(input: {
  sourceKind: string;
  sourceClass: MemorySourceInventoryClass;
  storage?: MemorySourceInventoryStorage;
  configuredSearchPolicy?: MemorySourceSearchPolicy;
}): MemorySourceAdmissionPolicy {
  const fallback = SOURCE_POLICY_BY_CLASS[input.sourceClass];
  const baseline = SOURCE_POLICY_BY_KIND[input.sourceKind] ?? fallback;
  const searchPolicy = input.configuredSearchPolicy ?? baseline.searchPolicy;
  const explicit = typeof input.configuredSearchPolicy === "string";
  const rationale = explicit
    ? `configured source 显式声明 searchPolicy=${searchPolicy}，覆盖默认 ${baseline.searchPolicy}。`
    : baseline.rationale;
  return {
    searchPolicy,
    dedupPolicy: baseline.dedupPolicy,
    retentionHint: baseline.retentionHint,
    rationale,
    explicit,
  };
}

export function resolveMemorySourceIdentity(input: {
  id: string;
  sourceKind: string;
  sourceClass: MemorySourceInventoryClass;
  scope: MemorySourceInventoryScope;
  sourcePath?: string;
  sourceRef?: string;
  builtinInventoryId?: string;
  agentId?: string;
  updatedAt?: string;
}): MemorySourceIdentity {
  const normalizedPath = normalizeSourcePathForRegistryMatch(input.sourcePath);
  const normalizedRef = String(input.sourceRef ?? "").trim().toLowerCase();
  const normalizedAgentId = String(input.agentId ?? "").trim().toLowerCase();
  const normalizedBuiltinId = String(input.builtinInventoryId ?? "").trim();
  const sourceFamilyKey = buildSourceFamilyKey({
    normalizedPath,
    normalizedRef,
    sourceKind: input.sourceKind,
    scope: input.scope,
    builtinInventoryId: normalizedBuiltinId || undefined,
    agentId: normalizedAgentId || undefined,
  });
  const canonicalSourceKey = buildCanonicalSourceKey({
    id: input.id,
    normalizedPath,
    normalizedRef,
    sourceKind: input.sourceKind,
    builtinInventoryId: normalizedBuiltinId || undefined,
    agentId: normalizedAgentId || undefined,
  });
  const revisionHint = normalizeRevisionHint(input.updatedAt);
  return {
    canonicalSourceKey,
    sourceFamilyKey,
    ...(revisionHint ? { revisionHint } : {}),
  };
}

function buildCanonicalSourceKey(input: {
  id: string;
  normalizedPath: string;
  normalizedRef: string;
  sourceKind: string;
  builtinInventoryId?: string;
  agentId?: string;
}): string {
  if (input.builtinInventoryId) {
    return `builtin:${input.builtinInventoryId}`;
  }
  if (input.normalizedPath) {
    return input.agentId
      ? `path:${input.normalizedPath}#agent:${input.agentId}`
      : `path:${input.normalizedPath}`;
  }
  if (input.normalizedRef) {
    return input.agentId
      ? `ref:${input.sourceKind}:${input.normalizedRef}#agent:${input.agentId}`
      : `ref:${input.sourceKind}:${input.normalizedRef}`;
  }
  return input.agentId
    ? `id:${input.id}#agent:${input.agentId}`
    : `id:${input.id}`;
}

function buildSourceFamilyKey(input: {
  normalizedPath: string;
  normalizedRef: string;
  sourceKind: string;
  scope: MemorySourceInventoryScope;
  builtinInventoryId?: string;
  agentId?: string;
}): string {
  if (input.normalizedPath) {
    const sessionStem = stripSessionDerivedSuffix(input.normalizedPath);
    if (sessionStem !== input.normalizedPath) {
      return `session:${sessionStem}`;
    }
    if (input.sourceKind === "configured_external") {
      return `configured-root:${input.normalizedPath}`;
    }
    return input.agentId
      ? `path:${input.normalizedPath}#agent:${input.agentId}`
      : `path:${input.normalizedPath}`;
  }
  if (input.builtinInventoryId) {
    return `builtin:${input.builtinInventoryId}`;
  }
  if (input.normalizedRef) {
    return input.agentId
      ? `ref:${input.sourceKind}:${input.normalizedRef}#agent:${input.agentId}`
      : `ref:${input.sourceKind}:${input.normalizedRef}`;
  }
  return input.agentId
    ? `kind:${input.sourceKind}:scope:${input.scope}#agent:${input.agentId}`
    : `kind:${input.sourceKind}:scope:${input.scope}`;
}

function stripSessionDerivedSuffix(normalizedPath: string): string {
  return normalizedPath
    .replace(/\.transcript\.jsonl$/i, "")
    .replace(/\.meta\.json$/i, "")
    .replace(/\.digest\.json$/i, "")
    .replace(/\.session-memory\.json$/i, "")
    .replace(/\.jsonl$/i, "");
}

function normalizeRevisionHint(value?: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp).toISOString();
}
