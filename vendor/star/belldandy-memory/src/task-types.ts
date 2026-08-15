export type TaskSource = "chat" | "sub_agent" | "cron" | "heartbeat" | "manual";
export type TaskStatus = "running" | "success" | "failed" | "partial";
export type TaskMemoryRelation = "used" | "generated" | "referenced";
export type TaskActivityState = "completed" | "attempted" | "failed" | "blocked" | "decided";
export type TaskActivityKind =
  | "task_started"
  | "task_switched"
  | "tool_called"
  | "command_executed"
  | "file_changed"
  | "artifact_generated"
  | "memory_recalled"
  | "error_observed"
  | "decision_made"
  | "task_paused"
  | "task_completed";

export interface TaskActivitySourceRef {
  type: "tool_call" | "artifact" | "memory_chunk" | "runtime_event";
  id: string;
}

export interface TaskActivityMetadata {
  durationMs?: number;
  exitCode?: number;
  decisionType?: "approach" | "constraint" | "rollback" | "handoff" | "other";
  blockReason?: string;
  diffStats?: {
    filesChanged?: number;
    additions?: number;
    deletions?: number;
  };
  relation?: TaskMemoryRelation;
  sourceRefs?: TaskActivitySourceRef[];
}

export interface TaskActivityRecord {
  id: string;
  taskId: string;
  conversationId: string;
  sessionKey: string;
  agentId?: string;
  source: TaskSource;
  kind: TaskActivityKind;
  state: TaskActivityState;
  sequence: number;
  happenedAt: string;
  recordedAt: string;
  title: string;
  summary?: string;
  toolName?: string;
  actionKey?: string;
  command?: string;
  files?: string[];
  artifactPaths?: string[];
  memoryChunkIds?: string[];
  note?: string;
  error?: string;
  metadata?: TaskActivityMetadata;
}

export interface TaskWorkRecapSnapshot {
  taskId: string;
  conversationId: string;
  sessionKey: string;
  agentId?: string;
  headline: string;
  confirmedFacts: string[];
  pendingActions?: string[];
  blockers?: string[];
  derivedFromActivityIds: string[];
  updatedAt: string;
}

export interface ResumeContextSnapshot {
  taskId: string;
  conversationId: string;
  sessionKey: string;
  agentId?: string;
  currentStopPoint?: string;
  nextStep?: string;
  openQuestions?: string[];
  blockers?: string[];
  derivedFromActivityIds: string[];
  updatedAt: string;
}

export interface TaskToolCallSummary {
  toolName: string;
  success: boolean;
  durationMs?: number;
  note?: string;
  actionKey?: string;
  artifactPaths?: string[];
}

export interface TaskRecord {
  id: string;
  conversationId: string;
  sessionKey: string;
  parentConversationId?: string;
  parentTaskId?: string;
  agentId?: string;
  source: TaskSource;
  title?: string;
  objective?: string;
  status: TaskStatus;
  outcome?: string;
  summary?: string;
  reflection?: string;
  toolCalls?: TaskToolCallSummary[];
  artifactPaths?: string[];
  tokenInput?: number;
  tokenOutput?: number;
  tokenTotal?: number;
  durationMs?: number;
  startedAt: string;
  finishedAt?: string;
  summaryModel?: string;
  summaryVersion?: string;
  workRecap?: TaskWorkRecapSnapshot;
  resumeContext?: ResumeContextSnapshot;
  /**
   * 预留扩展字段。
   * 长期任务 Phase 1 会在此写入：
   * - goalId
   * - nodeId
   * - runId
   * - goalSession
   */
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * 派生检索使用的有界 Task 投影。
 * 它故意不包含 session、memory link、experience usage 或其他完整详情字段。
 */
export interface TaskDerivedDetail {
  id: string;
  conversationId: string;
  title?: string;
  objective?: string;
  summary?: string;
  reflection?: string;
  status: TaskStatus;
  source: TaskSource;
  startedAt: string;
  finishedAt?: string;
  updatedAt: string;
  agentId?: string;
  toolCalls?: TaskToolCallSummary[];
  artifactPaths?: string[];
  workRecap?: TaskWorkRecapSnapshot;
  resumeContext?: ResumeContextSnapshot;
  recentActivityTitles: string[];
}

export interface TaskSearchFilter {
  agentId?: string;
  status?: TaskStatus | TaskStatus[];
  source?: TaskSource | TaskSource[];
  dateFrom?: string;
  dateTo?: string;
  parentConversationId?: string;
  goalId?: string;
}

export interface TaskSearchOptions {
  limit?: number;
  filter?: TaskSearchFilter;
}

export interface TaskConversationStore {
  getHistory(id: string): Array<{ role: "user" | "assistant"; content: string }>;
}
