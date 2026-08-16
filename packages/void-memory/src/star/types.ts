/** 记忆块 */
export type MemoryType = "core" | "daily" | "session" | "dream_index" | "dream_note" | "other";

/** 内容语义分类（P1-6） */
export type MemoryCategory = "preference" | "fact" | "decision" | "entity" | "experience" | "other";

/** 共享可见性（P3-1） */
export type MemoryVisibility = "private" | "shared";

/** 自动注入时使用的粗粒度重要性分层 */
export type MemoryImportance = "high" | "medium" | "low";

/** 检索范围（P3-2） */
export type MemorySearchScope = "private" | "shared" | "all";
export type MemorySharedPromotionStatus = "pending" | "approved" | "rejected" | "revoked" | "active" | "none";

/** 检索触发模式：显式工具检索 vs 隐式自动召回 */
export type MemoryRetrievalMode = "explicit" | "implicit";
export type MemorySearchRoutingPolicy = "chunk_only" | "node_assisted";

export interface MemoryChunk {
  id: string;
  sourcePath: string;
  sourceType: "file" | "session" | "manual"; // 来源类型
  memoryType: MemoryType; // 记忆类型：长期/短期/其他
  content: string;
  startLine?: number;
  endLine?: number;
  channel?: string;   // 来源渠道: webchat/feishu/heartbeat/cron/...
  topic?: string;     // 话题标签（可选）
  tsDate?: string;    // 日期 YYYY-MM-DD
  category?: MemoryCategory; // 内容语义分类
  agentId?: string;   // Agent ID（用于多 Agent 记忆隔离）
  visibility?: MemoryVisibility; // 可见性：默认私有
  metadata?: Record<string, any>;
}

/** 检索过滤条件 */
export interface MemorySearchFilter {
  memoryType?: MemoryType | MemoryType[];
  channel?: string;
  topic?: string;
  dateFrom?: string;  // YYYY-MM-DD
  dateTo?: string;    // YYYY-MM-DD
  category?: MemoryCategory | MemoryCategory[];
  uncategorized?: boolean; // 仅查询未分类/非法分类数据
  scope?: MemorySearchScope; // 显式检索范围；不传时保持历史行为
  agentId?: string | null;  // Agent ID 过滤（null 表示查询全局记忆）
  sharedPromotionStatus?: MemorySharedPromotionStatus | MemorySharedPromotionStatus[];
  sharedPromotionClaimed?: boolean;
}

/** 检索选项（传给 MemoryManager.search） */
export interface MemorySearchOptions {
  limit?: number;
  filter?: MemorySearchFilter;
  retrievalMode?: MemoryRetrievalMode;
  routingPolicy?: MemorySearchRoutingPolicy;
  includeContent?: boolean;
  /** 调用方取消信号；取消后检索拒绝并丢弃迟到的 Provider 结果。 */
  signal?: AbortSignal;
  /** 绝对 Unix epoch 毫秒 deadline；到期时使用已完成的本地关键词结果降级。 */
  deadlineMs?: number;
}

/** 检索结果 */
export interface MemorySearchResult {
  id: string;
  sourcePath: string;
  sourceType: string;
  memoryType?: MemoryType;
  topic?: string;
  category?: MemoryCategory;
  visibility?: MemoryVisibility;
  content?: string;
  snippet: string;
  summary?: string;       // L0 摘要（由 LLM 生成的单句概括）
  score: number;
  metadata?: Record<string, any>;
  startLine?: number;
  endLine?: number;
  updatedAt?: string;
}

/** 索引状态 */
export type MemoryIndexStatus = {
  files: number;
  chunks: number;
  categorized?: number;
  uncategorized?: number;
  categoryBuckets?: Partial<Record<MemoryCategory, number>>;
  lastIndexedAt?: string;
  vectorIndexed?: number;
  vectorCached?: number;
  summarized?: number;
  summaryPending?: number;
};

export class AuthenticationError extends Error { }
export class RateLimitError extends Error { }
