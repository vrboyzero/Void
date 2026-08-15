import Database from "better-sqlite3";

import {
  clampProfileStateConfidence,
  inferProfileStateValueType,
  normalizeProfileStateAgentId,
  normalizeProfileStateEventAction,
  normalizeProfileStatePath,
  normalizeProfileStateScope,
  normalizeProfileStateStatus,
  type DeleteProfileStateEntryInput,
  type ProfileStateEntry,
  type ProfileStateEntryFilter,
  type ProfileStateEvent,
  type ProfileStateEventAction,
  type ProfileStateEventFilter,
  type ProfileStateScope,
  type ProfileStateSourceRef,
  type ProfileStateStatus,
  type ProfileStateValue,
  type UpsertProfileStateEntryInput,
} from "./profile-state-types.js";

const PROFILE_STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS profile_state_entries (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL DEFAULT 'default',
  scope TEXT NOT NULL,
  path TEXT NOT NULL,
  value_json TEXT NOT NULL,
  value_type TEXT NOT NULL,
  confidence REAL DEFAULT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  source_refs_json TEXT DEFAULT NULL,
  last_confirmed_at TEXT DEFAULT NULL,
  superseded_by TEXT DEFAULT NULL,
  contradicted_by TEXT DEFAULT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(agent_id, scope, path)
);

CREATE INDEX IF NOT EXISTS idx_profile_state_entries_agent_scope
  ON profile_state_entries(agent_id, scope, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_profile_state_entries_path
  ON profile_state_entries(path);

CREATE TABLE IF NOT EXISTS profile_state_events (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT 'default',
  scope TEXT NOT NULL,
  path TEXT NOT NULL,
  action TEXT NOT NULL,
  old_value_json TEXT DEFAULT NULL,
  new_value_json TEXT DEFAULT NULL,
  reason TEXT DEFAULT NULL,
  source_refs_json TEXT DEFAULT NULL,
  created_by TEXT DEFAULT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profile_state_events_entry
  ON profile_state_events(entry_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_profile_state_events_agent_scope
  ON profile_state_events(agent_id, scope, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_profile_state_events_path
  ON profile_state_events(path);
`;

type ProfileStateMutationResult = {
  changed: boolean;
  entry: ProfileStateEntry;
};

type ProfileStateDeleteResult = {
  changed: boolean;
  entry: ProfileStateEntry | null;
};

type SqlClause = {
  clause: string;
  params: unknown[];
};

export function installProfileStateSchema(db: Database.Database): void {
  db.exec(PROFILE_STATE_SCHEMA);
}

export function upsertProfileStateEntryInDb(
  db: Database.Database,
  input: UpsertProfileStateEntryInput,
): ProfileStateMutationResult {
  const agentId = normalizeProfileStateAgentId(input.agentId);
  const scope = normalizeProfileStateScope(input.scope);
  const profilePath = normalizeProfileStatePath(input.path);
  if (!profilePath) {
    throw new Error("profile state path is required");
  }

  const existing = getProfileStateEntryFromDb(db, profilePath, {
    agentId,
    scope,
    status: ["active", "deleted"],
  });
  const nextValueJson = JSON.stringify(input.value ?? null);
  const nextValueType = inferProfileStateValueType(input.value ?? null);
  const nextConfidence = clampProfileStateConfidence(input.confidence);
  const nextSourceRefsJson = serializeSourceRefs(input.sourceRefs);
  const nextLastConfirmedAt = normalizeOptionalString(input.lastConfirmedAt)
    ?? existing?.lastConfirmedAt
    ?? new Date().toISOString();
  const now = new Date().toISOString();
  const nextAction = resolveUpsertAction(existing, {
    valueJson: nextValueJson,
    confidence: nextConfidence,
    sourceRefsJson: nextSourceRefsJson,
    lastConfirmedAt: nextLastConfirmedAt,
  });

  if (nextAction === null && existing) {
    return {
      changed: false,
      entry: existing,
    };
  }

  const entryId = existing?.id ?? buildProfileStateEntryId(agentId, scope, profilePath);
  const createdAt = existing?.createdAt ?? now;

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO profile_state_entries (
        id, agent_id, scope, path, value_json, value_type, confidence, status,
        source_refs_json, last_confirmed_at, superseded_by, contradicted_by, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, scope, path) DO UPDATE SET
        id = excluded.id,
        value_json = excluded.value_json,
        value_type = excluded.value_type,
        confidence = excluded.confidence,
        status = excluded.status,
        source_refs_json = excluded.source_refs_json,
        last_confirmed_at = excluded.last_confirmed_at,
        superseded_by = excluded.superseded_by,
        contradicted_by = excluded.contradicted_by,
        updated_at = excluded.updated_at
    `).run(
      entryId,
      agentId,
      scope,
      profilePath,
      nextValueJson,
      nextValueType,
      nextConfidence ?? null,
      "active",
      nextSourceRefsJson,
      nextLastConfirmedAt,
      null,
      null,
      createdAt,
      now,
    );

    insertProfileStateEvent(db, {
      id: buildProfileStateEventId(entryId, now),
      entryId,
      agentId,
      scope,
      path: profilePath,
      action: nextAction ?? "update",
      oldValueJson: existing ? JSON.stringify(existing.value ?? null) : JSON.stringify(null),
      newValueJson: nextValueJson,
      reason: normalizeOptionalString(input.reason),
      sourceRefsJson: nextSourceRefsJson,
      createdBy: normalizeOptionalString(input.createdBy),
      createdAt: now,
    });
  });

  tx();

  return {
    changed: true,
    entry: getProfileStateEntryFromDb(db, profilePath, {
      agentId,
      scope,
      status: "active",
    })!,
  };
}

export function deleteProfileStateEntryInDb(
  db: Database.Database,
  path: string,
  input: DeleteProfileStateEntryInput = {},
): ProfileStateDeleteResult {
  const agentId = normalizeProfileStateAgentId(input.agentId);
  const scope = normalizeProfileStateScope(input.scope);
  const profilePath = normalizeProfileStatePath(path);
  if (!profilePath) {
    throw new Error("profile state path is required");
  }

  const existing = getProfileStateEntryFromDb(db, profilePath, {
    agentId,
    scope,
    status: ["active", "deleted"],
  });
  if (!existing) {
    return {
      changed: false,
      entry: null,
    };
  }
  if (existing.status === "deleted") {
    return {
      changed: false,
      entry: existing,
    };
  }

  const now = new Date().toISOString();
  const sourceRefsJson = serializeSourceRefs(input.sourceRefs);
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE profile_state_entries
      SET status = ?, source_refs_json = ?, updated_at = ?
      WHERE agent_id = ? AND scope = ? AND path = ?
    `).run("deleted", sourceRefsJson, now, agentId, scope, profilePath);

    insertProfileStateEvent(db, {
      id: buildProfileStateEventId(existing.id, now),
      entryId: existing.id,
      agentId,
      scope,
      path: profilePath,
      action: "delete",
      oldValueJson: JSON.stringify(existing.value ?? null),
      newValueJson: JSON.stringify(null),
      reason: normalizeOptionalString(input.reason),
      sourceRefsJson,
      createdBy: normalizeOptionalString(input.createdBy),
      createdAt: now,
    });
  });

  tx();

  return {
    changed: true,
    entry: getProfileStateEntryFromDb(db, profilePath, {
      agentId,
      scope,
      status: "deleted",
    }),
  };
}

export function getProfileStateEntryFromDb(
  db: Database.Database,
  path: string,
  filter: Omit<ProfileStateEntryFilter, "path" | "pathPrefix" | "ids"> = {},
): ProfileStateEntry | null {
  const entries = listProfileStateEntriesFromDb(db, 1, {
    ...filter,
    path,
  });
  return entries[0] ?? null;
}

export function listProfileStateEntriesFromDb(
  db: Database.Database,
  limit = 20,
  filter: ProfileStateEntryFilter = {},
): ProfileStateEntry[] {
  const { clause, params } = buildProfileStateEntryClause(filter);
  const rows = db.prepare(`
    SELECT *
    FROM profile_state_entries
    WHERE 1 = 1${clause}
    ORDER BY updated_at DESC, path ASC
    LIMIT ?
  `).all(...params, Math.max(1, Math.floor(limit))) as Array<Record<string, unknown>>;
  return rows.map(rowToProfileStateEntry);
}

export function listProfileStateEventsFromDb(
  db: Database.Database,
  limit = 50,
  filter: ProfileStateEventFilter = {},
): ProfileStateEvent[] {
  const { clause, params } = buildProfileStateEventClause(filter);
  const rows = db.prepare(`
    SELECT *
    FROM profile_state_events
    WHERE 1 = 1${clause}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(...params, Math.max(1, Math.floor(limit))) as Array<Record<string, unknown>>;
  return rows.map(rowToProfileStateEvent);
}

function buildProfileStateEntryClause(filter: ProfileStateEntryFilter): SqlClause {
  const clauseParts: string[] = [];
  const params: unknown[] = [];

  const agentId = normalizeOptionalString(filter.agentId);
  if (agentId) {
    clauseParts.push(" AND agent_id = ?");
    params.push(normalizeProfileStateAgentId(agentId));
  }

  const scopes = normalizeScopeList(filter.scope);
  if (scopes.length > 0) {
    clauseParts.push(` AND scope IN (${scopes.map(() => "?").join(", ")})`);
    params.push(...scopes);
  }

  const statuses = normalizeStatusList(filter.status);
  const effectiveStatuses = statuses.length > 0 ? statuses : ["active"];
  clauseParts.push(` AND status IN (${effectiveStatuses.map(() => "?").join(", ")})`);
  params.push(...effectiveStatuses);

  const profilePath = normalizeOptionalString(filter.path);
  if (profilePath) {
    clauseParts.push(" AND path = ?");
    params.push(profilePath);
  }

  const pathPrefix = normalizeOptionalString(filter.pathPrefix);
  if (pathPrefix) {
    clauseParts.push(" AND path LIKE ?");
    params.push(`${pathPrefix}%`);
  }

  const ids = Array.isArray(filter.ids) ? filter.ids.map((item) => String(item).trim()).filter(Boolean) : [];
  if (ids.length > 0) {
    clauseParts.push(` AND id IN (${ids.map(() => "?").join(", ")})`);
    params.push(...ids);
  }

  return {
    clause: clauseParts.join(""),
    params,
  };
}

function buildProfileStateEventClause(filter: ProfileStateEventFilter): SqlClause {
  const clauseParts: string[] = [];
  const params: unknown[] = [];

  const agentId = normalizeOptionalString(filter.agentId);
  if (agentId) {
    clauseParts.push(" AND agent_id = ?");
    params.push(normalizeProfileStateAgentId(agentId));
  }

  const scopes = normalizeScopeList(filter.scope);
  if (scopes.length > 0) {
    clauseParts.push(` AND scope IN (${scopes.map(() => "?").join(", ")})`);
    params.push(...scopes);
  }

  const entryId = normalizeOptionalString(filter.entryId);
  if (entryId) {
    clauseParts.push(" AND entry_id = ?");
    params.push(entryId);
  }

  const profilePath = normalizeOptionalString(filter.path);
  if (profilePath) {
    clauseParts.push(" AND path = ?");
    params.push(profilePath);
  }

  const actions = normalizeActionList(filter.action);
  if (actions.length > 0) {
    clauseParts.push(` AND action IN (${actions.map(() => "?").join(", ")})`);
    params.push(...actions);
  }

  return {
    clause: clauseParts.join(""),
    params,
  };
}

function insertProfileStateEvent(
  db: Database.Database,
  input: {
    id: string;
    entryId: string;
    agentId: string;
    scope: ProfileStateScope;
    path: string;
    action: ProfileStateEventAction;
    oldValueJson: string | null;
    newValueJson: string | null;
    reason?: string;
    sourceRefsJson?: string | null;
    createdBy?: string;
    createdAt: string;
  },
): void {
  db.prepare(`
    INSERT INTO profile_state_events (
      id, entry_id, agent_id, scope, path, action, old_value_json, new_value_json,
      reason, source_refs_json, created_by, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.entryId,
    input.agentId,
    input.scope,
    input.path,
    input.action,
    input.oldValueJson,
    input.newValueJson,
    input.reason ?? null,
    input.sourceRefsJson ?? null,
    input.createdBy ?? null,
    input.createdAt,
  );
}

function resolveUpsertAction(
  existing: ProfileStateEntry | null,
  next: {
    valueJson: string;
    confidence?: number;
    sourceRefsJson?: string | null;
    lastConfirmedAt: string;
  },
): ProfileStateEventAction | null {
  if (!existing || existing.status === "deleted") {
    return "create";
  }
  const currentValueJson = JSON.stringify(existing.value ?? null);
  const currentSourceRefsJson = serializeSourceRefs(existing.sourceRefs);
  const currentConfidence = clampProfileStateConfidence(existing.confidence);
  const currentLastConfirmedAt = normalizeOptionalString(existing.lastConfirmedAt);
  const changed = currentValueJson !== next.valueJson
    || currentConfidence !== next.confidence
    || currentSourceRefsJson !== next.sourceRefsJson
    || currentLastConfirmedAt !== next.lastConfirmedAt
    || existing.status !== "active";
  if (!changed) {
    return null;
  }
  return currentValueJson === next.valueJson ? "confirm" : "update";
}

function rowToProfileStateEntry(row: Record<string, unknown>): ProfileStateEntry {
  return {
    id: String(row.id),
    agentId: normalizeOptionalString(row.agent_id),
    scope: normalizeProfileStateScope(row.scope),
    path: String(row.path),
    value: parseProfileStateValue(row.value_json) ?? null,
    valueType: normalizeProfileStateValueType(row.value_type),
    confidence: optionalNumber(row.confidence),
    status: normalizeProfileStateStatus(row.status),
    sourceRefs: parseSourceRefs(row.source_refs_json),
    lastConfirmedAt: normalizeOptionalString(row.last_confirmed_at),
    supersededBy: normalizeOptionalString(row.superseded_by),
    contradictedBy: normalizeOptionalString(row.contradicted_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToProfileStateEvent(row: Record<string, unknown>): ProfileStateEvent {
  return {
    id: String(row.id),
    entryId: String(row.entry_id),
    agentId: normalizeOptionalString(row.agent_id),
    scope: normalizeProfileStateScope(row.scope),
    path: String(row.path),
    action: normalizeProfileStateEventAction(row.action),
    oldValue: parseProfileStateValue(row.old_value_json),
    newValue: parseProfileStateValue(row.new_value_json),
    reason: normalizeOptionalString(row.reason),
    sourceRefs: parseSourceRefs(row.source_refs_json),
    createdBy: normalizeOptionalString(row.created_by),
    createdAt: String(row.created_at),
  };
}

function parseProfileStateValue(value: unknown): ProfileStateValue | undefined {
  if (value === null) return null;
  const raw = normalizeOptionalString(value);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as ProfileStateValue;
  } catch {
    return raw;
  }
}

function parseSourceRefs(value: unknown): ProfileStateSourceRef[] | undefined {
  const raw = normalizeOptionalString(value);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    const refs = parsed
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        kind: normalizeProfileStateSourceRefKind((item as Record<string, unknown>).kind),
        id: normalizeOptionalString((item as Record<string, unknown>).id),
        sourcePath: normalizeOptionalString((item as Record<string, unknown>).sourcePath),
        excerpt: normalizeOptionalString((item as Record<string, unknown>).excerpt),
        note: normalizeOptionalString((item as Record<string, unknown>).note),
      }));
    return refs.length > 0 ? refs : undefined;
  } catch {
    return undefined;
  }
}

function serializeSourceRefs(value: ProfileStateSourceRef[] | undefined): string | null {
  if (!Array.isArray(value) || value.length <= 0) {
    return null;
  }
  return JSON.stringify(value);
}

function buildProfileStateEntryId(agentId: string, scope: ProfileStateScope, path: string): string {
  return `profile_state:${encodeURIComponent(agentId)}:${scope}:${encodeURIComponent(path)}`;
}

function buildProfileStateEventId(entryId: string, createdAt: string): string {
  const suffix = `${createdAt}:${Math.random().toString(36).slice(2, 10)}`;
  return `profile_state_event:${encodeURIComponent(entryId)}:${suffix}`;
}

function normalizeScopeList(value: ProfileStateScope | ProfileStateScope[] | undefined): ProfileStateScope[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map((item) => normalizeProfileStateScope(item));
}

function normalizeStatusList(value: ProfileStateStatus | ProfileStateStatus[] | undefined): ProfileStateStatus[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map((item) => normalizeProfileStateStatus(item));
}

function normalizeActionList(
  value: ProfileStateEventAction | ProfileStateEventAction[] | undefined,
): ProfileStateEventAction[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map((item) => normalizeProfileStateEventAction(item));
}

function normalizeProfileStateSourceRefKind(value: unknown): ProfileStateSourceRef["kind"] {
  switch (value) {
    case "conversation":
    case "task":
    case "memory_chunk":
    case "file":
    case "manual":
    case "system":
      return value;
    default:
      return "manual";
  }
}

function normalizeProfileStateValueType(value: unknown): ProfileStateEntry["valueType"] {
  switch (value) {
    case "string":
    case "number":
    case "boolean":
    case "json":
    case "null":
      return value;
    default:
      return "json";
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
