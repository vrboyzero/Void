import type { SqliteDatabase } from "./index.js";
import { vectorFromBuffer, vectorToBuffer, type EmbeddingVector } from "./embeddings/index.js";

export const CHUNK_VECTOR_READ_BIND_PARAMETER_BATCH_SIZE = 900;

export type ChunkVectorWrite = {
  chunkId: string;
  embedding: EmbeddingVector;
  cacheHash?: string;
};

export function buildChunkVectorBatchReadQuery(candidateCount: number): string {
  if (
    !Number.isSafeInteger(candidateCount)
    || candidateCount <= 0
    || candidateCount > CHUNK_VECTOR_READ_BIND_PARAMETER_BATCH_SIZE
  ) {
    throw new Error("Invalid chunk vector batch candidate count.");
  }
  const placeholders = Array.from({ length: candidateCount }, () => "?").join(", ");
  return `
    SELECT c.id AS chunk_id, v.embedding
    FROM chunks c
    INNER JOIN chunks_vec v ON c.rowid = v.rowid
    WHERE c.id IN (${placeholders})
  `;
}

/**
 * 为 reranker 提供一次 SQL 读取多个 vec0 向量的适配层。
 * 返回 Map 保留输入首次出现的顺序，缺失或无法读取的向量显式映射为 null。
 */
export function readChunkVectorsBatch(
  db: SqliteDatabase,
  vectorStoreReady: boolean,
  chunkIds: string[],
): Map<string, EmbeddingVector | null> {
  const normalizedChunkIds = normalizeChunkIds(chunkIds);
  const vectors = new Map<string, EmbeddingVector | null>(
    normalizedChunkIds.map((chunkId) => [chunkId, null]),
  );
  if (!vectorStoreReady || normalizedChunkIds.length === 0) {
    return vectors;
  }

  for (const chunkIdBatch of splitIntoBatches(normalizedChunkIds, CHUNK_VECTOR_READ_BIND_PARAMETER_BATCH_SIZE)) {
    let rows: Array<{ chunk_id: string; embedding: Buffer }>;
    try {
      rows = db.prepare(buildChunkVectorBatchReadQuery(chunkIdBatch.length))
        .all(...chunkIdBatch) as Array<{ chunk_id: string; embedding: Buffer }>;
    } catch {
      // 与单项读取保持同一降级语义：vec0 不可读时让 reranker 按无向量继续。
      continue;
    }

    for (const row of rows) {
      try {
        vectors.set(row.chunk_id, vectorFromBuffer(row.embedding));
      } catch {
        // 单条损坏向量不得阻断同批其他候选的规则重排。
      }
    }
  }

  return vectors;
}

/**
 * 校验 batch 的共同维度，防止不同 vec0 维度或非有限数值破坏整批写入语义。
 */
export function resolveChunkVectorBatchDimensions(writes: ChunkVectorWrite[]): number | null {
  if (writes.length === 0) {
    return null;
  }

  const dimensions = writes[0]?.embedding?.length;
  if (!Number.isSafeInteger(dimensions) || dimensions <= 0) {
    throw new Error("Invalid chunk vector batch dimensions.");
  }

  const chunkIds = new Set<string>();
  for (const write of writes) {
    if (!write || typeof write.chunkId !== "string" || write.chunkId.trim().length === 0) {
      throw new Error("Invalid chunk vector batch chunk id.");
    }
    if (chunkIds.has(write.chunkId)) {
      throw new Error("Duplicate chunk vector batch chunk id.");
    }
    chunkIds.add(write.chunkId);
    if (!isFiniteVector(write.embedding, dimensions)) {
      throw new Error("Invalid chunk vector batch embedding.");
    }
  }
  return dimensions;
}

/**
 * 在一个 SQLite transaction 内完成 rowid 映射、vec0 replace 与可选 cache 写入。
 * 缺失 chunk 被稳定跳过，任一实际写入失败会回滚整个已选批次。
 */
export function writeChunkVectorsBatch(
  db: SqliteDatabase,
  writes: ChunkVectorWrite[],
  model: string,
): string[] {
  if (writes.length === 0) {
    return [];
  }

  const deleteVector = db.prepare(`DELETE FROM chunks_vec WHERE rowid = ?`);
  const insertVector = db.prepare(`INSERT INTO chunks_vec(rowid, embedding) VALUES (?, ?)`);
  const cacheEmbedding = db.prepare(`
    INSERT OR REPLACE INTO embedding_cache (content_hash, embedding, dimensions, model, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const writeBatch = db.transaction((items: ChunkVectorWrite[]) => {
    const rowIds = readChunkRowIds(db, items.map((item) => item.chunkId));
    const writtenChunkIds: string[] = [];
    const createdAt = new Date().toISOString();

    for (const item of items) {
      const rowId = rowIds.get(item.chunkId);
      if (rowId === undefined) {
        continue;
      }
      const embedding = vectorToBuffer(item.embedding);
      deleteVector.run(BigInt(rowId));
      insertVector.run(BigInt(rowId), embedding);
      if (typeof item.cacheHash === "string" && item.cacheHash.length > 0) {
        cacheEmbedding.run(item.cacheHash, embedding, item.embedding.length, model, createdAt);
      }
      writtenChunkIds.push(item.chunkId);
    }
    return writtenChunkIds;
  });

  return writeBatch(writes);
}

function normalizeChunkIds(chunkIds: string[]): string[] {
  return [...new Set(chunkIds.filter((chunkId) => typeof chunkId === "string" && chunkId.length > 0))];
}

function readChunkRowIds(db: SqliteDatabase, chunkIds: string[]): Map<string, number> {
  const rowIds = new Map<string, number>();
  for (const chunkIdBatch of splitIntoBatches(chunkIds, CHUNK_VECTOR_READ_BIND_PARAMETER_BATCH_SIZE)) {
    const placeholders = chunkIdBatch.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT id, rowid
      FROM chunks
      WHERE id IN (${placeholders})
    `).all(...chunkIdBatch) as Array<{ id: string; rowid: number }>;
    for (const row of rows) {
      rowIds.set(row.id, row.rowid);
    }
  }
  return rowIds;
}

function isFiniteVector(value: unknown, dimensions: number): value is EmbeddingVector {
  return Array.isArray(value)
    && value.length === dimensions
    && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

function splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += batchSize) {
    batches.push(items.slice(start, start + batchSize));
  }
  return batches;
}
