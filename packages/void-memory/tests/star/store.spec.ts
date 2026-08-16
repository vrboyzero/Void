import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MemoryStore } from "../../src/star/store.js";
import { buildTaskRecapArtifacts } from "../../src/star/task-recap.js";
import type { MemoryChunk } from "../../src/star/types.js";
import type { TaskActivityRecord, TaskRecord } from "../../src/star/task-types.js";

describe("MemoryStore", () => {
  let rootDir: string;
  let dbPath: string;
  let store: MemoryStore;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "belldandy-memory-store-"));
    dbPath = path.join(rootDir, "memory.db");
    store = new MemoryStore(dbPath);
  });

  afterEach(async () => {
    store.close();
    await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
  });

  it("rolls back replaceSourceChunks when a chunk write fails", () => {
    const sourcePath = "/tmp/atomic-source.md";

    store.upsertChunk({
      id: "old-1",
      sourcePath,
      sourceType: "file",
      memoryType: "other",
      content: "old content chunk one",
    });
    store.upsertChunk({
      id: "old-2",
      sourcePath,
      sourceType: "file",
      memoryType: "other",
      content: "old content chunk two",
    });

    const circularMetadata: { self?: unknown } = {};
    circularMetadata.self = circularMetadata;

    const replacementChunks: MemoryChunk[] = [
      {
        id: "new-1",
        sourcePath,
        sourceType: "file",
        memoryType: "other",
        content: "new content chunk one",
      },
      {
        id: "new-2",
        sourcePath,
        sourceType: "file",
        memoryType: "other",
        content: "new content chunk two",
        metadata: circularMetadata,
      },
    ];

    expect(() => store.replaceSourceChunks(sourcePath, replacementChunks)).toThrow();

    const remainingChunks = store.getChunksBySource(sourcePath, 10);

    expect(remainingChunks).toHaveLength(2);
    expect(remainingChunks.map((item) => item.id)).toEqual(["old-1", "old-2"]);
    expect(remainingChunks.every((item) => item.content?.includes("old content"))).toBe(true);
  });

  it("reads chunk vectors in one batch while preserving missing and duplicate ids", () => {
    store.upsertChunk({
      id: "batch-vector-a",
      sourcePath: "/tmp/batch-vector-a.md",
      sourceType: "file",
      memoryType: "other",
      content: "batch vector a",
    });
    store.upsertChunk({
      id: "batch-vector-b",
      sourcePath: "/tmp/batch-vector-b.md",
      sourceType: "file",
      memoryType: "other",
      content: "batch vector b",
    });
    store.prepareVectorStore(2);
    store.upsertChunkVector("batch-vector-a", [0.1, 0.2], "test-model");

    const vectors = store.getChunkVectors([
      "batch-vector-a",
      "batch-vector-b",
      "batch-vector-missing",
      "batch-vector-a",
    ]);

    expect([...vectors.keys()]).toEqual([
      "batch-vector-a",
      "batch-vector-b",
      "batch-vector-missing",
    ]);
    expect(vectors.get("batch-vector-a")).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
    ]);
    expect(vectors.get("batch-vector-b")).toBeNull();
    expect(vectors.get("batch-vector-missing")).toBeNull();
  });

  it("writes chunk vectors and cache entries in one batch transaction", () => {
    for (const id of ["batch-write-a", "batch-write-b"]) {
      store.upsertChunk({
        id,
        sourcePath: `/tmp/${id}.md`,
        sourceType: "file",
        memoryType: "other",
        content: id,
      });
    }

    const writtenChunkIds = store.upsertChunkVectorsBatch([
      { chunkId: "batch-write-a", embedding: [0.1, 0.2], cacheHash: "batch-write-cache-a" },
      { chunkId: "batch-write-b", embedding: [0.3, 0.4], cacheHash: "batch-write-cache-b" },
    ], "test-model");

    expect(writtenChunkIds).toEqual(["batch-write-a", "batch-write-b"]);
    expect(store.getChunkVector("batch-write-a")).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
    ]);
    expect(store.getChunkVector("batch-write-b")).toEqual([
      expect.closeTo(0.3, 5),
      expect.closeTo(0.4, 5),
    ]);
    expect(store.getCachedEmbedding("batch-write-cache-a")).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
    ]);
    expect(store.getCachedEmbedding("batch-write-cache-b")).toEqual([
      expect.closeTo(0.3, 5),
      expect.closeTo(0.4, 5),
    ]);
  });

  it("prunes expired and oldest embedding cache entries without deleting indexed vectors", () => {
    for (const id of ["cache-retention-expired", "cache-retention-old", "cache-retention-new"]) {
      store.upsertChunk({
        id,
        sourcePath: `/tmp/${id}.md`,
        sourceType: "file",
        memoryType: "other",
        content: id,
      });
    }
    store.upsertChunkVectorsBatch([
      { chunkId: "cache-retention-expired", embedding: [0.1, 0.2], cacheHash: "cache-retention-expired" },
      { chunkId: "cache-retention-old", embedding: [0.3, 0.4], cacheHash: "cache-retention-old" },
      { chunkId: "cache-retention-new", embedding: [0.5, 0.6], cacheHash: "cache-retention-new" },
    ], "test-model");

    const db = store.getDbHandleForSharedSchema();
    const setCreatedAt = db.prepare("UPDATE embedding_cache SET created_at = ? WHERE content_hash = ?");
    setCreatedAt.run("2026-06-01T00:00:00.000Z", "cache-retention-expired");
    setCreatedAt.run("2026-07-21T00:00:00.000Z", "cache-retention-old");
    setCreatedAt.run("2026-07-22T00:00:00.000Z", "cache-retention-new");

    const result = store.pruneEmbeddingCache({
      maxAgeMs: 7 * 24 * 60 * 60 * 1000,
      maxEntries: 1,
      maxBytes: 1024,
      nowMs: Date.parse("2026-07-23T00:00:00.000Z"),
    });

    expect(result).toEqual({
      expired: 1,
      overflow: 1,
      remaining: 1,
      remainingBytes: 8,
    });
    expect(store.getCachedEmbedding("cache-retention-expired")).toBeNull();
    expect(store.getCachedEmbedding("cache-retention-old")).toBeNull();
    expect(store.getCachedEmbedding("cache-retention-new")).toEqual([
      expect.closeTo(0.5, 5),
      expect.closeTo(0.6, 5),
    ]);
    for (const id of ["cache-retention-expired", "cache-retention-old", "cache-retention-new"]) {
      expect(store.getChunkVector(id)).not.toBeNull();
    }
  });

  it("uses the byte budget to retain the newest embedding cache entries", () => {
    store.cacheEmbedding("cache-byte-old", [0.1, 0.2], "test-model");
    store.cacheEmbedding("cache-byte-middle", [0.3, 0.4], "test-model");
    store.cacheEmbedding("cache-byte-new", [0.5, 0.6], "test-model");

    const db = store.getDbHandleForSharedSchema();
    const setCreatedAt = db.prepare("UPDATE embedding_cache SET created_at = ? WHERE content_hash = ?");
    setCreatedAt.run("2026-07-20T00:00:00.000Z", "cache-byte-old");
    setCreatedAt.run("2026-07-21T00:00:00.000Z", "cache-byte-middle");
    setCreatedAt.run("2026-07-22T00:00:00.000Z", "cache-byte-new");

    expect(store.getEmbeddingCacheStatus()).toEqual({
      entryCount: 3,
      totalBytes: 24,
      oldestCreatedAt: "2026-07-20T00:00:00.000Z",
    });

    const result = store.pruneEmbeddingCache({
      maxAgeMs: 30 * 24 * 60 * 60 * 1000,
      maxEntries: 10,
      maxBytes: 16,
      nowMs: Date.parse("2026-07-23T00:00:00.000Z"),
    });

    expect(result).toEqual({
      expired: 0,
      overflow: 1,
      remaining: 2,
      remainingBytes: 16,
    });
    expect(store.getCachedEmbedding("cache-byte-old")).toBeNull();
    expect(store.getCachedEmbedding("cache-byte-middle")).not.toBeNull();
    expect(store.getCachedEmbedding("cache-byte-new")).not.toBeNull();
    expect(store.getEmbeddingCacheStatus()).toEqual({
      entryCount: 2,
      totalBytes: 16,
      oldestCreatedAt: "2026-07-21T00:00:00.000Z",
    });
  });

  it("skips vector search when a query uses a different dimension than the vec0 table", () => {
    store.upsertChunk({
      id: "mismatched-query-dimension",
      sourcePath: "/tmp/mismatched-query-dimension.md",
      sourceType: "file",
      memoryType: "other",
      content: "keyword fallback remains available",
    });
    store.prepareVectorStore(3);
    store.upsertChunkVector(
      "mismatched-query-dimension",
      [0.1, 0.2, 0.3],
      "test-model",
    );

    expect(() => store.searchVector([0.1, 0.2])).not.toThrow();
    expect(store.searchVector([0.1, 0.2])).toEqual([]);
  });

  it("rolls back every vector and cache write when one cache insert fails", () => {
    for (const id of ["batch-rollback-a", "batch-rollback-b"]) {
      store.upsertChunk({
        id,
        sourcePath: `/tmp/${id}.md`,
        sourceType: "file",
        memoryType: "other",
        content: id,
      });
    }
    store.getDbHandleForSharedSchema().exec(`
      CREATE TRIGGER fail_batch_embedding_cache
      BEFORE INSERT ON embedding_cache
      WHEN NEW.content_hash = 'batch-rollback-cache-b'
      BEGIN
        SELECT RAISE(ABORT, 'forced embedding cache failure');
      END;
    `);

    expect(() => store.upsertChunkVectorsBatch([
      { chunkId: "batch-rollback-a", embedding: [0.1, 0.2], cacheHash: "batch-rollback-cache-a" },
      { chunkId: "batch-rollback-b", embedding: [0.3, 0.4], cacheHash: "batch-rollback-cache-b" },
    ], "test-model")).toThrow("forced embedding cache failure");

    expect(store.getChunkVector("batch-rollback-a")).toBeNull();
    expect(store.getChunkVector("batch-rollback-b")).toBeNull();
    expect(store.getCachedEmbedding("batch-rollback-cache-a")).toBeNull();
    expect(store.getCachedEmbedding("batch-rollback-cache-b")).toBeNull();
  });

  it("tracks task and memory change sequences", () => {
    expect(store.getTaskChangeSeq()).toBe(0);
    expect(store.getMemoryChangeSeq()).toBe(0);

    store.upsertChunk({
      id: "mem-1",
      sourcePath: "/tmp/memory-source.md",
      sourceType: "file",
      memoryType: "daily",
      content: "first memory chunk",
    });
    expect(store.getMemoryChangeSeq()).toBe(1);

    expect(store.promoteChunkVisibility("mem-1")).toBe(true);
    expect(store.getMemoryChangeSeq()).toBe(2);

    expect(store.deleteBySource("/tmp/memory-source.md")).toBe(1);
    expect(store.getMemoryChangeSeq()).toBe(3);

    store.replaceSourceChunks("/tmp/memory-source.md", [{
      id: "mem-2",
      sourcePath: "/tmp/memory-source.md",
      sourceType: "file",
      memoryType: "daily",
      content: "replacement memory chunk",
    }]);
    expect(store.getMemoryChangeSeq()).toBe(4);

    const taskId = "task-change-seq-1";
    store.createTask({
      id: taskId,
      conversationId: "conv-task-change-seq-1",
      sessionKey: "conv-task-change-seq-1",
      source: "chat",
      status: "running",
      startedAt: "2026-04-19T10:00:00.000Z",
      createdAt: "2026-04-19T10:00:00.000Z",
      updatedAt: "2026-04-19T10:00:00.000Z",
    });
    expect(store.getTaskChangeSeq()).toBe(1);

    store.updateTask(taskId, {
      summary: "补充 task change seq 的最小验证。",
    });
    expect(store.getTaskChangeSeq()).toBe(2);
  });

  it("rebuilds work recap and resume context when task metadata updates", async () => {
    const startedAt = "2026-04-17T08:00:00.000Z";
    const completedAt = "2026-04-17T08:05:00.000Z";
    const baseTask: TaskRecord = {
      id: "task-recap-refresh-1",
      conversationId: "conv-recap-refresh-1",
      sessionKey: "session-recap-refresh-1",
      source: "chat",
      status: "partial",
      objective: "继续整理 Step 2 的 resume 能力",
      startedAt,
      finishedAt: completedAt,
      createdAt: completedAt,
      updatedAt: completedAt,
    };
    const activities: TaskActivityRecord[] = [
      {
        id: "activity-recap-refresh-1",
        taskId: baseTask.id,
        conversationId: baseTask.conversationId,
        sessionKey: baseTask.sessionKey,
        source: baseTask.source,
        kind: "task_completed",
        state: "attempted",
        sequence: 0,
        happenedAt: completedAt,
        recordedAt: completedAt,
        title: "任务暂告一段，等待继续。",
      },
    ];
    const initialArtifacts = buildTaskRecapArtifacts({
      task: baseTask,
      activities,
      updatedAt: completedAt,
    });

    store.createTask({
      ...baseTask,
      workRecap: initialArtifacts.workRecap,
      resumeContext: initialArtifacts.resumeContext,
    });
    store.createTaskActivity(activities[0]);

    await new Promise((resolve) => setTimeout(resolve, 10));

    store.updateTask(baseTask.id, {
      summary: "已停在整理 resume 能力的字段与注入链路，等待下一步继续落检索入口。",
    });

    const updated = store.getTask(baseTask.id);

    expect(updated?.summary).toBe("已停在整理 resume 能力的字段与注入链路，等待下一步继续落检索入口。");
    expect(updated?.workRecap?.headline).toContain("当前停在：已停在整理 resume 能力的字段与注入链路");
    expect(updated?.resumeContext?.currentStopPoint).toBe("已停在整理 resume 能力的字段与注入链路，等待下一步继续落检索入口。");
    expect(updated?.workRecap?.updatedAt).toBe(updated?.updatedAt);
    expect(updated?.resumeContext?.updatedAt).toBe(updated?.updatedAt);
  });

  it("creates memory tree phase-1 tables on initialization", () => {
    const db = (store as any).db;
    const rows = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('memory_sources', 'memory_scores', 'memory_tree_nodes', 'memory_tree_edges', 'memory_clean_reports')
      ORDER BY name ASC
    `).all() as Array<{ name: string }>;

    expect(rows.map((row) => row.name)).toEqual([
      "memory_clean_reports",
      "memory_scores",
      "memory_sources",
      "memory_tree_edges",
      "memory_tree_nodes",
    ]);
    expect(store.getMeta("memory_tree_schema_version")).toBe("p9-phase1-v1");
    expect(store.getMeta("memory_tree_score_version")).toBe("v1_rule_only");
  });

  it("upserts memory sources and scores idempotently", () => {
    store.upsertMemorySources([
      {
        id: "builtin:memory:daily-notes",
        sourceKind: "memory_notes",
        sourceClass: "raw",
        scope: "private",
        sourcePath: "memory",
        sourceRef: "**/*.md",
        itemCount: 3,
        metadata: {
          recordType: "inventory_preview",
        },
      },
    ]);

    store.upsertMemorySources([
      {
        id: "builtin:memory:daily-notes",
        sourceKind: "memory_notes",
        sourceClass: "raw",
        scope: "private",
        sourcePath: "memory",
        sourceRef: "**/*.md",
        itemCount: 5,
        metadata: {
          recordType: "inventory_preview",
          refreshed: true,
        },
      },
    ]);

    const sources = store.listMemorySources(10, { sourceKind: "memory_notes" });
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      id: "builtin:memory:daily-notes",
      itemCount: 5,
      metadata: expect.objectContaining({
        refreshed: true,
      }),
    });

    store.upsertMemoryScores([
      {
        id: "score:v1_rule_only:chunk:chunk-1",
        targetType: "chunk",
        targetId: "chunk-1",
        sourceId: "builtin:memory:daily-notes",
        scoreTotal: 0.61,
        recencyScore: 0.8,
        sourceWeightScore: 0.7,
        interactionScore: 0.5,
        taskOutcomeScore: 0.4,
        scoreVersion: "v1_rule_only",
        rationale: { step: 1 },
      },
    ]);

    store.upsertMemoryScores([
      {
        id: "score:v1_rule_only:chunk:chunk-1",
        targetType: "chunk",
        targetId: "chunk-1",
        sourceId: "builtin:memory:daily-notes",
        scoreTotal: 0.92,
        recencyScore: 1,
        sourceWeightScore: 0.8,
        interactionScore: 0.9,
        taskOutcomeScore: 0.7,
        scoreVersion: "v1_rule_only",
        rationale: { step: 2 },
      },
    ]);

    const scores = store.listMemoryScores(10, {
      targetType: "chunk",
      targetId: "chunk-1",
      scoreVersion: "v1_rule_only",
    });
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({
      id: "score:v1_rule_only:chunk:chunk-1",
      scoreTotal: 0.92,
      rationale: expect.objectContaining({
        step: 2,
      }),
    });
  });

  it("stores memory clean reports and task tree nodes with edges", () => {
    store.upsertMemoryCleanReports([
      {
        id: "report:inventory:1",
        reportType: "inventory",
        scope: "private",
        status: "ready",
        inputVersion: "v1",
        summary: { sourceKinds: 10 },
        details: { items: [{ id: "builtin:memory:daily-notes" }] },
        createdBy: "test",
      },
    ]);

    const report = store.getMemoryCleanReport("report:inventory:1");
    expect(report).toMatchObject({
      id: "report:inventory:1",
      reportType: "inventory",
      summary: expect.objectContaining({
        sourceKinds: 10,
      }),
    });
    expect(store.listMemoryCleanReports(10, { reportType: "inventory" })).toHaveLength(1);

    store.upsertMemoryTreeNodes([
      {
        id: "task:node-1",
        level: 1,
        kind: "task",
        scope: "private",
        title: "Node 1",
        summary: "Task node summary",
        summaryVersion: "p10-task-node-v1",
        metadata: {
          taskId: "task-1",
        },
      },
    ]);
    store.upsertMemoryTreeEdges([
      {
        id: "edge:task:node-1:chunk-1",
        parentNodeId: "task:node-1",
        childType: "chunk",
        childId: "chunk-1",
        relation: "contains",
        position: 0,
        metadata: {
          relation: "used",
        },
      },
    ]);

    const nodes = store.listMemoryTreeNodes(10, { kind: "task" });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      id: "task:node-1",
      summaryVersion: "p10-task-node-v1",
      metadata: expect.objectContaining({
        taskId: "task-1",
      }),
    });

    const edges = store.listMemoryTreeEdges({ parentNodeId: "task:node-1" });
    expect(edges).toEqual([
      expect.objectContaining({
        id: "edge:task:node-1:chunk-1",
        childId: "chunk-1",
        relation: "contains",
      }),
    ]);
  });
});
