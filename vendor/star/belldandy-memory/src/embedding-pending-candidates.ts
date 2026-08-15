import type { SqliteDatabase } from "./index.js";
import type { MemoryChunk, MemoryType, MemoryVisibility } from "./types.js";

export type PendingEmbeddingCandidate = {
  rowId: number;
  chunk: MemoryChunk;
};

export type ListPendingEmbeddingCandidatesOptions = {
  limit: number;
  afterRowId: number;
  vectorStoreReady: boolean;
};

export type PendingEmbeddingCandidateCursorOptions = {
  listPage: (limit: number, afterRowId: number) => PendingEmbeddingCandidate[];
  getBackoffChunkIds: (chunkIds: string[]) => ReadonlySet<string>;
};

/**
 * 以 SQLite rowid 作为本次同步内的稳定游标，避免 backoff 的首项反复遮住后续健康 chunk。
 */
export function listPendingEmbeddingCandidates(
  db: SqliteDatabase,
  options: ListPendingEmbeddingCandidatesOptions,
): PendingEmbeddingCandidate[] {
  const limit = normalizeLimit(options.limit);
  const afterRowId = normalizeAfterRowId(options.afterRowId);
  const rows = options.vectorStoreReady
    ? db.prepare(`
      SELECT c.rowid AS chunk_rowid, c.*
      FROM chunks c
      LEFT JOIN chunks_vec v ON c.rowid = v.rowid
      WHERE v.rowid IS NULL AND c.rowid > ?
      ORDER BY c.rowid
      LIMIT ?
    `).all(afterRowId, limit)
    : db.prepare(`
      SELECT c.rowid AS chunk_rowid, c.*
      FROM chunks c
      WHERE c.rowid > ?
      ORDER BY c.rowid
      LIMIT ?
    `).all(afterRowId, limit);

  return (rows as Array<Record<string, unknown>>).map((row) => ({
    rowId: Number(row.chunk_rowid),
    chunk: {
      id: String(row.id),
      sourcePath: String(row.source_path),
      sourceType: String(row.source_type) as MemoryChunk["sourceType"],
      memoryType: row.memory_type as MemoryType,
      visibility: (row.visibility ?? "private") as MemoryVisibility,
      startLine: asOptionalNumber(row.start_line),
      endLine: asOptionalNumber(row.end_line),
      content: String(row.content),
      channel: asOptionalString(row.channel),
      topic: asOptionalString(row.topic),
      tsDate: asOptionalString(row.ts_date),
      metadata: safeParseMetadata(row.metadata),
    },
  }));
}

/**
 * 每次同步独占一个游标。已跳过的 backoff 项会推进游标，而不是让下一轮再次命中同一前缀。
 */
export class PendingEmbeddingCandidateCursor {
  private afterRowId = 0;

  constructor(private readonly options: PendingEmbeddingCandidateCursorOptions) {}

  take(limit: number): MemoryChunk[] {
    const requestedLimit = normalizeLimit(limit);
    const selected: MemoryChunk[] = [];

    while (selected.length < requestedLimit) {
      const remaining = requestedLimit - selected.length;
      const page = this.options.listPage(remaining, this.afterRowId);
      if (page.length === 0) {
        break;
      }

      const lastRowId = page[page.length - 1]?.rowId;
      if (!Number.isSafeInteger(lastRowId) || lastRowId <= this.afterRowId) {
        break;
      }
      this.afterRowId = lastRowId;

      const blockedChunkIds = this.options.getBackoffChunkIds(page.map((candidate) => candidate.chunk.id));
      for (const candidate of page) {
        if (!blockedChunkIds.has(candidate.chunk.id)) {
          selected.push(candidate.chunk);
        }
      }

      if (page.length < remaining) {
        break;
      }
    }

    return selected;
  }
}

function normalizeLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function normalizeAfterRowId(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeParseMetadata(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || !value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
