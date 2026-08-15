import type {
  MemorySourceInventoryClass,
  MemorySourceInventoryScope,
} from "./memory-source-inventory.js";
import type { MemorySearchResult, MemoryVisibility } from "./types.js";

export type MemoryTreeScope = MemorySourceInventoryScope;
export type MemoryTreeTargetType = "chunk" | "node" | "source";

export type MemoryTreeSourceRecord = {
  id: string;
  sourceKind: string;
  sourceClass: MemorySourceInventoryClass;
  scope: MemoryTreeScope;
  agentId?: string;
  sourcePath?: string;
  sourceRef?: string;
  contentHash?: string;
  timeFrom?: string;
  timeTo?: string;
  itemCount?: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
};

export type MemoryTreeSourceListFilter = {
  ids?: string[];
  sourceKind?: string | string[];
  sourceClass?: MemorySourceInventoryClass | MemorySourceInventoryClass[];
  scope?: MemoryTreeScope | MemoryTreeScope[];
  agentId?: string | null;
  sourcePath?: string;
  sourceRef?: string;
};

export type MemoryTreeScoreRecord = {
  id: string;
  targetType: MemoryTreeTargetType;
  targetId: string;
  sourceId?: string;
  scoreTotal: number;
  recencyScore?: number;
  sourceWeightScore?: number;
  interactionScore?: number;
  taskOutcomeScore?: number;
  entityDensityScore?: number;
  llmImportanceScore?: number;
  dedupConfidence?: number;
  scoreVersion: string;
  rationale?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
};

export type MemoryTreeScoreListFilter = {
  targetType?: MemoryTreeTargetType | MemoryTreeTargetType[];
  targetId?: string;
  sourceId?: string;
  scoreVersion?: string | string[];
};

export type MemoryTreeChunkScoreInput = {
  chunkId: string;
  sourcePath: string;
  sourceType: string;
  memoryType?: string;
  visibility?: MemoryVisibility;
  agentId?: string;
  updatedAt?: string;
  content?: string;
  taskLinkCount: number;
  successTaskCount: number;
  partialTaskCount: number;
  failedTaskCount: number;
  runningTaskCount: number;
};

export type MemoryTreeSourceRebuildResult = {
  rebuiltAt: string;
  totalSources: number;
  inventorySources: number;
  dynamicSources: number;
  skipped?: boolean;
  skipReason?: string;
  skippedAt?: string;
};

export type MemoryTreeScoreRebuildResult = {
  rebuiltAt: string;
  scoreVersion: string;
  totalScores: number;
  skipped?: boolean;
  skipReason?: string;
  skippedAt?: string;
};

export type MemoryTreeReportType =
  | "inventory"
  | "dedup_preview"
  | "external_ingest_preview"
  | "shared_governance_preview"
  | "compression_preview"
  | "tree_build_preview";

export type MemoryTreeReportStatus =
  | "ready"
  | "approved"
  | "rejected"
  | "superseded"
  | "applied";

export type MemoryTreeReportReviewDecision =
  | "approved"
  | "rejected"
  | "superseded";

export type MemoryTreeReportRecord = {
  id: string;
  reportType: MemoryTreeReportType;
  scope: MemoryTreeScope;
  agentId?: string;
  status: MemoryTreeReportStatus;
  inputVersion?: string;
  summary: Record<string, unknown>;
  details: Record<string, unknown>;
  exportMarkdownPath?: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type MemoryTreeReportListFilter = {
  ids?: string[];
  reportType?: MemoryTreeReportType | MemoryTreeReportType[];
  scope?: MemoryTreeScope | MemoryTreeScope[];
  agentId?: string | null;
  status?: MemoryTreeReportStatus | MemoryTreeReportStatus[];
};

export type MemoryTreeNodeKind =
  | "task"
  | "conversation"
  | "day"
  | "topic"
  | "project"
  | "agent"
  | "profile"
  | "global";

export type MemoryTreeNodeRecord = {
  id: string;
  level: number;
  kind: MemoryTreeNodeKind;
  scope: MemoryTreeScope;
  agentId?: string;
  topicKey?: string;
  title?: string;
  summary: string;
  summaryModel?: string;
  summaryVersion?: string;
  timeFrom?: string;
  timeTo?: string;
  sourceClassMix?: Record<string, number>;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
};

export type MemoryTreeNodeListFilter = {
  ids?: string[];
  level?: number | number[];
  kind?: MemoryTreeNodeKind | MemoryTreeNodeKind[];
  scope?: MemoryTreeScope | MemoryTreeScope[];
  agentId?: string | null;
  topicKey?: string;
};

export type MemoryTreeEdgeRecord = {
  id: string;
  parentNodeId: string;
  childType: MemoryTreeTargetType;
  childId: string;
  relation: string;
  position?: number;
  weight?: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
};

export type MemoryTreeEdgeListFilter = {
  parentNodeId?: string;
  childType?: MemoryTreeTargetType | MemoryTreeTargetType[];
  childId?: string;
  relation?: string | string[];
};

export type MemoryTreeNodeRebuildResult = {
  rebuiltAt: string;
  totalNodes: number;
  totalEdges: number;
  kind: MemoryTreeNodeKind;
  skipped?: boolean;
  skipReason?: string;
  skippedAt?: string;
};

export type MemoryTreeNodeSearchResult = {
  node: MemoryTreeNodeRecord;
  score: number;
  matchReasons: string[];
  edges: MemoryTreeEdgeRecord[];
  chunks: MemorySearchResult[];
  sources?: MemoryTreeSourceRecord[];
};

export type MemoryTreeNodeDetailResult = {
  node: MemoryTreeNodeRecord;
  edges: MemoryTreeEdgeRecord[];
  chunks: MemorySearchResult[];
  sources: MemoryTreeSourceRecord[];
};

export type MemoryTreeReportPersistResult = {
  reportId: string;
  reportType: MemoryTreeReportType;
  status: MemoryTreeReportStatus;
  persistedAt: string;
};

export type MemoryTreeReportReviewResult = {
  report: MemoryTreeReportRecord;
  previousStatus: MemoryTreeReportStatus;
  decision: MemoryTreeReportReviewDecision;
  reviewedAt: string;
};

export type MemoryTreeReportApplyAction = {
  kind?: "dedup_archive" | "dedup_skip" | "external_ingest" | "report_governance_ack";
  reportType?: MemoryTreeReportType;
  governanceState?: string;
  chunkId?: string;
  keepChunkId?: string;
  normalizedHash?: string;
  previousScoreTotal?: number;
  nextScoreTotal?: number;
  archived?: boolean;
  sourcePath?: string;
  importedChunkCount?: number;
  removedChunkCount?: number;
  skipped?: boolean;
  stale?: boolean;
  reason?: string;
};

export type MemoryTreeReportApplyResult = {
  report: MemoryTreeReportRecord;
  appliedAt: string;
  updatedChunkCount: number;
  updatedScoreCount: number;
  skippedChunkIds: string[];
  actions: MemoryTreeReportApplyAction[];
};
