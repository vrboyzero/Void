import type { SqliteDatabase } from "./index.js";

const SQLITE_BIND_PARAMETER_BATCH_SIZE = 900;
const TASK_DERIVED_ACTIVITY_LIMIT = 3;

type DatabaseRow = Record<string, unknown>;

export type TaskDerivedDetailBatchRows = {
  taskIds: string[];
  taskRowsById: Map<string, DatabaseRow>;
  recentActivityTitleRowsByTaskId: Map<string, DatabaseRow[]>;
};

/**
 * 只读取派生检索排序和展示需要的 Task 字段。
 * activity 不读取完整记录，每个 task 仅保留最近三条非完成标题。
 */
export function readTaskDerivedDetailBatchRows(
  db: SqliteDatabase,
  taskIds: string[],
): TaskDerivedDetailBatchRows {
  const normalizedTaskIds = normalizeTaskIds(taskIds);
  const result: TaskDerivedDetailBatchRows = {
    taskIds: normalizedTaskIds,
    taskRowsById: new Map(),
    recentActivityTitleRowsByTaskId: new Map(),
  };
  if (normalizedTaskIds.length === 0) {
    return result;
  }

  for (const taskIdBatch of splitIntoBatches(normalizedTaskIds, SQLITE_BIND_PARAMETER_BATCH_SIZE)) {
    const placeholders = taskIdBatch.map(() => "?").join(", ");
    const taskRows = db.prepare(`
      SELECT
        id,
        conversation_id,
        agent_id,
        source,
        title,
        objective,
        summary,
        reflection,
        tool_calls_json,
        artifact_paths_json,
        status,
        started_at,
        finished_at,
        updated_at,
        work_recap_json,
        resume_context_json
      FROM tasks
      WHERE id IN (${placeholders})
    `).all(...taskIdBatch) as DatabaseRow[];
    for (const row of taskRows) {
      result.taskRowsById.set(String(row.id), row);
    }

    const activityRows = db.prepare(`
      SELECT task_id, title
      FROM (
        SELECT
          activity.task_id,
          activity.title,
          ROW_NUMBER() OVER (
            PARTITION BY activity.task_id
            ORDER BY activity.sequence DESC, activity.happened_at DESC, activity.recorded_at DESC
          ) AS task_rank
        FROM task_activities activity
        WHERE activity.task_id IN (${placeholders})
          AND activity.kind <> 'task_completed'
          AND TRIM(activity.title) <> ''
      )
      WHERE task_rank <= ?
      ORDER BY task_id ASC, task_rank ASC
    `).all(...taskIdBatch, TASK_DERIVED_ACTIVITY_LIMIT) as DatabaseRow[];
    appendRowsByTaskId(result.recentActivityTitleRowsByTaskId, activityRows);
  }

  return result;
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

function splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += batchSize) {
    batches.push(items.slice(start, start + batchSize));
  }
  return batches;
}
