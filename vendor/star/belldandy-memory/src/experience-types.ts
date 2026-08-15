import type { MemoryVisibility } from "./types.js";
import type {
  TaskActivityRecord,
  TaskMemoryRelation,
  TaskRecord,
  TaskSource,
  TaskStatus,
  TaskToolCallSummary,
} from "./task-types.js";

export type ExperienceCandidateType = "method" | "skill";
export type ExperienceCandidateStatus = "draft" | "reviewed" | "accepted" | "rejected" | "published";
export type ExperienceAssetType = "method" | "skill";
export type ExperiencePublishedAssetSource = "method_asset" | "skill_asset";
export type ExperienceUsageVia = "manual" | "search" | "tool" | "auto_suggest";
export type ExperienceDraftOriginKind = "generated" | "synthesized" | "published";
export type ExperienceSynthesisRelation = "same_family" | "similar";

export interface ExperienceTaskMemoryLink {
  chunkId: string;
  relation: TaskMemoryRelation;
  sourcePath?: string;
  memoryType?: string;
  visibility?: MemoryVisibility;
  snippet?: string;
}

export interface ExperienceSourceTaskSnapshot {
  taskId: string;
  conversationId: string;
  agentId?: string;
  source: TaskSource;
  status: TaskStatus;
  title?: string;
  objective?: string;
  summary?: string;
  reflection?: string;
  outcome?: string;
  toolCalls?: TaskToolCallSummary[];
  artifactPaths?: string[];
  memoryLinks?: ExperienceTaskMemoryLink[];
  startedAt: string;
  finishedAt?: string;
}

export interface ExperienceCandidateDraftOriginMetadata {
  kind: ExperienceDraftOriginKind;
}

export interface ExperienceCandidatePublishedOriginMetadata {
  assetPath: string;
  assetKey: string;
  assetSource: ExperiencePublishedAssetSource;
}

export interface ExperienceCandidateSynthesisMetadata {
  seedCandidateId: string;
  sourceCandidateIds: string[];
  sourceCount: number;
  createdBy: "main_model";
  templateId?: string;
  templatePath?: string;
  seedPublishedPath?: string;
  seedPublishedAssetKey?: string;
  seedPublishedAssetSource?: ExperiencePublishedAssetSource;
}

export interface ExperienceCandidateSynthesisConsumedMetadata {
  consumed: true;
  consumedByCandidateId: string;
  consumedAt: string;
  consumedRunId: string;
}

export interface ExperienceCandidateMetadata {
  draftOrigin?: ExperienceCandidateDraftOriginMetadata;
  publishedOrigin?: ExperienceCandidatePublishedOriginMetadata;
  synthesis?: ExperienceCandidateSynthesisMetadata;
  synthesisConsumed?: ExperienceCandidateSynthesisConsumedMetadata;
}

export interface ExperienceCandidate {
  id: string;
  taskId: string;
  type: ExperienceCandidateType;
  status: ExperienceCandidateStatus;
  title: string;
  slug: string;
  content: string;
  summary?: string;
  qualityScore?: number;
  sourceTaskSnapshot: ExperienceSourceTaskSnapshot;
  publishedPath?: string;
  createdAt: string;
  reviewedAt?: string;
  acceptedAt?: string;
  rejectedAt?: string;
  metadata?: ExperienceCandidateMetadata;
}

export interface ExperienceCandidateListFilter {
  taskId?: string;
  type?: ExperienceCandidateType | ExperienceCandidateType[];
  status?: ExperienceCandidateStatus | ExperienceCandidateStatus[];
  agentId?: string;
  synthesisConsumed?: boolean;
  consumedByCandidateId?: string;
  draftOriginKind?: ExperienceDraftOriginKind | ExperienceDraftOriginKind[];
}

export interface ExperienceCandidateStats {
  total: number;
  methods: number;
  skills: number;
  draft: number;
  accepted: number;
  rejected: number;
}

export interface ExperienceUsage {
  id: string;
  taskId: string;
  assetType: ExperienceAssetType;
  assetKey: string;
  sourceCandidateId?: string;
  usedVia: ExperienceUsageVia;
  createdAt: string;
}

export interface ExperienceUsageListFilter {
  taskId?: string;
  assetType?: ExperienceAssetType | ExperienceAssetType[];
  assetKey?: string;
  sourceCandidateId?: string;
}

export interface ExperienceUsageStats {
  assetType: ExperienceAssetType;
  assetKey: string;
  sourceCandidateId?: string;
  sourceCandidateType?: ExperienceCandidateType;
  sourceCandidateTitle?: string;
  sourceCandidateStatus?: ExperienceCandidateStatus;
  sourceCandidateTaskId?: string;
  sourceCandidatePublishedPath?: string;
  usageCount: number;
  lastUsedAt?: string;
  lastUsedTaskId?: string;
}

export interface ExperienceUsageSummary extends ExperienceUsageStats {
  usageId: string;
  taskId: string;
  usedVia: ExperienceUsageVia;
  createdAt: string;
}

export type ExperienceDedupDecision = "new_candidate" | "duplicate_existing" | "similar_existing";

export interface ExperienceDedupMatch {
  source: "candidate" | "method_asset" | "skill_asset";
  assetType: ExperienceCandidateType;
  key: string;
  title?: string;
  summary?: string;
  candidateId?: string;
  candidateStatus?: ExperienceCandidateStatus;
  publishedPath?: string;
  score?: number;
}

export interface ExperiencePromoteResult {
  candidate: ExperienceCandidate;
  reusedExisting: boolean;
  dedupDecision?: ExperienceDedupDecision;
  exactMatch?: ExperienceDedupMatch;
  similarMatches?: ExperienceDedupMatch[];
}

export interface ExperienceDedupCheckResult {
  taskId: string;
  type: ExperienceCandidateType;
  title: string;
  slug: string;
  summary?: string;
  decision: ExperienceDedupDecision;
  exactMatch?: ExperienceDedupMatch;
  similarMatches: ExperienceDedupMatch[];
}

export interface ExperienceSynthesisPreviewItem {
  candidateId: string;
  type: ExperienceCandidateType;
  status: ExperienceCandidateStatus;
  title: string;
  slug: string;
  summary?: string;
  taskId: string;
  sourceTaskId?: string;
  updatedAt?: string;
  score: number;
  relation: ExperienceSynthesisRelation;
}

export interface ExperienceSynthesisPreviewResult {
  seedCandidateId: string;
  candidateType: ExperienceCandidateType;
  totalCount: number;
  taskCount: number;
  items: ExperienceSynthesisPreviewItem[];
}

export interface ExperienceUsageRecordResult {
  usage: ExperienceUsage;
  reusedExisting: boolean;
}

export interface ExperienceUsageRevokeResult {
  usage: ExperienceUsage;
}

export interface ExperienceSourceTaskDetail extends TaskRecord {
  memoryLinks?: ExperienceTaskMemoryLink[];
}

export interface TaskExperienceDetail extends TaskRecord {
  activities: TaskActivityRecord[];
  memoryLinks: ExperienceTaskMemoryLink[];
  usedMethods: ExperienceUsageSummary[];
  usedSkills: ExperienceUsageSummary[];
}
