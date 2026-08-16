export const MEMORY_CLASS_VALUES = [
  "profile_semantic",
  "project_semantic",
  "episodic_task",
  "procedural_experience",
  "governance",
] as const;

export type MemoryClass = typeof MEMORY_CLASS_VALUES[number];

export const MEMORY_TRUTH_MODE_VALUES = [
  "canonical",
  "derived",
  "runtime_projection",
  "review_artifact",
] as const;

export type MemoryTruthMode = typeof MEMORY_TRUTH_MODE_VALUES[number];

export interface MemoryClassContract {
  memoryClass: MemoryClass;
  label: string;
  goal: string;
  truthBoundary: string;
  canonicalSourceSummary: string;
  primaryWritePathSummary: string;
  runtimeUsageSummary: string;
  observabilityUsageSummary: string;
  freshnessSignals: readonly string[];
  lineageSignals: readonly string[];
}

export const MEMORY_CLASS_ORDER: readonly MemoryClass[] = MEMORY_CLASS_VALUES;

// 五层记忆的 contract 先固定为文字化边界，后续 consumer 再逐步接到显式字段上。
const MEMORY_CLASS_CONTRACTS: Record<MemoryClass, MemoryClassContract> = {
  profile_semantic: {
    memoryClass: "profile_semantic",
    label: "Profile Semantic",
    goal: "Keep stable user profile facts, preferences, and long-lived constraints in a structured truth layer.",
    truthBoundary: "Canonical truth lives in profile state entries and profile state event history. Mind snapshot and prompt prelude are derived runtime projections.",
    canonicalSourceSummary: "Profile state entries and events persisted by the memory store.",
    primaryWritePathSummary: "Low-risk durable extraction patches and explicit profile state writes update the canonical profile layer.",
    runtimeUsageSummary: "Prompt prelude, runtime digest, and profile snapshot read this layer before emitting summarized mind context.",
    observabilityUsageSummary: "Prompt snapshot, runtime inspect, and future learning review consumers can inspect explicit profile fields and lineage.",
    freshnessSignals: ["updatedAt", "lastConfirmedAt"],
    lineageSignals: ["sourceRefs", "profileStateEvents", "supersededBy", "contradictedBy"],
  },
  project_semantic: {
    memoryClass: "project_semantic",
    label: "Project Semantic",
    goal: "Represent stable project facts, stage decisions, recurring constraints, and durable reference context.",
    truthBoundary: "P1-A1 treats durable project/reference memories plus curated notes as the canonical contract. Project/global/topic tree nodes remain derived aggregate views.",
    canonicalSourceSummary: "Durable memory entries tagged as project/reference and stable curated notes that survive beyond a single task.",
    primaryWritePathSummary: "Existing durable extraction and manual curation paths keep writing project/reference memories. No dedicated project state writer is added in this batch.",
    runtimeUsageSummary: "Runtime consumers can read this layer for stable project context, but prompt injection remains opt-in until a narrower project truth structure is chosen.",
    observabilityUsageSummary: "Tree reports, inventory, dedup, and later learning review can explain missing, stale, or conflicting project context through this contract.",
    freshnessSignals: ["updatedAt", "recencyScore", "interactionScore"],
    lineageSignals: ["sourceRefs", "memoryChunkIds", "candidateType", "treeSourceLinks"],
  },
  episodic_task: {
    memoryClass: "episodic_task",
    label: "Episodic Task",
    goal: "Preserve task-local work history, stop points, next steps, and concrete evidence needed to resume work.",
    truthBoundary: "Task records, work recap snapshots, resume context snapshots, and task activities are canonical. Derived task retrieval is a read model on top of them.",
    canonicalSourceSummary: "TaskRecord, TaskWorkRecapSnapshot, ResumeContextSnapshot, and task activity records.",
    primaryWritePathSummary: "Task and activity persistence flows write the canonical task layer as work progresses.",
    runtimeUsageSummary: "Resume, recent work, task detail, and similar past work surfaces consume this layer to continue work safely.",
    observabilityUsageSummary: "Explain-sources and future classed inspect surfaces can point back to exact tasks, activities, and derived recap evidence.",
    freshnessSignals: ["startedAt", "finishedAt", "workRecap.updatedAt", "resumeContext.updatedAt"],
    lineageSignals: ["taskId", "activityIds", "memoryChunkIds", "artifactPaths", "toolCalls"],
  },
  procedural_experience: {
    memoryClass: "procedural_experience",
    label: "Procedural Experience",
    goal: "Capture reusable methods, skills, and usage evidence that can improve later work.",
    truthBoundary: "Experience candidates, published method/skill assets, and experience usage records are canonical. Skill freshness is a lifecycle projection over that truth.",
    canonicalSourceSummary: "ExperienceCandidate records, published experience assets, and ExperienceUsage rows.",
    primaryWritePathSummary: "Experience promotion, publish, accept/reject, and usage recording flows update the canonical experience layer.",
    runtimeUsageSummary: "Runtime experience recall and candidate suggestion paths draw on this layer for reusable methods and skills.",
    observabilityUsageSummary: "Review, freshness, usage analytics, and later learning review can judge whether procedural knowledge is stale or underused.",
    freshnessSignals: ["createdAt", "updatedAt", "lastUsedAt", "freshnessScore"],
    lineageSignals: ["sourceTaskIds", "experienceUsage", "publishedAssetPath", "reviewDecision"],
  },
  governance: {
    memoryClass: "governance",
    label: "Governance",
    goal: "Track review, inventory, dedup, lifecycle, and apply-state facts that govern how memory assets are curated.",
    truthBoundary: "Governance keeps canonical review/apply state plus review artifacts. It is not a semantic memory layer for prompt grounding.",
    canonicalSourceSummary: "Persisted report records, review decisions, apply results, and governance summaries attached to lifecycle actions.",
    primaryWritePathSummary: "Inventory preview persistence, dedup preview persistence, report review, and report apply flows write governance state.",
    runtimeUsageSummary: "This layer usually does not flow into ordinary prompts; it acts as a control and audit surface for review-driven operations.",
    observabilityUsageSummary: "Doctor, governance preview, review/apply audit trails, and later risk gates consume this layer directly.",
    freshnessSignals: ["checkedAt", "reviewedAt", "appliedAt", "cooldownUntil"],
    lineageSignals: ["reportId", "reviewDecision", "applyAction", "backupPath", "configuredSources"],
  },
};

export function isMemoryClass(value: unknown): value is MemoryClass {
  return typeof value === "string"
    && (MEMORY_CLASS_VALUES as readonly string[]).includes(value.trim().toLowerCase());
}

export function isMemoryTruthMode(value: unknown): value is MemoryTruthMode {
  return typeof value === "string"
    && (MEMORY_TRUTH_MODE_VALUES as readonly string[]).includes(value.trim().toLowerCase());
}

export function normalizeMemoryClass(value: unknown, fallback?: MemoryClass): MemoryClass | undefined {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return isMemoryClass(normalized) ? normalized : fallback;
}

export function normalizeMemoryTruthMode(value: unknown, fallback?: MemoryTruthMode): MemoryTruthMode | undefined {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return isMemoryTruthMode(normalized) ? normalized : fallback;
}

export function getMemoryClassContract(memoryClass: MemoryClass): MemoryClassContract {
  return MEMORY_CLASS_CONTRACTS[memoryClass];
}

export function listMemoryClassContracts(): MemoryClassContract[] {
  return MEMORY_CLASS_ORDER.map((memoryClass) => MEMORY_CLASS_CONTRACTS[memoryClass]);
}
