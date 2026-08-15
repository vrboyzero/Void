import type { MemoryTreeNodeKind } from "./memory-tree-types.js";

export const MANAGED_MEMORY_TREE_NODE_KINDS = ["topic", "profile", "global"] as const;

export type ManagedMemoryTreeNodeKind = typeof MANAGED_MEMORY_TREE_NODE_KINDS[number];

export type MemoryTreeLifecycleGovernanceState = {
  failureCount: number;
  lastFailureAt?: string;
  lastError?: string;
  cooldownUntil?: string;
  cooldownActive: boolean;
};

export type MemoryTreeSourceLifecycleState = {
  kind: "source";
  dirty: boolean;
  reasons: string[];
  sourcePresent: boolean;
  currentMemorySeq: number;
  lastMemorySeq: number;
  lastRebuiltAt?: string;
  governance: MemoryTreeLifecycleGovernanceState;
};

export type MemoryTreeNodeLifecycleState = {
  kind: ManagedMemoryTreeNodeKind;
  dirty: boolean;
  reasons: string[];
  nodePresent: boolean;
  currentMemorySeq: number;
  currentTaskSeq: number;
  lastMemorySeq: number;
  lastTaskSeq: number;
  lastRebuiltAt?: string;
  governance: MemoryTreeLifecycleGovernanceState;
};

export function isManagedMemoryTreeNodeKind(value: unknown): value is ManagedMemoryTreeNodeKind {
  return value === "topic" || value === "profile" || value === "global";
}

export function resolveManagedMemoryTreeNodeKinds(
  values?: Array<MemoryTreeNodeKind | ManagedMemoryTreeNodeKind | string>,
): ManagedMemoryTreeNodeKind[] {
  const candidates = Array.isArray(values) && values.length > 0
    ? values
    : [...MANAGED_MEMORY_TREE_NODE_KINDS];
  const seen = new Set<ManagedMemoryTreeNodeKind>();
  const results: ManagedMemoryTreeNodeKind[] = [];
  for (const value of candidates) {
    if (!isManagedMemoryTreeNodeKind(value) || seen.has(value)) {
      continue;
    }
    seen.add(value);
    results.push(value);
  }
  return results;
}

export function buildMemoryTreeSourcesLastMemorySeqMetaKey(): string {
  return "memory_tree_sources_last_memory_seq";
}

export function buildMemoryTreeSourcesFailureCountMetaKey(): string {
  return "memory_tree_sources_failure_count";
}

export function buildMemoryTreeSourcesLastFailureAtMetaKey(): string {
  return "memory_tree_sources_last_failure_at";
}

export function buildMemoryTreeSourcesLastErrorMetaKey(): string {
  return "memory_tree_sources_last_error";
}

export function buildMemoryTreeSourcesCooldownUntilMetaKey(): string {
  return "memory_tree_sources_cooldown_until";
}

export function buildManagedMemoryTreeNodeLastRebuiltAtMetaKey(kind: ManagedMemoryTreeNodeKind): string {
  return `memory_tree_nodes_${kind}_last_rebuilt_at`;
}

export function buildManagedMemoryTreeNodeLastMemorySeqMetaKey(kind: ManagedMemoryTreeNodeKind): string {
  return `memory_tree_nodes_${kind}_last_memory_seq`;
}

export function buildManagedMemoryTreeNodeLastTaskSeqMetaKey(kind: ManagedMemoryTreeNodeKind): string {
  return `memory_tree_nodes_${kind}_last_task_seq`;
}

export function buildManagedMemoryTreeNodeFailureCountMetaKey(kind: ManagedMemoryTreeNodeKind): string {
  return `memory_tree_nodes_${kind}_failure_count`;
}

export function buildManagedMemoryTreeNodeLastFailureAtMetaKey(kind: ManagedMemoryTreeNodeKind): string {
  return `memory_tree_nodes_${kind}_last_failure_at`;
}

export function buildManagedMemoryTreeNodeLastErrorMetaKey(kind: ManagedMemoryTreeNodeKind): string {
  return `memory_tree_nodes_${kind}_last_error`;
}

export function buildManagedMemoryTreeNodeCooldownUntilMetaKey(kind: ManagedMemoryTreeNodeKind): string {
  return `memory_tree_nodes_${kind}_cooldown_until`;
}

export function buildMemoryTreeSourceLifecycleState(input: {
  sourcePresent: boolean;
  currentMemorySeq: number;
  lastMemorySeq: number;
  lastRebuiltAt?: string;
  governance: MemoryTreeLifecycleGovernanceState;
}): MemoryTreeSourceLifecycleState {
  const reasons: string[] = [];
  if (!input.sourcePresent) {
    reasons.push("missing_source_records");
  }
  if (!input.lastRebuiltAt) {
    reasons.push("never_rebuilt");
  }
  if (input.lastMemorySeq < input.currentMemorySeq) {
    reasons.push("memory_changed");
  }
  if (input.governance.lastError) {
    reasons.push("last_error");
  }
  if (input.governance.cooldownActive) {
    reasons.push("cooldown_active");
  }
  return {
    kind: "source",
    dirty: reasons.length > 0,
    reasons,
    sourcePresent: input.sourcePresent,
    currentMemorySeq: input.currentMemorySeq,
    lastMemorySeq: input.lastMemorySeq,
    lastRebuiltAt: input.lastRebuiltAt,
    governance: input.governance,
  };
}

export function buildManagedMemoryTreeNodeLifecycleState(input: {
  kind: ManagedMemoryTreeNodeKind;
  nodePresent: boolean;
  currentMemorySeq: number;
  currentTaskSeq: number;
  lastMemorySeq: number;
  lastTaskSeq: number;
  lastRebuiltAt?: string;
  governance: MemoryTreeLifecycleGovernanceState;
}): MemoryTreeNodeLifecycleState {
  const reasons: string[] = [];
  if (!input.nodePresent) {
    reasons.push("missing_nodes");
  }
  if (!input.lastRebuiltAt) {
    reasons.push("never_rebuilt");
  }
  if (input.lastMemorySeq < input.currentMemorySeq) {
    reasons.push("memory_changed");
  }
  if (input.lastTaskSeq < input.currentTaskSeq) {
    reasons.push("task_changed");
  }
  if (input.governance.lastError) {
    reasons.push("last_error");
  }
  if (input.governance.cooldownActive) {
    reasons.push("cooldown_active");
  }
  return {
    kind: input.kind,
    dirty: reasons.length > 0,
    reasons,
    nodePresent: input.nodePresent,
    currentMemorySeq: input.currentMemorySeq,
    currentTaskSeq: input.currentTaskSeq,
    lastMemorySeq: input.lastMemorySeq,
    lastTaskSeq: input.lastTaskSeq,
    lastRebuiltAt: input.lastRebuiltAt,
    governance: input.governance,
  };
}

export function buildMemoryTreeLifecycleGovernanceState(input: {
  failureCount: number;
  lastFailureAt?: string;
  lastError?: string;
  cooldownUntil?: string;
  checkedAt: string;
}): MemoryTreeLifecycleGovernanceState {
  return {
    failureCount: Math.max(0, Math.floor(input.failureCount)),
    lastFailureAt: input.lastFailureAt,
    lastError: input.lastError,
    cooldownUntil: input.cooldownUntil,
    cooldownActive: isFutureIsoTimestamp(input.cooldownUntil, input.checkedAt),
  };
}

export function resolveMemoryTreeLifecycleFailureCooldownMs(failureCount: number): number {
  const attempts = Math.max(1, Math.floor(failureCount));
  const baseMs = 60_000;
  const maxMs = 15 * 60_000;
  return Math.min(maxMs, baseMs * (2 ** Math.max(0, attempts - 1)));
}

function isFutureIsoTimestamp(value: string | undefined, checkedAt: string): boolean {
  if (!value) {
    return false;
  }
  const futureMs = Date.parse(value);
  const checkedMs = Date.parse(checkedAt);
  if (!Number.isFinite(futureMs) || !Number.isFinite(checkedMs)) {
    return false;
  }
  return futureMs > checkedMs;
}
