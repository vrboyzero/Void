import fs from "node:fs";

import Database from "better-sqlite3";
import type { MemoryCategory, MemoryChunk, MemorySearchResult, MemoryIndexStatus, MemoryType, MemorySearchFilter, MemorySharedPromotionStatus, MemoryVisibility } from "./types.js";
import {
  readChunkVectorsBatch,
  resolveChunkVectorBatchDimensions,
  writeChunkVectorsBatch,
  type ChunkVectorWrite,
} from "./chunk-vector-batch.js";
import {
  listPendingEmbeddingCandidates,
  type PendingEmbeddingCandidate,
} from "./embedding-pending-candidates.js";
import {
  applyExternalIngestBatchTransaction,
  type ExternalIngestBatchInput,
  type ExternalIngestBatchResult,
} from "./external-ingest-transaction.js";
import {
  installExperienceDerivedSearchSchema as installExperienceDerivedSearchSchemaInDb,
  readExperienceDerivedCandidates,
  searchExperienceDerivedCandidateIds as searchExperienceDerivedCandidateIdsInDb,
  type ExperienceDerivedCandidate,
} from "./experience-derived-search.js";
import { readTaskDerivedDetailBatchRows } from "./task-derived-detail-batch.js";
import {
  publishMemoryTreeKindTransaction,
  type MemoryTreeKindPublication,
} from "./memory-tree-publication.js";
import { readMemoryTreeNodeDetailsBatch } from "./memory-tree-detail-batch.js";
import { readTaskDetailBatchRows } from "./task-detail-batch.js";
import {
  buildMemoryExactDedupApplyPlan,
  buildMemoryExactDedupPreviewReport,
  ensureMemoryDedupBackupFile,
  type MemoryExactDedupApplyOptions,
  type MemoryExactDedupApplyResult,
  type MemoryExactDedupPreviewReport,
} from "./memory-dedup.js";
import {
  buildMemoryVacuumWarnings,
  ensureMemoryVacuumBackupFile,
  type MemoryVacuumApplyOptions,
  type MemoryVacuumApplyResult,
  type MemoryVacuumObservability,
} from "./memory-vacuum.js";
import type {
  ResumeContextSnapshot,
  TaskActivityKind,
  TaskActivityRecord,
  TaskDerivedDetail,
  TaskActivityState,
  TaskMemoryRelation,
  TaskRecord,
  TaskSearchFilter,
  TaskSource,
  TaskStatus,
  TaskToolCallSummary,
  TaskWorkRecapSnapshot,
} from "./task-types.js";

import type {
  ExperienceAssetType,
  ExperienceCandidate,
  ExperienceCandidateListFilter,
  ExperienceCandidateMetadata,
  ExperienceCandidateStats,
  ExperienceCandidateStatus,
  ExperienceCandidateType,
  ExperienceSourceTaskSnapshot,
  ExperienceUsage,
  ExperienceUsageListFilter,
  ExperienceUsageSummary,
  ExperienceUsageStats,
  ExperienceUsageVia,
  TaskExperienceDetail,
} from "./experience-types.js";
import { buildTaskRecapArtifacts } from "./task-recap.js";
import { cosineSimilarity, vectorToBuffer, vectorFromBuffer, type EmbeddingVector } from "./embeddings/index.js";
import { loadSqliteVec } from "./sqlite-vec.js";
import type {
  MemoryTreeChunkScoreInput,
  MemoryTreeEdgeListFilter,
  MemoryTreeEdgeRecord,
  MemoryTreeNodeKind,
  MemoryTreeNodeDetailResult,
  MemoryTreeNodeListFilter,
  MemoryTreeNodeRecord,
  MemoryTreeReportListFilter,
  MemoryTreeReportRecord,
  MemoryTreeScoreListFilter,
  MemoryTreeScoreRecord,
  MemoryTreeSourceListFilter,
  MemoryTreeSourceRecord,
  MemoryTreeTargetType,
} from "./memory-tree-types.js";
import {
  deleteProfileStateEntryInDb,
  getProfileStateEntryFromDb,
  installProfileStateSchema,
  listProfileStateEntriesFromDb,
  listProfileStateEventsFromDb,
  upsertProfileStateEntryInDb,
} from "./profile-state.js";
import {
  PROFILE_STATE_SCHEMA_VERSION,
  type DeleteProfileStateEntryInput,
  type ProfileStateEntry,
  type ProfileStateEntryFilter,
  type ProfileStateEvent,
  type ProfileStateEventFilter,
  type UpsertProfileStateEntryInput,
} from "./profile-state-types.js";

export type EmbeddingCacheRetentionPolicy = {
  maxAgeMs: number;
  maxEntries: number;
  maxBytes: number;
  nowMs?: number;
};

export type EmbeddingCachePruneResult = {
  expired: number;
  overflow: number;
  remaining: number;
  remainingBytes: number;
};

export type EmbeddingCacheStatus = {
  entryCount: number;
  totalBytes: number;
  oldestCreatedAt?: string;
};

const KNOWN_MEMORY_CATEGORIES = ["preference", "experience", "fact", "decision", "entity", "other"] as const;
const TASK_CHANGE_SEQ_META_KEY = "task_change_seq";
const MEMORY_CHANGE_SEQ_META_KEY = "memory_change_seq";
const MEMORY_TREE_SCHEMA_VERSION = "p9-phase1-v1";
const MEMORY_TREE_SCORE_VERSION = "v1_rule_only";

export type TaskSummaryRecord = {
  id: string;
  title?: string;
  objective?: string;
  summary?: string;
  status: TaskStatus;
  source: TaskSource;
  finishedAt?: string;
  agentId?: string;
  toolNames: string[];
  artifactPaths: string[];
  updatedAt?: string;
  workRecap?: TaskWorkRecapSnapshot;
  resumeContext?: ResumeContextSnapshot;
};

// 基础表结构。
const SCHEMA_BASE = `
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  source_type TEXT NOT NULL,
  memory_type TEXT NOT NULL DEFAULT 'other',
  visibility TEXT NOT NULL DEFAULT 'private',
  start_line INTEGER,
  end_line INTEGER,
  content TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_path);
CREATE INDEX IF NOT EXISTS idx_chunks_updated ON chunks(updated_at);

-- Embedding 缓存表（避免重复计算相同内容）
CREATE TABLE IF NOT EXISTS embedding_cache (
  content_hash TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  dimensions INTEGER NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 元信息表
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

const SCHEMA_TASKS = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  parent_conversation_id TEXT DEFAULT NULL,
  parent_task_id TEXT DEFAULT NULL,
  agent_id TEXT DEFAULT NULL,
  source TEXT NOT NULL,
  title TEXT DEFAULT NULL,
  objective TEXT DEFAULT NULL,
  status TEXT NOT NULL,
  outcome TEXT DEFAULT NULL,
  summary TEXT DEFAULT NULL,
  reflection TEXT DEFAULT NULL,
  tool_calls_json TEXT DEFAULT NULL,
  artifact_paths_json TEXT DEFAULT NULL,
  token_input INTEGER DEFAULT NULL,
  token_output INTEGER DEFAULT NULL,
  token_total INTEGER DEFAULT NULL,
  duration_ms INTEGER DEFAULT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT DEFAULT NULL,
  summary_model TEXT DEFAULT NULL,
  summary_version TEXT DEFAULT NULL,
  work_recap_json TEXT DEFAULT NULL,
  resume_context_json TEXT DEFAULT NULL,
  metadata TEXT DEFAULT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_conversation_id ON tasks(conversation_id);
CREATE INDEX IF NOT EXISTS idx_tasks_agent_id ON tasks(agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source);
CREATE INDEX IF NOT EXISTS idx_tasks_finished_at ON tasks(finished_at);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_conversation_id ON tasks(parent_conversation_id);

CREATE TABLE IF NOT EXISTS task_memory_links (
  task_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, chunk_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_task_memory_links_task_id ON task_memory_links(task_id);
CREATE INDEX IF NOT EXISTS idx_task_memory_links_chunk_id ON task_memory_links(chunk_id);
`;

const SCHEMA_TASK_ACTIVITIES = `
CREATE TABLE IF NOT EXISTS task_activities (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  agent_id TEXT DEFAULT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  happened_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT DEFAULT NULL,
  tool_name TEXT DEFAULT NULL,
  action_key TEXT DEFAULT NULL,
  command_text TEXT DEFAULT NULL,
  files_json TEXT DEFAULT NULL,
  artifact_paths_json TEXT DEFAULT NULL,
  memory_chunk_ids_json TEXT DEFAULT NULL,
  note TEXT DEFAULT NULL,
  error TEXT DEFAULT NULL,
  metadata_json TEXT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_activities_task_id ON task_activities(task_id);
CREATE INDEX IF NOT EXISTS idx_task_activities_conversation_id ON task_activities(conversation_id);
CREATE INDEX IF NOT EXISTS idx_task_activities_agent_id ON task_activities(agent_id);
CREATE INDEX IF NOT EXISTS idx_task_activities_happened_at ON task_activities(happened_at);
CREATE INDEX IF NOT EXISTS idx_task_activities_kind ON task_activities(kind);
CREATE INDEX IF NOT EXISTS idx_task_activities_state ON task_activities(state);
CREATE INDEX IF NOT EXISTS idx_task_activities_sequence ON task_activities(task_id, sequence);
`;

const SCHEMA_EXPERIENCE = `
CREATE TABLE IF NOT EXISTS experience_candidates (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT DEFAULT NULL,
  quality_score REAL DEFAULT NULL,
  source_task_snapshot_json TEXT NOT NULL,
  published_path TEXT DEFAULT NULL,
  created_at TEXT NOT NULL,
  reviewed_at TEXT DEFAULT NULL,
  accepted_at TEXT DEFAULT NULL,
  rejected_at TEXT DEFAULT NULL,
  metadata_json TEXT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_experience_candidates_task_id ON experience_candidates(task_id);
CREATE INDEX IF NOT EXISTS idx_experience_candidates_type ON experience_candidates(type);
CREATE INDEX IF NOT EXISTS idx_experience_candidates_status ON experience_candidates(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_experience_candidates_task_type_unique
  ON experience_candidates(task_id, type);

CREATE TABLE IF NOT EXISTS experience_usages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  asset_key TEXT NOT NULL,
  source_candidate_id TEXT DEFAULT NULL,
  used_via TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_experience_usages_task_id ON experience_usages(task_id);
CREATE INDEX IF NOT EXISTS idx_experience_usages_asset_type ON experience_usages(asset_type);
CREATE INDEX IF NOT EXISTS idx_experience_usages_asset_key ON experience_usages(asset_key);
CREATE INDEX IF NOT EXISTS idx_experience_usages_source_candidate_id ON experience_usages(source_candidate_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_experience_usages_task_asset_unique
  ON experience_usages(task_id, asset_type, asset_key);
`;

const SCHEMA_MEMORY_TREE = `
CREATE TABLE IF NOT EXISTS memory_sources (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_class TEXT NOT NULL,
  scope TEXT NOT NULL,
  agent_id TEXT DEFAULT NULL,
  source_path TEXT DEFAULT NULL,
  source_ref TEXT DEFAULT NULL,
  content_hash TEXT DEFAULT NULL,
  time_from TEXT DEFAULT NULL,
  time_to TEXT DEFAULT NULL,
  item_count INTEGER DEFAULT NULL,
  metadata_json TEXT DEFAULT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_sources_kind ON memory_sources(source_kind);
CREATE INDEX IF NOT EXISTS idx_memory_sources_class ON memory_sources(source_class);
CREATE INDEX IF NOT EXISTS idx_memory_sources_agent_id ON memory_sources(agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_sources_path ON memory_sources(source_path);
CREATE INDEX IF NOT EXISTS idx_memory_sources_ref ON memory_sources(source_ref);

CREATE TABLE IF NOT EXISTS memory_scores (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  source_id TEXT DEFAULT NULL,
  score_total REAL NOT NULL,
  recency_score REAL DEFAULT NULL,
  source_weight_score REAL DEFAULT NULL,
  interaction_score REAL DEFAULT NULL,
  task_outcome_score REAL DEFAULT NULL,
  entity_density_score REAL DEFAULT NULL,
  llm_importance_score REAL DEFAULT NULL,
  dedup_confidence REAL DEFAULT NULL,
  score_version TEXT NOT NULL,
  rationale_json TEXT DEFAULT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(target_type, target_id, score_version)
);

CREATE INDEX IF NOT EXISTS idx_memory_scores_target ON memory_scores(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_memory_scores_source_id ON memory_scores(source_id);
CREATE INDEX IF NOT EXISTS idx_memory_scores_total ON memory_scores(score_total DESC);

CREATE TABLE IF NOT EXISTS memory_tree_nodes (
  id TEXT PRIMARY KEY,
  level INTEGER NOT NULL,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  agent_id TEXT DEFAULT NULL,
  topic_key TEXT DEFAULT NULL,
  title TEXT DEFAULT NULL,
  summary TEXT NOT NULL,
  summary_model TEXT DEFAULT NULL,
  summary_version TEXT DEFAULT NULL,
  time_from TEXT DEFAULT NULL,
  time_to TEXT DEFAULT NULL,
  source_class_mix_json TEXT DEFAULT NULL,
  metadata_json TEXT DEFAULT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_tree_nodes_level_kind ON memory_tree_nodes(level, kind);
CREATE INDEX IF NOT EXISTS idx_memory_tree_nodes_agent_id ON memory_tree_nodes(agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_tree_nodes_topic_key ON memory_tree_nodes(topic_key);
CREATE INDEX IF NOT EXISTS idx_memory_tree_nodes_time_from ON memory_tree_nodes(time_from);

CREATE TABLE IF NOT EXISTS memory_tree_edges (
  id TEXT PRIMARY KEY,
  parent_node_id TEXT NOT NULL,
  child_type TEXT NOT NULL,
  child_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  position INTEGER DEFAULT NULL,
  weight REAL DEFAULT NULL,
  metadata_json TEXT DEFAULT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(parent_node_id, child_type, child_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_memory_tree_edges_parent ON memory_tree_edges(parent_node_id);
CREATE INDEX IF NOT EXISTS idx_memory_tree_edges_child ON memory_tree_edges(child_type, child_id);

CREATE TABLE IF NOT EXISTS memory_clean_reports (
  id TEXT PRIMARY KEY,
  report_type TEXT NOT NULL,
  scope TEXT NOT NULL,
  agent_id TEXT DEFAULT NULL,
  status TEXT NOT NULL,
  input_version TEXT DEFAULT NULL,
  summary_json TEXT NOT NULL,
  details_json TEXT NOT NULL,
  export_markdown_path TEXT DEFAULT NULL,
  created_by TEXT DEFAULT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_clean_reports_type ON memory_clean_reports(report_type);
CREATE INDEX IF NOT EXISTS idx_memory_clean_reports_agent_id ON memory_clean_reports(agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_clean_reports_status ON memory_clean_reports(status);
CREATE INDEX IF NOT EXISTS idx_memory_clean_reports_created_at ON memory_clean_reports(created_at DESC);
`;

// FTS5 全文索引（better-sqlite3 默认编译 FTS5）
const SCHEMA_FTS5 = `
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  content='chunks',
  content_rowid='rowid',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', OLD.rowid, OLD.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', OLD.rowid, OLD.content);
  INSERT INTO chunks_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
  title,
  objective,
  summary,
  reflection,
  outcome,
  content='tasks',
  content_rowid='rowid',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS tasks_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts(rowid, title, objective, summary, reflection, outcome)
  VALUES (NEW.rowid, NEW.title, NEW.objective, NEW.summary, NEW.reflection, NEW.outcome);
END;

CREATE TRIGGER IF NOT EXISTS tasks_ad AFTER DELETE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, objective, summary, reflection, outcome)
  VALUES('delete', OLD.rowid, OLD.title, OLD.objective, OLD.summary, OLD.reflection, OLD.outcome);
END;

CREATE TRIGGER IF NOT EXISTS tasks_au AFTER UPDATE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, objective, summary, reflection, outcome)
  VALUES('delete', OLD.rowid, OLD.title, OLD.objective, OLD.summary, OLD.reflection, OLD.outcome);
  INSERT INTO tasks_fts(rowid, title, objective, summary, reflection, outcome)
  VALUES (NEW.rowid, NEW.title, NEW.objective, NEW.summary, NEW.reflection, NEW.outcome);
END;
`;

// Phase M-1: 元数据列迁移（ALTER TABLE 对已有列安全，会被 SQLite 忽略）
const SCHEMA_METADATA_COLUMNS = [
  "ALTER TABLE chunks ADD COLUMN channel TEXT DEFAULT NULL",
  "ALTER TABLE chunks ADD COLUMN topic TEXT DEFAULT NULL",
  "ALTER TABLE chunks ADD COLUMN ts_date TEXT DEFAULT NULL",
];

// Phase M-N2: L0 摘要列迁移
const SCHEMA_SUMMARY_COLUMNS = [
  "ALTER TABLE chunks ADD COLUMN summary TEXT DEFAULT NULL",
  "ALTER TABLE chunks ADD COLUMN summary_tokens INTEGER DEFAULT NULL",
];

// P1-6: 内容语义分类列迁移
const SCHEMA_CATEGORY_COLUMNS = [
  "ALTER TABLE chunks ADD COLUMN category TEXT DEFAULT NULL",
];

// Scope 隔离：agent_id 列迁移（多 Agent 记忆隔离）
const SCHEMA_AGENT_ID_COLUMNS = [
  "ALTER TABLE chunks ADD COLUMN agent_id TEXT DEFAULT NULL",
];

// P3-1: 共享可见性列迁移
const SCHEMA_VISIBILITY_COLUMNS = [
  "ALTER TABLE chunks ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'",
];

const SCHEMA_TASK_RECAP_COLUMNS = [
  "ALTER TABLE tasks ADD COLUMN work_recap_json TEXT DEFAULT NULL",
  "ALTER TABLE tasks ADD COLUMN resume_context_json TEXT DEFAULT NULL",
];

const SCHEMA_EXPERIENCE_METADATA_COLUMNS = [
  "ALTER TABLE experience_candidates ADD COLUMN metadata_json TEXT DEFAULT NULL",
];

const SCHEMA_METADATA_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_chunks_channel ON chunks(channel);
CREATE INDEX IF NOT EXISTS idx_chunks_topic ON chunks(topic);
CREATE INDEX IF NOT EXISTS idx_chunks_ts_date ON chunks(ts_date);
CREATE INDEX IF NOT EXISTS idx_chunks_memory_type ON chunks(memory_type);
CREATE INDEX IF NOT EXISTS idx_chunks_category ON chunks(category);
CREATE INDEX IF NOT EXISTS idx_chunks_agent_id ON chunks(agent_id);
CREATE INDEX IF NOT EXISTS idx_chunks_visibility ON chunks(visibility);
`;

export class MemoryStore {
  private db: Database.Database;
  private closed = false;
  private vecDims: number | null = null;
  /** 当前 SQLite 是否支持 FTS5（better-sqlite3 默认编译 FTS5） */
  private hasFts5: boolean;
  /** Experience 派生检索的 FTS schema 已安装且旧库 rebuild 成功。 */
  private hasExperienceFts = false;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    loadSqliteVec(this.db);
    this.db.exec(SCHEMA_BASE);
    this.db.exec(SCHEMA_TASKS);
    this.db.exec(SCHEMA_TASK_ACTIVITIES);
    this.db.exec(SCHEMA_EXPERIENCE);
    this.db.exec(SCHEMA_MEMORY_TREE);
    installProfileStateSchema(this.db);

    // Phase M-1: 元数据列迁移（对已有列 ALTER TABLE ADD COLUMN 会报 duplicate，安全忽略）
    for (const sql of SCHEMA_METADATA_COLUMNS) {
      try { this.db.exec(sql); } catch { /* column already exists */ }
    }
    // Phase M-N2: L0 摘要列迁移
    for (const sql of SCHEMA_SUMMARY_COLUMNS) {
      try { this.db.exec(sql); } catch { /* column already exists */ }
    }
    // P1-6: 内容语义分类列迁移
    for (const sql of SCHEMA_CATEGORY_COLUMNS) {
      try { this.db.exec(sql); } catch { /* column already exists */ }
    }
    // Scope 隔离：agent_id 列迁移
    for (const sql of SCHEMA_AGENT_ID_COLUMNS) {
      try { this.db.exec(sql); } catch { /* column already exists */ }
    }
    // P3-1: 共享可见性列迁移
    for (const sql of SCHEMA_VISIBILITY_COLUMNS) {
      try { this.db.exec(sql); } catch { /* column already exists */ }
    }
    for (const sql of SCHEMA_TASK_RECAP_COLUMNS) {
      try { this.db.exec(sql); } catch { /* column already exists */ }
    }
    for (const sql of SCHEMA_EXPERIENCE_METADATA_COLUMNS) {
      try { this.db.exec(sql); } catch { /* column already exists */ }
    }
    this.db.exec(SCHEMA_METADATA_INDEXES);
    this.setMeta("memory_tree_schema_version", MEMORY_TREE_SCHEMA_VERSION);
    this.setMeta("memory_tree_score_version", MEMORY_TREE_SCORE_VERSION);
    this.setMeta("profile_state_schema_version", PROFILE_STATE_SCHEMA_VERSION);
    this.backfillMetadataColumns();

    // 从现有 chunks_vec 表读取维度（如果存在）
    this.initVecDimsFromExistingTable();

    try {
      this.db.exec(SCHEMA_FTS5);
      this.hasFts5 = true;
      // 兼容老库：如果 chunks 已有存量数据，但 FTS 索引为空，则执行一次 rebuild。
      // 否则会出现"关键词检索命中为 0"的假性失效。
      this.ensureFtsRebuiltIfNeeded();
      this.ensureTaskFtsRebuiltIfNeeded();
      this.hasExperienceFts = this.installExperienceDerivedSearchSchema().ready;
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      if (msg.includes("fts5") || msg.includes("no such module")) {
        this.hasFts5 = false;
        console.warn(
          "[belldandy-memory] FTS5 not available (e.g. Node built-in sqlite). Keyword search will use LIKE fallback."
        );
      } else {
        throw err;
      }
    }
  }

  /** 插入或更新 chunk */
  upsertChunk(chunk: MemoryChunk): void {
    this.ensureOpen();
    const now = new Date().toISOString();
    const visibility = chunk.visibility ?? "private";
    const stmt = this.db.prepare(`
      INSERT INTO chunks (id, source_path, source_type, memory_type, visibility, start_line, end_line, content, metadata, channel, topic, ts_date, category, agent_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at,
        memory_type = excluded.memory_type,
        visibility = excluded.visibility,
        channel = excluded.channel,
        topic = excluded.topic,
        ts_date = excluded.ts_date,
        category = excluded.category,
        agent_id = excluded.agent_id
    `);
    stmt.run(
      chunk.id,
      chunk.sourcePath,
      chunk.sourceType,
      chunk.memoryType,
      visibility,
      chunk.startLine ?? null,
      chunk.endLine ?? null,
      chunk.content,
      JSON.stringify(chunk.metadata ?? {}),
      chunk.channel ?? null,
      chunk.topic ?? null,
      chunk.tsDate ?? null,
      chunk.category ?? null,
      chunk.agentId ?? null,
      now,
      now
    );
    this.incrementNumericMeta(MEMORY_CHANGE_SEQ_META_KEY);
  }

  /** 按来源路径删除 chunks */
  deleteBySource(sourcePath: string, options: { bumpChangeSeq?: boolean } = {}): number {
    this.ensureOpen();
    // 先查出要删除的 rowid，同步删除 vec 数据
    const rows = this.db.prepare(`SELECT rowid FROM chunks WHERE source_path = ?`).all(sourcePath) as { rowid: number }[];
    if (rows.length > 0 && this.vecDims) {
      // vec0 删除需要 rowid
      // 为了性能，可以使用事务或 batch
      const vecDelete = this.db.prepare(`DELETE FROM chunks_vec WHERE rowid = ?`);
      for (const row of rows) {
        vecDelete.run(BigInt(row.rowid));
      }
    }

    const stmt = this.db.prepare(`DELETE FROM chunks WHERE source_path = ?`);
    const result = stmt.run(sourcePath);
    const changes = Number(result.changes);
    if (changes > 0 && options.bumpChangeSeq !== false) {
      this.incrementNumericMeta(MEMORY_CHANGE_SEQ_META_KEY);
    }
    return changes;
  }

  replaceSourceChunks(sourcePath: string, chunks: MemoryChunk[]): void {
    this.ensureOpen();
    const now = new Date().toISOString();
    const upsertChunkStmt = this.db.prepare(`
      INSERT INTO chunks (id, source_path, source_type, memory_type, visibility, start_line, end_line, content, metadata, channel, topic, ts_date, category, agent_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at,
        memory_type = excluded.memory_type,
        visibility = excluded.visibility,
        channel = excluded.channel,
        topic = excluded.topic,
        ts_date = excluded.ts_date,
        category = excluded.category,
        agent_id = excluded.agent_id
    `);

    let deletedCount = 0;
    const tx = this.db.transaction(() => {
      deletedCount = this.deleteBySource(sourcePath, { bumpChangeSeq: false });
      for (const chunk of chunks) {
        const visibility = chunk.visibility ?? "private";
        upsertChunkStmt.run(
          chunk.id,
          chunk.sourcePath,
          chunk.sourceType,
          chunk.memoryType,
          visibility,
          chunk.startLine ?? null,
          chunk.endLine ?? null,
          chunk.content,
          JSON.stringify(chunk.metadata ?? {}),
          chunk.channel ?? null,
          chunk.topic ?? null,
          chunk.tsDate ?? null,
          chunk.category ?? null,
          chunk.agentId ?? null,
          now,
          now,
        );
      }
    });

    tx();
    if (deletedCount > 0 || chunks.length > 0) {
      this.incrementNumericMeta(MEMORY_CHANGE_SEQ_META_KEY);
    }
  }

  /** external ingest 的跨 source 发布由相邻 transaction owner 处理，Store 只保留状态与 change-seq 接线。 */
  applyExternalIngestBatch(input: ExternalIngestBatchInput): ExternalIngestBatchResult {
    this.ensureOpen();
    const result = applyExternalIngestBatchTransaction({
      db: this.db,
      vectorStoreReady: this.vecDims !== null,
      changeSequenceMetaKey: MEMORY_CHANGE_SEQ_META_KEY,
      now: new Date().toISOString(),
      ...input,
    });
    return result;
  }

  /** 删除所有 chunks */
  deleteAll(): number {
    this.ensureOpen();
    if (this.vecDims) {
      try {
        this.db.exec(`DELETE FROM chunks_vec`);
      } catch (e) {
        // Ignore if table doesn't exist
      }
    }
    const stmt = this.db.prepare(`DELETE FROM chunks`);
    const result = stmt.run();
    const changes = Number(result.changes);
    if (changes > 0) {
      this.incrementNumericMeta(MEMORY_CHANGE_SEQ_META_KEY);
    }
    return changes;
  }

  private upsertTask(task: TaskRecord): void {
    this.ensureOpen();
    const stmt = this.db.prepare(`
      INSERT INTO tasks (
        id, conversation_id, session_key, parent_conversation_id, parent_task_id, agent_id,
        source, title, objective, status, outcome, summary, reflection, tool_calls_json,
        artifact_paths_json, token_input, token_output, token_total, duration_ms,
        started_at, finished_at, summary_model, summary_version, work_recap_json, resume_context_json,
        metadata, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        session_key = excluded.session_key,
        parent_conversation_id = excluded.parent_conversation_id,
        parent_task_id = excluded.parent_task_id,
        agent_id = excluded.agent_id,
        source = excluded.source,
        title = excluded.title,
        objective = excluded.objective,
        status = excluded.status,
        outcome = excluded.outcome,
        summary = excluded.summary,
        reflection = excluded.reflection,
        tool_calls_json = excluded.tool_calls_json,
        artifact_paths_json = excluded.artifact_paths_json,
        token_input = excluded.token_input,
        token_output = excluded.token_output,
        token_total = excluded.token_total,
        duration_ms = excluded.duration_ms,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        summary_model = excluded.summary_model,
        summary_version = excluded.summary_version,
        work_recap_json = excluded.work_recap_json,
        resume_context_json = excluded.resume_context_json,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      task.id,
      task.conversationId,
      task.sessionKey,
      task.parentConversationId ?? null,
      task.parentTaskId ?? null,
      task.agentId ?? null,
      task.source,
      task.title ?? null,
      task.objective ?? null,
      task.status,
      task.outcome ?? null,
      task.summary ?? null,
      task.reflection ?? null,
      JSON.stringify(task.toolCalls ?? []),
      JSON.stringify(task.artifactPaths ?? []),
      task.tokenInput ?? null,
      task.tokenOutput ?? null,
      task.tokenTotal ?? null,
      task.durationMs ?? null,
      task.startedAt,
      task.finishedAt ?? null,
      task.summaryModel ?? null,
      task.summaryVersion ?? null,
      JSON.stringify(task.workRecap ?? null),
      JSON.stringify(task.resumeContext ?? null),
      JSON.stringify(task.metadata ?? {}),
      task.createdAt,
      task.updatedAt
    );
  }

  /** 关键词搜索（有 FTS5 用全文索引，否则用 LIKE 降级） */
  searchKeyword(query: string, limit = 10, filter?: MemorySearchFilter, includeContent = true): MemorySearchResult[] {
    this.ensureOpen();

    const tokens = tokenizeForSearch(query);
    if (tokens.length === 0) return [];

    const { clause: filterClause, params: filterParams } = this.buildFilterClause(filter);

    if (this.hasFts5) {
      const ftsQuery = buildFtsQuery(query);
      if (!ftsQuery) return [];
      try {
        const stmt = this.db.prepare(`
          SELECT
            c.id, c.source_path, c.source_type, c.memory_type, c.visibility, c.start_line, c.end_line,
            ${includeContent ? "c.content" : "NULL AS content"}, substr(c.content, 1, 500) AS snippet_text,
            c.metadata, c.channel, c.topic, c.ts_date, c.summary, c.category,
            bm25(chunks_fts) as rank
          FROM chunks_fts f
          JOIN chunks c ON c.rowid = f.rowid
          WHERE chunks_fts MATCH ?${filterClause}
          ORDER BY rank
          LIMIT ?
        `);
        const rows = stmt.all(ftsQuery, ...filterParams, limit) as any[];
        return rows.map((row) => rowToSearchResult(row, bm25RankToScore(row.rank)));
      } catch (err) {
        console.error("FTS query error:", err);
        return [];
      }
    }

    // 无 FTS5 时用 LIKE 降级（多词 AND，转义 % _ 避免通配符）
    const likeConditions = tokens.map(() => `content LIKE ? ESCAPE '\\'`).join(" AND ");
    const likeArgs = tokens.map((t) => `%${escapeLike(t)}%`);
    const stmt = this.db.prepare(`
      SELECT id, source_path, source_type, memory_type, visibility, start_line, end_line,
             ${includeContent ? "content" : "NULL AS content"}, substr(content, 1, 500) AS snippet_text,
             metadata, channel, topic, ts_date, summary, category
      FROM chunks c
      WHERE ${likeConditions}${filterClause}
      LIMIT ?
    `);
    const rows = stmt.all(...likeArgs, ...filterParams, limit) as any[];
    return rows.map((row) => rowToSearchResult(row, 0.5));
  }

  /** 获取文件元数据（用于增量检查） */
  getFileMetadata(sourcePath: string): { updatedAt: string; metadata?: any } | null {
    this.ensureOpen();
    const stmt = this.db.prepare(`
      SELECT updated_at, metadata 
      FROM chunks 
      WHERE source_path = ? 
      ORDER BY updated_at DESC 
      LIMIT 1
    `);
    const row = stmt.get(sourcePath) as { updated_at: string; metadata: string } | undefined;

    if (!row) return null;

    return {
      updatedAt: row.updated_at,
      metadata: safeParseJson(row.metadata),
    };
  }

  /** 获取最近更新的记忆块（按 updated_at 降序） */
  getRecentChunks(limit = 5, filter?: MemorySearchFilter, includeContent = true): MemorySearchResult[] {
    this.ensureOpen();
    const { clause: filterClause, params: filterParams } = this.buildFilterClause(filter);
    const stmt = this.db.prepare(`
      SELECT id, source_path, source_type, memory_type, visibility,
             ${includeContent ? "content" : "NULL AS content"}, substr(content, 1, 500) AS snippet_text,
             metadata, start_line, end_line, category, updated_at
      FROM chunks c
      WHERE 1 = 1${filterClause}
      ORDER BY c.updated_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(...filterParams, limit) as any[];
    return rows.map((row) => rowToSearchResult(row, 1));
  }

  countChunks(filter?: MemorySearchFilter): number {
    this.ensureOpen();
    const { clause: filterClause, params: filterParams } = this.buildFilterClause(filter);
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM chunks c
      WHERE 1 = 1${filterClause}
    `);
    const row = stmt.get(...filterParams) as { count: number } | undefined;
    return typeof row?.count === "number" && Number.isFinite(row.count) ? row.count : 0;
  }

  getDatabasePageStats(): {
    pageCount: number;
    freelistCount: number;
  } {
    this.ensureOpen();
    const pageCountRow = this.db.prepare(`PRAGMA page_count`).get() as { page_count?: number } | undefined;
    const freelistCountRow = this.db.prepare(`PRAGMA freelist_count`).get() as { freelist_count?: number } | undefined;
    return {
      pageCount: typeof pageCountRow?.page_count === "number" && Number.isFinite(pageCountRow.page_count)
        ? Math.max(0, Math.floor(pageCountRow.page_count))
        : 0,
      freelistCount: typeof freelistCountRow?.freelist_count === "number" && Number.isFinite(freelistCountRow.freelist_count)
        ? Math.max(0, Math.floor(freelistCountRow.freelist_count))
        : 0,
    };
  }

  getDatabaseVacuumObservability(): MemoryVacuumObservability {
    this.ensureOpen();
    const dbPath = this.getDbPath();
    const pageStats = this.getDatabasePageStats();
    const pageSizeRow = this.db.prepare(`PRAGMA page_size`).get() as { page_size?: number } | undefined;
    const journalModeRow = this.db.prepare(`PRAGMA journal_mode`).get() as { journal_mode?: string } | undefined;
    const pageSize = typeof pageSizeRow?.page_size === "number" && Number.isFinite(pageSizeRow.page_size)
      ? Math.max(0, Math.floor(pageSizeRow.page_size))
      : 0;
    const dbFileBytes = readOptionalFileSizeBytes(dbPath);
    const walFileBytes = readOptionalFileSizeBytes(dbPath ? `${dbPath}-wal` : "");
    const shmFileBytes = readOptionalFileSizeBytes(dbPath ? `${dbPath}-shm` : "");
    const estimatedReclaimableBytes = Math.max(0, pageStats.freelistCount * pageSize);
    return {
      chunkCount: this.countChunks(),
      pageCount: pageStats.pageCount,
      freelistCount: pageStats.freelistCount,
      pageSize,
      journalMode: typeof journalModeRow?.journal_mode === "string" && journalModeRow.journal_mode.trim()
        ? journalModeRow.journal_mode.trim()
        : "unknown",
      dbFileBytes,
      walFileBytes,
      shmFileBytes,
      totalFileBytes: Math.max(0, dbFileBytes + walFileBytes + shmFileBytes),
      estimatedReclaimableBytes,
      freelistRatio: roundVacuumRatio(pageStats.freelistCount / Math.max(pageStats.pageCount, 1)),
      reclaimableRatio: roundVacuumRatio(estimatedReclaimableBytes / Math.max(dbFileBytes, 1)),
    };
  }

  getChunk(chunkId: string): MemorySearchResult | null {
    this.ensureOpen();
    const stmt = this.db.prepare(`
      SELECT id, source_path, source_type, memory_type, visibility, content, metadata, topic, start_line, end_line, summary, category, updated_at
      FROM chunks
      WHERE id = ?
      LIMIT 1
    `);
    const row = stmt.get(chunkId) as any;
    if (!row) return null;
    return {
      id: row.id,
      sourcePath: row.source_path,
      sourceType: row.source_type,
      memoryType: row.memory_type,
      topic: optionalString(row.topic),
      category: normalizeCategory(row.category),
      visibility: row.visibility ?? "private",
      snippet: (row.content ?? "").slice(0, 500),
      content: row.content,
      summary: row.summary ?? undefined,
      score: 1,
      metadata: safeParseJson(row.metadata),
      startLine: row.start_line ?? undefined,
      endLine: row.end_line ?? undefined,
      updatedAt: optionalString(row.updated_at),
    };
  }

  promoteChunkVisibility(chunkId: string, visibility: MemoryVisibility = "shared"): boolean {
    this.ensureOpen();
    const stmt = this.db.prepare(`
      UPDATE chunks
      SET visibility = ?, updated_at = ?
      WHERE id = ?
    `);
    const result = stmt.run(visibility, new Date().toISOString(), chunkId);
    if (Number(result.changes) > 0) {
      this.setChunkVisibility(chunkId, visibility);
      this.incrementNumericMeta(MEMORY_CHANGE_SEQ_META_KEY);
      return true;
    }
    return false;
  }

  updateChunkMetadata(chunkId: string, metadata: Record<string, unknown>): boolean {
    this.ensureOpen();
    const stmt = this.db.prepare(`
      UPDATE chunks
      SET metadata = ?, updated_at = ?
      WHERE id = ?
    `);
    const result = stmt.run(
      JSON.stringify(metadata ?? {}),
      new Date().toISOString(),
      chunkId,
    );
    if (Number(result.changes) > 0) {
      this.incrementNumericMeta(MEMORY_CHANGE_SEQ_META_KEY);
      return true;
    }
    return false;
  }

  promoteSourceVisibility(sourcePath: string, visibility: MemoryVisibility = "shared"): number {
    this.ensureOpen();
    const stmt = this.db.prepare(`
      UPDATE chunks
      SET visibility = ?, updated_at = ?
      WHERE source_path = ?
    `);
    const result = stmt.run(visibility, new Date().toISOString(), sourcePath);
    if (Number(result.changes) > 0) {
      this.setSourceVisibility(sourcePath, visibility);
      this.incrementNumericMeta(MEMORY_CHANGE_SEQ_META_KEY);
    }
    return Number(result.changes);
  }

  createTask(task: TaskRecord): void {
    this.upsertTask(task);
    this.incrementNumericMeta(TASK_CHANGE_SEQ_META_KEY);
  }

  createTaskActivity(activity: TaskActivityRecord): void {
    this.ensureOpen();
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO task_activities (
        id, task_id, conversation_id, session_key, agent_id, source, kind, state, sequence,
        happened_at, recorded_at, title, summary, tool_name, action_key, command_text,
        files_json, artifact_paths_json, memory_chunk_ids_json, note, error, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      activity.id,
      activity.taskId,
      activity.conversationId,
      activity.sessionKey,
      activity.agentId ?? null,
      activity.source,
      activity.kind,
      activity.state,
      activity.sequence,
      activity.happenedAt,
      activity.recordedAt,
      activity.title,
      activity.summary ?? null,
      activity.toolName ?? null,
      activity.actionKey ?? null,
      activity.command ?? null,
      JSON.stringify(activity.files ?? []),
      JSON.stringify(activity.artifactPaths ?? []),
      JSON.stringify(activity.memoryChunkIds ?? []),
      activity.note ?? null,
      activity.error ?? null,
      JSON.stringify(activity.metadata ?? {}),
    );
  }

  updateTask(taskId: string, patch: Partial<TaskRecord>): void {
    const existing = this.getTask(taskId);
    if (!existing) return;

    const updated: TaskRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    if (patch.workRecap === undefined || patch.resumeContext === undefined) {
      const activities = this.listTaskActivities(taskId);
      if (activities.length > 0) {
        const recapArtifacts = buildTaskRecapArtifacts({
          task: updated,
          activities,
          updatedAt: updated.updatedAt,
        });
        if (patch.workRecap === undefined) {
          updated.workRecap = recapArtifacts.workRecap;
        }
        if (patch.resumeContext === undefined) {
          updated.resumeContext = recapArtifacts.resumeContext;
        }
      }
    }

    this.upsertTask(updated);
    this.incrementNumericMeta(TASK_CHANGE_SEQ_META_KEY);
  }

  getTask(taskId: string): TaskRecord | null {
    this.ensureOpen();
    const stmt = this.db.prepare(`
      SELECT * FROM tasks WHERE id = ? LIMIT 1
    `);
    const row = stmt.get(taskId) as Record<string, unknown> | undefined;
    return row ? rowToTaskRecord(row) : null;
  }

  /**
   * 将 task、activity、memory link 和 experience usage 合并为有界批量投影。
   * 返回顺序按首次出现的有效 task id 保持，缺失 task 不占位。
   */
  getTaskDetails(taskIds: string[]): TaskExperienceDetail[] {
    this.ensureOpen();
    const batch = readTaskDetailBatchRows(this.db, taskIds);
    const details: TaskExperienceDetail[] = [];

    for (const taskId of batch.taskIds) {
      const taskRow = batch.taskRowsById.get(taskId);
      if (!taskRow) continue;
      const usages = (batch.usageRowsByTaskId.get(taskId) ?? []).map(rowToExperienceUsage);
      const toUsageSummary = (usage: ExperienceUsage): ExperienceUsageSummary => {
        const statsRow = batch.usageStatsRowsByAssetType.get(usage.assetType)?.get(usage.assetKey);
        return toTaskExperienceUsageSummary(usage, statsRow);
      };
      details.push({
        ...rowToTaskRecord(taskRow),
        activities: (batch.activityRowsByTaskId.get(taskId) ?? []).map(rowToTaskActivityRecord),
        memoryLinks: (batch.memoryLinkRowsByTaskId.get(taskId) ?? []).map(rowToTaskMemoryLink),
        usedMethods: usages.filter((usage) => usage.assetType === "method").map(toUsageSummary),
        usedSkills: usages.filter((usage) => usage.assetType === "skill").map(toUsageSummary),
      });
    }

    return details;
  }

  /**
   * 给派生检索使用的轻量批量投影，不读取 memory link 或 experience usage。
   */
  getTaskDerivedDetails(taskIds: string[]): TaskDerivedDetail[] {
    this.ensureOpen();
    const batch = readTaskDerivedDetailBatchRows(this.db, taskIds);
    const details: TaskDerivedDetail[] = [];

    for (const taskId of batch.taskIds) {
      const taskRow = batch.taskRowsById.get(taskId);
      if (!taskRow) continue;
      details.push(rowToTaskDerivedDetail(
        taskRow,
        batch.recentActivityTitleRowsByTaskId.get(taskId) ?? [],
      ));
    }

    return details;
  }

  getTaskByConversation(conversationId: string): TaskRecord | null {
    this.ensureOpen();
    const stmt = this.db.prepare(`
      SELECT * FROM tasks
      WHERE conversation_id = ?
      ORDER BY COALESCE(finished_at, started_at) DESC, created_at DESC
      LIMIT 1
    `);
    const row = stmt.get(conversationId) as Record<string, unknown> | undefined;
    return row ? rowToTaskRecord(row) : null;
  }

  listTasks(limit = 10, filter?: TaskSearchFilter): TaskRecord[] {
    this.ensureOpen();
    const { clause, params } = this.buildTaskFilterClause(filter);
    const stmt = this.db.prepare(`
      SELECT * FROM tasks t
      WHERE 1 = 1${clause}
      ORDER BY COALESCE(t.finished_at, t.started_at) DESC, t.created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(...params, limit) as Record<string, unknown>[];
    return rows.map(rowToTaskRecord);
  }

  getTaskInventoryStats(): {
    taskCount: number;
    taskActivityCount: number;
    lastTaskUpdatedAt?: string;
    lastActivityAt?: string;
  } {
    this.ensureOpen();
    const taskRow = this.db.prepare(`
      SELECT COUNT(*) AS count, MAX(updated_at) AS last_updated_at
      FROM tasks
    `).get() as Record<string, unknown> | undefined;
    const activityRow = this.db.prepare(`
      SELECT COUNT(*) AS count, MAX(recorded_at) AS last_activity_at
      FROM task_activities
    `).get() as Record<string, unknown> | undefined;
    return {
      taskCount: optionalNumber(taskRow?.count) ?? 0,
      taskActivityCount: optionalNumber(activityRow?.count) ?? 0,
      lastTaskUpdatedAt: optionalString(taskRow?.last_updated_at),
      lastActivityAt: optionalString(activityRow?.last_activity_at),
    };
  }

  listTaskActivities(taskId: string, limit = 200): TaskActivityRecord[] {
    this.ensureOpen();
    const stmt = this.db.prepare(`
      SELECT * FROM task_activities
      WHERE task_id = ?
      ORDER BY sequence ASC, happened_at ASC, recorded_at ASC
      LIMIT ?
    `);
    const rows = stmt.all(taskId, limit) as Record<string, unknown>[];
    return rows.map(rowToTaskActivityRecord);
  }

  listTaskSummaries(limit = 10, filter?: TaskSearchFilter): TaskSummaryRecord[] {
    this.ensureOpen();
    const { clause, params } = this.buildTaskFilterClause(filter);
    const stmt = this.db.prepare(`
      SELECT
        t.id,
        t.title,
        t.objective,
        t.summary,
        t.status,
        t.source,
        t.finished_at,
        t.agent_id,
        t.tool_calls_json,
        t.artifact_paths_json,
        t.updated_at,
        t.work_recap_json,
        t.resume_context_json
      FROM tasks t
      WHERE 1 = 1${clause}
      ORDER BY COALESCE(t.finished_at, t.started_at) DESC, t.created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(...params, limit) as Record<string, unknown>[];
    return rows.map(rowToTaskSummaryRecord);
  }

  searchTasksKeyword(query: string, limit = 10, filter?: TaskSearchFilter): TaskRecord[] {
    this.ensureOpen();
    const normalized = query.trim();
    if (!normalized) return [];

    const { clause, params } = this.buildTaskFilterClause(filter);
    if (this.hasFts5) {
      const ftsQuery = buildFtsQuery(normalized);
      if (!ftsQuery) return [];
      const stmt = this.db.prepare(`
        SELECT t.*
        FROM tasks_fts f
        JOIN tasks t ON t.rowid = f.rowid
        WHERE tasks_fts MATCH ?${clause}
        ORDER BY bm25(tasks_fts)
        LIMIT ?
      `);
      const rows = stmt.all(ftsQuery, ...params, limit) as Record<string, unknown>[];
      return rows.map(rowToTaskRecord);
    }

    const like = `%${escapeLike(normalized)}%`;
    const stmt = this.db.prepare(`
      SELECT * FROM tasks t
      WHERE (
        t.title LIKE ? ESCAPE '\\'
        OR t.objective LIKE ? ESCAPE '\\'
        OR t.summary LIKE ? ESCAPE '\\'
        OR t.reflection LIKE ? ESCAPE '\\'
        OR t.outcome LIKE ? ESCAPE '\\'
      )${clause}
      ORDER BY COALESCE(t.finished_at, t.started_at) DESC, t.created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(like, like, like, like, like, ...params, limit) as Record<string, unknown>[];
    return rows.map(rowToTaskRecord);
  }

  linkTaskMemory(taskId: string, chunkId: string, relation: "used" | "generated" | "referenced"): void {
    this.ensureOpen();
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO task_memory_links (task_id, chunk_id, relation, created_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(taskId, chunkId, relation, new Date().toISOString());
  }

  listTaskMemoryLinks(taskId: string): Array<{ chunkId: string; relation: TaskMemoryRelation; sourcePath?: string; memoryType?: string; visibility?: MemoryVisibility; snippet?: string }> {
    this.ensureOpen();
    const stmt = this.db.prepare(`
      SELECT l.chunk_id, l.relation, c.source_path, c.memory_type, c.visibility, c.content
      FROM task_memory_links l
      LEFT JOIN chunks c ON c.id = l.chunk_id
      WHERE l.task_id = ?
    `);
    return (stmt.all(taskId) as Record<string, unknown>[]).map(rowToTaskMemoryLink);
  }

  upsertProfileStateEntry(input: UpsertProfileStateEntryInput): ProfileStateEntry {
    this.ensureOpen();
    const result = upsertProfileStateEntryInDb(this.db, input);
    if (result.changed) {
      this.incrementNumericMeta(MEMORY_CHANGE_SEQ_META_KEY);
    }
    return result.entry;
  }

  getProfileStateEntry(
    path: string,
    filter: Omit<ProfileStateEntryFilter, "path" | "pathPrefix" | "ids"> = {},
  ): ProfileStateEntry | null {
    this.ensureOpen();
    return getProfileStateEntryFromDb(this.db, path, filter);
  }

  listProfileStateEntries(limit = 20, filter: ProfileStateEntryFilter = {}): ProfileStateEntry[] {
    this.ensureOpen();
    return listProfileStateEntriesFromDb(this.db, limit, filter);
  }

  deleteProfileStateEntry(path: string, input: DeleteProfileStateEntryInput = {}): ProfileStateEntry | null {
    this.ensureOpen();
    const result = deleteProfileStateEntryInDb(this.db, path, input);
    if (result.changed) {
      this.incrementNumericMeta(MEMORY_CHANGE_SEQ_META_KEY);
    }
    return result.entry;
  }

  listProfileStateEvents(limit = 50, filter: ProfileStateEventFilter = {}): ProfileStateEvent[] {
    this.ensureOpen();
    return listProfileStateEventsFromDb(this.db, limit, filter);
  }

  createExperienceCandidate(candidate: ExperienceCandidate): void {
    this.ensureOpen();
    const stmt = this.db.prepare(`
      INSERT INTO experience_candidates (
        id, task_id, type, status, title, slug, content, summary, quality_score,
        source_task_snapshot_json, published_path, created_at, reviewed_at, accepted_at, rejected_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      candidate.id,
      candidate.taskId,
      candidate.type,
      candidate.status,
      candidate.title,
      candidate.slug,
      candidate.content,
      candidate.summary ?? null,
      candidate.qualityScore ?? null,
      JSON.stringify(candidate.sourceTaskSnapshot),
      candidate.publishedPath ?? null,
      candidate.createdAt,
      candidate.reviewedAt ?? null,
      candidate.acceptedAt ?? null,
      candidate.rejectedAt ?? null,
      candidate.metadata ? JSON.stringify(candidate.metadata) : null,
    );
  }

  getExperienceCandidate(candidateId: string): ExperienceCandidate | null {
    this.ensureOpen();
    const stmt = this.db.prepare(`
      SELECT * FROM experience_candidates
      WHERE id = ?
      LIMIT 1
    `);
    const row = stmt.get(candidateId) as Record<string, unknown> | undefined;
    return row ? rowToExperienceCandidate(row) : null;
  }

  findExperienceCandidateByTaskAndType(taskId: string, type: ExperienceCandidateType): ExperienceCandidate | null {
    this.ensureOpen();
    const stmt = this.db.prepare(`
      SELECT * FROM experience_candidates
      WHERE task_id = ? AND type = ?
      LIMIT 1
    `);
    const row = stmt.get(taskId, type) as Record<string, unknown> | undefined;
    return row ? rowToExperienceCandidate(row) : null;
  }

  listExperienceCandidates(limit = 20, filter?: ExperienceCandidateListFilter, offset = 0): ExperienceCandidate[] {
    this.ensureOpen();
    const { clause, params } = this.buildExperienceCandidateFilterClause(filter);
    const safeOffset = Number.isInteger(offset) && offset > 0 ? offset : 0;
    const stmt = this.db.prepare(`
      SELECT c.*
      FROM experience_candidates c
      LEFT JOIN tasks t ON t.id = c.task_id
      WHERE 1 = 1${clause}
      ORDER BY c.created_at DESC
      LIMIT ?
      OFFSET ?
    `);
    const rows = stmt.all(...params, limit, safeOffset) as Record<string, unknown>[];
    return rows.map(rowToExperienceCandidate);
  }

  /**
   * 先用 FTS 或受控 title/summary fallback 取得 Experience 候选 ID。
   * 不读取候选正文；FTS 不可用时允许降低正文命中召回，但绝不回退为全表 content scan。
   */
  searchExperienceDerivedCandidateIds(
    query: string,
    limit = 24,
    filter?: ExperienceCandidateListFilter,
  ): string[] {
    this.ensureOpen();
    return searchExperienceDerivedCandidateIdsInDb({
      db: this.db,
      query,
      limit,
      filter,
      useFts: this.hasExperienceFts,
    });
  }

  /** 只读取 Experience 派生 surface 所需的有限字段和有界正文前缀。 */
  getExperienceDerivedCandidates(candidateIds: string[]): ExperienceDerivedCandidate[] {
    this.ensureOpen();
    return readExperienceDerivedCandidates(this.db, candidateIds);
  }

  getExperienceCandidateStats(filter?: ExperienceCandidateListFilter): ExperienceCandidateStats {
    this.ensureOpen();
    const { clause, params } = this.buildExperienceCandidateFilterClause(filter);
    const stmt = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN c.type = 'method' THEN 1 ELSE 0 END) AS methods,
        SUM(CASE WHEN c.type = 'skill' THEN 1 ELSE 0 END) AS skills,
        SUM(CASE WHEN c.status = 'draft' THEN 1 ELSE 0 END) AS draft,
        SUM(CASE WHEN c.status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
        SUM(CASE WHEN c.status = 'rejected' THEN 1 ELSE 0 END) AS rejected
      FROM experience_candidates c
      LEFT JOIN tasks t ON t.id = c.task_id
      WHERE 1 = 1${clause}
    `);
    const row = stmt.get(...params) as Record<string, unknown> | undefined;
    return {
      total: optionalNumber(row?.total) ?? 0,
      methods: optionalNumber(row?.methods) ?? 0,
      skills: optionalNumber(row?.skills) ?? 0,
      draft: optionalNumber(row?.draft) ?? 0,
      accepted: optionalNumber(row?.accepted) ?? 0,
      rejected: optionalNumber(row?.rejected) ?? 0,
    };
  }

  getExperienceInventoryStats(): {
    candidateCount: number;
    draftCandidateCount: number;
    acceptedCandidateCount: number;
    rejectedCandidateCount: number;
    usageCount: number;
    lastCandidateCreatedAt?: string;
    lastUsageCreatedAt?: string;
  } {
    this.ensureOpen();
    const candidateRow = this.db.prepare(`
      SELECT
        COUNT(*) AS candidate_count,
        SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft_count,
        SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted_count,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count,
        MAX(created_at) AS last_candidate_created_at
      FROM experience_candidates
    `).get() as Record<string, unknown> | undefined;
    const usageRow = this.db.prepare(`
      SELECT COUNT(*) AS usage_count, MAX(created_at) AS last_usage_created_at
      FROM experience_usages
    `).get() as Record<string, unknown> | undefined;
    return {
      candidateCount: optionalNumber(candidateRow?.candidate_count) ?? 0,
      draftCandidateCount: optionalNumber(candidateRow?.draft_count) ?? 0,
      acceptedCandidateCount: optionalNumber(candidateRow?.accepted_count) ?? 0,
      rejectedCandidateCount: optionalNumber(candidateRow?.rejected_count) ?? 0,
      usageCount: optionalNumber(usageRow?.usage_count) ?? 0,
      lastCandidateCreatedAt: optionalString(candidateRow?.last_candidate_created_at),
      lastUsageCreatedAt: optionalString(usageRow?.last_usage_created_at),
    };
  }

  upsertMemorySources(records: MemoryTreeSourceRecord[]): void {
    this.ensureOpen();
    if (!Array.isArray(records) || records.length <= 0) {
      return;
    }
    const stmt = this.db.prepare(`
      INSERT INTO memory_sources (
        id, source_kind, source_class, scope, agent_id, source_path, source_ref,
        content_hash, time_from, time_to, item_count, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_kind = excluded.source_kind,
        source_class = excluded.source_class,
        scope = excluded.scope,
        agent_id = excluded.agent_id,
        source_path = excluded.source_path,
        source_ref = excluded.source_ref,
        content_hash = excluded.content_hash,
        time_from = excluded.time_from,
        time_to = excluded.time_to,
        item_count = excluded.item_count,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `);
    const tx = this.db.transaction((items: MemoryTreeSourceRecord[]) => {
      const now = new Date().toISOString();
      for (const item of items) {
        const createdAt = item.createdAt ?? now;
        const updatedAt = item.updatedAt ?? now;
        stmt.run(
          item.id,
          item.sourceKind,
          item.sourceClass,
          item.scope,
          item.agentId ?? null,
          item.sourcePath ?? null,
          item.sourceRef ?? null,
          item.contentHash ?? null,
          item.timeFrom ?? null,
          item.timeTo ?? null,
          typeof item.itemCount === "number" ? Math.max(0, Math.floor(item.itemCount)) : null,
          item.metadata ? JSON.stringify(item.metadata) : null,
          createdAt,
          updatedAt,
        );
      }
    });
    tx(records);
  }

  listMemorySources(limit = 100, filter?: MemoryTreeSourceListFilter): MemoryTreeSourceRecord[] {
    this.ensureOpen();
    const { clause, params } = this.buildMemorySourceFilterClause(filter);
    const stmt = this.db.prepare(`
      SELECT *
      FROM memory_sources
      WHERE 1 = 1${clause}
      ORDER BY updated_at DESC, id ASC
      LIMIT ?
    `);
    const rows = stmt.all(...params, limit) as Record<string, unknown>[];
    return rows.map(rowToMemorySourceRecord);
  }

  upsertMemoryScores(records: MemoryTreeScoreRecord[]): void {
    this.ensureOpen();
    if (!Array.isArray(records) || records.length <= 0) {
      return;
    }
    const stmt = this.db.prepare(`
      INSERT INTO memory_scores (
        id, target_type, target_id, source_id, score_total, recency_score,
        source_weight_score, interaction_score, task_outcome_score,
        entity_density_score, llm_importance_score, dedup_confidence,
        score_version, rationale_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        target_type = excluded.target_type,
        target_id = excluded.target_id,
        source_id = excluded.source_id,
        score_total = excluded.score_total,
        recency_score = excluded.recency_score,
        source_weight_score = excluded.source_weight_score,
        interaction_score = excluded.interaction_score,
        task_outcome_score = excluded.task_outcome_score,
        entity_density_score = excluded.entity_density_score,
        llm_importance_score = excluded.llm_importance_score,
        dedup_confidence = excluded.dedup_confidence,
        score_version = excluded.score_version,
        rationale_json = excluded.rationale_json,
        updated_at = excluded.updated_at
    `);
    const tx = this.db.transaction((items: MemoryTreeScoreRecord[]) => {
      const now = new Date().toISOString();
      for (const item of items) {
        const createdAt = item.createdAt ?? now;
        const updatedAt = item.updatedAt ?? now;
        stmt.run(
          item.id,
          item.targetType,
          item.targetId,
          item.sourceId ?? null,
          item.scoreTotal,
          item.recencyScore ?? null,
          item.sourceWeightScore ?? null,
          item.interactionScore ?? null,
          item.taskOutcomeScore ?? null,
          item.entityDensityScore ?? null,
          item.llmImportanceScore ?? null,
          item.dedupConfidence ?? null,
          item.scoreVersion,
          item.rationale ? JSON.stringify(item.rationale) : null,
          createdAt,
          updatedAt,
        );
      }
    });
    tx(records);
  }

  listMemoryScores(limit = 100, filter?: MemoryTreeScoreListFilter): MemoryTreeScoreRecord[] {
    this.ensureOpen();
    const { clause, params } = this.buildMemoryScoreFilterClause(filter);
    const stmt = this.db.prepare(`
      SELECT *
      FROM memory_scores
      WHERE 1 = 1${clause}
      ORDER BY score_total DESC, updated_at DESC, id ASC
      LIMIT ?
    `);
    const rows = stmt.all(...params, limit) as Record<string, unknown>[];
    return rows.map(rowToMemoryScoreRecord);
  }

  listMemoryScoresByTargetIds(targetType: MemoryTreeTargetType, targetIds: string[]): MemoryTreeScoreRecord[] {
    this.ensureOpen();
    const normalizedIds = [...new Set(
      (Array.isArray(targetIds) ? targetIds : [])
        .map((item) => String(item ?? "").trim())
        .filter((item) => item.length > 0),
    )];
    if (normalizedIds.length <= 0) {
      return [];
    }
    const placeholders = normalizedIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT *
      FROM memory_scores
      WHERE target_type = ?
        AND target_id IN (${placeholders})
      ORDER BY score_total DESC, updated_at DESC, id ASC
    `).all(targetType, ...normalizedIds) as Record<string, unknown>[];
    return rows.map(rowToMemoryScoreRecord);
  }

  upsertMemoryCleanReports(records: MemoryTreeReportRecord[]): void {
    this.ensureOpen();
    if (!Array.isArray(records) || records.length <= 0) {
      return;
    }
    const stmt = this.db.prepare(`
      INSERT INTO memory_clean_reports (
        id, report_type, scope, agent_id, status, input_version,
        summary_json, details_json, export_markdown_path, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        report_type = excluded.report_type,
        scope = excluded.scope,
        agent_id = excluded.agent_id,
        status = excluded.status,
        input_version = excluded.input_version,
        summary_json = excluded.summary_json,
        details_json = excluded.details_json,
        export_markdown_path = excluded.export_markdown_path,
        created_by = excluded.created_by,
        updated_at = excluded.updated_at
    `);
    const tx = this.db.transaction((items: MemoryTreeReportRecord[]) => {
      const now = new Date().toISOString();
      for (const item of items) {
        stmt.run(
          item.id,
          item.reportType,
          item.scope,
          item.agentId ?? null,
          item.status,
          item.inputVersion ?? null,
          JSON.stringify(item.summary ?? {}),
          JSON.stringify(item.details ?? {}),
          item.exportMarkdownPath ?? null,
          item.createdBy ?? null,
          item.createdAt ?? now,
          item.updatedAt ?? now,
        );
      }
    });
    tx(records);
  }

  listMemoryCleanReports(limit = 50, filter?: MemoryTreeReportListFilter): MemoryTreeReportRecord[] {
    this.ensureOpen();
    const { clause, params } = this.buildMemoryReportFilterClause(filter);
    const stmt = this.db.prepare(`
      SELECT *
      FROM memory_clean_reports
      WHERE 1 = 1${clause}
      ORDER BY created_at DESC, id ASC
      LIMIT ?
    `);
    const rows = stmt.all(...params, limit) as Record<string, unknown>[];
    return rows.map(rowToMemoryReportRecord);
  }

  getMemoryCleanReport(reportId: string): MemoryTreeReportRecord | null {
    this.ensureOpen();
    const row = this.db.prepare(`
      SELECT *
      FROM memory_clean_reports
      WHERE id = ?
      LIMIT 1
    `).get(reportId) as Record<string, unknown> | undefined;
    return row ? rowToMemoryReportRecord(row) : null;
  }

  upsertMemoryTreeNodes(records: MemoryTreeNodeRecord[]): void {
    this.ensureOpen();
    if (!Array.isArray(records) || records.length <= 0) {
      return;
    }
    const stmt = this.db.prepare(`
      INSERT INTO memory_tree_nodes (
        id, level, kind, scope, agent_id, topic_key, title, summary,
        summary_model, summary_version, time_from, time_to,
        source_class_mix_json, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        level = excluded.level,
        kind = excluded.kind,
        scope = excluded.scope,
        agent_id = excluded.agent_id,
        topic_key = excluded.topic_key,
        title = excluded.title,
        summary = excluded.summary,
        summary_model = excluded.summary_model,
        summary_version = excluded.summary_version,
        time_from = excluded.time_from,
        time_to = excluded.time_to,
        source_class_mix_json = excluded.source_class_mix_json,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `);
    const tx = this.db.transaction((items: MemoryTreeNodeRecord[]) => {
      const now = new Date().toISOString();
      for (const item of items) {
        stmt.run(
          item.id,
          Math.max(1, Math.floor(item.level)),
          item.kind,
          item.scope,
          item.agentId ?? null,
          item.topicKey ?? null,
          item.title ?? null,
          item.summary,
          item.summaryModel ?? null,
          item.summaryVersion ?? null,
          item.timeFrom ?? null,
          item.timeTo ?? null,
          item.sourceClassMix ? JSON.stringify(item.sourceClassMix) : null,
          item.metadata ? JSON.stringify(item.metadata) : null,
          item.createdAt ?? now,
          item.updatedAt ?? now,
        );
      }
    });
    tx(records);
  }

  listMemoryTreeNodes(limit = 100, filter?: MemoryTreeNodeListFilter): MemoryTreeNodeRecord[] {
    this.ensureOpen();
    const { clause, params } = this.buildMemoryNodeFilterClause(filter);
    const stmt = this.db.prepare(`
      SELECT *
      FROM memory_tree_nodes
      WHERE 1 = 1${clause}
      ORDER BY level ASC, COALESCE(time_to, time_from, updated_at) DESC, id ASC
      LIMIT ?
    `);
    const rows = stmt.all(...params, limit) as Record<string, unknown>[];
    return rows.map(rowToMemoryNodeRecord);
  }

  getMemoryTreeNode(nodeId: string): MemoryTreeNodeRecord | null {
    this.ensureOpen();
    const row = this.db.prepare(`
      SELECT *
      FROM memory_tree_nodes
      WHERE id = ?
      LIMIT 1
    `).get(nodeId) as Record<string, unknown> | undefined;
    return row ? rowToMemoryNodeRecord(row) : null;
  }

  getMemoryTreeNodeDetails(
    nodeIds: string[],
    options: { chunkLimit?: number } = {},
  ): Map<string, MemoryTreeNodeDetailResult> {
    this.ensureOpen();
    return readMemoryTreeNodeDetailsBatch(this.db, nodeIds, options, {
      node: rowToMemoryNodeRecord,
      edge: rowToMemoryEdgeRecord,
      chunk: (row) => rowToSearchResult(row, 1),
      source: rowToMemorySourceRecord,
    });
  }

  deleteMemoryTreeNodesByKind(kind: MemoryTreeNodeKind): void {
    this.ensureOpen();
    const nodeIds = this.db.prepare(`
      SELECT id
      FROM memory_tree_nodes
      WHERE kind = ?
    `).all(kind) as Array<{ id: string }>;
    if (nodeIds.length <= 0) {
      return;
    }
    const placeholders = nodeIds.map(() => "?").join(", ");
    const ids = nodeIds.map((item) => item.id);
    const tx = this.db.transaction(() => {
      this.db.prepare(`
        DELETE FROM memory_tree_edges
        WHERE parent_node_id IN (${placeholders})
      `).run(...ids);
      this.db.prepare(`
        DELETE FROM memory_tree_nodes
        WHERE id IN (${placeholders})
      `).run(...ids);
    });
    tx();
  }

  /** Memory Tree kind 快照由相邻 transaction owner 一次发布，避免 delete/insert 分离提交。 */
  publishMemoryTreeKind(input: MemoryTreeKindPublication): void {
    this.ensureOpen();
    publishMemoryTreeKindTransaction(this.db, input);
  }

  upsertMemoryTreeEdges(records: MemoryTreeEdgeRecord[]): void {
    this.ensureOpen();
    if (!Array.isArray(records) || records.length <= 0) {
      return;
    }
    const stmt = this.db.prepare(`
      INSERT INTO memory_tree_edges (
        id, parent_node_id, child_type, child_id, relation, position, weight, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        parent_node_id = excluded.parent_node_id,
        child_type = excluded.child_type,
        child_id = excluded.child_id,
        relation = excluded.relation,
        position = excluded.position,
        weight = excluded.weight,
        metadata_json = excluded.metadata_json
    `);
    const tx = this.db.transaction((items: MemoryTreeEdgeRecord[]) => {
      const now = new Date().toISOString();
      for (const item of items) {
        stmt.run(
          item.id,
          item.parentNodeId,
          item.childType,
          item.childId,
          item.relation,
          typeof item.position === "number" ? Math.floor(item.position) : null,
          item.weight ?? null,
          item.metadata ? JSON.stringify(item.metadata) : null,
          item.createdAt ?? now,
        );
      }
    });
    tx(records);
  }

  listMemoryTreeEdges(filter?: MemoryTreeEdgeListFilter): MemoryTreeEdgeRecord[] {
    this.ensureOpen();
    const { clause, params } = this.buildMemoryEdgeFilterClause(filter);
    const rows = this.db.prepare(`
      SELECT *
      FROM memory_tree_edges
      WHERE 1 = 1${clause}
      ORDER BY parent_node_id ASC, COALESCE(position, 999999) ASC, child_id ASC
    `).all(...params) as Record<string, unknown>[];
    return rows.map(rowToMemoryEdgeRecord);
  }

  listChunkSourceSummaries(): Array<{
    sourcePath: string;
    sourceType: string;
    agentId?: string;
    scope: "private" | "shared";
    itemCount: number;
    timeFrom?: string;
    timeTo?: string;
    memoryTypes: string[];
  }> {
    this.ensureOpen();
    const rows = this.db.prepare(`
      SELECT
        source_path,
        source_type,
        agent_id,
        CASE
          WHEN SUM(CASE WHEN visibility = 'shared' THEN 1 ELSE 0 END) > 0 THEN 'shared'
          ELSE 'private'
        END AS scope,
        COUNT(*) AS item_count,
        MIN(created_at) AS time_from,
        MAX(updated_at) AS time_to,
        GROUP_CONCAT(DISTINCT memory_type) AS memory_types
      FROM chunks
      GROUP BY source_path, source_type, agent_id
      ORDER BY MAX(updated_at) DESC, source_path ASC
    `).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      sourcePath: String(row.source_path ?? ""),
      sourceType: String(row.source_type ?? ""),
      agentId: optionalString(row.agent_id),
      scope: String(row.scope ?? "private") === "shared" ? "shared" : "private",
      itemCount: optionalNumber(row.item_count) ?? 0,
      timeFrom: optionalString(row.time_from),
      timeTo: optionalString(row.time_to),
      memoryTypes: String(row.memory_types ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    }));
  }

  listChunkTopicSummaries(): Array<{
    topic: string;
    agentId?: string;
    scope: "private" | "shared";
    itemCount: number;
    timeFrom?: string;
    timeTo?: string;
    memoryTypes: string[];
  }> {
    this.ensureOpen();
    const rows = this.db.prepare(`
      SELECT
        topic,
        agent_id,
        CASE
          WHEN visibility = 'shared' THEN 'shared'
          ELSE 'private'
        END AS scope,
        COUNT(*) AS item_count,
        MIN(created_at) AS time_from,
        MAX(updated_at) AS time_to,
        GROUP_CONCAT(DISTINCT memory_type) AS memory_types
      FROM chunks
      WHERE topic IS NOT NULL
        AND TRIM(topic) <> ''
      GROUP BY topic, agent_id, CASE
        WHEN visibility = 'shared' THEN 'shared'
        ELSE 'private'
      END
      ORDER BY MAX(updated_at) DESC, topic ASC
    `).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      topic: String(row.topic ?? ""),
      agentId: optionalString(row.agent_id),
      scope: String(row.scope ?? "private") === "shared" ? "shared" : "private",
      itemCount: optionalNumber(row.item_count) ?? 0,
      timeFrom: optionalString(row.time_from),
      timeTo: optionalString(row.time_to),
      memoryTypes: String(row.memory_types ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    }));
  }

  listChunkScoreInputs(): MemoryTreeChunkScoreInput[] {
    this.ensureOpen();
    const rows = this.db.prepare(`
      SELECT
        c.id AS chunk_id,
        c.source_path,
        c.source_type,
        c.memory_type,
        c.visibility,
        c.agent_id,
        c.updated_at,
        c.content,
        COUNT(DISTINCT tml.task_id) AS task_link_count,
        SUM(CASE WHEN t.status = 'success' THEN 1 ELSE 0 END) AS success_task_count,
        SUM(CASE WHEN t.status = 'partial' THEN 1 ELSE 0 END) AS partial_task_count,
        SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) AS failed_task_count,
        SUM(CASE WHEN t.status = 'running' THEN 1 ELSE 0 END) AS running_task_count
      FROM chunks c
      LEFT JOIN task_memory_links tml ON tml.chunk_id = c.id
      LEFT JOIN tasks t ON t.id = tml.task_id
      GROUP BY c.id
      ORDER BY c.updated_at DESC, c.rowid DESC
    `).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      chunkId: String(row.chunk_id ?? ""),
      sourcePath: String(row.source_path ?? ""),
      sourceType: String(row.source_type ?? ""),
      memoryType: optionalString(row.memory_type),
      visibility: normalizeVisibility(row.visibility) ?? "private",
      agentId: optionalString(row.agent_id),
      updatedAt: optionalString(row.updated_at),
      content: optionalString(row.content),
      taskLinkCount: optionalNumber(row.task_link_count) ?? 0,
      successTaskCount: optionalNumber(row.success_task_count) ?? 0,
      partialTaskCount: optionalNumber(row.partial_task_count) ?? 0,
      failedTaskCount: optionalNumber(row.failed_task_count) ?? 0,
      runningTaskCount: optionalNumber(row.running_task_count) ?? 0,
    }));
  }

  rejectExperienceCandidates(filter?: ExperienceCandidateListFilter): number {
    this.ensureOpen();
    const effectiveFilter: ExperienceCandidateListFilter = {
      ...(filter && typeof filter === "object" ? filter : {}),
      status: "draft",
    };
    const { clause, params } = this.buildExperienceCandidateFilterClause(effectiveFilter);
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE experience_candidates
      SET
        status = 'rejected',
        reviewed_at = COALESCE(reviewed_at, ?),
        accepted_at = NULL,
        rejected_at = ?
      WHERE id IN (
        SELECT c.id
        FROM experience_candidates c
        LEFT JOIN tasks t ON t.id = c.task_id
        WHERE 1 = 1${clause}
      )
    `);
    const result = stmt.run(now, now, ...params);
    return Number(result.changes ?? 0);
  }

  previewExactDedup(filter?: MemorySearchFilter, options: { maxGroups?: number } = {}): MemoryExactDedupPreviewReport {
    this.ensureOpen();
    const { clause, params } = this.buildFilterClause(filter);
    const rows = this.db.prepare(`
      SELECT
        c.id,
        c.source_path,
        c.source_type,
        c.memory_type,
        c.visibility,
        c.start_line,
        c.end_line,
        c.content,
        c.created_at,
        c.updated_at,
        (
          SELECT COUNT(*)
          FROM task_memory_links l
          WHERE l.chunk_id = c.id
        ) AS task_link_count
      FROM chunks c
      WHERE 1=1${clause}
      ORDER BY c.updated_at DESC, c.rowid DESC
    `).all(...params) as Array<{
      id: string;
      source_path: string;
      source_type: string;
      memory_type?: MemoryType | null;
      visibility?: MemoryVisibility | null;
      start_line?: number | null;
      end_line?: number | null;
      content: string;
      created_at?: string | null;
      updated_at?: string | null;
      task_link_count?: number | null;
    }>;

    return buildMemoryExactDedupPreviewReport({
      chunks: rows.map((row) => ({
        id: row.id,
        sourcePath: row.source_path,
        sourceType: row.source_type,
        memoryType: row.memory_type ?? undefined,
        visibility: row.visibility ?? "private",
        startLine: row.start_line ?? undefined,
        endLine: row.end_line ?? undefined,
        content: row.content,
        createdAt: row.created_at ?? undefined,
        updatedAt: row.updated_at ?? undefined,
        taskLinkCount: row.task_link_count ?? 0,
      })),
      filter,
      maxGroups: options.maxGroups,
    });
  }

  applyExactDedup(filter: MemorySearchFilter | undefined, options: MemoryExactDedupApplyOptions): MemoryExactDedupApplyResult {
    this.ensureOpen();
    const { clause, params } = this.buildFilterClause(filter);
    const rows = this.db.prepare(`
      SELECT
        c.id,
        c.source_path,
        c.source_type,
        c.memory_type,
        c.visibility,
        c.start_line,
        c.end_line,
        c.content,
        c.created_at,
        c.updated_at,
        (
          SELECT COUNT(*)
          FROM task_memory_links l
          WHERE l.chunk_id = c.id
        ) AS task_link_count
      FROM chunks c
      WHERE 1=1${clause}
      ORDER BY c.updated_at DESC, c.rowid DESC
    `).all(...params) as Array<{
      id: string;
      source_path: string;
      source_type: string;
      memory_type?: MemoryType | null;
      visibility?: MemoryVisibility | null;
      start_line?: number | null;
      end_line?: number | null;
      content: string;
      created_at?: string | null;
      updated_at?: string | null;
      task_link_count?: number | null;
    }>;
    const snapshots = rows.map((row) => ({
      id: row.id,
      sourcePath: row.source_path,
      sourceType: row.source_type,
      memoryType: row.memory_type ?? undefined,
      visibility: row.visibility ?? "private",
      startLine: row.start_line ?? undefined,
      endLine: row.end_line ?? undefined,
      content: row.content,
      createdAt: row.created_at ?? undefined,
      updatedAt: row.updated_at ?? undefined,
      taskLinkCount: row.task_link_count ?? 0,
    }));
    const plan = buildMemoryExactDedupApplyPlan({
      chunks: snapshots,
      filter,
      maxGroups: options.maxGroups,
    });
    const backup = ensureMemoryDedupBackupFile({
      dbPath: this.getDbPath(),
      backupRootDir: options.backupRootDir,
      runId: options.runId,
    });
    const selectLinks = this.db.prepare(`
      SELECT task_id, relation
      FROM task_memory_links
      WHERE chunk_id = ?
    `);
    const upsertLink = this.db.prepare(`
      INSERT OR IGNORE INTO task_memory_links (task_id, chunk_id, relation, created_at)
      VALUES (?, ?, ?, ?)
    `);
    const deleteLinks = this.db.prepare(`DELETE FROM task_memory_links WHERE chunk_id = ?`);
    const selectRowId = this.db.prepare(`SELECT rowid FROM chunks WHERE id = ?`);
    const deleteChunk = this.db.prepare(`DELETE FROM chunks WHERE id = ?`);
    const deleteVec = this.vecDims
      ? this.db.prepare(`DELETE FROM chunks_vec WHERE rowid = ?`)
      : null;
    let removedChunks = 0;
    let relinkedTaskMemoryLinks = 0;
    const appliedGroups: Array<{
      normalizedHash: string;
      keepChunkId: string;
      removedChunkIds: string[];
      relinkedTaskMemoryLinks: number;
    }> = [];

    const tx = this.db.transaction(() => {
      for (const operation of plan.operations) {
        let groupRelinked = 0;
        const now = new Date().toISOString();
        for (const removeChunkId of operation.removeChunkIds) {
          const links = selectLinks.all(removeChunkId) as Array<{ task_id: string; relation: "used" | "generated" | "referenced" }>;
          for (const link of links) {
            const result = upsertLink.run(link.task_id, operation.keepChunkId, link.relation, now);
            groupRelinked += Number(result.changes ?? 0);
          }
          deleteLinks.run(removeChunkId);
          const row = selectRowId.get(removeChunkId) as { rowid: number } | undefined;
          if (row && deleteVec) {
            deleteVec.run(BigInt(row.rowid));
          }
          const deleteResult = deleteChunk.run(removeChunkId);
          removedChunks += Number(deleteResult.changes ?? 0);
        }
        relinkedTaskMemoryLinks += groupRelinked;
        appliedGroups.push({
          normalizedHash: operation.normalizedHash,
          keepChunkId: operation.keepChunkId,
          removedChunkIds: [...operation.removeChunkIds],
          relinkedTaskMemoryLinks: groupRelinked,
        });
      }
      if (removedChunks > 0) {
        this.incrementNumericMeta(MEMORY_CHANGE_SEQ_META_KEY, removedChunks);
      }
    });
    tx();
    if (removedChunks > 0) {
      this.ensureFtsRebuiltIfNeeded();
    }
    return {
      mode: "apply",
      strategy: "hash_only_exact",
      normalization: "trimmed_lf",
      ...(filter ? { filter } : {}),
      runId: backup.runId,
      backupPath: backup.backupPath,
      totals: {
        scannedChunks: plan.report.totals.scannedChunks,
        duplicateGroups: plan.report.totals.duplicateGroups,
        duplicateChunks: plan.report.totals.duplicateChunks,
        removedChunks,
        relinkedTaskMemoryLinks,
        keptChunks: plan.operations.length,
      },
      groups: appliedGroups,
    };
  }

  applyMemoryVacuum(options: MemoryVacuumApplyOptions): MemoryVacuumApplyResult {
    this.ensureOpen();
    const before = this.getDatabaseVacuumObservability();
    try {
      this.db.prepare(`PRAGMA wal_checkpoint(TRUNCATE)`).get();
    } catch {
      // Keep going so the actual vacuum failure can surface to the caller.
    }
    const backup = ensureMemoryVacuumBackupFile({
      dbPath: this.getDbPath(),
      backupRootDir: options.backupRootDir,
      runId: options.runId,
    });
    this.db.exec(`VACUUM`);
    try {
      this.db.prepare(`PRAGMA wal_checkpoint(TRUNCATE)`).get();
    } catch {
      // Best effort only; final file stats below still reflect the end state.
    }
    const after = this.getDatabaseVacuumObservability();
    const reclaimedBytes = Math.max(0, before.totalFileBytes - after.totalFileBytes);
    return {
      mode: "apply",
      runId: backup.runId,
      backupPath: backup.backupPath,
      changed: reclaimedBytes > 0 || after.pageCount !== before.pageCount || after.freelistCount !== before.freelistCount,
      before,
      after,
      reclaimedBytes,
      warnings: buildMemoryVacuumWarnings(before),
    };
  }

  deleteExperienceCandidates(filter?: ExperienceCandidateListFilter): number {
    this.ensureOpen();
    const { clause, params } = this.buildExperienceCandidateFilterClause(filter);
    const stmt = this.db.prepare(`
      DELETE FROM experience_candidates
      WHERE id IN (
        SELECT c.id
        FROM experience_candidates c
        LEFT JOIN tasks t ON t.id = c.task_id
        WHERE 1 = 1${clause}
      )
    `);
    const result = stmt.run(...params);
    return Number(result.changes ?? 0);
  }

  updateExperienceCandidate(candidateId: string, patch: Partial<ExperienceCandidate>): ExperienceCandidate | null {
    const existing = this.getExperienceCandidate(candidateId);
    if (!existing) return null;

    const updated: ExperienceCandidate = {
      ...existing,
      ...patch,
      id: existing.id,
      taskId: existing.taskId,
      type: existing.type,
      createdAt: existing.createdAt,
      sourceTaskSnapshot: patch.sourceTaskSnapshot ?? existing.sourceTaskSnapshot,
    };

    const stmt = this.db.prepare(`
      UPDATE experience_candidates
      SET
        status = ?,
        title = ?,
        slug = ?,
        content = ?,
        summary = ?,
        quality_score = ?,
        source_task_snapshot_json = ?,
        published_path = ?,
        reviewed_at = ?,
        accepted_at = ?,
        rejected_at = ?
        , metadata_json = ?
      WHERE id = ?
    `);

    stmt.run(
      updated.status,
      updated.title,
      updated.slug,
      updated.content,
      updated.summary ?? null,
      updated.qualityScore ?? null,
      JSON.stringify(updated.sourceTaskSnapshot),
      updated.publishedPath ?? null,
      updated.reviewedAt ?? null,
      updated.acceptedAt ?? null,
      updated.rejectedAt ?? null,
      updated.metadata ? JSON.stringify(updated.metadata) : null,
      candidateId,
    );

    return this.getExperienceCandidate(candidateId);
  }

  createExperienceUsage(usage: ExperienceUsage): void {
    this.ensureOpen();
    const stmt = this.db.prepare(`
      INSERT INTO experience_usages (
        id, task_id, asset_type, asset_key, source_candidate_id, used_via, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      usage.id,
      usage.taskId,
      usage.assetType,
      usage.assetKey,
      usage.sourceCandidateId ?? null,
      usage.usedVia,
      usage.createdAt,
    );
  }

  getExperienceUsage(usageId: string): ExperienceUsage | null {
    this.ensureOpen();
    const stmt = this.db.prepare(`
      SELECT *
      FROM experience_usages
      WHERE id = ?
      LIMIT 1
    `);
    const row = stmt.get(usageId) as Record<string, unknown> | undefined;
    return row ? rowToExperienceUsage(row) : null;
  }

  deleteExperienceUsage(usageId: string): ExperienceUsage | null {
    this.ensureOpen();
    const existing = this.getExperienceUsage(usageId);
    if (!existing) return null;

    this.db.prepare(`
      DELETE FROM experience_usages
      WHERE id = ?
    `).run(usageId);

    return existing;
  }

  findExperienceUsage(taskId: string, assetType: ExperienceAssetType, assetKey: string): ExperienceUsage | null {
    this.ensureOpen();
    const stmt = this.db.prepare(`
      SELECT *
      FROM experience_usages
      WHERE task_id = ? AND asset_type = ? AND asset_key = ?
      LIMIT 1
    `);
    const row = stmt.get(taskId, assetType, assetKey) as Record<string, unknown> | undefined;
    return row ? rowToExperienceUsage(row) : null;
  }

  deleteExperienceUsageByTaskAsset(taskId: string, assetType: ExperienceAssetType, assetKey: string): ExperienceUsage | null {
    this.ensureOpen();
    const existing = this.findExperienceUsage(taskId, assetType, assetKey);
    if (!existing) return null;
    return this.deleteExperienceUsage(existing.id);
  }

  listExperienceUsages(limit = 20, filter?: ExperienceUsageListFilter): ExperienceUsage[] {
    this.ensureOpen();
    const { clause, params } = this.buildExperienceUsageFilterClause(filter);
    const stmt = this.db.prepare(`
      SELECT *
      FROM experience_usages
      WHERE 1 = 1${clause}
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(...params, limit) as Record<string, unknown>[];
    return rows.map(rowToExperienceUsage);
  }

  getExperienceUsageStats(assetType: ExperienceAssetType, assetKey: string): ExperienceUsageStats {
    this.ensureOpen();
    const row = this.db.prepare(`
      WITH aggregated AS (
        SELECT COUNT(*) AS usage_count, MAX(created_at) AS last_used_at
        FROM experience_usages
        WHERE asset_type = ? AND asset_key = ?
      ),
      latest AS (
        SELECT source_candidate_id, task_id AS last_used_task_id
        FROM experience_usages
        WHERE asset_type = ? AND asset_key = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
      )
      SELECT
        ? AS asset_type,
        ? AS asset_key,
        latest.source_candidate_id,
        latest.last_used_task_id,
        aggregated.usage_count,
        aggregated.last_used_at,
        candidate.type AS source_candidate_type,
        candidate.title AS source_candidate_title,
        candidate.status AS source_candidate_status,
        candidate.task_id AS source_candidate_task_id,
        candidate.published_path AS source_candidate_published_path
      FROM aggregated
      LEFT JOIN latest ON 1 = 1
      LEFT JOIN experience_candidates candidate ON candidate.id = latest.source_candidate_id
    `).get(assetType, assetKey, assetType, assetKey, assetType, assetKey) as Record<string, unknown> | undefined;

    return rowToExperienceUsageStats(row ?? {
      asset_type: assetType,
      asset_key: assetKey,
      usage_count: 0,
    });
  }

  listExperienceUsageStats(limit = 50, filter?: Pick<ExperienceUsageListFilter, "assetType" | "assetKey" | "sourceCandidateId">): ExperienceUsageStats[] {
    this.ensureOpen();
    const { clause, params } = this.buildExperienceUsageStatsFilterClause(filter);
    const stmt = this.db.prepare(`
      WITH filtered AS (
        SELECT rowid, asset_type, asset_key, source_candidate_id, task_id, created_at
        FROM experience_usages
        WHERE 1 = 1${clause}
      ),
      ranked AS (
        SELECT
          asset_type,
          asset_key,
          source_candidate_id,
          task_id,
          created_at,
          COUNT(*) OVER (PARTITION BY asset_type, asset_key) AS usage_count,
          ROW_NUMBER() OVER (
            PARTITION BY asset_type, asset_key
            ORDER BY created_at DESC, rowid DESC
          ) AS row_rank
        FROM filtered
      )
      SELECT
        ranked.asset_type,
        ranked.asset_key,
        ranked.source_candidate_id,
        ranked.task_id AS last_used_task_id,
        ranked.usage_count,
        ranked.created_at AS last_used_at,
        candidate.type AS source_candidate_type,
        candidate.title AS source_candidate_title,
        candidate.status AS source_candidate_status,
        candidate.task_id AS source_candidate_task_id,
        candidate.published_path AS source_candidate_published_path
      FROM ranked
      LEFT JOIN experience_candidates candidate ON candidate.id = ranked.source_candidate_id
      WHERE row_rank = 1
      ORDER BY last_used_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(...params, limit) as Record<string, unknown>[];
    return rows.map(rowToExperienceUsageStats);
  }

  /** 获取索引状态 */
  getStatus(): MemoryIndexStatus {
    this.ensureOpen();

    const filesStmt = this.db.prepare(`SELECT COUNT(DISTINCT source_path) as count FROM chunks`);
    const filesRow = filesStmt.get() as { count: number };

    const chunksStmt = this.db.prepare(`SELECT COUNT(*) as count FROM chunks`);
    const chunksRow = chunksStmt.get() as { count: number };

    const categoryRows = this.db.prepare(`
      SELECT category, COUNT(*) as count
      FROM chunks
      GROUP BY category
    `).all() as Array<{ category: string | null; count: number }>;

    const categoryBuckets: Partial<Record<MemoryCategory, number>> = {};
    let categorized = 0;
    let uncategorized = 0;
    for (const row of categoryRows) {
      const category = normalizeCategory(row.category);
      if (category) {
        categoryBuckets[category] = row.count;
        categorized += row.count;
      } else {
        uncategorized += row.count;
      }
    }

    const metaStmt = this.db.prepare(`SELECT value FROM meta WHERE key = 'last_indexed_at'`);
    const metaRow = metaStmt.get() as { value: string } | undefined;

    return {
      files: filesRow.count,
      chunks: chunksRow.count,
      categorized,
      uncategorized,
      categoryBuckets,
      lastIndexedAt: metaRow?.value,
    };
  }

  /** 更新最后索引时间 */
  updateLastIndexedAt(): void {
    this.ensureOpen();
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO meta (key, value) VALUES ('last_indexed_at', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    stmt.run(now);
  }

  // ========== Phase M-N3: Session 记忆提取标记 ==========

  /** 检查 session 是否已提取过记忆 */
  isSessionMemoryExtracted(sessionKey: string): boolean {
    this.ensureOpen();
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(`memory_extracted:${sessionKey}`) as { value: string } | undefined;
    return row?.value === "true";
  }

  /** 标记 session 已提取记忆 */
  markSessionMemoryExtracted(sessionKey: string): void {
    this.ensureOpen();
    const stmt = this.db.prepare(`
      INSERT INTO meta (key, value) VALUES (?, 'true')
      ON CONFLICT(key) DO UPDATE SET value = 'true'
    `);
    stmt.run(`memory_extracted:${sessionKey}`);
  }

  /** 关闭数据库连接 */
  // ========== Phase M-N4: 源路径聚合检索 ==========

  /**
   * 按 source_path 拉取该来源的所有 chunk，按 start_line 排序。
   * @param maxPerSource 每个 source 最多返回的 chunk 数
   */
  getChunksBySource(sourcePath: string, maxPerSource = 10): MemorySearchResult[] {
    this.ensureOpen();
    const stmt = this.db.prepare(`
      SELECT id, source_path, source_type, memory_type, start_line, end_line,
             visibility, content, metadata, channel, topic, ts_date, summary, category
      FROM chunks
      WHERE source_path = ?
      ORDER BY start_line ASC, rowid ASC
      LIMIT ?
    `);
    const rows = stmt.all(sourcePath, maxPerSource) as any[];
    return rows.map(row => rowToSearchResult(row, 0));
  }

  getChunksByTopic(
    topic: string,
    options: {
      maxPerTopic?: number;
      agentId?: string | null;
      scope?: "private" | "shared";
    } = {},
  ): MemorySearchResult[] {
    this.ensureOpen();
    const normalizedTopic = String(topic ?? "").trim();
    if (!normalizedTopic) {
      return [];
    }
    const conditions = ["topic = ?"];
    const params: unknown[] = [normalizedTopic];
    if (options.agentId === null) {
      conditions.push("agent_id IS NULL");
    } else if (typeof options.agentId === "string" && options.agentId.trim()) {
      conditions.push("agent_id = ?");
      params.push(options.agentId.trim());
    }
    if (options.scope === "shared") {
      conditions.push("visibility = 'shared'");
    } else if (options.scope === "private") {
      conditions.push("visibility <> 'shared'");
    }
    const maxPerTopic = typeof options.maxPerTopic === "number" && Number.isFinite(options.maxPerTopic)
      ? Math.max(1, Math.floor(options.maxPerTopic))
      : 20;
    const stmt = this.db.prepare(`
      SELECT id, source_path, source_type, memory_type, visibility, start_line, end_line,
             content, metadata, channel, topic, ts_date, summary, category, updated_at
      FROM chunks
      WHERE ${conditions.join(" AND ")}
      ORDER BY updated_at DESC, rowid DESC
      LIMIT ?
    `);
    const rows = stmt.all(...params, maxPerTopic) as any[];
    return rows.map((row) => rowToSearchResult(row, 0));
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  getDbPath(): string {
    this.ensureOpen();
    const row = this.db.prepare(`PRAGMA database_list`).all() as Array<{ file?: string | null }>;
    const main = row.find((item) => item.file);
    return String(main?.file ?? "");
  }

  /**
   * 暴露底层 better-sqlite3 db 句柄供同进程治理模块共享 schema 和事务。
   *
   * 使用约束：
   * - 调用方只能用于安装自有 schema（CREATE TABLE IF NOT EXISTS ...）和执行自有 CRUD
   * - 调用方不得关闭该句柄（close 仍由 MemoryStore 管理）
   * - 调用方不得修改 MemoryStore 管理的表（chunks / tasks / experience_* / memory_tree_* / profile_state_*）
   * - 仅限同进程使用，不跨进程传递
   *
   * 当前消费者：WorkflowJournal（动态工作流事件溯源）。
   */
  getDbHandleForSharedSchema(): Database.Database {
    this.ensureOpen();
    return this.db;
  }

  // ========== Phase M-1: 元数据过滤 ==========

  /**
   * 存量数据回填：从 source_path / metadata 推断 channel / ts_date。
   * 仅对 ts_date IS NULL 的行执行，幂等安全。
   */
  private backfillMetadataColumns(): void {
    // 回填 ts_date：从 source_path 中提取日期（memory/YYYY-MM-DD.md）或从 metadata.file_mtime 推断
    const rows = this.db.prepare(
      `SELECT rowid, source_path, metadata FROM chunks WHERE ts_date IS NULL`
    ).all() as Array<{ rowid: number; source_path: string; metadata: string | null }>;

    if (rows.length === 0) return;

    const update = this.db.prepare(
      `UPDATE chunks SET channel = ?, ts_date = ? WHERE rowid = ?`
    );

    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const channel = inferChannel(row.source_path);
        const tsDate = inferTsDate(row.source_path, row.metadata);
        update.run(channel, tsDate, row.rowid);
      }
    });
    tx();

    if (rows.length > 0) {
      console.log(`[MemoryStore] Backfilled metadata columns for ${rows.length} chunks`);
    }
  }

  /**
   * 构建 filter 的 WHERE 子句片段和参数。
   * 返回 { clause: "AND ...", params: [...] }，clause 为空字符串表示无过滤。
   */
  private buildFilterClause(filter?: MemorySearchFilter): { clause: string; params: unknown[] } {
    if (!filter) return { clause: "", params: [] };

    const conditions: string[] = [];
    const params: unknown[] = [];

    // memory_type（支持单值或数组）
    if (filter.memoryType) {
      if (Array.isArray(filter.memoryType)) {
        if (filter.memoryType.length > 0) {
          const placeholders = filter.memoryType.map(() => "?").join(", ");
          conditions.push(`c.memory_type IN (${placeholders})`);
          params.push(...filter.memoryType);
        }
      } else {
        conditions.push(`c.memory_type = ?`);
        params.push(filter.memoryType);
      }
    }

    if (filter.channel) {
      conditions.push(`c.channel = ?`);
      params.push(filter.channel);
    }

    if (filter.topic) {
      conditions.push(`c.topic = ?`);
      params.push(filter.topic);
    }

    if (filter.dateFrom) {
      conditions.push(`c.ts_date >= ?`);
      params.push(filter.dateFrom);
    }

    if (filter.dateTo) {
      conditions.push(`c.ts_date <= ?`);
      params.push(filter.dateTo);
    }

    // P4-2: uncategorized 显式过滤（优先级高于 category）
    if (filter.uncategorized) {
      const known = KNOWN_MEMORY_CATEGORIES.map((item) => `'${item}'`).join(", ");
      conditions.push(`(c.category IS NULL OR TRIM(c.category) = '' OR c.category NOT IN (${known}))`);
    } else if (filter.category) {
      // P1-6: category 过滤（支持单值或数组）
      if (Array.isArray(filter.category)) {
        if (filter.category.length > 0) {
          const placeholders = filter.category.map(() => "?").join(", ");
          conditions.push(`c.category IN (${placeholders})`);
          params.push(...filter.category);
        }
      } else {
        conditions.push(`c.category = ?`);
        params.push(filter.category);
      }
    }

    if (filter.sharedPromotionStatus) {
      const statuses = normalizeSharedPromotionStatusFilter(filter.sharedPromotionStatus);
      if (statuses.length === 1 && statuses[0] === "none") {
        conditions.push(`(
          json_extract(c.metadata, '$.sharedPromotion.status') IS NULL
          OR TRIM(COALESCE(json_extract(c.metadata, '$.sharedPromotion.status'), '')) = ''
        )`);
      } else if (statuses.length > 0) {
        const includesNone = statuses.includes("none");
        const concreteStatuses = statuses
          .filter((item): item is Exclude<MemorySharedPromotionStatus, "none"> => item !== "none")
          .flatMap((item) => item === "approved" ? ["approved", "active"] : [item]);
        const uniqueStatuses = [...new Set(concreteStatuses)];
        const statusConditions: string[] = [];
        if (uniqueStatuses.length > 0) {
          const placeholders = uniqueStatuses.map(() => "?").join(", ");
          statusConditions.push(`LOWER(COALESCE(json_extract(c.metadata, '$.sharedPromotion.status'), '')) IN (${placeholders})`);
          params.push(...uniqueStatuses);
        }
        if (includesNone) {
          statusConditions.push(`(
            json_extract(c.metadata, '$.sharedPromotion.status') IS NULL
            OR TRIM(COALESCE(json_extract(c.metadata, '$.sharedPromotion.status'), '')) = ''
          )`);
        }
        if (statusConditions.length > 0) {
          conditions.push(`(${statusConditions.join(" OR ")})`);
        }
      }
    }

    if (typeof filter.sharedPromotionClaimed === "boolean") {
      if (filter.sharedPromotionClaimed) {
        conditions.push(`TRIM(COALESCE(json_extract(c.metadata, '$.sharedPromotion.claimedByAgentId'), '')) <> ''`);
      } else {
        conditions.push(`(
          json_extract(c.metadata, '$.sharedPromotion.claimedByAgentId') IS NULL
          OR TRIM(COALESCE(json_extract(c.metadata, '$.sharedPromotion.claimedByAgentId'), '')) = ''
        )`);
      }
    }

    // P3-2: scope 检索
    // - 不传 scope：保持历史 agentId 过滤行为不变
    // - scope=private：只查私有层（当前 Agent 私有 + 系统级私有）
    // - scope=shared：查共享层 + 系统级记忆
    // - scope=all：查当前 Agent 私有 + 共享层 + 系统级记忆
    if (filter.scope === "private") {
      conditions.push(`c.visibility = 'private'`);
      if (filter.agentId !== undefined) {
        if (filter.agentId === null) {
          conditions.push(`c.agent_id IS NULL`);
        } else {
          conditions.push(`(c.agent_id IS NULL OR c.agent_id = ?)`);
          params.push(filter.agentId);
        }
      }
    } else if (filter.scope === "shared") {
      conditions.push(`(c.agent_id IS NULL OR c.visibility = 'shared')`);
    } else if (filter.scope === "all") {
      if (filter.agentId === undefined) {
        // 无 agent 上下文时，all 等价于历史“查全部”
      } else if (filter.agentId === null) {
        conditions.push(`(c.agent_id IS NULL OR c.visibility = 'shared')`);
      } else {
        conditions.push(`(c.agent_id IS NULL OR c.agent_id = ? OR c.visibility = 'shared')`);
        params.push(filter.agentId);
      }
    } else {
      // Scope 隔离：agentId 过滤
      // - agentId 为 string：默认查「全局 + 该 Agent」记忆（避免子 Agent 因历史数据无 agent_id 而“失忆”）
      // - agentId 为 null：只查全局记忆（agent_id IS NULL）
      // - agentId 为 undefined：不过滤（查询所有）
      if (filter.agentId !== undefined) {
        if (filter.agentId === null) {
          conditions.push(`c.agent_id IS NULL`);
        } else {
          conditions.push(`(c.agent_id IS NULL OR c.agent_id = ?)`);
          params.push(filter.agentId);
        }
      }
    }

    const clause = conditions.length > 0 ? " AND " + conditions.join(" AND ") : "";
    return { clause, params };
  }

  private buildMemorySourceFilterClause(filter?: MemoryTreeSourceListFilter): { clause: string; params: unknown[] } {
    if (!filter) return { clause: "", params: [] };

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (Array.isArray(filter.ids) && filter.ids.length > 0) {
      const placeholders = filter.ids.map(() => "?").join(", ");
      conditions.push(`id IN (${placeholders})`);
      params.push(...filter.ids);
    }

    if (filter.sourceKind) {
      if (Array.isArray(filter.sourceKind) && filter.sourceKind.length > 0) {
        const placeholders = filter.sourceKind.map(() => "?").join(", ");
        conditions.push(`source_kind IN (${placeholders})`);
        params.push(...filter.sourceKind);
      } else if (typeof filter.sourceKind === "string") {
        conditions.push(`source_kind = ?`);
        params.push(filter.sourceKind);
      }
    }

    if (filter.sourceClass) {
      if (Array.isArray(filter.sourceClass) && filter.sourceClass.length > 0) {
        const placeholders = filter.sourceClass.map(() => "?").join(", ");
        conditions.push(`source_class IN (${placeholders})`);
        params.push(...filter.sourceClass);
      } else if (typeof filter.sourceClass === "string") {
        conditions.push(`source_class = ?`);
        params.push(filter.sourceClass);
      }
    }

    if (filter.scope) {
      if (Array.isArray(filter.scope) && filter.scope.length > 0) {
        const placeholders = filter.scope.map(() => "?").join(", ");
        conditions.push(`scope IN (${placeholders})`);
        params.push(...filter.scope);
      } else if (typeof filter.scope === "string") {
        conditions.push(`scope = ?`);
        params.push(filter.scope);
      }
    }

    if (filter.agentId === null) {
      conditions.push(`agent_id IS NULL`);
    } else if (typeof filter.agentId === "string" && filter.agentId.trim()) {
      conditions.push(`agent_id = ?`);
      params.push(filter.agentId.trim());
    }

    if (filter.sourcePath) {
      conditions.push(`source_path = ?`);
      params.push(filter.sourcePath);
    }

    if (filter.sourceRef) {
      conditions.push(`source_ref = ?`);
      params.push(filter.sourceRef);
    }

    return {
      clause: conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : "",
      params,
    };
  }

  private buildMemoryScoreFilterClause(filter?: MemoryTreeScoreListFilter): { clause: string; params: unknown[] } {
    if (!filter) return { clause: "", params: [] };

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.targetType) {
      if (Array.isArray(filter.targetType) && filter.targetType.length > 0) {
        const placeholders = filter.targetType.map(() => "?").join(", ");
        conditions.push(`target_type IN (${placeholders})`);
        params.push(...filter.targetType);
      } else if (typeof filter.targetType === "string") {
        conditions.push(`target_type = ?`);
        params.push(filter.targetType);
      }
    }

    if (filter.targetId) {
      conditions.push(`target_id = ?`);
      params.push(filter.targetId);
    }

    if (filter.sourceId) {
      conditions.push(`source_id = ?`);
      params.push(filter.sourceId);
    }

    if (filter.scoreVersion) {
      if (Array.isArray(filter.scoreVersion) && filter.scoreVersion.length > 0) {
        const placeholders = filter.scoreVersion.map(() => "?").join(", ");
        conditions.push(`score_version IN (${placeholders})`);
        params.push(...filter.scoreVersion);
      } else if (typeof filter.scoreVersion === "string") {
        conditions.push(`score_version = ?`);
        params.push(filter.scoreVersion);
      }
    }

    return {
      clause: conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : "",
      params,
    };
  }

  private buildMemoryReportFilterClause(filter?: MemoryTreeReportListFilter): { clause: string; params: unknown[] } {
    if (!filter) return { clause: "", params: [] };

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (Array.isArray(filter.ids) && filter.ids.length > 0) {
      const placeholders = filter.ids.map(() => "?").join(", ");
      conditions.push(`id IN (${placeholders})`);
      params.push(...filter.ids);
    }

    if (filter.reportType) {
      if (Array.isArray(filter.reportType) && filter.reportType.length > 0) {
        const placeholders = filter.reportType.map(() => "?").join(", ");
        conditions.push(`report_type IN (${placeholders})`);
        params.push(...filter.reportType);
      } else if (typeof filter.reportType === "string") {
        conditions.push(`report_type = ?`);
        params.push(filter.reportType);
      }
    }

    if (filter.scope) {
      if (Array.isArray(filter.scope) && filter.scope.length > 0) {
        const placeholders = filter.scope.map(() => "?").join(", ");
        conditions.push(`scope IN (${placeholders})`);
        params.push(...filter.scope);
      } else if (typeof filter.scope === "string") {
        conditions.push(`scope = ?`);
        params.push(filter.scope);
      }
    }

    if (filter.agentId === null) {
      conditions.push(`agent_id IS NULL`);
    } else if (typeof filter.agentId === "string" && filter.agentId.trim()) {
      conditions.push(`agent_id = ?`);
      params.push(filter.agentId.trim());
    }

    if (filter.status) {
      if (Array.isArray(filter.status) && filter.status.length > 0) {
        const placeholders = filter.status.map(() => "?").join(", ");
        conditions.push(`status IN (${placeholders})`);
        params.push(...filter.status);
      } else if (typeof filter.status === "string") {
        conditions.push(`status = ?`);
        params.push(filter.status);
      }
    }

    return {
      clause: conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : "",
      params,
    };
  }

  private buildMemoryNodeFilterClause(filter?: MemoryTreeNodeListFilter): { clause: string; params: unknown[] } {
    if (!filter) return { clause: "", params: [] };

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (Array.isArray(filter.ids) && filter.ids.length > 0) {
      const placeholders = filter.ids.map(() => "?").join(", ");
      conditions.push(`id IN (${placeholders})`);
      params.push(...filter.ids);
    }

    if (filter.level !== undefined) {
      if (Array.isArray(filter.level) && filter.level.length > 0) {
        const placeholders = filter.level.map(() => "?").join(", ");
        conditions.push(`level IN (${placeholders})`);
        params.push(...filter.level.map((item) => Math.max(1, Math.floor(item))));
      } else if (typeof filter.level === "number") {
        conditions.push(`level = ?`);
        params.push(Math.max(1, Math.floor(filter.level)));
      }
    }

    if (filter.kind) {
      if (Array.isArray(filter.kind) && filter.kind.length > 0) {
        const placeholders = filter.kind.map(() => "?").join(", ");
        conditions.push(`kind IN (${placeholders})`);
        params.push(...filter.kind);
      } else if (typeof filter.kind === "string") {
        conditions.push(`kind = ?`);
        params.push(filter.kind);
      }
    }

    if (filter.scope) {
      if (Array.isArray(filter.scope) && filter.scope.length > 0) {
        const placeholders = filter.scope.map(() => "?").join(", ");
        conditions.push(`scope IN (${placeholders})`);
        params.push(...filter.scope);
      } else if (typeof filter.scope === "string") {
        conditions.push(`scope = ?`);
        params.push(filter.scope);
      }
    }

    if (filter.agentId === null) {
      conditions.push(`agent_id IS NULL`);
    } else if (typeof filter.agentId === "string" && filter.agentId.trim()) {
      conditions.push(`agent_id = ?`);
      params.push(filter.agentId.trim());
    }

    if (filter.topicKey) {
      conditions.push(`topic_key = ?`);
      params.push(filter.topicKey);
    }

    return {
      clause: conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : "",
      params,
    };
  }

  private buildMemoryEdgeFilterClause(filter?: MemoryTreeEdgeListFilter): { clause: string; params: unknown[] } {
    if (!filter) return { clause: "", params: [] };

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.parentNodeId) {
      conditions.push(`parent_node_id = ?`);
      params.push(filter.parentNodeId);
    }

    if (filter.childType) {
      if (Array.isArray(filter.childType) && filter.childType.length > 0) {
        const placeholders = filter.childType.map(() => "?").join(", ");
        conditions.push(`child_type IN (${placeholders})`);
        params.push(...filter.childType);
      } else if (typeof filter.childType === "string") {
        conditions.push(`child_type = ?`);
        params.push(filter.childType);
      }
    }

    if (filter.childId) {
      conditions.push(`child_id = ?`);
      params.push(filter.childId);
    }

    if (filter.relation) {
      if (Array.isArray(filter.relation) && filter.relation.length > 0) {
        const placeholders = filter.relation.map(() => "?").join(", ");
        conditions.push(`relation IN (${placeholders})`);
        params.push(...filter.relation);
      } else if (typeof filter.relation === "string") {
        conditions.push(`relation = ?`);
        params.push(filter.relation);
      }
    }

    return {
      clause: conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : "",
      params,
    };
  }

  private buildTaskFilterClause(filter?: TaskSearchFilter): { clause: string; params: unknown[] } {
    if (!filter) return { clause: "", params: [] };

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.agentId) {
      conditions.push(`t.agent_id = ?`);
      params.push(filter.agentId);
    }

    if (filter.status) {
      if (Array.isArray(filter.status) && filter.status.length > 0) {
        const placeholders = filter.status.map(() => "?").join(", ");
        conditions.push(`t.status IN (${placeholders})`);
        params.push(...filter.status);
      } else if (typeof filter.status === "string") {
        conditions.push(`t.status = ?`);
        params.push(filter.status);
      }
    }

    if (filter.source) {
      if (Array.isArray(filter.source) && filter.source.length > 0) {
        const placeholders = filter.source.map(() => "?").join(", ");
        conditions.push(`t.source IN (${placeholders})`);
        params.push(...filter.source);
      } else if (typeof filter.source === "string") {
        conditions.push(`t.source = ?`);
        params.push(filter.source);
      }
    }

    if (filter.dateFrom) {
      conditions.push(`COALESCE(t.finished_at, t.started_at) >= ?`);
      params.push(filter.dateFrom);
    }

    if (filter.dateTo) {
      conditions.push(`COALESCE(t.finished_at, t.started_at) <= ?`);
      params.push(filter.dateTo);
    }

    if (filter.parentConversationId) {
      conditions.push(`t.parent_conversation_id = ?`);
      params.push(filter.parentConversationId);
    }

    if (filter.goalId) {
      conditions.push(`json_extract(t.metadata, '$.goalId') = ?`);
      params.push(filter.goalId);
    }

    return {
      clause: conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : "",
      params,
    };
  }

  private buildExperienceCandidateFilterClause(filter?: ExperienceCandidateListFilter): { clause: string; params: unknown[] } {
    if (!filter) return { clause: "", params: [] };

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.taskId) {
      conditions.push(`c.task_id = ?`);
      params.push(filter.taskId);
    }

    if (filter.type) {
      if (Array.isArray(filter.type) && filter.type.length > 0) {
        const placeholders = filter.type.map(() => "?").join(", ");
        conditions.push(`c.type IN (${placeholders})`);
        params.push(...filter.type);
      } else if (typeof filter.type === "string") {
        conditions.push(`c.type = ?`);
        params.push(filter.type);
      }
    }

    if (filter.status) {
      if (Array.isArray(filter.status) && filter.status.length > 0) {
        const placeholders = filter.status.map(() => "?").join(", ");
        conditions.push(`c.status IN (${placeholders})`);
        params.push(...filter.status);
      } else if (typeof filter.status === "string") {
        conditions.push(`c.status = ?`);
        params.push(filter.status);
      }
    }

    if (filter.agentId) {
      conditions.push(`t.agent_id = ?`);
      params.push(filter.agentId);
    }

    if (typeof filter.synthesisConsumed === "boolean") {
      if (filter.synthesisConsumed) {
        conditions.push(`COALESCE(json_extract(c.metadata_json, '$.synthesisConsumed.consumed'), 0) = 1`);
      } else {
        conditions.push(`COALESCE(json_extract(c.metadata_json, '$.synthesisConsumed.consumed'), 0) <> 1`);
      }
    }

    if (filter.consumedByCandidateId) {
      conditions.push(`COALESCE(json_extract(c.metadata_json, '$.synthesisConsumed.consumedByCandidateId'), '') = ?`);
      params.push(filter.consumedByCandidateId);
    }

    if (filter.draftOriginKind) {
      if (Array.isArray(filter.draftOriginKind) && filter.draftOriginKind.length > 0) {
        const placeholders = filter.draftOriginKind.map(() => "?").join(", ");
        conditions.push(`COALESCE(json_extract(c.metadata_json, '$.draftOrigin.kind'), '') IN (${placeholders})`);
        params.push(...filter.draftOriginKind);
      } else if (typeof filter.draftOriginKind === "string") {
        conditions.push(`COALESCE(json_extract(c.metadata_json, '$.draftOrigin.kind'), '') = ?`);
        params.push(filter.draftOriginKind);
      }
    }

    return {
      clause: conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : "",
      params,
    };
  }

  private buildExperienceUsageFilterClause(filter?: ExperienceUsageListFilter): { clause: string; params: unknown[] } {
    if (!filter) return { clause: "", params: [] };

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.taskId) {
      conditions.push(`task_id = ?`);
      params.push(filter.taskId);
    }

    if (filter.assetType) {
      if (Array.isArray(filter.assetType) && filter.assetType.length > 0) {
        const placeholders = filter.assetType.map(() => "?").join(", ");
        conditions.push(`asset_type IN (${placeholders})`);
        params.push(...filter.assetType);
      } else if (typeof filter.assetType === "string") {
        conditions.push(`asset_type = ?`);
        params.push(filter.assetType);
      }
    }

    if (filter.assetKey) {
      conditions.push(`asset_key = ?`);
      params.push(filter.assetKey);
    }

    if (filter.sourceCandidateId) {
      conditions.push(`source_candidate_id = ?`);
      params.push(filter.sourceCandidateId);
    }

    return {
      clause: conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : "",
      params,
    };
  }

  private buildExperienceUsageStatsFilterClause(filter?: Pick<ExperienceUsageListFilter, "assetType" | "assetKey" | "sourceCandidateId">): { clause: string; params: unknown[] } {
    if (!filter) return { clause: "", params: [] };
    return this.buildExperienceUsageFilterClause({
      assetType: filter.assetType,
      assetKey: filter.assetKey,
      sourceCandidateId: filter.sourceCandidateId,
    });
  }

  /**
   * 初始化/准备向量表
   */
  prepareVectorStore(dimensions: number): void {
    this.ensureOpen();
    this.ensureVectorTable(dimensions);
  }

  /** 返回已存在 vec0 表的维度，供未知 Provider 避免额外 probe 请求。 */
  getVectorDimensions(): number | null {
    this.ensureOpen();
    return this.vecDims;
  }

  /**
   * 首次没有 vec0 表时，从真实待索引内容获取一批候选，供 Provider 响应推导维度。
   */
  getInitialEmbeddingCandidates(limit = 10): MemoryChunk[] {
    this.ensureOpen();
    const rows = this.db.prepare(`
      SELECT c.*
      FROM chunks c
      ORDER BY c.rowid
      LIMIT ?
    `).all(limit) as any[];
    return this.mapMemoryChunkRows(rows);
  }

  /**
   * 获取未向量化的 chunks
   */
  getUnembeddedChunks(limit = 10): MemoryChunk[] {
    this.ensureOpen();
    if (!this.vecDims) return []; // Vector table not ready

    // Find chunks that exist in 'chunks' but not in 'chunks_vec'
    // NOTE: vec0 table uses rowid matching usually.
    // We strictly use JOIN on rowid.
    const stmt = this.db.prepare(`
        SELECT c.*
        FROM chunks c
        LEFT JOIN chunks_vec v ON c.rowid = v.rowid
        WHERE v.rowid IS NULL
        ORDER BY c.rowid
        LIMIT ?
    `);

    const rows = stmt.all(limit) as any[];
    return this.mapMemoryChunkRows(rows);
  }

  /**
   * 向 embedding 同步提供带稳定 rowid 游标的待处理页；具体 SQL 保持在相邻模块中，避免扩大 Store。
   */
  getPendingEmbeddingCandidatePage(limit = 10, afterRowId = 0): PendingEmbeddingCandidate[] {
    this.ensureOpen();
    return listPendingEmbeddingCandidates(this.db, {
      limit,
      afterRowId,
      vectorStoreReady: this.vecDims !== null,
    });
  }

  private mapMemoryChunkRows(rows: any[]): MemoryChunk[] {
    return rows.map(row => ({
      id: row.id,
      sourcePath: row.source_path,
      sourceType: row.source_type,
      memoryType: row.memory_type as MemoryType,
      visibility: (row.visibility ?? "private") as MemoryVisibility,
      startLine: row.start_line,
      endLine: row.end_line,
      content: row.content,
      channel: row.channel ?? undefined,
      topic: row.topic ?? undefined,
      tsDate: row.ts_date ?? undefined,
      metadata: safeParseJson(row.metadata),
    }));
  }

  // ========== 向量存储方法 ==========

  private ensureVectorTable(dimensions: number): void {
    if (this.vecDims === dimensions) return;

    // 检查表是否存在
    const row = this.db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks_vec'`
    ).get() as { sql: string | null } | undefined;

    if (!row?.sql) {
      this.db.exec(`
        CREATE VIRTUAL TABLE chunks_vec USING vec0(
          embedding float[${dimensions}]
        )
      `);
      this.vecDims = dimensions;
      return;
    }

    // vec0 虚拟表的维度是写死在创建 SQL 里的；如果变更 embedding 维度，必须重建。
    const existingDims = parseVec0DimsFromSql(row.sql);
    if (existingDims && existingDims !== dimensions) {
      console.warn(
        `[MemoryStore] chunks_vec dimensions mismatch (existing=${existingDims}, new=${dimensions}), rebuilding vector table...`
      );
      try {
        this.db.exec(`DROP TABLE IF EXISTS chunks_vec`);
      } catch {
        // ignore
      }
      this.db.exec(`
        CREATE VIRTUAL TABLE chunks_vec USING vec0(
          embedding float[${dimensions}]
        )
      `);
      this.vecDims = dimensions;
      return;
    }

    // 维度一致（或解析失败）：沿用现有表
    this.vecDims = dimensions;
  }

  /**
   * 存储 chunk 的 embedding 向量
   */
  upsertChunkVector(chunkId: string, embedding: EmbeddingVector, model: string): void {
    this.ensureOpen();
    const dimensions = embedding.length;
    this.ensureVectorTable(dimensions);

    // 获取 chunk 的 rowid
    const chunkRow = this.db.prepare(`SELECT rowid FROM chunks WHERE id = ?`).get(chunkId) as { rowid: number } | undefined;
    if (!chunkRow) {
      // 可能 chunk 还没插入？或者已被删除。
      // 一般来说调用方应该先 upsertChunk。
      return;
    }

    const blob = vectorToBuffer(embedding);

    // vec0 虚拟表严格要求 rowid 为 SQLITE_INTEGER，用 BigInt 在绑定层保证类型
    const rowid = BigInt(chunkRow.rowid);
    this.db.prepare(`DELETE FROM chunks_vec WHERE rowid = ?`).run(rowid);
    this.db.prepare(`INSERT INTO chunks_vec(rowid, embedding) VALUES (?, ?)`).run(rowid, blob);
  }

  /**
   * 获取 chunk 的 embedding 向量
   */
  getChunkVector(chunkId: string): EmbeddingVector | null {
    this.ensureOpen();
    if (!this.vecDims) return null;

    const chunkRow = this.db.prepare(`SELECT rowid FROM chunks WHERE id = ?`).get(chunkId) as { rowid: number } | undefined;
    if (!chunkRow) return null;

    try {
      const stmt = this.db.prepare(`SELECT embedding FROM chunks_vec WHERE rowid = ?`);
      const row = stmt.get(BigInt(chunkRow.rowid)) as { embedding: Buffer } | undefined;
      if (!row) return null;
      return vectorFromBuffer(row.embedding);
    } catch {
      return null;
    }
  }

  /**
   * 以结构化参数批量读取 vec0 向量，供 reranker 避免按候选重复 rowid/vec 查询。
   */
  getChunkVectors(chunkIds: string[]): Map<string, EmbeddingVector | null> {
    this.ensureOpen();
    return readChunkVectorsBatch(this.db, this.vecDims !== null, chunkIds);
  }

  /**
   * 在同一 transaction 中写入多条 vec0 和对应 embedding cache，返回实际写入的 chunk id。
   */
  upsertChunkVectorsBatch(writes: ChunkVectorWrite[], model: string): string[] {
    this.ensureOpen();
    const dimensions = resolveChunkVectorBatchDimensions(writes);
    if (dimensions === null) {
      return [];
    }
    this.ensureVectorTable(dimensions);
    return writeChunkVectorsBatch(this.db, writes, model);
  }

  /**
   * 缓存 embedding（按内容 hash）
   */
  cacheEmbedding(contentHash: string, embedding: EmbeddingVector, model: string): void {
    this.ensureOpen();
    const now = new Date().toISOString();
    const blob = vectorToBuffer(embedding);
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO embedding_cache (content_hash, embedding, dimensions, model, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(contentHash, blob, embedding.length, model, now);
  }

  /**
   * 从缓存获取 embedding
   */
  getCachedEmbedding(contentHash: string): EmbeddingVector | null {
    this.ensureOpen();
    const stmt = this.db.prepare(`SELECT embedding FROM embedding_cache WHERE content_hash = ?`);
    const row = stmt.get(contentHash) as { embedding: Buffer } | undefined;
    if (!row) return null;
    return vectorFromBuffer(row.embedding);
  }

  /** 只返回 cache 治理所需的匿名聚合；原始时间仅供领域 Doctor 转换为年龄。 */
  getEmbeddingCacheStatus(): EmbeddingCacheStatus {
    this.ensureOpen();
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS entry_count,
        COALESCE(SUM(length(embedding)), 0) AS total_bytes,
        MIN(created_at) AS oldest_created_at
      FROM embedding_cache
    `).get() as {
      entry_count: number;
      total_bytes: number;
      oldest_created_at: string | null;
    };
    return {
      entryCount: row.entry_count,
      totalBytes: row.total_bytes,
      ...(row.oldest_created_at ? { oldestCreatedAt: row.oldest_created_at } : {}),
    };
  }

  /**
   * 清理可重建的 passage embedding cache。读取不更新 created_at，故按最近写入顺序保留，
   * 不将其表述为读取 LRU；chunks_vec 中已经索引的向量不受影响。
   */
  pruneEmbeddingCache(policy: EmbeddingCacheRetentionPolicy): EmbeddingCachePruneResult {
    this.ensureOpen();
    const retention = normalizeEmbeddingCacheRetentionPolicy(policy);
    const cutoff = new Date(retention.nowMs - retention.maxAgeMs).toISOString();
    const expired = this.db.prepare(`
      DELETE FROM embedding_cache
      WHERE created_at < ?
    `).run(cutoff).changes;
    const overflow = this.db.prepare(`
      WITH ranked AS (
        SELECT
          content_hash,
          ROW_NUMBER() OVER (ORDER BY created_at DESC, content_hash DESC) AS recency_rank,
          SUM(length(embedding)) OVER (
            ORDER BY created_at DESC, content_hash DESC
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS retained_bytes
        FROM embedding_cache
      )
      DELETE FROM embedding_cache
      WHERE content_hash IN (
        SELECT content_hash
        FROM ranked
        WHERE recency_rank > ? OR retained_bytes > ?
      )
    `).run(retention.maxEntries, retention.maxBytes).changes;
    const remaining = this.db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(length(embedding)), 0) AS bytes
      FROM embedding_cache
    `).get() as { count: number; bytes: number };

    return {
      expired,
      overflow,
      remaining: remaining.count,
      remainingBytes: remaining.bytes,
    };
  }

  /**
   * 向量搜索：返回与查询向量最相似的 chunks
   * filter 通过 post-filter 实现（chunks_vec 无 metadata 列）
   */
  searchVector(queryVec: EmbeddingVector, limit = 10, filter?: MemorySearchFilter, includeContent = true): MemorySearchResult[] {
    this.ensureOpen();
    // vec0 rejects a mismatched query vector. During a provider dimension migration the
    // memory manager may receive a new query before its derived vector table is rebuilt.
    if (!this.vecDims || queryVec.length !== this.vecDims) return [];

    const blob = vectorToBuffer(queryVec);
    const { clause: filterClause, params: filterParams } = this.buildFilterClause(filter);
    const hasFilter = filterClause.length > 0;

    // 有 filter 时多取一些，post-filter 后再截断
    const fetchLimit = hasFilter ? limit * 5 : limit;

    // sqlite-vec KNN search
    const stmt = this.db.prepare(`
        SELECT
            c.id, c.source_path, c.source_type, c.memory_type, c.visibility, c.start_line, c.end_line,
            ${includeContent ? "c.content" : "NULL AS content"}, substr(c.content, 1, 500) AS snippet_text,
            c.metadata, c.channel, c.topic, c.ts_date, c.summary, c.category,
            v.distance
        FROM chunks_vec v
        JOIN chunks c ON c.rowid = v.rowid
        WHERE v.embedding MATCH ? AND k = ?${filterClause}
        ORDER BY v.distance
    `);

    const rows = stmt.all(blob, fetchLimit, ...filterParams) as Array<{
      id: string;
      source_path: string;
      source_type: string;
      memory_type: string;
      visibility: string;
      start_line: number | null;
      end_line: number | null;
      content: string;
      metadata: string | null;
      channel: string | null;
      topic: string | null;
      ts_date: string | null;
      summary: string | null;
      category: string | null;
      distance: number;
    }>;

    return rows.slice(0, limit).map((row) => ({
      ...rowToSearchResult(row, 1 / (1 + row.distance)),
    }));
  }

  /**
   * 混合搜索：结合关键词（BM25）和向量（语义）搜索
   */
  searchHybrid(
    query: string,
    queryVec: EmbeddingVector | null,
    options: {
      limit?: number;
      vectorWeight?: number;
      textWeight?: number;
      filter?: MemorySearchFilter;
      includeContent?: boolean;
      /** deadline 路径可复用已完成的关键词结果，避免正常融合重复执行 FTS。 */
      keywordResults?: MemorySearchResult[];
    } = {}
  ): MemorySearchResult[] {
    const { limit = 10, vectorWeight = 0.7, textWeight = 0.3, filter, includeContent = true } = options;

    // 获取关键词搜索结果
    const keywordResults = options.keywordResults
      ?? this.searchKeyword(query, limit * 2, filter, includeContent);

    // 如果没有向量，只返回关键词结果
    if (!queryVec || queryVec.length === 0) {
      return keywordResults.slice(0, limit);
    }

    // 获取向量搜索结果
    const vectorResults = this.searchVector(queryVec, limit * 2, filter, includeContent);

    // 合并结果（使用 RRF - Reciprocal Rank Fusion）
    const scoreMap = new Map<string, { result: MemorySearchResult; score: number }>();

    // 添加关键词结果的权重
    keywordResults.forEach((result, rank) => {
      const rrf = textWeight / (rank + 60);
      const existing = scoreMap.get(result.id);
      if (existing) {
        existing.score += rrf;
      } else {
        scoreMap.set(result.id, { result, score: rrf });
      }
    });

    // 添加向量结果的权重
    vectorResults.forEach((result, rank) => {
      const rrf = vectorWeight / (rank + 60);
      const existing = scoreMap.get(result.id);
      if (existing) {
        existing.score += rrf;
      } else {
        scoreMap.set(result.id, { result, score: rrf });
      }
    });

    // 按融合分数排序
    const merged = Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // 归一化 RRF 分数到 0-1 范围（保持与纯关键词搜索的分数量级一致）
    const maxScore = merged[0]?.score ?? 1;
    const minScore = merged[merged.length - 1]?.score ?? 0;
    const range = maxScore - minScore || 1;

    return merged.map(({ result, score }) => ({
      ...result,
      // 归一化到 0.3-1.0 范围，避免被 reranker minScore 过滤
      score: 0.3 + 0.7 * (score - minScore) / range,
    }));
  }

  /**
   * 获取向量索引状态
   */
  getVectorStatus(): { indexed: number; cached: number; model?: string } {
    this.ensureOpen();

    let indexed = 0;
    try {
      const row = this.db.prepare(`SELECT COUNT(*) as count FROM chunks_vec`).get() as { count: number };
      indexed = row.count;
    } catch {
      // table might not exist
    }

    const cachedStmt = this.db.prepare(`SELECT COUNT(*) as count FROM embedding_cache`);
    const cachedRow = cachedStmt.get() as { count: number };

    // vec0 doesn't store model name, we might lose this info unless we store it elsewhere.
    // For now return undefined or fix meta.
    return {
      indexed,
      cached: cachedRow.count,
    };
  }

  // ========== Phase M-N2: L0 摘要层 ==========

  /**
   * 获取需要生成摘要的 chunks（summary IS NULL 且内容足够长）
   */
  getChunksNeedingSummary(minContentLength = 500, limit = 20): Array<{ id: string; content: string }> {
    this.ensureOpen();
    const stmt = this.db.prepare(`
      SELECT id, content FROM chunks
      WHERE summary IS NULL AND length(content) > ?
      ORDER BY updated_at DESC
      LIMIT ?
    `);
    return stmt.all(minContentLength, limit) as Array<{ id: string; content: string }>;
  }

  /**
   * 更新 chunk 的摘要
   */
  updateChunkSummary(chunkId: string, summary: string, summaryTokens?: number): void {
    this.ensureOpen();
    const stmt = this.db.prepare(`
      UPDATE chunks SET summary = ?, summary_tokens = ? WHERE id = ?
    `);
    stmt.run(summary, summaryTokens ?? null, chunkId);
  }

  /**
   * 获取摘要统计
   */
  getSummaryStatus(): { total: number; summarized: number; pending: number } {
    this.ensureOpen();
    const total = (this.db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number }).c;
    const summarized = (this.db.prepare(`SELECT COUNT(*) as c FROM chunks WHERE summary IS NOT NULL`).get() as { c: number }).c;
    // pending = content long enough but no summary yet
    const pending = (this.db.prepare(`SELECT COUNT(*) as c FROM chunks WHERE summary IS NULL AND length(content) > 500`).get() as { c: number }).c;
    return { total, summarized, pending };
  }

  // ========== Meta（用于版本/签名标记） ==========

  getMeta(key: string): string | null {
    this.ensureOpen();
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.ensureOpen();
    const stmt = this.db.prepare(`
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    stmt.run(key, value);
  }

  private getNumericMeta(key: string): number {
    const value = this.getMeta(key);
    if (typeof value !== "string") return 0;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }

  private incrementNumericMeta(key: string, by = 1): number {
    const next = Math.max(0, this.getNumericMeta(key) + Math.max(1, Math.floor(by)));
    this.setMeta(key, String(next));
    return next;
  }

  getTaskChangeSeq(): number {
    return this.getNumericMeta(TASK_CHANGE_SEQ_META_KEY);
  }

  getMemoryChangeSeq(): number {
    return this.getNumericMeta(MEMORY_CHANGE_SEQ_META_KEY);
  }

  getSourceAgentId(sourcePath: string): string | null {
    return this.getMeta(sourceAgentMetaKey(sourcePath));
  }

  setSourceAgentId(sourcePath: string, agentId: string): void {
    this.setMeta(sourceAgentMetaKey(sourcePath), agentId);
  }

  getSourceVisibility(sourcePath: string): MemoryVisibility | null {
    return normalizeVisibility(this.getMeta(sourceVisibilityMetaKey(sourcePath)));
  }

  setSourceVisibility(sourcePath: string, visibility: MemoryVisibility): void {
    this.setMeta(sourceVisibilityMetaKey(sourcePath), visibility);
  }

  getChunkVisibility(chunkId: string): MemoryVisibility | null {
    return normalizeVisibility(this.getMeta(chunkVisibilityMetaKey(chunkId)));
  }

  setChunkVisibility(chunkId: string, visibility: MemoryVisibility): void {
    this.setMeta(chunkVisibilityMetaKey(chunkId), visibility);
  }

  // ========== 派生索引清理（自愈重建用） ==========

  clearEmbeddingCache(): void {
    this.ensureOpen();
    try {
      this.db.exec(`DELETE FROM embedding_cache`);
    } catch {
      // ignore
    }
  }

  clearVectorIndex(): void {
    this.ensureOpen();
    try {
      this.db.exec(`DELETE FROM chunks_vec`);
    } catch {
      // table might not exist
    }
  }

  /**
   * 兼容老库：如果 chunks 与 chunks_fts 数量不一致，则执行一次 rebuild。
   * 这能修复"FTS 表后加但未 rebuild 导致的关键词检索失效"以及"部分数据未被索引"的问题。
   */
  private installExperienceDerivedSearchSchema(): { ready: boolean; rebuilt: boolean } {
    const result = installExperienceDerivedSearchSchemaInDb({
      db: this.db,
      getMeta: (key) => this.getMeta(key),
      setMeta: (key, value) => this.setMeta(key, value),
    });
    if (!result.ready) {
      console.warn("[belldandy-memory] Experience derived FTS is unavailable; using bounded title/summary fallback.");
    }
    return result;
  }

  private ensureFtsRebuiltIfNeeded(): void {
    if (!this.hasFts5) return;
    try {
      const chunks = (this.db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number }).c;
      if (chunks <= 0) return;
      const fts = (this.db.prepare(`SELECT COUNT(*) as c FROM chunks_fts`).get() as { c: number }).c;
      // 如果 FTS 索引为空，或者数量差异超过 5%，则触发 rebuild
      const mismatchRatio = chunks > 0 ? Math.abs(chunks - fts) / chunks : 0;
      if (fts > 0 && mismatchRatio < 0.05) return;
      console.warn(`[MemoryStore] chunks_fts mismatch (chunks=${chunks}, fts=${fts}, ratio=${(mismatchRatio * 100).toFixed(1)}%), rebuilding FTS index...`);
      this.db.exec(`INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')`);
    } catch {
      // ignore — rebuild is best-effort
    }
  }

  private ensureTaskFtsRebuiltIfNeeded(): void {
    if (!this.hasFts5) return;
    try {
      const tasks = (this.db.prepare(`SELECT COUNT(*) as c FROM tasks`).get() as { c: number }).c;
      if (tasks <= 0) return;
      const fts = (this.db.prepare(`SELECT COUNT(*) as c FROM tasks_fts`).get() as { c: number }).c;
      const mismatchRatio = tasks > 0 ? Math.abs(tasks - fts) / tasks : 0;
      if (fts > 0 && mismatchRatio < 0.05) return;
      this.db.exec(`INSERT INTO tasks_fts(tasks_fts) VALUES('rebuild')`);
    } catch {
      // ignore — rebuild is best-effort
    }
  }

  /** 从现有 chunks_vec 表读取维度（启动时自动恢复 vecDims） */
  private initVecDimsFromExistingTable(): void {
    try {
      const row = this.db.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks_vec'`
      ).get() as { sql: string | null } | undefined;
      if (row?.sql) {
        const dims = parseVec0DimsFromSql(row.sql);
        if (dims) {
          this.vecDims = dims;
        }
      }
    } catch {
      // ignore — table might not exist
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error("MemoryStore already closed");
    }
  }
}

function readOptionalFileSizeBytes(filePath: string): number {
  if (!filePath) {
    return 0;
  }
  try {
    return Math.max(0, Math.trunc(fs.statSync(filePath).size));
  } catch {
    return 0;
  }
}

function roundVacuumRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * 1000) / 1000;
}

/** 分词（FTS5 与 LIKE 共用） */
function tokenizeForSearch(raw: string): string[] {
  const tokens: string[] = [];

  // 提取英文/数字词（保持完整）
  const englishTokens = raw.match(/[A-Za-z0-9_]+/g) ?? [];
  tokens.push(...englishTokens);

  // 提取中文并按 2-gram 分词（FTS5 unicode61 对中文按字符分词，需要拆分）
  const chineseMatches = raw.match(/[\u4e00-\u9fa5]+/g) ?? [];
  for (const chinese of chineseMatches) {
    if (chinese.length <= 2) {
      tokens.push(chinese);
    } else {
      // 2-gram 分词：取首尾和中间关键词，避免 AND 查询过于严格
      tokens.push(chinese.slice(0, 2)); // 首 2 字
      tokens.push(chinese.slice(-2));   // 尾 2 字
      if (chinese.length > 4) {
        const mid = Math.floor(chinese.length / 2);
        tokens.push(chinese.slice(mid - 1, mid + 1)); // 中间 2 字
      }
    }
  }

  return [...new Set(tokens)].filter(Boolean);
}

/** LIKE 模式中转义 % 和 _（配合 ESCAPE '\\'） */
function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** 构建 FTS5 查询字符串 */
function buildFtsQuery(raw: string): string | null {
  const tokens = tokenizeForSearch(raw);
  if (tokens.length === 0) return null;
  // 使用 OR 连接，让 BM25 根据匹配数量自动排序（匹配越多分数越高）
  return tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

/** BM25 rank 转换为 0-1 分数（rank 越小越好） */
function bm25RankToScore(rank: number): number {
  const normalized = Number.isFinite(rank) ? Math.abs(rank) : 0;
  return Math.min(1, normalized / 10);
}

/** 截断内容 */
function truncateContent(content: string, maxLen: number): string {
  if (content.length <= maxLen) return content;
  return content.slice(0, maxLen) + "...";
}

/**
 * 从 sqlite_master.sql 中解析 vec0 维度。
 * 示例：CREATE VIRTUAL TABLE chunks_vec USING vec0( embedding float[1536] )
 */
function parseVec0DimsFromSql(sql: string): number | null {
  const m = sql.match(/float\[(\d+)\]/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 安全解析 JSON */
function safeParseJson(str: string | null): Record<string, unknown> | undefined {
  if (!str) return undefined;
  try {
    const parsed = JSON.parse(str);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 将 DB row 转为 MemorySearchResult（消除重复映射代码） */
function rowToSearchResult(row: any, score: number): MemorySearchResult {
  const snippet = typeof row.snippet_text === "string"
    ? row.snippet_text
    : truncateContent(row.content ?? "", 500);
  return {
    id: row.id,
    sourcePath: row.source_path,
    sourceType: row.source_type,
    memoryType: row.memory_type as MemoryType,
    topic: optionalString(row.topic),
    category: normalizeCategory(row.category),
    visibility: (row.visibility ?? "private") as MemoryVisibility,
    content: row.content ?? undefined,
    startLine: row.start_line ?? undefined,
    endLine: row.end_line ?? undefined,
    snippet,
    summary: row.summary ?? undefined,
    score,
    metadata: safeParseJson(row.metadata),
    updatedAt: optionalString(row.updated_at),
  };
}

function normalizeCategory(value: unknown): MemoryCategory | undefined {
  switch (value) {
    case "preference":
    case "experience":
    case "fact":
    case "decision":
    case "entity":
    case "other":
      return value;
    default:
      return undefined;
  }
}

function normalizeSharedPromotionStatusFilter(
  value: MemorySharedPromotionStatus | MemorySharedPromotionStatus[],
): MemorySharedPromotionStatus[] {
  const values = Array.isArray(value) ? value : [value];
  const normalized: MemorySharedPromotionStatus[] = [];
  for (const item of values) {
    switch (item) {
      case "pending":
      case "approved":
      case "rejected":
      case "revoked":
      case "active":
      case "none":
        normalized.push(item);
        break;
      default:
        break;
    }
  }
  return normalized;
}

function normalizeVisibility(value: unknown): MemoryVisibility | null {
  switch (value) {
    case "private":
    case "shared":
      return value;
    default:
      return null;
  }
}

function sourceAgentMetaKey(sourcePath: string): string {
  return `source_agent:${sourcePath}`;
}

function sourceVisibilityMetaKey(sourcePath: string): string {
  return `source_visibility:${sourcePath}`;
}

function chunkVisibilityMetaKey(chunkId: string): string {
  return `chunk_visibility:${chunkId}`;
}

function rowToTaskActivityRecord(row: Record<string, unknown>): TaskActivityRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    conversationId: String(row.conversation_id),
    sessionKey: String(row.session_key),
    agentId: optionalString(row.agent_id),
    source: String(row.source) as TaskSource,
    kind: normalizeTaskActivityKind(row.kind),
    state: normalizeTaskActivityState(row.state),
    sequence: optionalNumber(row.sequence) ?? 0,
    happenedAt: String(row.happened_at),
    recordedAt: String(row.recorded_at),
    title: String(row.title),
    summary: optionalString(row.summary),
    toolName: optionalString(row.tool_name),
    actionKey: optionalString(row.action_key),
    command: optionalString(row.command_text),
    files: safeParseStringArray(row.files_json),
    artifactPaths: safeParseStringArray(row.artifact_paths_json),
    memoryChunkIds: safeParseStringArray(row.memory_chunk_ids_json),
    note: optionalString(row.note),
    error: optionalString(row.error),
    metadata: safeParseTaskActivityMetadata(row.metadata_json),
  };
}

function rowToTaskMemoryLink(row: Record<string, unknown>): {
  chunkId: string;
  relation: TaskMemoryRelation;
  sourcePath?: string;
  memoryType?: string;
  visibility?: MemoryVisibility;
  snippet?: string;
} {
  const sourcePath = typeof row.source_path === "string" ? row.source_path : undefined;
  const memoryType = typeof row.memory_type === "string" ? row.memory_type : undefined;
  const visibility = typeof row.visibility === "string" ? row.visibility : undefined;
  const content = typeof row.content === "string" ? row.content : undefined;
  return {
    chunkId: String(row.chunk_id),
    relation: String(row.relation) as TaskMemoryRelation,
    sourcePath,
    memoryType,
    visibility: visibility === "shared" ? "shared" : visibility === "private" ? "private" : undefined,
    snippet: content ? truncateContent(content, 120) : undefined,
  };
}

function rowToTaskRecord(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    sessionKey: String(row.session_key),
    parentConversationId: optionalString(row.parent_conversation_id),
    parentTaskId: optionalString(row.parent_task_id),
    agentId: optionalString(row.agent_id),
    source: String(row.source) as TaskSource,
    title: optionalString(row.title),
    objective: optionalString(row.objective),
    status: String(row.status) as TaskStatus,
    outcome: optionalString(row.outcome),
    summary: optionalString(row.summary),
    reflection: optionalString(row.reflection),
    toolCalls: safeParseToolCalls(row.tool_calls_json),
    artifactPaths: safeParseStringArray(row.artifact_paths_json),
    tokenInput: optionalNumber(row.token_input),
    tokenOutput: optionalNumber(row.token_output),
    tokenTotal: optionalNumber(row.token_total),
    durationMs: optionalNumber(row.duration_ms),
    startedAt: String(row.started_at),
    finishedAt: optionalString(row.finished_at),
    summaryModel: optionalString(row.summary_model),
    summaryVersion: optionalString(row.summary_version),
    workRecap: safeParseTaskWorkRecap(asNullableString(row.work_recap_json)),
    resumeContext: safeParseResumeContext(asNullableString(row.resume_context_json)),
    metadata: safeParseJson(asNullableString(row.metadata)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToTaskSummaryRecord(row: Record<string, unknown>): TaskSummaryRecord {
  const toolCalls = safeParseToolCalls(row.tool_calls_json) ?? [];
  const artifactPaths = safeParseStringArray(row.artifact_paths_json) ?? [];
  return {
    id: String(row.id),
    title: optionalString(row.title),
    objective: optionalString(row.objective),
    summary: optionalString(row.summary),
    status: String(row.status) as TaskStatus,
    source: String(row.source) as TaskSource,
    finishedAt: optionalString(row.finished_at),
    agentId: optionalString(row.agent_id),
    toolNames: toolCalls.map((item) => item.toolName),
    artifactPaths,
    updatedAt: optionalString(row.updated_at),
    workRecap: safeParseTaskWorkRecap(asNullableString(row.work_recap_json)),
    resumeContext: safeParseResumeContext(asNullableString(row.resume_context_json)),
  };
}

function rowToExperienceCandidate(row: Record<string, unknown>): ExperienceCandidate {
  const sourceTaskSnapshot = safeParseExperienceSnapshot(asNullableString(row.source_task_snapshot_json));
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    type: String(row.type) as ExperienceCandidateType,
    status: String(row.status) as ExperienceCandidate["status"],
    title: String(row.title),
    slug: String(row.slug),
    content: String(row.content),
    summary: optionalString(row.summary),
    qualityScore: optionalNumber(row.quality_score),
    sourceTaskSnapshot,
    publishedPath: optionalString(row.published_path),
    createdAt: String(row.created_at),
    reviewedAt: optionalString(row.reviewed_at),
    acceptedAt: optionalString(row.accepted_at),
    rejectedAt: optionalString(row.rejected_at),
    metadata: safeParseExperienceCandidateMetadata(asNullableString(row.metadata_json)),
  };
}

function rowToExperienceUsage(row: Record<string, unknown>): ExperienceUsage {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    assetType: String(row.asset_type) as ExperienceAssetType,
    assetKey: String(row.asset_key),
    sourceCandidateId: optionalString(row.source_candidate_id),
    usedVia: String(row.used_via) as ExperienceUsageVia,
    createdAt: String(row.created_at),
  };
}

function rowToExperienceUsageStats(row: Record<string, unknown>): ExperienceUsageStats {
  return {
    assetType: String(row.asset_type) as ExperienceAssetType,
    assetKey: String(row.asset_key),
    sourceCandidateId: optionalString(row.source_candidate_id),
    sourceCandidateType: optionalString(row.source_candidate_type) as ExperienceCandidateType | undefined,
    sourceCandidateTitle: optionalString(row.source_candidate_title),
    sourceCandidateStatus: optionalString(row.source_candidate_status) as ExperienceCandidateStatus | undefined,
    sourceCandidateTaskId: optionalString(row.source_candidate_task_id),
    sourceCandidatePublishedPath: optionalString(row.source_candidate_published_path),
    usageCount: optionalNumber(row.usage_count) ?? 0,
    lastUsedAt: optionalString(row.last_used_at),
    lastUsedTaskId: optionalString(row.last_used_task_id),
  };
}

function rowToTaskDerivedDetail(
  row: Record<string, unknown>,
  recentActivityRows: Record<string, unknown>[],
): TaskDerivedDetail {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    agentId: optionalString(row.agent_id),
    source: String(row.source) as TaskSource,
    title: optionalString(row.title),
    objective: optionalString(row.objective),
    summary: optionalString(row.summary),
    reflection: optionalString(row.reflection),
    toolCalls: safeParseToolCalls(row.tool_calls_json),
    artifactPaths: safeParseStringArray(row.artifact_paths_json),
    status: String(row.status) as TaskStatus,
    startedAt: String(row.started_at),
    finishedAt: optionalString(row.finished_at),
    updatedAt: String(row.updated_at),
    workRecap: safeParseTaskWorkRecap(asNullableString(row.work_recap_json)),
    resumeContext: safeParseResumeContext(asNullableString(row.resume_context_json)),
    recentActivityTitles: recentActivityRows
      .map((activity) => optionalString(activity.title))
      .filter((title): title is string => Boolean(title)),
  };
}

function toTaskExperienceUsageSummary(
  usage: ExperienceUsage,
  statsRow?: Record<string, unknown>,
): ExperienceUsageSummary {
  const stats = rowToExperienceUsageStats(statsRow ?? {
    asset_type: usage.assetType,
    asset_key: usage.assetKey,
    usage_count: 0,
  });
  return {
    ...stats,
    usageId: usage.id,
    taskId: usage.taskId,
    assetType: usage.assetType,
    assetKey: usage.assetKey,
    sourceCandidateId: usage.sourceCandidateId ?? stats.sourceCandidateId,
    usedVia: usage.usedVia,
    createdAt: usage.createdAt,
  };
}

function rowToMemorySourceRecord(row: Record<string, unknown>): MemoryTreeSourceRecord {
  return {
    id: String(row.id),
    sourceKind: String(row.source_kind),
    sourceClass: String(row.source_class) as MemoryTreeSourceRecord["sourceClass"],
    scope: String(row.scope) as MemoryTreeSourceRecord["scope"],
    agentId: optionalString(row.agent_id),
    sourcePath: optionalString(row.source_path),
    sourceRef: optionalString(row.source_ref),
    contentHash: optionalString(row.content_hash),
    timeFrom: optionalString(row.time_from),
    timeTo: optionalString(row.time_to),
    itemCount: optionalNumber(row.item_count) ?? undefined,
    metadata: safeParseJson(asNullableString(row.metadata_json)),
    createdAt: optionalString(row.created_at),
    updatedAt: optionalString(row.updated_at),
  };
}

function rowToMemoryScoreRecord(row: Record<string, unknown>): MemoryTreeScoreRecord {
  return {
    id: String(row.id),
    targetType: String(row.target_type) as MemoryTreeTargetType,
    targetId: String(row.target_id),
    sourceId: optionalString(row.source_id),
    scoreTotal: optionalNumber(row.score_total) ?? 0,
    recencyScore: optionalNumber(row.recency_score) ?? undefined,
    sourceWeightScore: optionalNumber(row.source_weight_score) ?? undefined,
    interactionScore: optionalNumber(row.interaction_score) ?? undefined,
    taskOutcomeScore: optionalNumber(row.task_outcome_score) ?? undefined,
    entityDensityScore: optionalNumber(row.entity_density_score) ?? undefined,
    llmImportanceScore: optionalNumber(row.llm_importance_score) ?? undefined,
    dedupConfidence: optionalNumber(row.dedup_confidence) ?? undefined,
    scoreVersion: String(row.score_version),
    rationale: safeParseJson(asNullableString(row.rationale_json)),
    createdAt: optionalString(row.created_at),
    updatedAt: optionalString(row.updated_at),
  };
}

function rowToMemoryReportRecord(row: Record<string, unknown>): MemoryTreeReportRecord {
  return {
    id: String(row.id),
    reportType: String(row.report_type) as MemoryTreeReportRecord["reportType"],
    scope: String(row.scope) as MemoryTreeReportRecord["scope"],
    agentId: optionalString(row.agent_id),
    status: String(row.status) as MemoryTreeReportRecord["status"],
    inputVersion: optionalString(row.input_version),
    summary: safeParseJson(asNullableString(row.summary_json)) ?? {},
    details: safeParseJson(asNullableString(row.details_json)) ?? {},
    exportMarkdownPath: optionalString(row.export_markdown_path),
    createdBy: optionalString(row.created_by),
    createdAt: optionalString(row.created_at),
    updatedAt: optionalString(row.updated_at),
  };
}

function rowToMemoryNodeRecord(row: Record<string, unknown>): MemoryTreeNodeRecord {
  return {
    id: String(row.id),
    level: optionalNumber(row.level) ?? 1,
    kind: String(row.kind) as MemoryTreeNodeRecord["kind"],
    scope: String(row.scope) as MemoryTreeNodeRecord["scope"],
    agentId: optionalString(row.agent_id),
    topicKey: optionalString(row.topic_key),
    title: optionalString(row.title),
    summary: String(row.summary ?? ""),
    summaryModel: optionalString(row.summary_model),
    summaryVersion: optionalString(row.summary_version),
    timeFrom: optionalString(row.time_from),
    timeTo: optionalString(row.time_to),
    sourceClassMix: safeParseJson(asNullableString(row.source_class_mix_json)) as Record<string, number> | undefined,
    metadata: safeParseJson(asNullableString(row.metadata_json)),
    createdAt: optionalString(row.created_at),
    updatedAt: optionalString(row.updated_at),
  };
}

function rowToMemoryEdgeRecord(row: Record<string, unknown>): MemoryTreeEdgeRecord {
  return {
    id: String(row.id),
    parentNodeId: String(row.parent_node_id),
    childType: String(row.child_type) as MemoryTreeEdgeRecord["childType"],
    childId: String(row.child_id),
    relation: String(row.relation),
    position: optionalNumber(row.position) ?? undefined,
    weight: optionalNumber(row.weight) ?? undefined,
    metadata: safeParseJson(asNullableString(row.metadata_json)),
    createdAt: optionalString(row.created_at),
  };
}

// ========== Phase M-1: 元数据推断辅助函数 ==========

/** 从 source_path 推断来源渠道 */
function inferChannel(sourcePath: string): string | null {
  const lower = sourcePath.toLowerCase().replace(/\\/g, "/");
  if (lower.includes("/sessions/")) {
    // 会话文件：尝试从路径中推断渠道
    if (lower.includes("feishu") || lower.includes("lark")) return "feishu";
    return "webchat"; // 默认会话来源
  }
  if (lower.includes("heartbeat")) return "heartbeat";
  if (lower.includes("memory.md") || lower.includes("memory/")) return null; // 文件记忆无渠道
  return null;
}

/** 从 source_path 或 metadata 推断日期 */
function inferTsDate(sourcePath: string, metadataStr: string | null): string | null {
  // 优先从文件名提取日期：memory/YYYY-MM-DD.md
  const dateMatch = sourcePath.match(/(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) return dateMatch[1];

  // 从 metadata.file_mtime 推断
  const meta = safeParseJson(metadataStr);
  if (meta?.file_mtime) {
    try {
      return new Date(meta.file_mtime as string).toISOString().slice(0, 10);
    } catch { /* ignore */ }
  }

  return null;
}

function safeParseToolCalls(value: unknown): TaskToolCallSummary[] | undefined {
  const raw = asNullableString(value);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    return parsed
      .filter((item) => item && typeof item === "object" && typeof item.toolName === "string")
      .map((item) => ({
        toolName: String(item.toolName),
        success: Boolean(item.success),
        durationMs: typeof item.durationMs === "number" ? item.durationMs : undefined,
        note: typeof item.note === "string" ? item.note : undefined,
        actionKey: typeof item.actionKey === "string" ? item.actionKey : undefined,
        artifactPaths: Array.isArray(item.artifactPaths)
          ? item.artifactPaths.map((artifactPath: unknown) => String(artifactPath)).filter(Boolean)
          : undefined,
      }));
  } catch {
    return undefined;
  }
}

function safeParseTaskActivityMetadata(value: unknown): TaskActivityRecord["metadata"] {
  const parsed = safeParseJson(asNullableString(value));
  if (!parsed) return undefined;
  return parsed as TaskActivityRecord["metadata"];
}

function safeParseTaskWorkRecap(value: string | null): TaskWorkRecapSnapshot | undefined {
  const parsed = safeParseJson(value) as TaskWorkRecapSnapshot | undefined;
  return parsed && typeof parsed === "object" ? parsed : undefined;
}

function safeParseResumeContext(value: string | null): ResumeContextSnapshot | undefined {
  const parsed = safeParseJson(value) as ResumeContextSnapshot | undefined;
  return parsed && typeof parsed === "object" ? parsed : undefined;
}

function normalizeTaskActivityKind(value: unknown): TaskActivityKind {
  switch (value) {
    case "task_started":
    case "task_switched":
    case "tool_called":
    case "command_executed":
    case "file_changed":
    case "artifact_generated":
    case "memory_recalled":
    case "error_observed":
    case "decision_made":
    case "task_paused":
    case "task_completed":
      return value;
    default:
      return "tool_called";
  }
}

function normalizeTaskActivityState(value: unknown): TaskActivityState {
  switch (value) {
    case "completed":
    case "attempted":
    case "failed":
    case "blocked":
    case "decided":
      return value;
    default:
      return "attempted";
  }
}

function safeParseStringArray(value: unknown): string[] | undefined {
  const raw = asNullableString(value);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const values = parsed.map((item) => String(item)).filter(Boolean);
    return values.length > 0 ? values : undefined;
  } catch {
    return undefined;
  }
}

function safeParseExperienceSnapshot(value: string | null): ExperienceSourceTaskSnapshot {
  const parsed = safeParseJson(value) as ExperienceSourceTaskSnapshot | undefined;
  if (parsed && typeof parsed.taskId === "string" && typeof parsed.conversationId === "string" && typeof parsed.source === "string" && typeof parsed.status === "string" && typeof parsed.startedAt === "string") {
    return parsed;
  }
  return {
    taskId: "",
    conversationId: "",
    source: "manual",
    status: "failed",
    startedAt: new Date(0).toISOString(),
  };
}

function safeParseExperienceCandidateMetadata(value: string | null): ExperienceCandidateMetadata | undefined {
  const parsed = safeParseJson(value) as ExperienceCandidateMetadata | undefined;
  return parsed && typeof parsed === "object" ? parsed : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeEmbeddingCacheRetentionPolicy(policy: EmbeddingCacheRetentionPolicy): Required<EmbeddingCacheRetentionPolicy> {
  const maxAgeMs = Math.floor(policy.maxAgeMs);
  const maxEntries = Math.floor(policy.maxEntries);
  const maxBytes = Math.floor(policy.maxBytes);
  const nowMs = Math.floor(policy.nowMs ?? Date.now());
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
    throw new Error("Embedding cache retention maxAgeMs must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new Error("Embedding cache retention maxEntries must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Embedding cache retention maxBytes must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(nowMs)) {
    throw new Error("Embedding cache retention nowMs must be a safe integer.");
  }
  return { maxAgeMs, maxEntries, maxBytes, nowMs };
}
