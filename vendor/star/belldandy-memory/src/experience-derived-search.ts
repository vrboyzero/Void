import type {
  ExperienceCandidateListFilter,
  ExperienceCandidateStatus,
  ExperienceCandidateType,
} from "./experience-types.js";
import type { SqliteDatabase } from "./index.js";

export const EXPERIENCE_DERIVED_FTS_MARKER_KEY = "experience_derived_fts_schema_version";
export const EXPERIENCE_DERIVED_FTS_SCHEMA_VERSION = "1";
export const EXPERIENCE_DERIVED_CANDIDATE_LIMIT = 24;
export const EXPERIENCE_DERIVED_DETAIL_LIMIT = 12;
export const EXPERIENCE_DERIVED_MAX_BODY_BYTES = 8 * 1024;
export const EXPERIENCE_DERIVED_MAX_TOTAL_BODY_BYTES = 96 * 1024;

const MAX_BODY_CHARS = Math.floor(EXPERIENCE_DERIVED_MAX_BODY_BYTES / 4);
const MAX_TITLE_CHARS = 256;
const MAX_SUMMARY_CHARS = 512;

const SCHEMA_EXPERIENCE_DERIVED_FTS5 = `
CREATE VIRTUAL TABLE IF NOT EXISTS experience_candidates_fts USING fts5(
  title,
  summary,
  content,
  content='experience_candidates',
  content_rowid='rowid',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS experience_candidates_fts_ai AFTER INSERT ON experience_candidates BEGIN
  INSERT INTO experience_candidates_fts(rowid, title, summary, content)
  VALUES (NEW.rowid, NEW.title, NEW.summary, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS experience_candidates_fts_ad AFTER DELETE ON experience_candidates BEGIN
  INSERT INTO experience_candidates_fts(experience_candidates_fts, rowid, title, summary, content)
  VALUES('delete', OLD.rowid, OLD.title, OLD.summary, OLD.content);
END;

CREATE TRIGGER IF NOT EXISTS experience_candidates_fts_au AFTER UPDATE ON experience_candidates BEGIN
  INSERT INTO experience_candidates_fts(experience_candidates_fts, rowid, title, summary, content)
  VALUES('delete', OLD.rowid, OLD.title, OLD.summary, OLD.content);
  INSERT INTO experience_candidates_fts(rowid, title, summary, content)
  VALUES (NEW.rowid, NEW.title, NEW.summary, NEW.content);
END;
`;

export type ExperienceDerivedCandidate = {
  id: string;
  type: ExperienceCandidateType;
  status: ExperienceCandidateStatus;
  title: string;
  content: string;
  summary?: string;
  qualityScore?: number;
  sourceTaskTitle?: string;
  sourceTaskSummary?: string;
  publishedPath?: string;
  createdAt: string;
  reviewedAt?: string;
  acceptedAt?: string;
};

export type ExperienceDerivedSearchSchemaResult = {
  ready: boolean;
  rebuilt: boolean;
};

export function installExperienceDerivedSearchSchema(input: {
  db: SqliteDatabase;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}): ExperienceDerivedSearchSchemaResult {
  let rebuilt = false;
  try {
    const install = input.db.transaction(() => {
      input.db.exec(SCHEMA_EXPERIENCE_DERIVED_FTS5);
      const candidateCount = readTableCount(input.db, "experience_candidates");
      const ftsCount = readTableCount(input.db, "experience_candidates_fts");
      const marker = input.getMeta(EXPERIENCE_DERIVED_FTS_MARKER_KEY);
      rebuilt = marker !== EXPERIENCE_DERIVED_FTS_SCHEMA_VERSION || ftsCount !== candidateCount;
      if (rebuilt) {
        input.db.exec("INSERT INTO experience_candidates_fts(experience_candidates_fts) VALUES('rebuild')");
      }
      input.setMeta(EXPERIENCE_DERIVED_FTS_MARKER_KEY, EXPERIENCE_DERIVED_FTS_SCHEMA_VERSION);
    });
    install();
    return { ready: true, rebuilt };
  } catch {
    return { ready: false, rebuilt: false };
  }
}

export function searchExperienceDerivedCandidateIds(input: {
  db: SqliteDatabase;
  query: string;
  limit?: number;
  filter?: ExperienceCandidateListFilter;
  useFts: boolean;
}): string[] {
  const tokens = tokenizeForSearch(input.query);
  if (tokens.length === 0) return [];

  const limit = normalizeLimit(input.limit, EXPERIENCE_DERIVED_CANDIDATE_LIMIT);
  const filter = buildCandidateFilter(input.filter);
  if (!filter) return [];

  if (input.useFts) {
    const ftsQuery = buildFtsQuery(tokens);
    try {
      const rows = input.db.prepare(`
        SELECT c.id
        FROM experience_candidates_fts f
        JOIN experience_candidates c ON c.rowid = f.rowid
        ${filter.joinTasks ? "LEFT JOIN tasks t ON t.id = c.task_id" : ""}
        WHERE experience_candidates_fts MATCH ?${filter.clause}
        ORDER BY bm25(experience_candidates_fts), c.id ASC
        LIMIT ?
      `).all(ftsQuery, ...filter.params, limit) as Array<{ id: string }>;
      return rows.map((row) => String(row.id));
    } catch {
      return [];
    }
  }

  const titleSummaryClauses = tokens.map(() => "(c.title LIKE ? ESCAPE '\\' OR COALESCE(c.summary, '') LIKE ? ESCAPE '\\')");
  const titleSummaryParams = tokens.flatMap((token) => {
    const value = `%${escapeLike(token)}%`;
    return [value, value];
  });
  const rows = input.db.prepare(`
    SELECT c.id
    FROM experience_candidates c
    ${filter.joinTasks ? "LEFT JOIN tasks t ON t.id = c.task_id" : ""}
    WHERE ${titleSummaryClauses.join(" AND ")}${filter.clause}
    ORDER BY COALESCE(c.accepted_at, c.reviewed_at, c.created_at) DESC, c.id ASC
    LIMIT ?
  `).all(...titleSummaryParams, ...filter.params, limit) as Array<{ id: string }>;
  return rows.map((row) => String(row.id));
}

export function readExperienceDerivedCandidates(
  db: SqliteDatabase,
  candidateIds: string[],
): ExperienceDerivedCandidate[] {
  const ids = normalizeCandidateIds(candidateIds).slice(0, EXPERIENCE_DERIVED_DETAIL_LIMIT);
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT
      c.id,
      c.type,
      c.status,
      substr(c.title, 1, ${MAX_TITLE_CHARS}) AS title,
      substr(c.content, 1, ${MAX_BODY_CHARS}) AS content,
      substr(c.summary, 1, ${MAX_SUMMARY_CHARS}) AS summary,
      c.quality_score,
      substr(json_extract(c.source_task_snapshot_json, '$.title'), 1, ${MAX_TITLE_CHARS}) AS source_task_title,
      substr(json_extract(c.source_task_snapshot_json, '$.summary'), 1, ${MAX_SUMMARY_CHARS}) AS source_task_summary,
      substr(c.published_path, 1, ${MAX_SUMMARY_CHARS}) AS published_path,
      c.created_at,
      c.reviewed_at,
      c.accepted_at
    FROM experience_candidates c
    WHERE c.id IN (${placeholders})
  `).all(...ids) as Array<Record<string, unknown>>;
  const byId = new Map(rows.map((row) => [String(row.id), rowToExperienceDerivedCandidate(row)]));
  return ids.flatMap((id) => {
    const candidate = byId.get(id);
    return candidate ? [candidate] : [];
  });
}

function buildCandidateFilter(filter?: ExperienceCandidateListFilter): {
  clause: string;
  params: unknown[];
  joinTasks: boolean;
} | null {
  const statuses = normalizeSearchableStatuses(filter?.status);
  if (statuses.length === 0) return null;

  const conditions = [`c.status IN (${statuses.map(() => "?").join(", ")})`];
  const params: unknown[] = [...statuses];
  if (filter?.taskId) {
    conditions.push("c.task_id = ?");
    params.push(filter.taskId);
  }
  if (filter?.type) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    if (types.length > 0) {
      conditions.push(`c.type IN (${types.map(() => "?").join(", ")})`);
      params.push(...types);
    }
  }
  if (filter?.agentId) {
    conditions.push("t.agent_id = ?");
    params.push(filter.agentId);
  }
  conditions.push("COALESCE(json_extract(c.metadata_json, '$.synthesisConsumed.consumed'), 0) <> 1");
  return {
    clause: ` AND ${conditions.join(" AND ")}`,
    params,
    joinTasks: Boolean(filter?.agentId),
  };
}

function normalizeSearchableStatuses(value: ExperienceCandidateListFilter["status"]): ExperienceCandidateStatus[] {
  const requested = value ? (Array.isArray(value) ? value : [value]) : ["accepted", "published"];
  return [...new Set(requested.filter((status) => status === "accepted" || status === "published"))];
}

function normalizeLimit(value: number | undefined, maximum: number): number {
  if (!Number.isFinite(value)) return maximum;
  return Math.max(1, Math.min(maximum, Math.floor(value!)));
}

function normalizeCandidateIds(candidateIds: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidateId of candidateIds) {
    const id = typeof candidateId === "string" ? candidateId.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function rowToExperienceDerivedCandidate(row: Record<string, unknown>): ExperienceDerivedCandidate {
  return {
    id: String(row.id),
    type: String(row.type) as ExperienceCandidateType,
    status: String(row.status) as ExperienceCandidateStatus,
    title: String(row.title ?? ""),
    content: truncateUtf8(String(row.content ?? ""), EXPERIENCE_DERIVED_MAX_BODY_BYTES),
    summary: optionalString(row.summary),
    qualityScore: optionalNumber(row.quality_score),
    sourceTaskTitle: optionalString(row.source_task_title),
    sourceTaskSummary: optionalString(row.source_task_summary),
    publishedPath: optionalString(row.published_path),
    createdAt: String(row.created_at),
    reviewedAt: optionalString(row.reviewed_at),
    acceptedAt: optionalString(row.accepted_at),
  };
}

function readTableCount(db: SqliteDatabase, tableName: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count?: number } | undefined;
  return Math.max(0, Number(row?.count ?? 0));
}

function tokenizeForSearch(raw: string): string[] {
  const tokens: string[] = [];
  tokens.push(...(raw.match(/[A-Za-z0-9_]+/g) ?? []));
  for (const chinese of raw.match(/[\u4e00-\u9fa5]+/g) ?? []) {
    if (chinese.length <= 2) {
      tokens.push(chinese);
    } else {
      tokens.push(chinese.slice(0, 2), chinese.slice(-2));
      if (chinese.length > 4) {
        const mid = Math.floor(chinese.length / 2);
        tokens.push(chinese.slice(mid - 1, mid + 1));
      }
    }
  }
  return [...new Set(tokens)].filter(Boolean);
}

function buildFtsQuery(tokens: string[]): string {
  return tokens.map((token) => `"${token.replace(/"/g, "")}"`).join(" OR ");
}

function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let usedBytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + characterBytes > maximumBytes) break;
    result += character;
    usedBytes += characterBytes;
  }
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
