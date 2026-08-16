import { randomUUID } from "node:crypto";
import type {
  TaskActivityKind,
  TaskActivityRecord,
  TaskActivityState,
  TaskConversationStore,
  TaskMemoryRelation,
  TaskRecord,
  TaskSource,
  TaskStatus,
  TaskToolCallSummary,
} from "./task-types.js";
import { TaskSummarizer } from "./task-summarizer.js";
import { buildTaskRecapArtifacts } from "./task-recap.js";
import type { MemoryStore } from "./store.js";

type UsageSnapshot = {
  type: "usage";
  inputTokens: number;
  outputTokens: number;
};

interface TaskDraft {
  taskId: string;
  conversationId: string;
  sessionKey: string;
  agentId?: string;
  source: TaskSource;
  objective?: string;
  parentConversationId?: string;
  metadata?: Record<string, unknown>;
  startedAt: string;
  toolCalls: TaskToolCallSummary[];
  artifactPaths: string[];
  memoryLinks: Array<{ chunkId: string; relation: TaskMemoryRelation }>;
  activities: TaskActivityRecord[];
  nextActivitySequence: number;
}

export interface TaskProcessorOptions {
  enabled?: boolean;
  conversationStore?: TaskConversationStore;
  summarizer?: TaskSummarizer;
  summaryMinDurationMs?: number;
  summaryMinToolCalls?: number;
  summaryMinTokenTotal?: number;
}

export class TaskProcessor {
  private readonly store: MemoryStore;
  private readonly enabled: boolean;
  private readonly conversationStore?: TaskConversationStore;
  private readonly summarizer?: TaskSummarizer;
  private readonly summaryMinDurationMs: number;
  private readonly summaryMinToolCalls: number;
  private readonly summaryMinTokenTotal: number;
  private readonly drafts = new Map<string, TaskDraft>();
  private readonly summaryQueue: Array<{ taskId: string; conversationId: string }> = [];
  private summaryRunning = false;

  constructor(store: MemoryStore, options: TaskProcessorOptions = {}) {
    this.store = store;
    this.enabled = options.enabled ?? false;
    this.conversationStore = options.conversationStore;
    this.summarizer = options.summarizer;
    this.summaryMinDurationMs = options.summaryMinDurationMs ?? 15_000;
    this.summaryMinToolCalls = options.summaryMinToolCalls ?? 2;
    this.summaryMinTokenTotal = options.summaryMinTokenTotal ?? 2_000;
  }

  startTask(input: {
    conversationId: string;
    sessionKey: string;
    agentId?: string;
    source: TaskSource;
    objective?: string;
    parentConversationId?: string;
    metadata?: Record<string, unknown>;
  }): string | null {
    if (!this.enabled) return null;

    const taskId = `task_${randomUUID().slice(0, 8)}`;
    const objective = sanitizeObjective(input.objective);
    const draft: TaskDraft = {
      taskId,
      conversationId: input.conversationId,
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      source: input.source,
      objective,
      parentConversationId: input.parentConversationId,
      metadata: sanitizeMetadata(input.metadata),
      startedAt: new Date().toISOString(),
      toolCalls: [],
      artifactPaths: [],
      memoryLinks: [],
      activities: [],
      nextActivitySequence: 1,
    };
    this.drafts.set(input.conversationId, draft);
    this.appendActivity(draft, {
      kind: "task_started",
      state: "completed",
      title: buildTaskStartedTitle(objective, input.source),
      summary: buildTaskStartedSummary(objective, input.source),
    });
    return taskId;
  }

  recordToolCall(conversationId: string, item: TaskToolCallSummary): void {
    if (!this.enabled) return;
    const draft = this.drafts.get(conversationId);
    if (!draft) return;

    draft.toolCalls.push(item);
    const nextArtifactPaths = uniqueStrings(item.artifactPaths ?? []);
    const newlyAddedArtifactPaths: string[] = [];
    for (const artifactPath of nextArtifactPaths) {
      if (!draft.artifactPaths.includes(artifactPath)) {
        draft.artifactPaths.push(artifactPath);
        newlyAddedArtifactPaths.push(artifactPath);
      }
    }

    const toolState: TaskActivityState = item.success ? "completed" : "failed";
    this.appendActivity(draft, {
      kind: "tool_called",
      state: toolState,
      title: item.success ? `已执行工具 ${item.toolName}` : `工具 ${item.toolName} 执行失败`,
      summary: buildToolCallSummary(item),
      toolName: item.toolName,
      actionKey: shorten(item.actionKey, 200),
      artifactPaths: newlyAddedArtifactPaths.length > 0 ? newlyAddedArtifactPaths : undefined,
      note: shorten(item.note, 400),
      error: item.success ? undefined : shorten(item.note, 400),
      metadata: {
        durationMs: item.durationMs,
        sourceRefs: [
          {
            type: "tool_call",
            id: buildToolCallSourceRefId(item.toolName, draft.nextActivitySequence),
          },
        ],
      },
    });

    if (newlyAddedArtifactPaths.length > 0) {
      const fileMutation = isFileMutationTool(item.toolName);
      this.appendActivity(draft, {
        kind: fileMutation ? "file_changed" : "artifact_generated",
        state: toolState,
        title: fileMutation
          ? buildFileChangedTitle(newlyAddedArtifactPaths, item.success)
          : buildArtifactGeneratedTitle(newlyAddedArtifactPaths, item.success),
        summary: fileMutation
          ? buildFileChangedSummary(newlyAddedArtifactPaths, item.toolName, item.success)
          : buildArtifactGeneratedSummary(newlyAddedArtifactPaths, item.toolName, item.success),
        toolName: item.toolName,
        files: fileMutation ? newlyAddedArtifactPaths : undefined,
        artifactPaths: newlyAddedArtifactPaths,
        error: item.success ? undefined : shorten(item.note, 400),
        metadata: {
          durationMs: item.durationMs,
          diffStats: fileMutation ? { filesChanged: newlyAddedArtifactPaths.length } : undefined,
          sourceRefs: newlyAddedArtifactPaths.map((artifactPath) => ({
            type: "artifact",
            id: artifactPath,
          })),
        },
      });
    }
  }

  linkMemory(conversationId: string, chunkIds: string[], relation: TaskMemoryRelation = "used"): void {
    if (!this.enabled || chunkIds.length === 0) return;
    const draft = this.drafts.get(conversationId);
    if (!draft) return;

    const linkedChunkIds: string[] = [];
    for (const chunkId of chunkIds) {
      if (!chunkId) continue;
      const exists = draft.memoryLinks.some((link) => link.chunkId === chunkId && link.relation === relation);
      if (!exists) {
        draft.memoryLinks.push({ chunkId, relation });
        linkedChunkIds.push(chunkId);
      }
    }

    if (linkedChunkIds.length > 0 && relation !== "generated") {
      this.appendActivity(draft, {
        kind: "memory_recalled",
        state: "completed",
        title: relation === "referenced"
          ? `已引用 ${linkedChunkIds.length} 条相关记忆`
          : `已关联 ${linkedChunkIds.length} 条召回记忆`,
        summary: buildMemoryRecalledSummary(linkedChunkIds, relation),
        memoryChunkIds: linkedChunkIds,
        metadata: {
          relation,
          sourceRefs: linkedChunkIds.map((chunkId) => ({
            type: "memory_chunk",
            id: chunkId,
          })),
        },
      });
    }
  }

  addArtifactPath(conversationId: string, artifactPath: string): void {
    if (!this.enabled || !artifactPath) return;
    const draft = this.drafts.get(conversationId);
    if (!draft) return;
    if (!draft.artifactPaths.includes(artifactPath)) {
      draft.artifactPaths.push(artifactPath);
      this.appendActivity(draft, {
        kind: "artifact_generated",
        state: "completed",
        title: buildArtifactGeneratedTitle([artifactPath], true),
        summary: `已记录产物路径 ${artifactPath}。`,
        artifactPaths: [artifactPath],
        metadata: {
          sourceRefs: [{ type: "artifact", id: artifactPath }],
        },
      });
    }
  }

  completeTask(input: {
    conversationId: string;
    success: boolean;
    durationMs?: number;
    error?: string;
    messages?: unknown[];
  }): string | null {
    if (!this.enabled) return null;

    const draft = this.drafts.get(input.conversationId);
    if (!draft) return null;
    this.drafts.delete(input.conversationId);

    const usage = extractUsage(input.messages);
    const now = new Date().toISOString();
    const status: TaskStatus = input.success ? "success" : "failed";
    const outcome = input.success ? "success" : "failed";
    const title = buildFallbackTitle(draft.objective, draft.source);
    const summary = buildFallbackSummary({
      objective: draft.objective,
      source: draft.source,
      success: input.success,
      toolCalls: draft.toolCalls,
      error: input.error,
    });

    if (!input.success && input.error) {
      this.appendActivity(draft, {
        kind: "error_observed",
        state: "failed",
        title: "已记录任务失败原因",
        summary: "任务在结束阶段返回失败结果。",
        error: shorten(input.error, 500),
      });
    }

    this.appendActivity(draft, {
      kind: "task_completed",
      state: input.success ? "completed" : "failed",
      title: input.success ? "任务已完成" : "任务已失败结束",
      summary: buildTaskCompletedSummary({
        success: input.success,
        durationMs: input.durationMs,
        toolCallCount: draft.toolCalls.length,
        tokenTotal: usage?.totalTokens,
      }),
      error: input.success ? undefined : shorten(input.error, 500),
      metadata: {
        durationMs: input.durationMs,
      },
    });

    const baseTask: TaskRecord = {
      id: draft.taskId,
      conversationId: draft.conversationId,
      sessionKey: draft.sessionKey,
      parentConversationId: draft.parentConversationId,
      agentId: draft.agentId,
      source: draft.source,
      title,
      objective: draft.objective,
      status,
      outcome,
      summary,
      reflection: input.success ? undefined : shorten(input.error, 500),
      toolCalls: draft.toolCalls,
      artifactPaths: draft.artifactPaths,
      tokenInput: usage?.inputTokens,
      tokenOutput: usage?.outputTokens,
      tokenTotal: usage?.totalTokens,
      durationMs: input.durationMs,
      startedAt: draft.startedAt,
      finishedAt: now,
      metadata: {
        ...(draft.metadata ?? {}),
        toolCallCount: draft.toolCalls.length,
      },
      createdAt: now,
      updatedAt: now,
    };

    const recapArtifacts = buildTaskRecapArtifacts({
      task: baseTask,
      activities: draft.activities,
      updatedAt: now,
    });

    const task: TaskRecord = {
      ...baseTask,
      workRecap: recapArtifacts.workRecap,
      resumeContext: recapArtifacts.resumeContext,
    };

    this.store.createTask(task);
    for (const activity of draft.activities) {
      this.store.createTaskActivity(activity);
    }
    for (const link of draft.memoryLinks) {
      this.store.linkTaskMemory(task.id, link.chunkId, link.relation);
    }

    if (this.shouldSummarize(task)) {
      this.summaryQueue.push({ taskId: task.id, conversationId: task.conversationId });
      void this.flushSummaryQueue();
    }

    return task.id;
  }

  async waitForIdle(): Promise<void> {
    while (this.summaryRunning || this.summaryQueue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private shouldSummarize(task: TaskRecord): boolean {
    if (!this.summarizer?.isEnabled) return false;
    if (task.source === "sub_agent") return true;
    if (task.status !== "success") return true;
    if ((task.toolCalls?.length ?? 0) >= this.summaryMinToolCalls) return true;
    if ((task.durationMs ?? 0) >= this.summaryMinDurationMs) return true;
    if ((task.tokenTotal ?? 0) >= this.summaryMinTokenTotal) return true;
    return false;
  }

  private async flushSummaryQueue(): Promise<void> {
    if (this.summaryRunning) return;
    this.summaryRunning = true;

    try {
      while (this.summaryQueue.length > 0) {
        const current = this.summaryQueue.shift()!;
        const task = this.store.getTask(current.taskId);
        if (!task) continue;

        const history = this.conversationStore?.getHistory(current.conversationId) ?? [];
        if (!this.summarizer?.isEnabled) continue;

        try {
          const result = await this.summarizer.summarizeTask({
            task,
            history,
            toolCalls: task.toolCalls ?? [],
          });
          if (!result) continue;

          const nextArtifactPaths = uniqueStrings([
            ...(task.artifactPaths ?? []),
            ...(result.artifactPaths ?? []),
          ]);
          const summarizedStatus = normalizeTaskSummaryStatus(result.outcome);

          this.store.updateTask(task.id, {
            title: result.title ?? task.title,
            status: summarizedStatus ?? task.status,
            summary: result.summary ?? task.summary,
            reflection: result.reflection ?? task.reflection,
            outcome: result.outcome ?? task.outcome,
            artifactPaths: nextArtifactPaths.length > 0 ? nextArtifactPaths : task.artifactPaths,
            summaryModel: this.summarizerModelName(),
            summaryVersion: "task-summary-v1",
          });
        } catch (err) {
          console.warn("[TaskProcessor] Failed to summarize task:", err);
        }
      }
    } finally {
      this.summaryRunning = false;
    }
  }

  private summarizerModelName(): string | undefined {
    return this.summarizer?.modelName;
  }

  private appendActivity(
    draft: TaskDraft,
    input: {
      kind: TaskActivityKind;
      state: TaskActivityState;
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
      metadata?: TaskActivityRecord["metadata"];
    },
  ): void {
    const timestamp = new Date().toISOString();
    draft.activities.push({
      id: `activity_${randomUUID().slice(0, 8)}`,
      taskId: draft.taskId,
      conversationId: draft.conversationId,
      sessionKey: draft.sessionKey,
      agentId: draft.agentId,
      source: draft.source,
      kind: input.kind,
      state: input.state,
      sequence: draft.nextActivitySequence++,
      happenedAt: timestamp,
      recordedAt: timestamp,
      title: shorten(input.title, 180) ?? "已记录任务活动",
      summary: shorten(input.summary, 500),
      toolName: input.toolName,
      actionKey: shorten(input.actionKey, 200),
      command: shorten(input.command, 500),
      files: input.files?.length ? uniqueStrings(input.files) : undefined,
      artifactPaths: input.artifactPaths?.length ? uniqueStrings(input.artifactPaths) : undefined,
      memoryChunkIds: input.memoryChunkIds?.length ? uniqueStrings(input.memoryChunkIds) : undefined,
      note: shorten(input.note, 500),
      error: shorten(input.error, 500),
      metadata: input.metadata,
    });
  }
}

function sanitizeMetadata(metadata?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const entries = Object.entries(metadata).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

function normalizeTaskSummaryStatus(value?: string): TaskStatus | undefined {
  switch (value) {
    case "success":
    case "failed":
    case "partial":
      return value;
    default:
      return undefined;
  }
}

function sanitizeObjective(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 1000 ? `${trimmed.slice(0, 1000)}...` : trimmed;
}

function buildTaskStartedTitle(objective: string | undefined, source: TaskSource): string {
  const base = objective?.split(/\r?\n/)[0]?.trim();
  return base ? `已开始任务：${shorten(base, 120)}` : `已开始 ${source} 任务`;
}

function buildTaskStartedSummary(objective: string | undefined, source: TaskSource): string {
  const parts = [`来源：${source}。`];
  if (objective) {
    parts.push(`目标：${shorten(objective, 180)}。`);
  }
  return parts.join("");
}

function buildFallbackTitle(objective: string | undefined, source: TaskSource): string {
  const base = objective?.split(/\r?\n/)[0]?.trim();
  if (base) {
    return base.length > 80 ? `${base.slice(0, 80)}...` : base;
  }
  return `Task from ${source}`;
}

function buildFallbackSummary(input: {
  objective?: string;
  source: TaskSource;
  success: boolean;
  toolCalls: TaskToolCallSummary[];
  error?: string;
}): string {
  const objective = input.objective ? `目标：${shorten(input.objective, 120)}。` : "";
  const toolPart = input.toolCalls.length > 0
    ? `工具调用 ${input.toolCalls.length} 次。`
    : "未记录工具调用。";
  const resultPart = input.success
    ? "任务执行完成。"
    : `任务失败。${input.error ? `错误：${shorten(input.error, 120)}。` : ""}`;
  return `${objective}来源：${input.source}。${toolPart}${resultPart}`.trim();
}

function buildToolCallSummary(item: TaskToolCallSummary): string {
  const parts = [
    item.success ? "工具调用已完成。" : "工具调用已失败。",
    typeof item.durationMs === "number" ? `耗时：${item.durationMs}ms。` : "",
    item.actionKey ? `动作键：${shorten(item.actionKey, 120)}。` : "",
    item.artifactPaths?.length ? `关联路径：${item.artifactPaths.slice(0, 3).join(", ")}${item.artifactPaths.length > 3 ? "..." : ""}。` : "",
  ].filter(Boolean);
  return parts.join("");
}

function buildFileChangedTitle(paths: string[], success: boolean): string {
  if (paths.length === 1) {
    return success ? `已变更文件：${paths[0]}` : `文件变更失败：${paths[0]}`;
  }
  return success ? `已变更 ${paths.length} 个文件` : `${paths.length} 个文件变更失败`;
}

function buildFileChangedSummary(paths: string[], toolName: string, success: boolean): string {
  return `${success ? "文件变更已完成" : "文件变更未成功"}。工具：${toolName}。路径：${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ", ..." : ""}。`;
}

function buildArtifactGeneratedTitle(paths: string[], success: boolean): string {
  if (paths.length === 1) {
    return success ? `已生成产物：${paths[0]}` : `产物生成失败：${paths[0]}`;
  }
  return success ? `已记录 ${paths.length} 个产物` : `${paths.length} 个产物生成失败`;
}

function buildArtifactGeneratedSummary(paths: string[], toolName: string, success: boolean): string {
  return `${success ? "产物已记录" : "产物记录失败"}。工具：${toolName}。路径：${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ", ..." : ""}。`;
}

function buildMemoryRecalledSummary(chunkIds: string[], relation: TaskMemoryRelation): string {
  const relationText = relation === "referenced" ? "引用" : "召回";
  return `已${relationText} ${chunkIds.length} 条历史记忆。ID：${chunkIds.slice(0, 5).join(", ")}${chunkIds.length > 5 ? ", ..." : ""}。`;
}

function buildTaskCompletedSummary(input: {
  success: boolean;
  durationMs?: number;
  toolCallCount: number;
  tokenTotal?: number;
}): string {
  const parts = [
    input.success ? "任务已成功结束。" : "任务以失败状态结束。",
    `工具调用：${input.toolCallCount} 次。`,
    typeof input.durationMs === "number" ? `耗时：${input.durationMs}ms。` : "",
    typeof input.tokenTotal === "number" ? `Token：${input.tokenTotal}。` : "",
  ].filter(Boolean);
  return parts.join("");
}

function extractUsage(messages: unknown[] | undefined): {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
} | null {
  if (!Array.isArray(messages)) return null;

  let latest: UsageSnapshot | null = null;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const candidate = message as Partial<UsageSnapshot> & { type?: string };
    if (candidate.type !== "usage") continue;
    if (typeof candidate.inputTokens !== "number" || typeof candidate.outputTokens !== "number") continue;
    latest = candidate as UsageSnapshot;
  }

  if (!latest) return null;
  return {
    inputTokens: latest.inputTokens,
    outputTokens: latest.outputTokens,
    totalTokens: latest.inputTokens + latest.outputTokens,
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isFileMutationTool(toolName: string): boolean {
  return toolName === "apply_patch"
    || toolName === "file_write"
    || toolName === "file_delete"
    || toolName === "method_create";
}

function buildToolCallSourceRefId(toolName: string, sequence: number): string {
  return `${toolName}:${sequence}`;
}

function shorten(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
