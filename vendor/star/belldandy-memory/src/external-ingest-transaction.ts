import type Database from "better-sqlite3";

import type { MemoryChunk } from "./types.js";

type SqliteDatabase = InstanceType<typeof Database>;

export type ExternalIngestSourceReplacement = {
  sourcePath: string;
  chunks: MemoryChunk[];
  expectedPreviousContentHash?: string;
  expectedExistingState?: "missing" | "present";
};

export type ExternalIngestStaleSource = {
  sourcePath: string;
  expectedPreviousContentHash?: string;
};

export type ExternalIngestStaleDeletion = {
  sourcePath: string;
  deletedChunkCount: number;
  skippedReason?: "lineage_mismatch" | "revision_changed";
};

export type ExternalIngestBatchInput = {
  sourceId: string;
  replacements: ExternalIngestSourceReplacement[];
  staleSources: ExternalIngestStaleSource[];
};

export type ExternalIngestBatchResult = {
  changed: boolean;
  replacementSourcePaths: string[];
  staleDeletions: ExternalIngestStaleDeletion[];
};

type ExternalIngestBatchTransactionOptions = ExternalIngestBatchInput & {
  db: SqliteDatabase;
  vectorStoreReady: boolean;
  changeSequenceMetaKey: string;
  now: string;
};

type ExistingChunkRow = {
  rowid: number;
  metadata: string | null;
};

type ExistingExternalChunk = ExistingChunkRow & {
  externalSourceId?: string;
  contentHash?: string;
};

/**
 * external ingest 的所有 source replacement 和 stale 删除共享一个 SQLite transaction。
 * 先完成 lineage/revision 校验，再删除 vec0/chunk，避免失败路径暴露半发布状态。
 */
export function applyExternalIngestBatchTransaction(
  options: ExternalIngestBatchTransactionOptions,
): ExternalIngestBatchResult {
  const sourceId = normalizeRequiredString(options.sourceId, "sourceId");
  const replacements = normalizeReplacements(options.replacements);
  const staleSources = normalizeStaleSources(options.staleSources);
  assertDistinctSourcePaths(replacements, staleSources);
  assertReplacementChunkLineage(replacements, sourceId);

  const selectRowsBySource = options.db.prepare(`
    SELECT rowid, metadata
    FROM chunks
    WHERE source_path = ?
    ORDER BY rowid ASC
  `);
  const selectSourcePathByChunkId = options.db.prepare(`
    SELECT source_path
    FROM chunks
    WHERE id = ?
  `);
  const deleteChunkByRowId = options.db.prepare(`DELETE FROM chunks WHERE rowid = ?`);
  const deleteVectorByRowId = options.vectorStoreReady
    ? options.db.prepare(`DELETE FROM chunks_vec WHERE rowid = ?`)
    : null;
  const upsertChunk = options.db.prepare(`
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
  const incrementChangeSequence = options.db.prepare(`
    INSERT INTO meta (key, value)
    VALUES (?, '1')
    ON CONFLICT(key) DO UPDATE SET
      value = CAST(MAX(0, CAST(meta.value AS INTEGER)) + 1 AS TEXT)
  `);

  const staleDeletions: ExternalIngestStaleDeletion[] = [];
  let changed = false;
  const tx = options.db.transaction(() => {
    const replacementRows = replacements.map((replacement) => {
      const rows = readExistingExternalChunks(selectRowsBySource.all(replacement.sourcePath) as ExistingChunkRow[]);
      assertReplacementLineage(rows, replacement, sourceId);
      return { replacement, rows };
    });
    const staleRows = staleSources.map((stale) => ({
      stale,
      rows: readExistingExternalChunks(selectRowsBySource.all(stale.sourcePath) as ExistingChunkRow[]),
    }));
    assertReplacementChunkIds(replacements, selectSourcePathByChunkId);

    for (const item of replacementRows) {
      deleteRows(item.rows, deleteChunkByRowId, deleteVectorByRowId);
      for (const chunk of item.replacement.chunks) {
        upsertChunk.run(
          chunk.id,
          chunk.sourcePath,
          chunk.sourceType,
          chunk.memoryType,
          chunk.visibility ?? "private",
          chunk.startLine ?? null,
          chunk.endLine ?? null,
          chunk.content,
          JSON.stringify(chunk.metadata ?? {}),
          chunk.channel ?? null,
          chunk.topic ?? null,
          chunk.tsDate ?? null,
          chunk.category ?? null,
          chunk.agentId ?? null,
          options.now,
          options.now,
        );
      }
      changed = changed || item.rows.length > 0 || item.replacement.chunks.length > 0;
    }

    for (const item of staleRows) {
      const staleDeletion = resolveStaleDeletion(item.stale, item.rows, sourceId);
      if (staleDeletion.rowIds.length > 0) {
        deleteRowsById(staleDeletion.rowIds, deleteChunkByRowId, deleteVectorByRowId);
        changed = true;
      }
      staleDeletions.push({
        sourcePath: item.stale.sourcePath,
        deletedChunkCount: staleDeletion.rowIds.length,
        ...(staleDeletion.skippedReason ? { skippedReason: staleDeletion.skippedReason } : {}),
      });
    }
    if (changed) {
      incrementChangeSequence.run(options.changeSequenceMetaKey);
    }
  });
  tx();

  return {
    changed,
    replacementSourcePaths: replacements.map((item) => item.sourcePath),
    staleDeletions,
  };
}

function normalizeReplacements(input: ExternalIngestSourceReplacement[]): ExternalIngestSourceReplacement[] {
  if (!Array.isArray(input)) {
    throw new Error("external ingest replacements must be an array.");
  }
  return input.map((replacement) => {
    const sourcePath = normalizeRequiredString(replacement?.sourcePath, "replacement sourcePath");
    if (!Array.isArray(replacement?.chunks) || replacement.chunks.length <= 0) {
      throw new Error(`external ingest replacement requires chunks: ${sourcePath}`);
    }
    for (const chunk of replacement.chunks) {
      if (chunk.sourcePath !== sourcePath) {
        throw new Error(`external ingest replacement chunk source mismatch: ${sourcePath}`);
      }
    }
    const expectedPreviousContentHash = normalizeOptionalString(replacement.expectedPreviousContentHash);
    const expectedExistingState = normalizeExpectedExistingState(replacement.expectedExistingState);
    return {
      sourcePath,
      chunks: replacement.chunks,
      ...(expectedPreviousContentHash ? { expectedPreviousContentHash } : {}),
      ...(expectedExistingState ? { expectedExistingState } : {}),
    };
  });
}

function normalizeStaleSources(input: ExternalIngestStaleSource[]): ExternalIngestStaleSource[] {
  if (!Array.isArray(input)) {
    throw new Error("external ingest stale sources must be an array.");
  }
  return input.map((stale) => ({
    sourcePath: normalizeRequiredString(stale?.sourcePath, "stale sourcePath"),
    ...(normalizeOptionalString(stale.expectedPreviousContentHash)
      ? { expectedPreviousContentHash: normalizeOptionalString(stale.expectedPreviousContentHash) }
      : {}),
  }));
}

function assertDistinctSourcePaths(
  replacements: ExternalIngestSourceReplacement[],
  staleSources: ExternalIngestStaleSource[],
): void {
  const paths = new Set<string>();
  for (const sourcePath of [...replacements, ...staleSources].map((item) => item.sourcePath)) {
    if (paths.has(sourcePath)) {
      throw new Error(`external ingest source path appears more than once: ${sourcePath}`);
    }
    paths.add(sourcePath);
  }
}

function readExistingExternalChunks(rows: ExistingChunkRow[]): ExistingExternalChunk[] {
  return rows.map((row) => {
    const metadata = safeParseMetadata(row.metadata);
    const memoryTree = isRecord(metadata?.memoryTree) ? metadata.memoryTree : undefined;
    return {
      ...row,
      externalSourceId: typeof memoryTree?.externalSourceId === "string"
        ? memoryTree.externalSourceId
        : undefined,
      contentHash: typeof metadata?.file_hash === "string" ? metadata.file_hash : undefined,
    };
  });
}

function assertReplacementLineage(
  rows: ExistingExternalChunk[],
  replacement: ExternalIngestSourceReplacement,
  sourceId: string,
): void {
  if (replacement.expectedExistingState === "missing" && rows.length > 0) {
    throw new Error(`external ingest source revision changed: ${replacement.sourcePath}`);
  }
  if (rows.length <= 0) {
    if (replacement.expectedPreviousContentHash || replacement.expectedExistingState === "present") {
      throw new Error(`external ingest source revision changed: ${replacement.sourcePath}`);
    }
    return;
  }
  for (const row of rows) {
    if (row.externalSourceId !== sourceId) {
      throw new Error(`external ingest lineage conflict: ${replacement.sourcePath}`);
    }
    if (replacement.expectedPreviousContentHash && row.contentHash !== replacement.expectedPreviousContentHash) {
      throw new Error(`external ingest source revision changed: ${replacement.sourcePath}`);
    }
  }
}

function assertReplacementChunkLineage(
  replacements: ExternalIngestSourceReplacement[],
  sourceId: string,
): void {
  for (const replacement of replacements) {
    for (const chunk of replacement.chunks) {
      const metadata = isRecord(chunk.metadata) ? chunk.metadata : undefined;
      const memoryTree = isRecord(metadata?.memoryTree) ? metadata.memoryTree : undefined;
      if (memoryTree?.externalSourceId !== sourceId) {
        throw new Error(`external ingest replacement lineage mismatch: ${replacement.sourcePath}`);
      }
    }
  }
}

function assertReplacementChunkIds(
  replacements: ExternalIngestSourceReplacement[],
  selectSourcePathByChunkId: Database.Statement,
): void {
  const sourcePathByChunkId = new Map<string, string>();
  for (const replacement of replacements) {
    for (const chunk of replacement.chunks) {
      const priorInputSourcePath = sourcePathByChunkId.get(chunk.id);
      if (priorInputSourcePath && priorInputSourcePath !== replacement.sourcePath) {
        throw new Error(`external ingest chunk id conflict: ${chunk.id}`);
      }
      sourcePathByChunkId.set(chunk.id, replacement.sourcePath);

      const existing = selectSourcePathByChunkId.get(chunk.id) as { source_path: string } | undefined;
      if (existing && existing.source_path !== replacement.sourcePath) {
        throw new Error(`external ingest chunk id conflict: ${chunk.id}`);
      }
    }
  }
}

function resolveStaleDeletion(
  stale: ExternalIngestStaleSource,
  rows: ExistingExternalChunk[],
  sourceId: string,
): {
  rowIds: number[];
  skippedReason?: "lineage_mismatch" | "revision_changed";
} {
  const matchingRows = rows.filter((row) => row.externalSourceId === sourceId);
  if (matchingRows.length <= 0) {
    return {
      rowIds: [],
      ...(rows.length > 0 ? { skippedReason: "lineage_mismatch" as const } : {}),
    };
  }
  if (
    stale.expectedPreviousContentHash
    && matchingRows.some((row) => row.contentHash !== stale.expectedPreviousContentHash)
  ) {
    return { rowIds: [], skippedReason: "revision_changed" };
  }
  return { rowIds: matchingRows.map((row) => row.rowid) };
}

function deleteRows(
  rows: ExistingChunkRow[],
  deleteChunkByRowId: Database.Statement,
  deleteVectorByRowId: Database.Statement | null,
): void {
  deleteRowsById(rows.map((row) => row.rowid), deleteChunkByRowId, deleteVectorByRowId);
}

function deleteRowsById(
  rowIds: number[],
  deleteChunkByRowId: Database.Statement,
  deleteVectorByRowId: Database.Statement | null,
): void {
  for (const rowId of rowIds) {
    if (deleteVectorByRowId) {
      deleteVectorByRowId.run(BigInt(rowId));
    }
    deleteChunkByRowId.run(rowId);
  }
}

function normalizeRequiredString(value: unknown, label: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`external ingest ${label} is required.`);
  }
  return normalized;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeExpectedExistingState(value: unknown): "missing" | "present" | undefined {
  if (value == null || value === "") return undefined;
  if (value === "missing" || value === "present") return value;
  throw new Error("external ingest replacement expectedExistingState must be missing or present.");
}

function safeParseMetadata(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
