import type { SqliteDatabase } from "./index.js";
import type {
  MemoryTreeEdgeRecord,
  MemoryTreeNodeKind,
  MemoryTreeNodeRecord,
  MemoryTreeSourceRecord,
} from "./memory-tree-types.js";

export type MemoryTreeKindPublication = {
  kind: MemoryTreeNodeKind;
  nodes: MemoryTreeNodeRecord[];
  edges: MemoryTreeEdgeRecord[];
  sourceRecords?: MemoryTreeSourceRecord[];
};

/**
 * 以同一个 SQLite transaction 发布一种 tree kind 的完整快照。
 * 任意 source/node/edge 序列化或写入失败都会保留旧快照，查询方不会看到已删未写的中间状态。
 */
export function publishMemoryTreeKindTransaction(
  db: SqliteDatabase,
  input: MemoryTreeKindPublication,
): void {
  const sourceRecords = Array.isArray(input.sourceRecords) ? input.sourceRecords : [];
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  const edges = Array.isArray(input.edges) ? input.edges : [];
  const selectNodeIds = db.prepare(`
    SELECT id
    FROM memory_tree_nodes
    WHERE kind = ?
  `);
  const deleteEdgesByParentId = db.prepare(`
    DELETE FROM memory_tree_edges
    WHERE parent_node_id = ?
  `);
  const deleteNodeById = db.prepare(`
    DELETE FROM memory_tree_nodes
    WHERE id = ?
  `);
  const upsertSource = db.prepare(`
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
  const upsertNode = db.prepare(`
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
  const upsertEdge = db.prepare(`
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

  const publish = db.transaction(() => {
    const now = new Date().toISOString();
    for (const source of sourceRecords) {
      upsertSource.run(
        source.id,
        source.sourceKind,
        source.sourceClass,
        source.scope,
        source.agentId ?? null,
        source.sourcePath ?? null,
        source.sourceRef ?? null,
        source.contentHash ?? null,
        source.timeFrom ?? null,
        source.timeTo ?? null,
        typeof source.itemCount === "number" ? Math.max(0, Math.floor(source.itemCount)) : null,
        source.metadata ? JSON.stringify(source.metadata) : null,
        source.createdAt ?? now,
        source.updatedAt ?? now,
      );
    }

    const existingNodeIds = (selectNodeIds.all(input.kind) as Array<{ id: string }>).map((row) => row.id);
    for (const nodeId of existingNodeIds) {
      deleteEdgesByParentId.run(nodeId);
      deleteNodeById.run(nodeId);
    }

    for (const node of nodes) {
      upsertNode.run(
        node.id,
        Math.max(1, Math.floor(node.level)),
        node.kind,
        node.scope,
        node.agentId ?? null,
        node.topicKey ?? null,
        node.title ?? null,
        node.summary,
        node.summaryModel ?? null,
        node.summaryVersion ?? null,
        node.timeFrom ?? null,
        node.timeTo ?? null,
        node.sourceClassMix ? JSON.stringify(node.sourceClassMix) : null,
        node.metadata ? JSON.stringify(node.metadata) : null,
        node.createdAt ?? now,
        node.updatedAt ?? now,
      );
    }

    for (const edge of edges) {
      upsertEdge.run(
        edge.id,
        edge.parentNodeId,
        edge.childType,
        edge.childId,
        edge.relation,
        typeof edge.position === "number" ? Math.floor(edge.position) : null,
        edge.weight ?? null,
        edge.metadata ? JSON.stringify(edge.metadata) : null,
        edge.createdAt ?? now,
      );
    }
  });

  publish();
}
