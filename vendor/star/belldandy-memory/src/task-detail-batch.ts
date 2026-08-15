import type { SqliteDatabase } from "./index.js";

const SQLITE_BIND_PARAMETER_BATCH_SIZE = 900;
const TASK_DETAIL_ACTIVITY_LIMIT = 200;
const TASK_DETAIL_USAGE_LIMIT = 100;

type DatabaseRow = Record<string, unknown>;

export type TaskDetailBatchRows = {
  taskIds: string[];
  taskRowsById: Map<string, DatabaseRow>;
  activityRowsByTaskId: Map<string, DatabaseRow[]>;
  memoryLinkRowsByTaskId: Map<string, DatabaseRow[]>;
  usageRowsByTaskId: Map<string, DatabaseRow[]>;
  usageStatsRowsByAssetType: Map<string, Map<string, DatabaseRow>>;
};

/**
 * 批量读取完整 task detail 所需的行。每个 task 仍保留旧单项 API 的 activity/usage 上限，
 * 避免把一次批量投影意外扩展为全量历史读取。
 */
export function readTaskDetailBatchRows(
  db: SqliteDatabase,
  taskIds: string[],
): TaskDetailBatchRows {
  const normalizedTaskIds = normalizeTaskIds(taskIds);
  const result: TaskDetailBatchRows = {
    taskIds: normalizedTaskIds,
    taskRowsById: new Map(),
    activityRowsByTaskId: new Map(),
    memoryLinkRowsByTaskId: new Map(),
    usageRowsByTaskId: new Map(),
    usageStatsRowsByAssetType: new Map(),
  };
  if (normalizedTaskIds.length === 0) {
    return result;
  }

  for (const taskIdBatch of splitIntoBatches(normalizedTaskIds, SQLITE_BIND_PARAMETER_BATCH_SIZE)) {
    const placeholders = taskIdBatch.map(() => "?").join(", ");
    const taskRows = db.prepare(`
      SELECT *
      FROM tasks
      WHERE id IN (${placeholders})
    `).all(...taskIdBatch) as DatabaseRow[];
    for (const row of taskRows) {
      result.taskRowsById.set(String(row.id), row);
    }

    const activityRows = db.prepare(`
      SELECT *
      FROM (
        SELECT
          activity.*,
          ROW_NUMBER() OVER (
            PARTITION BY activity.task_id
            ORDER BY activity.sequence ASC, activity.happened_at ASC, activity.recorded_at ASC
          ) AS task_rank
        FROM task_activities activity
        WHERE activity.task_id IN (${placeholders})
      )
      WHERE task_rank <= ?
      ORDER BY task_id ASC, sequence ASC, happened_at ASC, recorded_at ASC
    `).all(...taskIdBatch, TASK_DETAIL_ACTIVITY_LIMIT) as DatabaseRow[];
    appendRowsByTaskId(result.activityRowsByTaskId, activityRows);

    const memoryLinkRows = db.prepare(`
      SELECT
        link.task_id,
        link.chunk_id,
        link.relation,
        chunk.source_path,
        chunk.memory_type,
        chunk.visibility,
        chunk.content
      FROM task_memory_links link
      LEFT JOIN chunks chunk ON chunk.id = link.chunk_id
      WHERE link.task_id IN (${placeholders})
      ORDER BY link.task_id ASC, link.rowid ASC
    `).all(...taskIdBatch) as DatabaseRow[];
    appendRowsByTaskId(result.memoryLinkRowsByTaskId, memoryLinkRows);

    const usageRows = db.prepare(`
      SELECT *
      FROM (
        SELECT
          usage.*,
          ROW_NUMBER() OVER (
            PARTITION BY usage.task_id
            ORDER BY usage.created_at DESC
          ) AS task_rank
        FROM experience_usages usage
        WHERE usage.task_id IN (${placeholders})
      )
      WHERE task_rank <= ?
      ORDER BY task_id ASC, created_at DESC
    `).all(...taskIdBatch, TASK_DETAIL_USAGE_LIMIT) as DatabaseRow[];
    appendRowsByTaskId(result.usageRowsByTaskId, usageRows);
  }

  readUsageStatsRows(db, result);
  return result;
}

function readUsageStatsRows(db: SqliteDatabase, result: TaskDetailBatchRows): void {
  const assets = collectUsageAssets(result.usageRowsByTaskId);
  // 每个 asset 需要两个 bind 参数，保留余量给 SQLite 默认参数上限。
  const assetBatchSize = Math.floor(SQLITE_BIND_PARAMETER_BATCH_SIZE / 2);
  for (const assetBatch of splitIntoBatches(assets, assetBatchSize)) {
    const values = assetBatch.map(() => "(?, ?)").join(", ");
    const params = assetBatch.flatMap((asset) => [asset.assetType, asset.assetKey]);
    const rows = db.prepare(`
      WITH requested_assets(asset_type, asset_key) AS (
        VALUES ${values}
      ),
      ranked AS (
        SELECT
          usage.asset_type,
          usage.asset_key,
          usage.source_candidate_id,
          usage.task_id AS last_used_task_id,
          usage.created_at,
          COUNT(*) OVER (
            PARTITION BY usage.asset_type, usage.asset_key
          ) AS usage_count,
          MAX(usage.created_at) OVER (
            PARTITION BY usage.asset_type, usage.asset_key
          ) AS last_used_at,
          ROW_NUMBER() OVER (
            PARTITION BY usage.asset_type, usage.asset_key
            ORDER BY usage.created_at DESC, usage.rowid DESC
          ) AS asset_rank
        FROM experience_usages usage
        INNER JOIN requested_assets asset
          ON asset.asset_type = usage.asset_type
          AND asset.asset_key = usage.asset_key
      )
      SELECT
        ranked.asset_type,
        ranked.asset_key,
        ranked.source_candidate_id,
        ranked.last_used_task_id,
        ranked.usage_count,
        ranked.last_used_at,
        candidate.type AS source_candidate_type,
        candidate.title AS source_candidate_title,
        candidate.status AS source_candidate_status,
        candidate.task_id AS source_candidate_task_id,
        candidate.published_path AS source_candidate_published_path
      FROM ranked
      LEFT JOIN experience_candidates candidate ON candidate.id = ranked.source_candidate_id
      WHERE ranked.asset_rank = 1
    `).all(...params) as DatabaseRow[];
    for (const row of rows) {
      const assetType = String(row.asset_type);
      const assetKey = String(row.asset_key);
      let statsByAssetKey = result.usageStatsRowsByAssetType.get(assetType);
      if (!statsByAssetKey) {
        statsByAssetKey = new Map();
        result.usageStatsRowsByAssetType.set(assetType, statsByAssetKey);
      }
      statsByAssetKey.set(assetKey, row);
    }
  }
}

function normalizeTaskIds(taskIds: string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const taskId of taskIds) {
    if (typeof taskId !== "string") continue;
    const trimmed = taskId.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function appendRowsByTaskId(target: Map<string, DatabaseRow[]>, rows: DatabaseRow[]): void {
  for (const row of rows) {
    const taskId = typeof row.task_id === "string" ? row.task_id : "";
    if (!taskId) continue;
    const current = target.get(taskId);
    if (current) {
      current.push(row);
    } else {
      target.set(taskId, [row]);
    }
  }
}

function collectUsageAssets(usageRowsByTaskId: Map<string, DatabaseRow[]>): Array<{
  assetType: string;
  assetKey: string;
}> {
  const assets: Array<{ assetType: string; assetKey: string }> = [];
  const seen = new Map<string, Set<string>>();
  for (const rows of usageRowsByTaskId.values()) {
    for (const row of rows) {
      const assetType = typeof row.asset_type === "string" ? row.asset_type : "";
      const assetKey = typeof row.asset_key === "string" ? row.asset_key : "";
      if (!assetType || !assetKey) continue;
      const keys = seen.get(assetType) ?? new Set<string>();
      if (keys.has(assetKey)) continue;
      keys.add(assetKey);
      seen.set(assetType, keys);
      assets.push({ assetType, assetKey });
    }
  }
  return assets;
}

function splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += batchSize) {
    batches.push(items.slice(start, start + batchSize));
  }
  return batches;
}
