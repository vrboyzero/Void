import type { SqliteDatabase } from "./index.js";
import { buildMemoryTreeSourceRecordFromEdge } from "./memory-tree-source-links.js";
import type {
  MemoryTreeEdgeRecord,
  MemoryTreeNodeDetailResult,
  MemoryTreeNodeRecord,
  MemoryTreeSourceRecord,
} from "./memory-tree-types.js";
import type { MemorySearchResult } from "./types.js";

const SQLITE_BIND_PARAMETER_BATCH_SIZE = 900;

type DatabaseRow = Record<string, unknown>;

export type MemoryTreeDetailRowMappers = {
  node: (row: DatabaseRow) => MemoryTreeNodeRecord;
  edge: (row: DatabaseRow) => MemoryTreeEdgeRecord;
  chunk: (row: DatabaseRow) => MemorySearchResult;
  source: (row: DatabaseRow) => MemoryTreeSourceRecord;
};

/**
 * 批量读取 Memory Tree 详情所需的四类投影。调用方 mapper 复用 Store 的 canonical row 映射，
 * 本模块只持有 SQL、bind 分批、每节点 chunk 上限和结果装配。
 */
export function readMemoryTreeNodeDetailsBatch(
  db: SqliteDatabase,
  nodeIds: string[],
  options: { chunkLimit?: number } = {},
  mappers: MemoryTreeDetailRowMappers,
): Map<string, MemoryTreeNodeDetailResult> {
  const normalizedNodeIds = normalizeIds(nodeIds);
  const result = new Map<string, MemoryTreeNodeDetailResult>();
  if (normalizedNodeIds.length === 0) {
    return result;
  }

  const nodeRowsById = readRowsById(db, "memory_tree_nodes", normalizedNodeIds);
  const existingNodeIds = normalizedNodeIds.filter((nodeId) => nodeRowsById.has(nodeId));
  if (existingNodeIds.length === 0) {
    return result;
  }

  const edgeRowsByNodeId = readEdgeRowsByNodeId(db, existingNodeIds);
  const chunkLimit = resolveChunkLimit(options.chunkLimit);
  const chunkIds = normalizeIds(existingNodeIds.flatMap((nodeId) => (edgeRowsByNodeId.get(nodeId) ?? [])
    .filter((row) => row.child_type === "chunk")
    .map((row) => String(row.child_id))));
  const sourceIds = normalizeIds(existingNodeIds.flatMap((nodeId) => (edgeRowsByNodeId.get(nodeId) ?? [])
    .filter((row) => row.child_type === "source")
    .map((row) => String(row.child_id))));
  const chunkRowsById = readChunkRowsById(db, chunkIds);
  const sourceRowsById = readRowsById(db, "memory_sources", sourceIds);

  for (const nodeId of existingNodeIds) {
    const nodeRow = nodeRowsById.get(nodeId);
    if (!nodeRow) continue;
    const edges = (edgeRowsByNodeId.get(nodeId) ?? []).map(mappers.edge);
    const chunks: MemorySearchResult[] = [];
    for (const edge of edges) {
      if (edge.childType !== "chunk") continue;
      const chunkRow = chunkRowsById.get(edge.childId);
      if (!chunkRow) continue;
      chunks.push(mappers.chunk(chunkRow));
      if (chunks.length >= chunkLimit) break;
    }
    const sources = edges
      .filter((edge) => edge.childType === "source")
      .map((edge) => {
        const sourceRow = sourceRowsById.get(edge.childId);
        return sourceRow ? mappers.source(sourceRow) : buildMemoryTreeSourceRecordFromEdge(edge);
      })
      .filter((source): source is MemoryTreeSourceRecord => Boolean(source));
    result.set(nodeId, {
      node: mappers.node(nodeRow),
      edges,
      chunks,
      sources,
    });
  }
  return result;
}

function readRowsById(
  db: SqliteDatabase,
  table: "memory_tree_nodes" | "memory_sources",
  ids: string[],
): Map<string, DatabaseRow> {
  const rowsById = new Map<string, DatabaseRow>();
  for (const batch of splitIntoBatches(ids, SQLITE_BIND_PARAMETER_BATCH_SIZE)) {
    const placeholders = batch.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT *
      FROM ${table}
      WHERE id IN (${placeholders})
    `).all(...batch) as DatabaseRow[];
    for (const row of rows) {
      rowsById.set(String(row.id), row);
    }
  }
  return rowsById;
}

function readEdgeRowsByNodeId(
  db: SqliteDatabase,
  nodeIds: string[],
): Map<string, DatabaseRow[]> {
  const rowsByNodeId = new Map<string, DatabaseRow[]>();
  for (const batch of splitIntoBatches(nodeIds, SQLITE_BIND_PARAMETER_BATCH_SIZE)) {
    const placeholders = batch.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT *
      FROM memory_tree_edges
      WHERE parent_node_id IN (${placeholders})
      ORDER BY parent_node_id ASC, COALESCE(position, 999999) ASC, child_id ASC
    `).all(...batch) as DatabaseRow[];
    appendRowsByKey(rowsByNodeId, rows, "parent_node_id");
  }
  return rowsByNodeId;
}

function readChunkRowsById(db: SqliteDatabase, chunkIds: string[]): Map<string, DatabaseRow> {
  const rowsById = new Map<string, DatabaseRow>();
  for (const batch of splitIntoBatches(chunkIds, SQLITE_BIND_PARAMETER_BATCH_SIZE)) {
    const placeholders = batch.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT id, source_path, source_type, memory_type, visibility, content, metadata,
             topic, start_line, end_line, summary, category, updated_at
      FROM chunks
      WHERE id IN (${placeholders})
    `).all(...batch) as DatabaseRow[];
    for (const row of rows) {
      rowsById.set(String(row.id), row);
    }
  }
  return rowsById;
}

function appendRowsByKey(
  target: Map<string, DatabaseRow[]>,
  rows: DatabaseRow[],
  key: string,
): void {
  for (const row of rows) {
    const value = typeof row[key] === "string" ? row[key] : "";
    if (!value) continue;
    const current = target.get(value);
    if (current) {
      current.push(row);
    } else {
      target.set(value, [row]);
    }
  }
}

function normalizeIds(ids: string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function resolveChunkLimit(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : 20;
}

function splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += batchSize) {
    batches.push(items.slice(start, start + batchSize));
  }
  return batches;
}
