import {
  MEMORY_CLASS_ORDER,
  getMemoryClassContract,
  type MemoryClass,
  type MemoryClassContract,
  type MemoryTruthMode,
} from "./memory-class-contract.js";

export const MEMORY_CLASS_BINDING_ROLE_VALUES = [
  "canonical_source",
  "primary_write_path",
  "primary_read_model",
  "runtime_consumer",
  "review_consumer",
  "observability_consumer",
] as const;

export type MemoryClassBindingRole = typeof MEMORY_CLASS_BINDING_ROLE_VALUES[number];

export interface MemoryClassModuleBinding {
  id: string;
  memoryClass: MemoryClass;
  role: MemoryClassBindingRole;
  truthMode: MemoryTruthMode;
  modulePath: string;
  exportNames?: readonly string[];
  summary: string;
  tags?: readonly string[];
}

export interface MemoryClassBindingRegistryEntry {
  contract: MemoryClassContract;
  bindings: MemoryClassModuleBinding[];
}

export interface MemoryClassBindingFilter {
  memoryClass?: MemoryClass | readonly MemoryClass[];
  role?: MemoryClassBindingRole | readonly MemoryClassBindingRole[];
  truthMode?: MemoryTruthMode | readonly MemoryTruthMode[];
  tag?: string;
  modulePath?: string;
}

// registry 只描述“现有模块属于哪一层、扮演什么角色”，不在这里引入新的运行时依赖。
const MEMORY_CLASS_BINDINGS: readonly MemoryClassModuleBinding[] = [
  {
    id: "profile-state-types",
    memoryClass: "profile_semantic",
    role: "canonical_source",
    truthMode: "canonical",
    modulePath: "packages/belldandy-memory/src/profile-state-types.ts",
    exportNames: ["ProfileStateEntry", "ProfileStateEvent"],
    summary: "Defines the canonical profile state entry and event contract.",
    tags: ["profile", "schema"],
  },
  {
    id: "profile-state-store",
    memoryClass: "profile_semantic",
    role: "canonical_source",
    truthMode: "canonical",
    modulePath: "packages/belldandy-memory/src/profile-state.ts",
    summary: "Implements canonical profile state reads and writes over the memory store.",
    tags: ["profile", "store"],
  },
  {
    id: "durable-profile-state-writer",
    memoryClass: "profile_semantic",
    role: "primary_write_path",
    truthMode: "canonical",
    modulePath: "packages/belldandy-memory/src/durable-profile-state.ts",
    summary: "Applies low-risk durable extraction output to canonical profile state fields.",
    tags: ["profile", "write", "durable_extraction"],
  },
  {
    id: "mind-profile-snapshot",
    memoryClass: "profile_semantic",
    role: "primary_read_model",
    truthMode: "derived",
    modulePath: "packages/belldandy-core/src/mind-profile-snapshot.ts",
    summary: "Builds a derived profile snapshot from canonical profile state for runtime use.",
    tags: ["profile", "runtime"],
  },
  {
    id: "mind-profile-runtime-digest",
    memoryClass: "profile_semantic",
    role: "primary_read_model",
    truthMode: "runtime_projection",
    modulePath: "packages/belldandy-core/src/mind-profile-runtime-digest.ts",
    summary: "Compresses canonical profile state into a runtime digest view.",
    tags: ["profile", "runtime", "digest"],
  },
  {
    id: "mind-profile-runtime-prelude",
    memoryClass: "profile_semantic",
    role: "runtime_consumer",
    truthMode: "runtime_projection",
    modulePath: "packages/belldandy-core/src/mind-profile-runtime-prelude.ts",
    summary: "Injects canonical profile state into prompt prelude context.",
    tags: ["profile", "prompt"],
  },
  {
    id: "project-durable-memory-manager",
    memoryClass: "project_semantic",
    role: "canonical_source",
    truthMode: "canonical",
    modulePath: "packages/belldandy-memory/src/manager.ts",
    summary: "Routes durable project/reference memories and maintains the current project semantic truth contract.",
    tags: ["project", "durable_memory"],
  },
  {
    id: "memory-tree-types",
    memoryClass: "project_semantic",
    role: "primary_read_model",
    truthMode: "derived",
    modulePath: "packages/belldandy-memory/src/memory-tree-types.ts",
    exportNames: ["MemoryTreeNodeKind"],
    summary: "Defines the derived tree shapes used to present project, profile, global, and topic views.",
    tags: ["project", "tree"],
  },
  {
    id: "memory-tree-layer-builders",
    memoryClass: "project_semantic",
    role: "primary_read_model",
    truthMode: "derived",
    modulePath: "packages/belldandy-memory/src/memory-tree-layer-builders.ts",
    summary: "Builds derived project/global/topic tree layers from underlying durable memory inputs.",
    tags: ["project", "tree", "aggregate"],
  },
  {
    id: "memory-experience-project-surface",
    memoryClass: "project_semantic",
    role: "runtime_consumer",
    truthMode: "derived",
    modulePath: "packages/belldandy-core/src/server-methods/memory-experience.ts",
    summary: "Exposes project/global/topic memory tree read surfaces during runtime and inspection flows.",
    tags: ["project", "api"],
  },
  {
    id: "task-types",
    memoryClass: "episodic_task",
    role: "canonical_source",
    truthMode: "canonical",
    modulePath: "packages/belldandy-memory/src/task-types.ts",
    exportNames: ["TaskRecord", "TaskActivityRecord"],
    summary: "Defines the canonical task, work recap, resume context, and task activity contracts.",
    tags: ["task", "schema"],
  },
  {
    id: "task-manager",
    memoryClass: "episodic_task",
    role: "primary_write_path",
    truthMode: "canonical",
    modulePath: "packages/belldandy-memory/src/manager.ts",
    summary: "Persists task records and activities, then builds enriched task detail views.",
    tags: ["task", "write"],
  },
  {
    id: "task-work-surface",
    memoryClass: "episodic_task",
    role: "primary_read_model",
    truthMode: "derived",
    modulePath: "packages/belldandy-memory/src/task-work-surface.ts",
    summary: "Projects canonical task facts into recent-work and resume-oriented read models.",
    tags: ["task", "resume"],
  },
  {
    id: "derived-task-retrieval",
    memoryClass: "episodic_task",
    role: "primary_read_model",
    truthMode: "derived",
    modulePath: "packages/belldandy-memory/src/derived-task-retrieval.ts",
    summary: "Retrieves task-local evidence as a derived read layer on top of canonical task records.",
    tags: ["task", "retrieval"],
  },
  {
    id: "memory-experience-task-surface",
    memoryClass: "episodic_task",
    role: "runtime_consumer",
    truthMode: "derived",
    modulePath: "packages/belldandy-core/src/server-methods/memory-experience.ts",
    summary: "Serves task detail, recent work, resume context, and similar past work from the episodic task layer.",
    tags: ["task", "api"],
  },
  {
    id: "experience-types",
    memoryClass: "procedural_experience",
    role: "canonical_source",
    truthMode: "canonical",
    modulePath: "packages/belldandy-memory/src/experience-types.ts",
    exportNames: ["ExperienceCandidate", "ExperienceUsage"],
    summary: "Defines the canonical experience candidate, usage, and published asset contracts.",
    tags: ["experience", "schema"],
  },
  {
    id: "experience-promoter",
    memoryClass: "procedural_experience",
    role: "primary_write_path",
    truthMode: "canonical",
    modulePath: "packages/belldandy-memory/src/experience-promoter.ts",
    summary: "Promotes tasks into reusable experience assets and writes canonical experience updates.",
    tags: ["experience", "write"],
  },
  {
    id: "derived-experience-retrieval",
    memoryClass: "procedural_experience",
    role: "primary_read_model",
    truthMode: "derived",
    modulePath: "packages/belldandy-memory/src/derived-experience-retrieval.ts",
    summary: "Retrieves reusable experience evidence from canonical experience records.",
    tags: ["experience", "retrieval"],
  },
  {
    id: "skill-freshness",
    memoryClass: "procedural_experience",
    role: "observability_consumer",
    truthMode: "derived",
    modulePath: "packages/belldandy-core/src/skill-freshness.ts",
    summary: "Builds lifecycle and freshness projections over canonical experience candidates and usages.",
    tags: ["experience", "freshness"],
  },
  {
    id: "memory-experience-procedural-surface",
    memoryClass: "procedural_experience",
    role: "runtime_consumer",
    truthMode: "derived",
    modulePath: "packages/belldandy-core/src/server-methods/memory-experience.ts",
    summary: "Exposes runtime candidate and usage surfaces for procedural experience recall.",
    tags: ["experience", "api"],
  },
  {
    id: "governance-manager",
    memoryClass: "governance",
    role: "canonical_source",
    truthMode: "canonical",
    modulePath: "packages/belldandy-memory/src/manager.ts",
    summary: "Persists review decisions, apply results, and governance summaries for memory lifecycle operations.",
    tags: ["governance", "review", "apply"],
  },
  {
    id: "memory-source-inventory",
    memoryClass: "governance",
    role: "primary_read_model",
    truthMode: "review_artifact",
    modulePath: "packages/belldandy-memory/src/memory-source-inventory.ts",
    summary: "Builds review artifacts describing current source inventory coverage and risk.",
    tags: ["governance", "inventory"],
  },
  {
    id: "memory-source-inventory-governance",
    memoryClass: "governance",
    role: "primary_read_model",
    truthMode: "review_artifact",
    modulePath: "packages/belldandy-memory/src/memory-source-inventory-governance.ts",
    summary: "Decorates inventory reports with governance summaries and suggested review actions.",
    tags: ["governance", "inventory", "review"],
  },
  {
    id: "memory-dedup",
    memoryClass: "governance",
    role: "primary_read_model",
    truthMode: "review_artifact",
    modulePath: "packages/belldandy-memory/src/memory-dedup.ts",
    summary: "Builds dedup preview artifacts used before any apply step changes stored memory.",
    tags: ["governance", "dedup"],
  },
  {
    id: "memory-dedup-governance",
    memoryClass: "governance",
    role: "primary_read_model",
    truthMode: "review_artifact",
    modulePath: "packages/belldandy-memory/src/memory-dedup-governance.ts",
    summary: "Adds governance scoring and suggested actions to dedup preview artifacts.",
    tags: ["governance", "dedup", "review"],
  },
  {
    id: "learning-review-input",
    memoryClass: "governance",
    role: "review_consumer",
    truthMode: "review_artifact",
    modulePath: "packages/belldandy-core/src/learning-review-input.ts",
    summary: "Consumes governance signals during review preparation and is a natural P1-C consumer of classed signals.",
    tags: ["governance", "learning_review"],
  },
  {
    id: "memory-experience-governance-surface",
    memoryClass: "governance",
    role: "observability_consumer",
    truthMode: "review_artifact",
    modulePath: "packages/belldandy-core/src/server-methods/memory-experience.ts",
    summary: "Exposes governance preview, review, and apply RPC surfaces for memory lifecycle operations.",
    tags: ["governance", "api"],
  },
  {
    id: "system-doctor-governance",
    memoryClass: "governance",
    role: "observability_consumer",
    truthMode: "review_artifact",
    modulePath: "packages/belldandy-core/src/server-methods/system-doctor.ts",
    summary: "Consumes governance state for doctor reporting and lifecycle observability.",
    tags: ["governance", "doctor"],
  },
];

const MEMORY_CLASS_BINDINGS_BY_CLASS = MEMORY_CLASS_ORDER.reduce<Record<MemoryClass, MemoryClassModuleBinding[]>>(
  (acc, memoryClass) => {
    acc[memoryClass] = MEMORY_CLASS_BINDINGS.filter((binding) => binding.memoryClass === memoryClass);
    return acc;
  },
  {
    profile_semantic: [],
    project_semantic: [],
    episodic_task: [],
    procedural_experience: [],
    governance: [],
  },
);

export function isMemoryClassBindingRole(value: unknown): value is MemoryClassBindingRole {
  return typeof value === "string"
    && (MEMORY_CLASS_BINDING_ROLE_VALUES as readonly string[]).includes(value.trim().toLowerCase());
}

export function normalizeMemoryClassModulePath(value?: string): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

export function listMemoryClassBindingEntries(): MemoryClassBindingRegistryEntry[] {
  return MEMORY_CLASS_ORDER.map((memoryClass) => ({
    contract: getMemoryClassContract(memoryClass),
    bindings: [...MEMORY_CLASS_BINDINGS_BY_CLASS[memoryClass]],
  }));
}

export function getMemoryClassBindingEntry(memoryClass: MemoryClass): MemoryClassBindingRegistryEntry {
  return {
    contract: getMemoryClassContract(memoryClass),
    bindings: [...MEMORY_CLASS_BINDINGS_BY_CLASS[memoryClass]],
  };
}

export function listMemoryClassBindings(filter: MemoryClassBindingFilter = {}): MemoryClassModuleBinding[] {
  const memoryClasses = toSet(filter.memoryClass);
  const roles = toSet(filter.role);
  const truthModes = toSet(filter.truthMode);
  const normalizedTag = normalizeTag(filter.tag);
  const normalizedModulePath = normalizeMemoryClassModulePath(filter.modulePath);

  return MEMORY_CLASS_BINDINGS.filter((binding) => {
    if (memoryClasses && !memoryClasses.has(binding.memoryClass)) {
      return false;
    }
    if (roles && !roles.has(binding.role)) {
      return false;
    }
    if (truthModes && !truthModes.has(binding.truthMode)) {
      return false;
    }
    if (normalizedTag) {
      const tags = Array.isArray(binding.tags)
        ? binding.tags.map((item) => normalizeTag(item)).filter(Boolean)
        : [];
      if (!tags.includes(normalizedTag)) {
        return false;
      }
    }
    if (normalizedModulePath && normalizeMemoryClassModulePath(binding.modulePath) !== normalizedModulePath) {
      return false;
    }
    return true;
  });
}

export function findMemoryClassBindingsByModulePath(modulePath: string): MemoryClassModuleBinding[] {
  return listMemoryClassBindings({ modulePath });
}

function normalizeTag(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

function toSet<T extends string>(value?: T | readonly T[]): Set<T> | undefined {
  if (!value) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const items = value as readonly T[];
    return items.length > 0 ? new Set<T>(items) : undefined;
  }
  const single = value as T;
  return new Set<T>([single]);
}
