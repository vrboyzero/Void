import fs from "node:fs/promises";
import path from "node:path";

import type { MemoryIndexStatus } from "./types.js";
import {
  resolveMemorySourceAdmission,
  resolveMemorySourceIdentity,
  type MemorySourceAdmissionPolicy,
  type MemorySourceIdentity,
  type MemorySourceSearchPolicy,
} from "./memory-source-registry.js";

export type MemorySourceInventoryClass = "raw" | "derived" | "curated";
export type MemorySourceInventoryScope = "private" | "shared" | "team";
export type MemorySourceInventoryStorage = "filesystem" | "database" | "external";
export type MemorySourceInventoryStatus = "present" | "missing" | "declared";
export type MemorySourceInventoryDuplicateRiskLevel = "low" | "medium" | "high";
export type MemorySourceInventoryFamilyRiskLevel = MemorySourceInventoryDuplicateRiskLevel;

export type MemoryTaskInventoryStats = {
  taskCount: number;
  taskActivityCount: number;
  lastTaskUpdatedAt?: string;
  lastActivityAt?: string;
};

export type MemoryExperienceInventoryStats = {
  candidateCount: number;
  draftCandidateCount: number;
  acceptedCandidateCount: number;
  rejectedCandidateCount: number;
  usageCount: number;
  lastCandidateCreatedAt?: string;
  lastUsageCreatedAt?: string;
};

export type MemorySourceInventoryConfiguredSource = {
  id?: string;
  label: string;
  sourceClass: MemorySourceInventoryClass;
  scope?: MemorySourceInventoryScope;
  searchPolicy?: MemorySourceSearchPolicy;
  rootPath?: string;
  filePath?: string;
  recursive?: boolean;
  fileExtensions?: string[];
  note?: string;
};

export type MemorySourceInventoryItem = {
  id: string;
  label: string;
  sourceKind: string;
  sourceClass: MemorySourceInventoryClass;
  scope: MemorySourceInventoryScope;
  storage: MemorySourceInventoryStorage;
  status: MemorySourceInventoryStatus;
  duplicateRisk: {
    level: MemorySourceInventoryDuplicateRiskLevel;
    rationale: string;
  };
  stats: {
    itemCount: number;
    fileCount: number;
    rowCount: number;
    totalBytes: number;
    lastUpdatedAt?: string;
  };
  admission: MemorySourceAdmissionPolicy;
  identity: MemorySourceIdentity;
  location: {
    path?: string;
    table?: string;
    pattern?: string;
  };
  notes: string[];
};

export type MemorySourceInventoryFamilyMember = {
  id: string;
  label: string;
  sourceKind: string;
  sourceClass: MemorySourceInventoryClass;
  storage: MemorySourceInventoryStorage;
  status: MemorySourceInventoryStatus;
  searchPolicy: MemorySourceSearchPolicy;
};

export type MemorySourceInventoryFamily = {
  sourceFamilyKey: string;
  memberCount: number;
  presentMemberCount: number;
  sourceKinds: string[];
  sourceClasses: MemorySourceInventoryClass[];
  searchPolicies: MemorySourceSearchPolicy[];
  duplicateRisk: {
    level: MemorySourceInventoryFamilyRiskLevel;
    rationale: string;
  };
  members: MemorySourceInventoryFamilyMember[];
};

export type MemorySourceInventoryReport = {
  version: string;
  generatedAt: string;
  stateDir: string;
  totals: {
    sourceKinds: number;
    presentSourceKinds: number;
    declaredSourceKinds: number;
    missingSourceKinds: number;
    fileCount: number;
    rowCount: number;
    totalBytes: number;
    indexedFiles: number;
    indexedChunks: number;
    sourceFamilyCount: number;
    multiMemberFamilyCount: number;
    highRiskFamilyCount: number;
    byClass: Record<MemorySourceInventoryClass, number>;
    byScope: Record<MemorySourceInventoryScope, number>;
    bySearchPolicy: Record<MemorySourceSearchPolicy, number>;
  };
  items: MemorySourceInventoryItem[];
  families: MemorySourceInventoryFamily[];
};

export type BuildMemorySourceInventoryInput = {
  stateDir: string;
  memoryStatus: Pick<MemoryIndexStatus, "files" | "chunks" | "lastIndexedAt">;
  taskStats: MemoryTaskInventoryStats;
  experienceStats: MemoryExperienceInventoryStats;
  configuredSources?: MemorySourceInventoryConfiguredSource[];
};

type InventoryBuiltinFileSpec = {
  id: string;
  label: string;
  sourceKind: string;
  sourceClass: MemorySourceInventoryClass;
  scope: MemorySourceInventoryScope;
  duplicateRisk: MemorySourceInventoryItem["duplicateRisk"];
  notes: string[];
  scan: (stateDir: string) => Promise<MemorySourceInventoryItem>;
};

const INVENTORY_REPORT_VERSION = "p10-source-registry-family-v1";

const BUILTIN_FILE_SPECS: InventoryBuiltinFileSpec[] = [
  createDirectorySpec({
    id: "builtin:sessions:messages",
    label: "会话原始消息",
    sourceKind: "session_messages",
    sourceClass: "raw",
    scope: "private",
    duplicateRisk: {
      level: "low",
      rationale: "原始对话日志是审计与回放基线，通常不应和其他派生摘要同权去重。",
    },
    notes: ["扫描 `sessions/*.jsonl`，排除 transcript 衍生文件。"],
    relativeDir: "sessions",
    pattern: "*.jsonl",
    recursive: false,
    matcher: (fileName) => fileName.endsWith(".jsonl") && !fileName.endsWith(".transcript.jsonl"),
  }),
  createDirectorySpec({
    id: "builtin:sessions:transcripts",
    label: "会话 transcript",
    sourceKind: "session_transcripts",
    sourceClass: "derived",
    scope: "private",
    duplicateRisk: {
      level: "high",
      rationale: "transcript 是对原始会话的派生重组，与原始消息存在天然重叠。",
    },
    notes: ["扫描 `sessions/*.transcript.jsonl`。"],
    relativeDir: "sessions",
    pattern: "*.transcript.jsonl",
    recursive: false,
    matcher: (fileName) => fileName.endsWith(".transcript.jsonl"),
  }),
  createDirectorySpec({
    id: "builtin:sessions:meta",
    label: "会话元数据",
    sourceKind: "session_meta",
    sourceClass: "derived",
    scope: "private",
    duplicateRisk: {
      level: "medium",
      rationale: "meta 混合运行时状态与摘要线索，和任务/摘要类来源存在交叉。",
    },
    notes: ["扫描 `sessions/*.meta.json`。"],
    relativeDir: "sessions",
    pattern: "*.meta.json",
    recursive: false,
    matcher: (fileName) => fileName.endsWith(".meta.json"),
  }),
  createDirectorySpec({
    id: "builtin:sessions:digest",
    label: "会话 digest",
    sourceKind: "session_digest",
    sourceClass: "derived",
    scope: "private",
    duplicateRisk: {
      level: "high",
      rationale: "digest 是对同一会话的浓缩摘要，和原始会话、session memory 高度重叠。",
    },
    notes: ["扫描 `sessions/*.digest.json`。"],
    relativeDir: "sessions",
    pattern: "*.digest.json",
    recursive: false,
    matcher: (fileName) => fileName.endsWith(".digest.json"),
  }),
  createDirectorySpec({
    id: "builtin:sessions:session-memory",
    label: "会话续做记忆",
    sourceKind: "session_memory",
    sourceClass: "derived",
    scope: "private",
    duplicateRisk: {
      level: "high",
      rationale: "session memory 是 continuation 摘要层，和 digest / transcript / task recap 都可能重复。",
    },
    notes: ["扫描 `sessions/*.session-memory.json`。"],
    relativeDir: "sessions",
    pattern: "*.session-memory.json",
    recursive: false,
    matcher: (fileName) => fileName.endsWith(".session-memory.json"),
  }),
  createSingleFileSpec({
    id: "builtin:memory:core-note",
    label: "核心 MEMORY.md",
    sourceKind: "memory_core_note",
    sourceClass: "curated",
    scope: "private",
    duplicateRisk: {
      level: "medium",
      rationale: "核心记忆通常是整理层，会和 daily memory、任务复盘产生摘要重叠。",
    },
    notes: ["扫描 `MEMORY.md`。"],
    relativePath: "MEMORY.md",
  }),
  createDirectorySpec({
    id: "builtin:memory:daily-notes",
    label: "memory 日记资产",
    sourceKind: "memory_notes",
    sourceClass: "raw",
    scope: "private",
    duplicateRisk: {
      level: "medium",
      rationale: "daily memory 会与任务、digest、dream 等派生层反复回灌同一事实。",
    },
    notes: ["扫描 `memory/**/*.md`。"],
    relativeDir: "memory",
    pattern: "**/*.md",
    recursive: true,
    matcher: (fileName) => fileName.endsWith(".md"),
  }),
  createSingleFileSpec({
    id: "builtin:dream:runtime",
    label: "dream runtime 状态",
    sourceKind: "dream_runtime",
    sourceClass: "derived",
    scope: "private",
    duplicateRisk: {
      level: "high",
      rationale: "dream runtime 保存的是状态快照，与 dream 笔记、digest、session memory 存在明显派生重叠。",
    },
    notes: ["扫描 `dream-runtime.json`。"],
    relativePath: "dream-runtime.json",
  }),
  createSingleFileSpec({
    id: "builtin:dream:index",
    label: "DREAM.md 索引",
    sourceKind: "dream_index",
    sourceClass: "derived",
    scope: "private",
    duplicateRisk: {
      level: "medium",
      rationale: "DREAM.md 更偏索引与摘要层，信息密度高但重复风险也高于 raw 来源。",
    },
    notes: ["扫描 `DREAM.md`。"],
    relativePath: "DREAM.md",
  }),
  createDirectorySpec({
    id: "builtin:dream:notes",
    label: "dream 笔记资产",
    sourceKind: "dream_notes",
    sourceClass: "curated",
    scope: "private",
    duplicateRisk: {
      level: "medium",
      rationale: "dream 笔记属于高层整理资产，可能复述 task、digest、memory 中的结论。",
    },
    notes: ["扫描 `dreams/**/*.md`。"],
    relativeDir: "dreams",
    pattern: "**/*.md",
    recursive: true,
    matcher: (fileName) => fileName.endsWith(".md"),
  }),
];

export async function buildMemorySourceInventoryReport(
  input: BuildMemorySourceInventoryInput,
): Promise<MemorySourceInventoryReport> {
  const builtinFileItems = await Promise.all(BUILTIN_FILE_SPECS.map((spec) => spec.scan(input.stateDir)));
  const databaseItems = buildDatabaseItems(input);
  const configuredItems = await Promise.all(
    (input.configuredSources ?? []).map((source, index) => scanConfiguredSource(source, index)),
  );
  const items = [...builtinFileItems, ...databaseItems, ...configuredItems].sort((left, right) =>
    left.label.localeCompare(right.label, "zh-CN"),
  );
  const families = buildInventoryFamilies(items);

  const totals = items.reduce<MemorySourceInventoryReport["totals"]>((acc, item) => {
    acc.sourceKinds += 1;
    acc.fileCount += item.stats.fileCount;
    acc.rowCount += item.stats.rowCount;
    acc.totalBytes += item.stats.totalBytes;
    acc.byClass[item.sourceClass] += item.stats.itemCount;
    acc.byScope[item.scope] += item.stats.itemCount;
    acc.bySearchPolicy[item.admission.searchPolicy] += item.stats.itemCount;
    if (item.status === "present") acc.presentSourceKinds += 1;
    if (item.status === "declared") acc.declaredSourceKinds += 1;
    if (item.status === "missing") acc.missingSourceKinds += 1;
    return acc;
  }, {
    sourceKinds: 0,
    presentSourceKinds: 0,
    declaredSourceKinds: 0,
    missingSourceKinds: 0,
    fileCount: 0,
    rowCount: 0,
    totalBytes: 0,
    indexedFiles: input.memoryStatus.files ?? 0,
    indexedChunks: input.memoryStatus.chunks ?? 0,
    sourceFamilyCount: families.length,
    multiMemberFamilyCount: families.filter((family) => family.memberCount > 1).length,
    highRiskFamilyCount: families.filter((family) => family.duplicateRisk.level === "high").length,
    byClass: { raw: 0, derived: 0, curated: 0 },
    byScope: { private: 0, shared: 0, team: 0 },
    bySearchPolicy: { "inventory-only": 0, searchable: 0, "summary-input-only": 0 },
  });

  return {
    version: INVENTORY_REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    stateDir: input.stateDir,
    totals,
    items,
    families,
  };
}

function buildDatabaseItems(input: BuildMemorySourceInventoryInput): MemorySourceInventoryItem[] {
  const taskLastUpdatedAt = maxIso(input.taskStats.lastTaskUpdatedAt, input.taskStats.lastActivityAt);
  const experienceLastUpdatedAt = maxIso(input.experienceStats.lastCandidateCreatedAt, input.experienceStats.lastUsageCreatedAt);
  return [
    finalizeInventoryItem({
      id: "builtin:db:tasks",
      label: "任务结构化记录",
      sourceKind: "tasks",
      sourceClass: "derived",
      scope: "private",
      storage: "database",
      status: input.taskStats.taskCount > 0 ? "present" : "missing",
      duplicateRisk: {
        level: "medium",
        rationale: "tasks 把会话执行整理成结构化记录，和 session / activity / experience 有交叉。",
      },
      stats: {
        itemCount: input.taskStats.taskCount,
        fileCount: 0,
        rowCount: input.taskStats.taskCount,
        totalBytes: 0,
        lastUpdatedAt: input.taskStats.lastTaskUpdatedAt,
      },
      location: {
        table: "tasks",
      },
      notes: ["来自 `memory.sqlite.tasks`。"],
    }),
    finalizeInventoryItem({
      id: "builtin:db:task-activities",
      label: "任务活动流水",
      sourceKind: "task_activities",
      sourceClass: "derived",
      scope: "private",
      storage: "database",
      status: input.taskStats.taskActivityCount > 0 ? "present" : "missing",
      duplicateRisk: {
        level: "high",
        rationale: "task activity 与 tasks、session transcript、tool 结果之间天然存在动作级重复。",
      },
      stats: {
        itemCount: input.taskStats.taskActivityCount,
        fileCount: 0,
        rowCount: input.taskStats.taskActivityCount,
        totalBytes: 0,
        lastUpdatedAt: taskLastUpdatedAt,
      },
      location: {
        table: "task_activities",
      },
      notes: ["来自 `memory.sqlite.task_activities`。"],
    }),
    finalizeInventoryItem({
      id: "builtin:db:experience-candidates",
      label: "经验候选资产",
      sourceKind: "experience_candidates",
      sourceClass: "curated",
      scope: "private",
      storage: "database",
      status: input.experienceStats.candidateCount > 0 ? "present" : "missing",
      duplicateRisk: {
        level: "medium",
        rationale: "经验候选是整理资产层，但会和任务复盘、已发布资产、合成结果形成语义重叠。",
      },
      stats: {
        itemCount: input.experienceStats.candidateCount,
        fileCount: 0,
        rowCount: input.experienceStats.candidateCount,
        totalBytes: 0,
        lastUpdatedAt: input.experienceStats.lastCandidateCreatedAt,
      },
      location: {
        table: "experience_candidates",
      },
      notes: [
        "来自 `memory.sqlite.experience_candidates`。",
        `draft=${input.experienceStats.draftCandidateCount}, accepted=${input.experienceStats.acceptedCandidateCount}, rejected=${input.experienceStats.rejectedCandidateCount}`,
      ],
    }),
    finalizeInventoryItem({
      id: "builtin:db:experience-usages",
      label: "经验消费记录",
      sourceKind: "experience_usages",
      sourceClass: "derived",
      scope: "private",
      storage: "database",
      status: input.experienceStats.usageCount > 0 ? "present" : "missing",
      duplicateRisk: {
        level: "low",
        rationale: "usage 更偏 telemetry 与 provenance，正文重复风险低于摘要类来源。",
      },
      stats: {
        itemCount: input.experienceStats.usageCount,
        fileCount: 0,
        rowCount: input.experienceStats.usageCount,
        totalBytes: 0,
        lastUpdatedAt: experienceLastUpdatedAt,
      },
      location: {
        table: "experience_usages",
      },
      notes: ["来自 `memory.sqlite.experience_usages`。"],
    }),
  ];
}

function createDirectorySpec(input: {
  id: string;
  label: string;
  sourceKind: string;
  sourceClass: MemorySourceInventoryClass;
  scope: MemorySourceInventoryScope;
  duplicateRisk: MemorySourceInventoryItem["duplicateRisk"];
  notes: string[];
  relativeDir: string;
  pattern: string;
  recursive: boolean;
  matcher: (fileName: string) => boolean;
}): InventoryBuiltinFileSpec {
  return {
    ...input,
    async scan(stateDir: string) {
      const rootDir = path.join(stateDir, input.relativeDir);
      const stats = await scanDirectory(rootDir, {
        recursive: input.recursive,
        matcher: input.matcher,
      });
      return finalizeInventoryItem({
        id: input.id,
        label: input.label,
        sourceKind: input.sourceKind,
        sourceClass: input.sourceClass,
        scope: input.scope,
        storage: "filesystem",
        status: stats.fileCount > 0 ? "present" : stats.exists ? "missing" : "missing",
        duplicateRisk: input.duplicateRisk,
        stats: {
          itemCount: stats.fileCount,
          fileCount: stats.fileCount,
          rowCount: 0,
          totalBytes: stats.totalBytes,
          lastUpdatedAt: stats.lastUpdatedAt,
        },
        location: {
          path: rootDir,
          pattern: input.pattern,
        },
        notes: input.notes,
      });
    },
  };
}

function createSingleFileSpec(input: {
  id: string;
  label: string;
  sourceKind: string;
  sourceClass: MemorySourceInventoryClass;
  scope: MemorySourceInventoryScope;
  duplicateRisk: MemorySourceInventoryItem["duplicateRisk"];
  notes: string[];
  relativePath: string;
}): InventoryBuiltinFileSpec {
  return {
    ...input,
    async scan(stateDir: string) {
      const filePath = path.join(stateDir, input.relativePath);
      const stats = await scanSingleFile(filePath);
      return finalizeInventoryItem({
        id: input.id,
        label: input.label,
        sourceKind: input.sourceKind,
        sourceClass: input.sourceClass,
        scope: input.scope,
        storage: "filesystem",
        status: stats.fileCount > 0 ? "present" : "missing",
        duplicateRisk: input.duplicateRisk,
        stats: {
          itemCount: stats.fileCount,
          fileCount: stats.fileCount,
          rowCount: 0,
          totalBytes: stats.totalBytes,
          lastUpdatedAt: stats.lastUpdatedAt,
        },
        location: {
          path: filePath,
          pattern: path.basename(filePath),
        },
        notes: input.notes,
      });
    },
  };
}

async function scanConfiguredSource(
  source: MemorySourceInventoryConfiguredSource,
  index: number,
): Promise<MemorySourceInventoryItem> {
  const label = source.label.trim() || `configured-source-${index + 1}`;
  const id = source.id?.trim() || `configured:${sanitizeIdentifier(label)}:${index + 1}`;
  const fileExtensions = normalizeFileExtensions(source.fileExtensions);
  if (typeof source.filePath === "string" && source.filePath.trim()) {
    const filePath = path.resolve(source.filePath.trim());
    const stats = await scanSingleFile(filePath);
    return finalizeInventoryItem({
      id,
      label,
      sourceKind: "configured_external",
      sourceClass: source.sourceClass,
      scope: source.scope ?? "private",
      storage: "external",
      status: stats.fileCount > 0 ? "present" : "declared",
      duplicateRisk: {
        level: source.sourceClass === "raw" ? "medium" : "low",
        rationale: "configured 外来源默认只做声明与盘点，后续仍需 inventory/classify/score 才能进入长期树。",
      },
      stats: {
        itemCount: stats.fileCount,
        fileCount: stats.fileCount,
        rowCount: 0,
        totalBytes: stats.totalBytes,
        lastUpdatedAt: stats.lastUpdatedAt,
      },
      location: {
        path: filePath,
        pattern: path.basename(filePath),
      },
      notes: [source.note, "configured 外来源：当前阶段只读盘点，不自动入树。"].filter(isTruthy),
    }, {
      configuredSearchPolicy: source.searchPolicy,
    });
  }

  if (typeof source.rootPath === "string" && source.rootPath.trim()) {
    const rootPath = path.resolve(source.rootPath.trim());
    const stats = await scanDirectory(rootPath, {
      recursive: source.recursive !== false,
      matcher: (fileName) => {
        if (fileExtensions.length <= 0) return true;
        return fileExtensions.some((ext) => fileName.toLowerCase().endsWith(ext));
      },
    });
    return finalizeInventoryItem({
      id,
      label,
      sourceKind: "configured_external",
      sourceClass: source.sourceClass,
      scope: source.scope ?? "private",
      storage: "external",
      status: stats.fileCount > 0 ? "present" : "declared",
      duplicateRisk: {
        level: source.sourceClass === "raw" ? "medium" : "low",
        rationale: "configured 外来源默认只做声明与盘点，后续仍需 inventory/classify/score 才能进入长期树。",
      },
      stats: {
        itemCount: stats.fileCount,
        fileCount: stats.fileCount,
        rowCount: 0,
        totalBytes: stats.totalBytes,
        lastUpdatedAt: stats.lastUpdatedAt,
      },
      location: {
        path: rootPath,
        pattern: fileExtensions.length > 0 ? `**/*{${fileExtensions.join(",")}}` : "**/*",
      },
      notes: [source.note, "configured 外来源：当前阶段只读盘点，不自动入树。"].filter(isTruthy),
    }, {
      configuredSearchPolicy: source.searchPolicy,
    });
  }

  return finalizeInventoryItem({
    id,
    label,
    sourceKind: "configured_external",
    sourceClass: source.sourceClass,
    scope: source.scope ?? "private",
    storage: "external",
    status: "declared",
    duplicateRisk: {
      level: source.sourceClass === "raw" ? "medium" : "low",
      rationale: "configured 外来源当前仅声明接入位，尚未绑定实际路径。",
    },
    stats: {
      itemCount: 0,
      fileCount: 0,
      rowCount: 0,
      totalBytes: 0,
    },
    location: {},
    notes: [source.note, "configured 外来源：当前阶段只读盘点，不自动入树。"].filter(isTruthy),
  }, {
    configuredSearchPolicy: source.searchPolicy,
  });
}

function finalizeInventoryItem(
  item: Omit<MemorySourceInventoryItem, "admission" | "identity">,
  options: {
    configuredSearchPolicy?: MemorySourceSearchPolicy;
  } = {},
): MemorySourceInventoryItem {
  return {
    ...item,
    admission: resolveMemorySourceAdmission({
      sourceKind: item.sourceKind,
      sourceClass: item.sourceClass,
      storage: item.storage,
      configuredSearchPolicy: options.configuredSearchPolicy,
    }),
    identity: resolveMemorySourceIdentity({
      id: item.id,
      sourceKind: item.sourceKind,
      sourceClass: item.sourceClass,
      scope: item.scope,
      sourcePath: item.location.path,
      sourceRef: item.location.table ?? item.location.pattern,
      builtinInventoryId: item.id.startsWith("builtin:") ? item.id : undefined,
      updatedAt: item.stats.lastUpdatedAt,
    }),
  };
}

function buildInventoryFamilies(items: MemorySourceInventoryItem[]): MemorySourceInventoryFamily[] {
  const familyMap = new Map<string, MemorySourceInventoryFamilyMember[]>();
  for (const item of items) {
    const familyKey = item.identity.sourceFamilyKey;
    const members = familyMap.get(familyKey) ?? [];
    members.push({
      id: item.id,
      label: item.label,
      sourceKind: item.sourceKind,
      sourceClass: item.sourceClass,
      storage: item.storage,
      status: item.status,
      searchPolicy: item.admission.searchPolicy,
    });
    familyMap.set(familyKey, members);
  }

  return [...familyMap.entries()]
    .map(([sourceFamilyKey, members]) => {
      const memberCount = members.length;
      const presentMemberCount = members.filter((item) => item.status === "present").length;
      const sourceKinds = dedupeStrings(members.map((item) => item.sourceKind));
      const sourceClasses = dedupeSourceClasses(members.map((item) => item.sourceClass));
      const searchPolicies = dedupeSearchPolicies(members.map((item) => item.searchPolicy));
      return {
        sourceFamilyKey,
        memberCount,
        presentMemberCount,
        sourceKinds,
        sourceClasses,
        searchPolicies,
        duplicateRisk: resolveFamilyDuplicateRisk(memberCount, sourceClasses, searchPolicies),
        members: [...members],
      };
    })
    .sort((left, right) => {
      if (right.memberCount !== left.memberCount) {
        return right.memberCount - left.memberCount;
      }
      return left.sourceFamilyKey.localeCompare(right.sourceFamilyKey, "zh-CN");
    });
}

function resolveFamilyDuplicateRisk(
  memberCount: number,
  sourceClasses: MemorySourceInventoryClass[],
  searchPolicies: MemorySourceSearchPolicy[],
): MemorySourceInventoryFamily["duplicateRisk"] {
  if (memberCount <= 1) {
    return {
      level: "low",
      rationale: "这个 family 目前只有一个来源成员，重复压力较低。",
    };
  }
  if (sourceClasses.length > 1) {
    return {
      level: "high",
      rationale: "同一个 family 里同时存在原文与派生层，容易发生重复、覆盖或摘要互相回灌。",
    };
  }
  if (memberCount >= 3 || searchPolicies.includes("summary-input-only")) {
    return {
      level: "medium",
      rationale: "同一个 family 有多个成员，适合继续按版本和用途分层治理。",
    };
  }
  return {
    level: "medium",
    rationale: "同一个 family 有多个成员，仍建议持续观察是否出现重复回灌。",
  };
}

function dedupeSourceClasses(values: MemorySourceInventoryClass[]): MemorySourceInventoryClass[] {
  return dedupeStrings(values) as MemorySourceInventoryClass[];
}

function dedupeSearchPolicies(values: MemorySourceSearchPolicy[]): MemorySourceSearchPolicy[] {
  return dedupeStrings(values) as MemorySourceSearchPolicy[];
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((item) => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))];
}

async function scanSingleFile(filePath: string): Promise<{
  fileCount: number;
  totalBytes: number;
  lastUpdatedAt?: string;
}> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return { fileCount: 0, totalBytes: 0 };
    }
    return {
      fileCount: 1,
      totalBytes: stat.size,
      lastUpdatedAt: stat.mtime.toISOString(),
    };
  } catch {
    return { fileCount: 0, totalBytes: 0 };
  }
}

async function scanDirectory(
  rootDir: string,
  options: {
    recursive: boolean;
    matcher: (fileName: string) => boolean;
  },
): Promise<{
  exists: boolean;
  fileCount: number;
  totalBytes: number;
  lastUpdatedAt?: string;
}> {
  try {
    const rootStat = await fs.stat(rootDir);
    if (!rootStat.isDirectory()) {
      return { exists: false, fileCount: 0, totalBytes: 0 };
    }
  } catch {
    return { exists: false, fileCount: 0, totalBytes: 0 };
  }

  let fileCount = 0;
  let totalBytes = 0;
  let newestMtimeMs = 0;

  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) continue;
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (options.recursive) {
          stack.push(fullPath);
        }
        continue;
      }
      if (!entry.isFile() || !options.matcher(entry.name)) {
        continue;
      }
      const stat = await fs.stat(fullPath).catch(() => null);
      if (!stat || !stat.isFile()) {
        continue;
      }
      fileCount += 1;
      totalBytes += stat.size;
      newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs);
    }
  }

  return {
    exists: true,
    fileCount,
    totalBytes,
    lastUpdatedAt: newestMtimeMs > 0 ? new Date(newestMtimeMs).toISOString() : undefined,
  };
}

function normalizeFileExtensions(fileExtensions?: string[]): string[] {
  if (!Array.isArray(fileExtensions)) return [];
  return [...new Set(fileExtensions
    .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
    .filter(Boolean)
    .map((item) => (item.startsWith(".") ? item : `.${item}`)))];
}

function sanitizeIdentifier(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "external";
}

function maxIso(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left >= right ? left : right;
}

function isTruthy<T>(value: T | null | undefined | ""): value is T {
  return Boolean(value);
}
