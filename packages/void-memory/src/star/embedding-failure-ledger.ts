import type { SqliteDatabase } from "./index.js";

export type EmbeddingFailureReason = "invalid_response" | "request_failed" | "storage_failed";

export type EmbeddingFailureRecord = {
  chunkId: string;
  scope: string;
  failureCount: number;
  nextRetryAt: number;
  lastFailureReason: EmbeddingFailureReason;
  lastFailureAt: number;
  updatedAt: number;
};

export type RecordEmbeddingFailuresInput = {
  scope: string;
  chunkIds: string[];
  reason: EmbeddingFailureReason;
  failedAtMs: number;
};

const INITIAL_RETRY_DELAY_MS = 60_000;
const MAX_RETRY_DELAY_MS = 15 * 60_000;
const SQLITE_BIND_PARAMETER_BATCH_SIZE = 900;

// 独立于 MemoryStore 基础表的可加性 schema；旧库首次启动时只新增本表和索引。
const SCHEMA_EMBEDDING_FAILURE_LEDGER = `
CREATE TABLE IF NOT EXISTS embedding_failure_ledger (
  chunk_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  failure_count INTEGER NOT NULL,
  next_retry_at INTEGER NOT NULL,
  last_failure_reason TEXT NOT NULL,
  last_failure_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chunk_id, scope)
);

CREATE INDEX IF NOT EXISTS idx_embedding_failure_ledger_scope_retry
  ON embedding_failure_ledger(scope, next_retry_at);
`;

type EmbeddingFailureLedgerRow = {
  chunk_id: string;
  scope: string;
  failure_count: number;
  next_retry_at: number;
  last_failure_reason: string;
  last_failure_at: number;
  updated_at: number;
};

/**
 * 为 embedding 同步保存无正文、无 Provider 错误的失败退避状态。
 * scope 由调用方按 embedding 配置隔离，避免模型或 passage 语义变更继承旧退避。
 */
export class EmbeddingFailureLedger {
  constructor(private readonly db: SqliteDatabase) {
    this.db.exec(SCHEMA_EMBEDDING_FAILURE_LEDGER);
  }

  recordFailures(input: RecordEmbeddingFailuresInput): EmbeddingFailureRecord[] {
    const scope = normalizeText(input.scope);
    const chunkIds = normalizeChunkIds(input.chunkIds);
    if (!scope || chunkIds.length === 0) {
      return [];
    }

    const failedAtMs = normalizeTimestamp(input.failedAtMs);
    const recordFailures = this.db.transaction((ids: string[]) => ids.map((chunkId) => {
      const current = this.readRecord(scope, chunkId);
      const failureCount = Math.max(1, (current?.failureCount ?? 0) + 1);
      const nextRetryAt = failedAtMs + resolveEmbeddingFailureRetryDelayMs(failureCount);
      const record: EmbeddingFailureRecord = {
        chunkId,
        scope,
        failureCount,
        nextRetryAt,
        lastFailureReason: input.reason,
        lastFailureAt: failedAtMs,
        updatedAt: failedAtMs,
      };

      this.db.prepare(`
        INSERT INTO embedding_failure_ledger (
          chunk_id,
          scope,
          failure_count,
          next_retry_at,
          last_failure_reason,
          last_failure_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chunk_id, scope) DO UPDATE SET
          failure_count = excluded.failure_count,
          next_retry_at = excluded.next_retry_at,
          last_failure_reason = excluded.last_failure_reason,
          last_failure_at = excluded.last_failure_at,
          updated_at = excluded.updated_at
      `).run(
        record.chunkId,
        record.scope,
        record.failureCount,
        record.nextRetryAt,
        record.lastFailureReason,
        record.lastFailureAt,
        record.updatedAt,
      );
      return record;
    }));

    return recordFailures(chunkIds);
  }

  getBackoffChunkIds(scope: string, chunkIds: string[], nowMs: number): Set<string> {
    const normalizedScope = normalizeText(scope);
    const normalizedChunkIds = normalizeChunkIds(chunkIds);
    if (!normalizedScope || normalizedChunkIds.length === 0) {
      return new Set();
    }

    const now = normalizeTimestamp(nowMs);
    const backoffChunkIds = new Set<string>();
    for (const chunkIdBatch of splitIntoBatches(normalizedChunkIds, SQLITE_BIND_PARAMETER_BATCH_SIZE)) {
      const placeholders = chunkIdBatch.map(() => "?").join(", ");
      const rows = this.db.prepare(`
        SELECT chunk_id
        FROM embedding_failure_ledger
        WHERE scope = ?
          AND next_retry_at > ?
          AND chunk_id IN (${placeholders})
      `).all(normalizedScope, now, ...chunkIdBatch) as Array<{ chunk_id: string }>;
      for (const row of rows) {
        backoffChunkIds.add(row.chunk_id);
      }
    }
    return backoffChunkIds;
  }

  getRecord(scope: string, chunkId: string): EmbeddingFailureRecord | undefined {
    const normalizedScope = normalizeText(scope);
    const normalizedChunkId = normalizeText(chunkId);
    return normalizedScope && normalizedChunkId
      ? this.readRecord(normalizedScope, normalizedChunkId)
      : undefined;
  }

  clearFailures(scope: string, chunkIds: string[]): void {
    const normalizedScope = normalizeText(scope);
    const normalizedChunkIds = normalizeChunkIds(chunkIds);
    if (!normalizedScope || normalizedChunkIds.length === 0) {
      return;
    }

    for (const chunkIdBatch of splitIntoBatches(normalizedChunkIds, SQLITE_BIND_PARAMETER_BATCH_SIZE)) {
      const placeholders = chunkIdBatch.map(() => "?").join(", ");
      this.db.prepare(`
        DELETE FROM embedding_failure_ledger
        WHERE scope = ? AND chunk_id IN (${placeholders})
      `).run(normalizedScope, ...chunkIdBatch);
    }
  }

  private readRecord(scope: string, chunkId: string): EmbeddingFailureRecord | undefined {
    const row = this.db.prepare(`
      SELECT
        chunk_id,
        scope,
        failure_count,
        next_retry_at,
        last_failure_reason,
        last_failure_at,
        updated_at
      FROM embedding_failure_ledger
      WHERE scope = ? AND chunk_id = ?
      LIMIT 1
    `).get(scope, chunkId) as EmbeddingFailureLedgerRow | undefined;
    return row ? mapFailureRecord(row) : undefined;
  }
}

export function resolveEmbeddingFailureRetryDelayMs(failureCount: number): number {
  const normalizedFailureCount = Math.max(1, Math.floor(failureCount));
  const exponent = Math.min(normalizedFailureCount - 1, 30);
  return Math.min(MAX_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS * (2 ** exponent));
}

function mapFailureRecord(row: EmbeddingFailureLedgerRow): EmbeddingFailureRecord {
  return {
    chunkId: row.chunk_id,
    scope: row.scope,
    failureCount: Math.max(1, Math.floor(Number(row.failure_count))),
    nextRetryAt: Math.max(0, Math.floor(Number(row.next_retry_at))),
    lastFailureReason: normalizeFailureReason(row.last_failure_reason),
    lastFailureAt: Math.max(0, Math.floor(Number(row.last_failure_at))),
    updatedAt: Math.max(0, Math.floor(Number(row.updated_at))),
  };
}

function normalizeChunkIds(chunkIds: string[]): string[] {
  return [...new Set(chunkIds.map(normalizeText).filter((chunkId): chunkId is string => Boolean(chunkId)))];
}

function normalizeText(value: string): string | undefined {
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeTimestamp(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : Date.now();
}

function normalizeFailureReason(value: string): EmbeddingFailureReason {
  if (value === "request_failed" || value === "storage_failed") {
    return value;
  }
  return "invalid_response";
}

function splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += batchSize) {
    batches.push(items.slice(start, start + batchSize));
  }
  return batches;
}
