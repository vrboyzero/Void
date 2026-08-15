import type {
  ExperienceUsageSummary,
  TaskExperienceDetail,
} from "./experience-types.js";
import type {
  TaskWorkSourceExplanation,
  TaskWorkSourceReference,
} from "./task-work-surface.js";
import type {
  ProfileStateEntry,
  ProfileStateValue,
  UpsertProfileStateEntryInput,
} from "./profile-state-types.js";
import type {
  MemoryCategory,
  MemorySearchFilter,
  MemorySearchResult,
  MemoryType,
  MemoryVisibility,
} from "./types.js";
import type { MemoryModelPrivacyRuntime } from "./memory-model-privacy.js";
import type {
  TaskSearchFilter,
  TaskSource,
  TaskStatus,
  TaskWorkRecapSnapshot,
  ResumeContextSnapshot,
} from "./task-types.js";

export type DreamStatus = "idle" | "queued" | "running" | "completed" | "failed";
export type DreamTriggerMode = "manual" | "heartbeat" | "cron" | "recovery";
export type DreamObsidianSyncStage = "idle" | "pending" | "synced" | "failed" | "skipped";
export type DreamShareCandidateVisibility = "private" | "shared_candidate" | "unclear";
export type DreamGenerationMode = "llm" | "fallback";
export type DreamFallbackReason = "missing_model_config" | "llm_call_failed";
export type DreamConfidenceLevel = "high" | "medium" | "low";

export interface DreamMindProfileSnapshot {
  summary?: {
    available?: boolean;
    headline?: string;
    usageLinkedCount?: number;
    privateMemoryCount?: number;
    sharedMemoryCount?: number;
    hasUserProfile?: boolean;
  };
  identity?: {
    userName?: string;
    hasUserProfile?: boolean;
  };
  memory?: {
    privateMemoryCount?: number;
    sharedMemoryCount?: number;
    privateSummary?: string;
    sharedSummary?: string;
    recentMemorySnippets?: Array<{
      scope?: "private" | "shared";
      sourcePath?: string;
      text?: string;
    }>;
  };
  experience?: {
    usageLinkedCount?: number;
  };
  profile?: {
    headline?: string;
    summaryLines?: string[];
    stateSummaryLines?: string[];
    stateEntries?: Array<{
      path?: string;
      valueText?: string;
      confidence?: number;
      updatedAt?: string;
      lastConfirmedAt?: string;
    }>;
    treeSummaryLines?: string[];
  };
  conversation?: {
    topResidents?: Array<{
      agentId?: string;
      conversationId?: string;
      digestStatus?: string;
      pendingMessageCount?: number;
      headline?: string;
    }>;
  };
  [key: string]: unknown;
}

export interface DreamLearningReviewInput {
  summary?: {
    available?: boolean;
    headline?: string;
    memorySignalCount?: number;
    taskSignalCount?: number;
    candidateSignalCount?: number;
    reviewSignalCount?: number;
    nudgeCount?: number;
  };
  summaryLines?: string[];
  nudges?: string[];
  [key: string]: unknown;
}

export interface DreamSessionDigest {
  conversationId?: string;
  status?: "idle" | "ready" | "updated" | string;
  messageCount?: number;
  digestedMessageCount?: number;
  pendingMessageCount?: number;
  threshold?: number;
  rollingSummary?: string;
  archivalSummary?: string;
  lastDigestAt?: number;
  digestGeneration?: number;
}

export interface DreamSessionMemory {
  conversationId?: string;
  summary?: string;
  currentGoal?: string;
  decisions?: string[];
  keyResults?: string[];
  filesTouched?: string[];
  errorsAndFixes?: string[];
  pendingTasks?: string[];
  currentWork?: string;
  nextStep?: string;
  lastSummarizedMessageCount?: number;
  lastSummarizedToolCursor?: number;
  updatedAt?: number;
}

export interface DreamWorkItem {
  taskId: string;
  conversationId: string;
  title?: string;
  objective?: string;
  summary?: string;
  status: TaskStatus;
  source: TaskSource;
  startedAt: string;
  finishedAt?: string;
  updatedAt: string;
  agentId?: string;
  toolNames: string[];
  artifactPaths: string[];
  recentActivityTitles: string[];
  workRecap?: TaskWorkRecapSnapshot;
  resumeContext?: ResumeContextSnapshot;
  sourceExplanation?: TaskWorkSourceExplanation | null;
}

export interface DreamDurableMemoryItem {
  id: string;
  sourcePath: string;
  sourceType: string;
  memoryType?: MemoryType;
  category?: MemoryCategory;
  visibility?: MemoryVisibility;
  content?: string;
  snippet: string;
  summary?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface DreamInputSourceCounts {
  recentTaskCount: number;
  recentWorkCount: number;
  recentWorkRecapCount: number;
  recentResumeContextCount: number;
  recentDurableMemoryCount: number;
  recentPrivateMemoryCount: number;
  recentSharedMemoryCount: number;
  recentExperienceUsageCount: number;
  sessionDigestAvailable: boolean;
  sessionMemoryAvailable: boolean;
  mindProfileAvailable: boolean;
  learningReviewAvailable: boolean;
}

export interface DreamRuleSkeletonSourceSummary {
  primarySources: string[];
  sourceCount: number;
  taskCount: number;
  workCount: number;
  durableMemoryCount: number;
  experienceUsageCount: number;
  summaryLine: string;
}

export interface DreamRuleSkeleton {
  topicCandidates: string[];
  confirmedFacts: string[];
  openLoops: string[];
  carryForwardCandidates: string[];
  sourceSummary: DreamRuleSkeletonSourceSummary;
  confidence: DreamConfidenceLevel;
}

export interface DreamInputSnapshotMeta {
  collectedAt: string;
  windowHours: number;
  conversationId?: string;
  focusTaskId?: string;
  sourceCounts: DreamInputSourceCounts;
}

export interface DreamInputSnapshot extends DreamInputSnapshotMeta {
  agentId: string;
  windowStartedAt: string;
  changeCursor?: DreamChangeCursor;
  mindProfileSnapshot?: DreamMindProfileSnapshot;
  sessionDigest?: DreamSessionDigest;
  sessionMemory?: DreamSessionMemory;
  focusTask?: TaskExperienceDetail;
  recentTasks: TaskExperienceDetail[];
  recentWorkItems: DreamWorkItem[];
  recentDurableMemories: DreamDurableMemoryItem[];
  recentExperienceUsages: ExperienceUsageSummary[];
  learningReviewInput?: DreamLearningReviewInput;
  ruleSkeleton?: DreamRuleSkeleton;
}

export interface DreamObsidianSyncStatus {
  enabled?: boolean;
  stage: DreamObsidianSyncStage;
  targetPath?: string;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  error?: string;
}

export interface DreamObsidianMirrorOptions {
  enabled?: boolean;
  vaultPath?: string;
  rootDir?: string;
}

export interface DreamRecord {
  id: string;
  agentId: string;
  status: Exclude<DreamStatus, "idle">;
  triggerMode: DreamTriggerMode;
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  conversationId?: string;
  summary?: string;
  reason?: string;
  error?: string;
  dreamPath?: string;
  indexPath?: string;
  generationMode?: DreamGenerationMode;
  fallbackReason?: DreamFallbackReason;
  input?: DreamInputSnapshotMeta;
  obsidianSync?: DreamObsidianSyncStatus;
  consolidation?: DreamConsolidationSummary;
}

export interface DreamShareCandidate {
  title: string;
  reason?: string;
  evidence?: string;
  suggestedVisibility?: DreamShareCandidateVisibility;
}

export interface DreamModelOutput {
  headline?: string;
  summary?: string;
  narrative?: string;
  generationMode?: DreamGenerationMode;
  fallbackReason?: DreamFallbackReason;
  stableInsights: string[];
  corrections: string[];
  openQuestions: string[];
  shareCandidates: DreamShareCandidate[];
  nextFocus: string[];
}

export interface DreamConsolidationProfilePatchCandidate {
  field: string;
  valueSummary: string;
  source: "mind_profile" | "learning_review" | "recent_work" | "durable_memory";
  confidence: DreamConfidenceLevel;
  reason: string;
  profilePath?: string;
  profileValue?: ProfileStateValue;
}

export interface DreamConsolidationStaleCandidate {
  memoryClass: "profile_semantic" | "episodic_task" | "procedural_experience" | "governance";
  reason: string;
  evidence?: string;
}

export interface DreamConsolidationContradictionCandidate {
  topic: string;
  left: string;
  right: string;
  reason: string;
}

export interface DreamConsolidationSummary {
  headline: string;
  summary: string;
  profilePatchCandidates: DreamConsolidationProfilePatchCandidate[];
  staleCandidates: DreamConsolidationStaleCandidate[];
  contradictionCandidates: DreamConsolidationContradictionCandidate[];
  review?: DreamConsolidationReviewState;
  apply?: DreamConsolidationApplyState;
}

export type DreamConsolidationReviewDecision = "approved" | "rejected" | "superseded";

export interface DreamConsolidationReviewState {
  status: "pending" | "approved" | "rejected" | "superseded";
  reviewedAt?: string;
  reviewedBy?: string;
  note?: string;
  approvedCandidatePaths?: string[];
}

export interface DreamConsolidationAppliedPatch {
  profilePath: string;
  profileValue: ProfileStateValue;
  entryId?: string;
  action: "create" | "update" | "confirm";
  changed: boolean;
}

export interface DreamConsolidationApplyState {
  status: "not_applied" | "applied";
  appliedAt?: string;
  appliedBy?: string;
  note?: string;
  appliedPatchCount?: number;
  appliedPatches?: DreamConsolidationAppliedPatch[];
}

export interface DreamPromptBundle {
  system: string;
  user: string;
  inputView: Record<string, unknown>;
}

export interface DreamWriterResult {
  dreamPath: string;
  indexPath: string;
  markdown: string;
  indexMarkdown: string;
  summary?: string;
}

export interface DreamRuntimeSettings {
  inputWindowHours: number;
  cooldownHours: number;
  failureBackoffMinutes: number;
  maxRecentRuns: number;
}

export interface DreamChangeCursor {
  digestGeneration: number;
  sessionMemoryMessageCount: number;
  sessionMemoryToolCursor: number;
  taskChangeSeq: number;
  memoryChangeSeq: number;
}

export interface DreamRuntimeState {
  version: 1;
  agentId: string;
  status: DreamStatus;
  updatedAt: string;
  lastRunId?: string;
  lastDreamAt?: string;
  lastFailedAt?: string;
  cooldownUntil?: string;
  failureBackoffUntil?: string;
  lastDreamCursor?: DreamChangeCursor;
  lastAutoTrigger?: DreamAutoTriggerState;
  autoStats?: DreamAutoStats;
  lastInput?: DreamInputSnapshotMeta;
  lastObsidianSync?: DreamObsidianSyncStatus;
  settings: DreamRuntimeSettings;
  recentRuns: DreamRecord[];
}

export type DreamInputMindProfileBuilder = (input: {
  agentId: string;
  conversationId?: string;
  stateDir?: string;
  now: Date;
}) => Promise<DreamMindProfileSnapshot | null | undefined> | DreamMindProfileSnapshot | null | undefined;

export type DreamInputLearningReviewBuilder = (input: {
  agentId: string;
  conversationId?: string;
  stateDir?: string;
  now: Date;
  mindProfileSnapshot?: DreamMindProfileSnapshot;
  focusTask?: TaskExperienceDetail;
  recentTasks: TaskExperienceDetail[];
  recentWorkItems: DreamWorkItem[];
  recentDurableMemories: DreamDurableMemoryItem[];
  recentExperienceUsages: ExperienceUsageSummary[];
}) => Promise<DreamLearningReviewInput | null | undefined> | DreamLearningReviewInput | null | undefined;

export interface DreamInputMemoryManagerDelegate {
  getRecent(limit?: number, filter?: MemorySearchFilter, includeContent?: boolean): MemorySearchResult[];
  getRecentTasks(limit?: number, filter?: TaskSearchFilter): Array<{ id: string; updatedAt: string }>;
  getTaskDetail(taskId: string): TaskExperienceDetail | null;
  getTaskByConversation?(conversationId: string): { id: string } | null;
  getRecentWork?(input?: {
    query?: string;
    limit?: number;
    filter?: TaskSearchFilter;
  }): DreamWorkItem[];
}

export interface DreamInputBuildOptions {
  agentId: string;
  conversationId?: string;
  stateDir?: string;
  sessionsDir?: string;
  now?: Date | number | string;
  inputWindowHours?: number;
  recentTaskLimit?: number;
  recentWorkLimit?: number;
  recentMemoryLimit?: number;
  memoryManager: DreamInputMemoryManagerDelegate;
  buildMindProfileSnapshot?: DreamInputMindProfileBuilder;
  buildLearningReviewInput?: DreamInputLearningReviewBuilder;
  getSessionDigest?: (conversationId: string) => Promise<DreamSessionDigest | null | undefined> | DreamSessionDigest | null | undefined;
  getSessionMemory?: (conversationId: string) => Promise<DreamSessionMemory | null | undefined> | DreamSessionMemory | null | undefined;
  getTaskChangeSeq?: () => Promise<number | null | undefined> | number | null | undefined;
  getMemoryChangeSeq?: () => Promise<number | null | undefined> | number | null | undefined;
}

export interface DreamConversationArtifactFileOptions {
  sessionsDir: string;
  conversationId: string;
  suffix: ".digest.json" | ".session-memory.json";
}

export interface DreamRuntimeModelOptions {
  enabled?: boolean;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  thinking?: Record<string, unknown>;
  reasoningEffort?: string;
  maxTokens?: number;
  timeoutMs?: number;
  temperature?: number;
  modelPrivacyRuntime?: MemoryModelPrivacyRuntime;
}

export interface DreamRuntimeLogger {
  debug?: (message: string, data?: unknown) => void;
  warn?: (message: string, data?: unknown) => void;
  error?: (message: string, data?: unknown) => void;
}

export interface DreamRunOptions {
  conversationId?: string;
  triggerMode?: DreamTriggerMode;
  reason?: string;
  signal?: AbortSignal;
}

export interface DreamRunResult {
  record: DreamRecord;
  state: DreamRuntimeState;
  draft?: DreamModelOutput;
  markdown?: string;
  indexMarkdown?: string;
}

export type DreamAutoSkipCode =
  | "runtime_unavailable"
  | "already_running"
  | "cooldown_active"
  | "failure_backoff_active"
  | "insufficient_signal";

export type DreamAutoSignalGateCode =
  | "digest_generation"
  | "session_memory_revision"
  | "change_budget"
  | "fresh_work_recap"
  | "fresh_digest_and_work"
  | "fresh_session_memory_and_work"
  | "fresh_completed_task"
  | "fresh_resume_context"
  | "fresh_durable_memory"
  | "insufficient_signal";

export interface DreamAutoStats {
  attemptedCount: number;
  executedCount: number;
  skippedCount: number;
  skipCodeCounts?: Partial<Record<DreamAutoSkipCode, number>>;
  signalGateCounts?: Partial<Record<DreamAutoSignalGateCode, number>>;
  byTriggerMode?: Partial<Record<"heartbeat" | "cron", DreamAutoTriggerModeStats>>;
}

export interface DreamAutoTriggerModeStats {
  attemptedCount: number;
  executedCount: number;
  skippedCount: number;
  skipCodeCounts?: Partial<Record<DreamAutoSkipCode, number>>;
  signalGateCounts?: Partial<Record<DreamAutoSignalGateCode, number>>;
}

export interface DreamAutoSignalSummary {
  baselineAt?: string;
  lastDreamCursor?: DreamChangeCursor;
  currentCursor?: DreamChangeCursor;
  recentWorkCount: number;
  recentWorkRecapCount: number;
  completedTaskCount: number;
  recentDurableMemoryCount: number;
  sessionDigestAvailable: boolean;
  sessionMemoryAvailable?: boolean;
  digestGenerationDelta?: number;
  sessionMemoryMessageDelta?: number;
  sessionMemoryToolDelta?: number;
  sessionMemoryRevisionDelta?: number;
  taskChangeSeqDelta?: number;
  memoryChangeSeqDelta?: number;
  changeBudget?: number;
  latestWorkAt?: string;
  latestWorkRecapAt?: string;
  latestResumeContextAt?: string;
  latestCompletedTaskAt?: string;
  latestDurableMemoryAt?: string;
  sessionDigestAt?: string;
  sessionMemoryAt?: string;
  freshWorkSinceBaseline?: boolean;
  freshWorkRecapSinceBaseline?: boolean;
  freshResumeContextSinceBaseline?: boolean;
  freshCompletedTaskSinceBaseline?: boolean;
  freshDurableMemorySinceBaseline?: boolean;
  freshSessionDigestSinceBaseline?: boolean;
  freshSessionMemorySinceBaseline?: boolean;
}

export interface DreamAutoTriggerState {
  triggerMode: "heartbeat" | "cron";
  attemptedAt: string;
  executed: boolean;
  runId?: string;
  status?: Exclude<DreamStatus, "idle">;
  skipCode?: DreamAutoSkipCode;
  signalGateCode?: DreamAutoSignalGateCode;
  skipReason?: string;
  signal?: DreamAutoSignalSummary;
}

export interface DreamAutoRunResult {
  executed: boolean;
  triggerMode: "heartbeat" | "cron";
  state: DreamRuntimeState;
  record?: DreamRecord;
  draft?: DreamModelOutput;
  markdown?: string;
  indexMarkdown?: string;
  skipCode?: DreamAutoSkipCode;
  skipReason?: string;
  signal?: DreamAutoSignalSummary;
}

export interface DreamRuntimeOptions extends DreamRuntimeModelOptions {
  stateDir: string;
  agentId: string;
  obsidianMirror?: DreamObsidianMirrorOptions;
  buildInputSnapshot: (input: {
    agentId: string;
    conversationId?: string;
    now: Date;
  }) => Promise<DreamInputSnapshot>;
  profileStateDelegate?: DreamProfileStateDelegate;
  logger?: DreamRuntimeLogger;
  now?: () => Date;
}

export type DreamTaskSourceRef = TaskWorkSourceReference;
export type DreamTaskSourceExplanation = TaskWorkSourceExplanation;

export interface DreamProfileStateDelegate {
  upsertProfileStateEntry: (input: UpsertProfileStateEntryInput) => ProfileStateEntry;
}

export interface DreamConsolidationReviewInput {
  reviewedBy?: string;
  note?: string;
  approvedCandidatePaths?: string[];
}

export interface DreamConsolidationApplyInput {
  appliedBy?: string;
  note?: string;
}
