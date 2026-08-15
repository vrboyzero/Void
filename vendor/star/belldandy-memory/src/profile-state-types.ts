export const PROFILE_STATE_SCHEMA_VERSION = "p0-v1";

export type ProfileStateScope = "user" | "assistant" | "shared";
export type ProfileStateStatus = "active" | "deleted";
export type ProfileStateValueType = "string" | "number" | "boolean" | "json" | "null";
export type ProfileStateEventAction = "create" | "update" | "confirm" | "delete";
export type ProfileStateValue = string | number | boolean | Record<string, unknown> | unknown[] | null;
export type ProfileStateSourceRefKind =
  | "conversation"
  | "task"
  | "memory_chunk"
  | "file"
  | "manual"
  | "system";

export interface ProfileStateSourceRef {
  kind: ProfileStateSourceRefKind;
  id?: string;
  sourcePath?: string;
  excerpt?: string;
  note?: string;
}

export interface ProfileStateEntry {
  id: string;
  agentId?: string;
  scope: ProfileStateScope;
  path: string;
  value: ProfileStateValue;
  valueType: ProfileStateValueType;
  confidence?: number;
  status: ProfileStateStatus;
  sourceRefs?: ProfileStateSourceRef[];
  lastConfirmedAt?: string;
  supersededBy?: string;
  contradictedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertProfileStateEntryInput {
  agentId?: string;
  scope?: ProfileStateScope;
  path: string;
  value: ProfileStateValue;
  confidence?: number;
  sourceRefs?: ProfileStateSourceRef[];
  lastConfirmedAt?: string;
  reason?: string;
  createdBy?: string;
}

export interface DeleteProfileStateEntryInput {
  agentId?: string;
  scope?: ProfileStateScope;
  reason?: string;
  createdBy?: string;
  sourceRefs?: ProfileStateSourceRef[];
}

export interface ProfileStateEntryFilter {
  agentId?: string;
  scope?: ProfileStateScope | ProfileStateScope[];
  status?: ProfileStateStatus | ProfileStateStatus[];
  path?: string;
  pathPrefix?: string;
  ids?: string[];
}

export interface ProfileStateEvent {
  id: string;
  entryId: string;
  agentId?: string;
  scope: ProfileStateScope;
  path: string;
  action: ProfileStateEventAction;
  oldValue?: ProfileStateValue;
  newValue?: ProfileStateValue;
  reason?: string;
  sourceRefs?: ProfileStateSourceRef[];
  createdBy?: string;
  createdAt: string;
}

export interface ProfileStateEventFilter {
  agentId?: string;
  scope?: ProfileStateScope | ProfileStateScope[];
  entryId?: string;
  path?: string;
  action?: ProfileStateEventAction | ProfileStateEventAction[];
}

export function normalizeProfileStateScope(value: unknown): ProfileStateScope {
  switch (value) {
    case "assistant":
    case "shared":
    case "user":
      return value;
    default:
      return "user";
  }
}

export function normalizeProfileStateStatus(value: unknown): ProfileStateStatus {
  switch (value) {
    case "deleted":
      return "deleted";
    default:
      return "active";
  }
}

export function normalizeProfileStateEventAction(value: unknown): ProfileStateEventAction {
  switch (value) {
    case "create":
    case "update":
    case "confirm":
    case "delete":
      return value;
    default:
      return "update";
  }
}

export function normalizeProfileStateAgentId(agentId: string | undefined): string {
  const normalized = String(agentId ?? "").trim();
  return normalized || "default";
}

export function normalizeProfileStatePath(path: string): string {
  return String(path ?? "").trim();
}

export function inferProfileStateValueType(value: ProfileStateValue): ProfileStateValueType {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "json";
  }
}

export function clampProfileStateConfidence(confidence: number | undefined): number | undefined {
  if (!Number.isFinite(confidence)) return undefined;
  const normalized = Number(confidence);
  return Math.min(1, Math.max(0, normalized));
}
