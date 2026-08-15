import type {
  ManagedMemoryTreeNodeKind,
  MemoryTreeLifecycleGovernanceState,
  MemoryTreeNodeLifecycleState,
  MemoryTreeSourceLifecycleState,
} from "./memory-tree-lifecycle.js";

export type MemoryTreeLifecycleReportTargetKind = "source" | ManagedMemoryTreeNodeKind;

export type MemoryTreeLifecycleReportCheckStatus = "pass" | "warn";

export type MemoryTreeLifecycleReportCheck = {
  id: string;
  name: string;
  status: MemoryTreeLifecycleReportCheckStatus;
  message: string;
  detail?: Record<string, unknown>;
};

export type MemoryTreeLifecycleReportTarget = {
  kind: MemoryTreeLifecycleReportTargetKind;
  label: string;
  present: boolean;
  dirty: boolean;
  status: "clean" | "dirty" | "cooldown";
  reasons: string[];
  currentMemorySeq: number;
  lastMemorySeq: number;
  currentTaskSeq?: number;
  lastTaskSeq?: number;
  lastRebuiltAt?: string;
  governance: MemoryTreeLifecycleGovernanceState;
  headline: string;
};

export type MemoryTreeLifecycleReport = {
  generatedAt: string;
  scope: {
    kinds: ManagedMemoryTreeNodeKind[];
  };
  summary: {
    targetCount: number;
    dirtyTargetCount: number;
    cleanTargetCount: number;
    cooldownTargetCount: number;
    failureCount: number;
    sourceDirty: boolean;
    nodeDirtyCount: number;
    latestFailureAt?: string;
  };
  headline: string;
  source: MemoryTreeLifecycleReportTarget;
  nodes: MemoryTreeLifecycleReportTarget[];
  checks: MemoryTreeLifecycleReportCheck[];
};

export function buildMemoryTreeLifecycleReport(input: {
  checkedAt: string;
  source: MemoryTreeSourceLifecycleState;
  nodes: MemoryTreeNodeLifecycleState[];
}): MemoryTreeLifecycleReport {
  const source = buildMemoryTreeLifecycleReportTarget("source", input.source);
  const nodes = input.nodes.map((node) => buildMemoryTreeLifecycleReportTarget(node.kind, node));
  const targets = [source, ...nodes];
  const dirtyTargets = targets.filter((target) => target.dirty);
  const cooldownTargets = targets.filter((target) => target.status === "cooldown");
  const failureCount = targets.reduce((total, target) => total + target.governance.failureCount, 0);
  const latestFailureAt = maxIsoTimestamp(targets.map((target) => target.governance.lastFailureAt).filter((value): value is string => Boolean(value)));

  return {
    generatedAt: input.checkedAt,
    scope: {
      kinds: input.nodes.map((node) => node.kind),
    },
    summary: {
      targetCount: targets.length,
      dirtyTargetCount: dirtyTargets.length,
      cleanTargetCount: targets.length - dirtyTargets.length,
      cooldownTargetCount: cooldownTargets.length,
      failureCount,
      sourceDirty: source.dirty,
      nodeDirtyCount: nodes.filter((node) => node.dirty).length,
      ...(latestFailureAt ? { latestFailureAt } : {}),
    },
    headline: buildLifecycleHeadline(targets),
    source,
    nodes,
    checks: [
      {
        id: "memory_tree_lifecycle",
        name: "Memory Tree Lifecycle",
        status: (dirtyTargets.length > 0 || cooldownTargets.length > 0 || failureCount > 0 ? "warn" : "pass") as MemoryTreeLifecycleReportCheckStatus,
        message: buildLifecycleHeadline(targets),
        detail: {
          targetCount: targets.length,
          dirtyTargetCount: dirtyTargets.length,
          cleanTargetCount: targets.length - dirtyTargets.length,
          cooldownTargetCount: cooldownTargets.length,
          failureCount,
          ...(latestFailureAt ? { latestFailureAt } : {}),
        },
      },
      ...targets.map((target) => ({
        id: `memory_tree_lifecycle_${target.kind}`,
        name: `Memory Tree ${target.label}`,
        status: (target.dirty || target.governance.failureCount > 0 || target.status === "cooldown" ? "warn" : "pass") as MemoryTreeLifecycleReportCheckStatus,
        message: target.headline,
        detail: {
          kind: target.kind,
          dirty: target.dirty,
          present: target.present,
          reasons: target.reasons,
          failureCount: target.governance.failureCount,
          ...(target.governance.lastFailureAt ? { lastFailureAt: target.governance.lastFailureAt } : {}),
          ...(target.governance.cooldownUntil ? { cooldownUntil: target.governance.cooldownUntil } : {}),
        },
      })),
    ],
  };
}

function buildMemoryTreeLifecycleReportTarget(
  kind: MemoryTreeLifecycleReportTargetKind,
  input: MemoryTreeSourceLifecycleState | MemoryTreeNodeLifecycleState,
): MemoryTreeLifecycleReportTarget {
  if (kind === "source") {
    const sourceInput = input as MemoryTreeSourceLifecycleState;
    const status: MemoryTreeLifecycleReportTarget["status"] = sourceInput.governance.cooldownActive
      ? "cooldown"
      : sourceInput.dirty
        ? "dirty"
        : "clean";
    return {
      kind,
      label: "Source",
      present: sourceInput.sourcePresent,
      dirty: sourceInput.dirty,
      status,
      reasons: [...sourceInput.reasons],
      currentMemorySeq: sourceInput.currentMemorySeq,
      lastMemorySeq: sourceInput.lastMemorySeq,
      ...(sourceInput.lastRebuiltAt ? { lastRebuiltAt: sourceInput.lastRebuiltAt } : {}),
      governance: sourceInput.governance,
      headline: buildTargetHeadline("Source", status, sourceInput),
    };
  }

  const nodeInput = input as MemoryTreeNodeLifecycleState;
  const label = kind === "topic"
      ? "Topic"
      : kind === "profile"
        ? "Profile"
        : "Global";
  const status: MemoryTreeLifecycleReportTarget["status"] = nodeInput.governance.cooldownActive
    ? "cooldown"
    : nodeInput.dirty
      ? "dirty"
      : "clean";
  return {
    kind,
    label,
    present: nodeInput.nodePresent,
    dirty: nodeInput.dirty,
    status,
    reasons: [...nodeInput.reasons],
    currentMemorySeq: nodeInput.currentMemorySeq,
    lastMemorySeq: nodeInput.lastMemorySeq,
    currentTaskSeq: nodeInput.currentTaskSeq,
    lastTaskSeq: nodeInput.lastTaskSeq,
    ...(nodeInput.lastRebuiltAt ? { lastRebuiltAt: nodeInput.lastRebuiltAt } : {}),
    governance: nodeInput.governance,
    headline: buildTargetHeadline(label, status, nodeInput),
  };
}

function buildTargetHeadline(
  label: string,
  status: MemoryTreeLifecycleReportTarget["status"],
  input: MemoryTreeSourceLifecycleState | MemoryTreeNodeLifecycleState,
): string {
  const parts: string[] = [];
  if (status === "clean") {
    parts.push("up to date");
  } else if (status === "cooldown") {
    parts.push(`cooldown until ${input.governance.cooldownUntil ?? "unknown"}`);
  } else {
    parts.push(`dirty: ${input.reasons.length > 0 ? input.reasons.join(", ") : "unknown"}`);
  }
  if (input.governance.failureCount > 0) {
    parts.push(`failures=${input.governance.failureCount}`);
  }
  if (input.governance.lastError) {
    parts.push(`lastError=${input.governance.lastError}`);
  }
  if (input.lastRebuiltAt) {
    parts.push(`lastRebuiltAt=${input.lastRebuiltAt}`);
  }
  return `${label} ${parts.join("; ")}`;
}

function buildLifecycleHeadline(targets: MemoryTreeLifecycleReportTarget[]): string {
  const dirtyTargets = targets.filter((target) => target.dirty).map((target) => target.kind);
  const cooldownTargets = targets.filter((target) => target.status === "cooldown").map((target) => target.kind);
  if (dirtyTargets.length === 0 && cooldownTargets.length === 0) {
    return `Lifecycle clean: ${targets.map((target) => target.kind).join(", ")} are up to date.`;
  }
  const parts = [`Lifecycle needs attention: ${dirtyTargets.join(", ") || "none"}`];
  if (cooldownTargets.length > 0) {
    parts.push(`cooldown: ${cooldownTargets.join(", ")}`);
  }
  return parts.join("; ");
}

function maxIsoTimestamp(values: string[]): string | undefined {
  if (values.length === 0) {
    return undefined;
  }
  let latest: string | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp) || timestamp <= latestMs) {
      continue;
    }
    latestMs = timestamp;
    latest = value;
  }
  return latest;
}
