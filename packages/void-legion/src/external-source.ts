/**
 * 外部触发来源（B8）：配置、运行状态、账本与去重的共同形状。
 *
 * 这一层只回答「来源怎么记」与「哪些字段必须 fail-closed」，不碰 GitHub/飞书协议，
 * 也不启动执行体——协议适配在 `github-source.ts`，执行在 `voidTeam.dispatchExternal`。
 *
 * 三条硬规则（§23.2 / §23.3）：
 * 1. 配置与状态分开：`config` 改动 +1 修订号，`runtime` 的游标/计数/账本不动 revision；
 * 2. 默认全收着：`allowed` 空 = 谁都不能下单，`bots` 空 = 所有 bot 都不接；
 * 3. `mode` 默认 `observe`：外部来源第一次接入只记账，主人显式切 `live` 才执行。
 *
 * @module @void/void-legion/external-source
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./atomic-file.js";

export const EXTERNAL_SOURCE_SCHEMA_VERSION = 1;
export const EXTERNAL_SOURCE_DIRECTORY = "legion/sources";
export const GITHUB_SOURCE_FILE_NAME = "github.json";
export const FEISHU_SOURCE_FILE_NAME = "feishu.json";

/** 账本最多保留多少条；更早的靠当日计数，不靠逐条历史。 */
export const MAX_EXTERNAL_SOURCE_ENTRIES = 200;
/** 当日计数最多保留多少天。 */
export const MAX_EXTERNAL_SOURCE_DAYS = 30;
/** 去重表最多保留多少条。 */
export const MAX_EXTERNAL_SOURCE_SEEN = 500;
/** 一轮最多处理多少条候选；超出直接记 dropped，不让洪峰拖垮宿主。 */
export const MAX_EVENTS_PER_POLL = 10;
/** 轮询间隔下限：默认 1 分钟，允许测试/调试压到 10 秒，但不允许 0。 */
export const MIN_EXTERNAL_SOURCE_INTERVAL_MS = 10_000;
export const DEFAULT_EXTERNAL_SOURCE_INTERVAL_MS = 60_000;

export type ExternalSourceId = "github" | "feishu";
export type ExternalSourceMode = "observe" | "live";
export type ExternalSourceStatus = "setup" | "starting" | "ready" | "error" | "off";
export type ExternalSourceOutcome = "observed" | "dispatched" | "filtered" | "dropped";
export type ExternalReceiveKey = "issues" | "pulls" | "comments" | "ci";
export type ExternalAdmission = "accept" | "reject";

export const EXTERNAL_RECEIVE_KEYS: readonly ExternalReceiveKey[] = ["issues", "pulls", "comments", "ci"];

export class ExternalSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalSourceError";
  }
}

export interface ExternalSourceConfig {
  /** 只服务一个仓库：`owner/name`。 */
  repo: string;
  /** 独立 gh 配置目录；空表示用当前进程的 gh 身份（不推荐）。 */
  ghConfigDir?: string;
  /** token 变量名，不是 token 值。 */
  tokenEnv?: string;
  intervalMs: number;
  /** 接收范围开关；默认全 false（只认通知里的 @/指派/review 请求）。 */
  receive: Record<ExternalReceiveKey, boolean>;
  /** 允许下单的外部账号；空 = 谁都不能下单。 */
  allowed: string[];
  /** 允许触发候选的 bot；空 = 所有 bot 都不接。 */
  bots: string[];
  /** 逐类型准入；默认 issues/pulls/comments accept，ci reject。 */
  admission: Record<ExternalReceiveKey, ExternalAdmission>;
  admissionContextMaxPages: number;
  admissionContextTimeoutMs: number;
  /** 派到哪支队伍。 */
  teamId: string;
  /** 派活父会话的 cwd；缺省用宿主当前工作目录。 */
  workspace?: string;
}

export interface ExternalSourceSeen {
  notificationId: string;
  updatedAt: string;
  commentId?: string;
}

export interface ExternalSourceCounts {
  observed: number;
  dispatched: number;
  filtered: number;
  dropped: number;
}

export interface ExternalSourceEntry {
  at: string;
  outcome: ExternalSourceOutcome;
  reason?: string;
  channel?: string;
  requester?: string;
  runId?: string;
  eventId?: string;
  detail?: string;
  droppedKind?: "channelGone" | "channelIgnored";
}

export interface ExternalSourceRuntime {
  status: ExternalSourceStatus;
  mode: ExternalSourceMode;
  lastPollAt?: string;
  nextPollAt?: string;
  consecutiveFailures: number;
  lastError?: string;
  lastDeliveryError?: string;
  agentLogin?: string;
  seen: ExternalSourceSeen[];
  counts: Record<string, ExternalSourceCounts>;
  entries: ExternalSourceEntry[];
}

export interface ExternalSourceDocument {
  schemaVersion: number;
  revision: number;
  updatedAt: string;
  updatedBy: string;
  config: ExternalSourceConfig;
  runtime: ExternalSourceRuntime;
}

export interface ExternalSourceSnapshot {
  configured: boolean;
  revision: number;
  config: ExternalSourceConfig;
  runtime: ExternalSourceRuntime;
  state: ExternalSourceStatus;
  reason: string;
  today: ExternalSourceCounts;
}

const EMPTY_COUNTS: ExternalSourceCounts = { observed: 0, dispatched: 0, filtered: 0, dropped: 0 };

function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function emptyExternalSourceRuntime(): ExternalSourceRuntime {
  return {
    status: "setup",
    mode: "observe",
    consecutiveFailures: 0,
    seen: [],
    counts: {},
    entries: [],
  };
}

export function defaultExternalSourceConfig(input: {
  repo: string;
  teamId: string;
  workspace?: string;
  intervalMs?: number;
  allowed?: string[];
  bots?: string[];
  ghConfigDir?: string;
  tokenEnv?: string;
}): ExternalSourceConfig {
  return {
    repo: input.repo,
    teamId: input.teamId,
    intervalMs: input.intervalMs ?? DEFAULT_EXTERNAL_SOURCE_INTERVAL_MS,
    receive: { issues: false, pulls: false, comments: false, ci: false },
    allowed: [...(input.allowed ?? [])],
    bots: [...(input.bots ?? [])],
    admission: { issues: "accept", pulls: "accept", comments: "accept", ci: "reject" },
    admissionContextMaxPages: 2,
    admissionContextTimeoutMs: 15_000,
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    ...(input.ghConfigDir === undefined ? {} : { ghConfigDir: input.ghConfigDir }),
    ...(input.tokenEnv === undefined ? {} : { tokenEnv: input.tokenEnv }),
  };
}

export function createExternalSourceDocument(input: {
  config: ExternalSourceConfig;
  now?: Date;
  updatedBy?: string;
}): ExternalSourceDocument {
  const now = input.now ?? new Date();
  return {
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    revision: 0,
    updatedAt: now.toISOString(),
    updatedBy: input.updatedBy ?? "owner",
    config: input.config,
    runtime: emptyExternalSourceRuntime(),
  };
}

// ── 解析 ───────────────────────────────────────────────────────────────────

function readObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ExternalSourceError(`外部来源的 ${where} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function readString(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ExternalSourceError(`外部来源的 ${where}.${key} 必须是非空字符串`);
  }
  return value;
}

function readOptionalString(source: Record<string, unknown>, key: string, where: string): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ExternalSourceError(`外部来源的 ${where}.${key} 必须是字符串`);
  return value;
}

function readBoolean(source: Record<string, unknown>, key: string, where: string): boolean {
  const value = source[key];
  if (typeof value !== "boolean") throw new ExternalSourceError(`外部来源的 ${where}.${key} 必须是布尔值`);
  return value;
}

function readInteger(source: Record<string, unknown>, key: string, where: string, min = 0): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new ExternalSourceError(`外部来源的 ${where}.${key} 必须是 ≥${min} 的整数`);
  }
  return value;
}

function readStringArray(source: Record<string, unknown>, key: string, where: string): string[] {
  const value = source[key];
  if (!Array.isArray(value)) throw new ExternalSourceError(`外部来源的 ${where}.${key} 必须是数组`);
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new ExternalSourceError(`外部来源的 ${where}.${key}[${index}] 必须是非空字符串`);
    }
    result.push(item);
  }
  return result;
}

function readReceive(source: Record<string, unknown>, where: string): Record<ExternalReceiveKey, boolean> {
  const result = { issues: false, pulls: false, comments: false, ci: false };
  const value = source[where];
  if (value === undefined) return result;
  const item = readObject(value, where);
  for (const key of EXTERNAL_RECEIVE_KEYS) {
    if (item[key] !== undefined) result[key] = readBoolean(item, key, where);
  }
  return result;
}

function readAdmission(source: Record<string, unknown>, where: string): Record<ExternalReceiveKey, ExternalAdmission> {
  const result: Record<ExternalReceiveKey, ExternalAdmission> = {
    issues: "accept",
    pulls: "accept",
    comments: "accept",
    ci: "reject",
  };
  const value = source[where];
  if (value === undefined) return result;
  const item = readObject(value, where);
  for (const key of EXTERNAL_RECEIVE_KEYS) {
    const raw = item[key];
    if (raw === undefined) continue;
    if (raw !== "accept" && raw !== "reject") {
      throw new ExternalSourceError(`外部来源的 ${where}.${key} 不认识: ${String(raw)}`);
    }
    result[key] = raw;
  }
  return result;
}

function parseConfig(value: unknown): ExternalSourceConfig {
  const source = readObject(value, "config");
  const repo = readString(source, "repo", "config");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new ExternalSourceError(`外部来源的 config.repo 必须是 owner/name: ${repo}`);
  }
  const intervalMs = readInteger(source, "intervalMs", "config", MIN_EXTERNAL_SOURCE_INTERVAL_MS);
  const teamId = readString(source, "teamId", "config");
  const maxPages = readInteger(source, "admissionContextMaxPages", "config", 1);
  const timeoutMs = readInteger(source, "admissionContextTimeoutMs", "config", 1);
  const ghConfigDir = readOptionalString(source, "ghConfigDir", "config");
  const tokenEnv = readOptionalString(source, "tokenEnv", "config");
  const workspace = readOptionalString(source, "workspace", "config");
  return {
    repo,
    teamId,
    intervalMs,
    receive: readReceive(source, "receive"),
    allowed: readStringArray(source, "allowed", "config"),
    bots: readStringArray(source, "bots", "config"),
    admission: readAdmission(source, "admission"),
    admissionContextMaxPages: maxPages,
    admissionContextTimeoutMs: timeoutMs,
    ...(ghConfigDir === undefined ? {} : { ghConfigDir }),
    ...(tokenEnv === undefined ? {} : { tokenEnv }),
    ...(workspace === undefined ? {} : { workspace }),
  };
}

function parseSeen(value: unknown): ExternalSourceSeen[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ExternalSourceError("外部来源的 runtime.seen 必须是数组");
  return value.map((item, index) => {
    const source = readObject(item, `runtime.seen[${index}]`);
    return {
      notificationId: readString(source, "notificationId", `runtime.seen[${index}]`),
      updatedAt: readString(source, "updatedAt", `runtime.seen[${index}]`),
      ...(readOptionalString(source, "commentId", `runtime.seen[${index}]`) === undefined
        ? {}
        : { commentId: readOptionalString(source, "commentId", `runtime.seen[${index}]`) }),
    };
  });
}

function parseCounts(value: unknown): Record<string, ExternalSourceCounts> {
  if (value === undefined) return {};
  const source = readObject(value, "runtime.counts");
  const counts: Record<string, ExternalSourceCounts> = {};
  for (const [day, raw] of Object.entries(source)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ExternalSourceError(`外部来源的 runtime.counts 日期不合法: ${day}`);
    const item = readObject(raw, `runtime.counts.${day}`);
    counts[day] = {
      observed: readInteger(item, "observed", `runtime.counts.${day}`),
      dispatched: readInteger(item, "dispatched", `runtime.counts.${day}`),
      filtered: readInteger(item, "filtered", `runtime.counts.${day}`),
      dropped: readInteger(item, "dropped", `runtime.counts.${day}`),
    };
  }
  return counts;
}

function parseEntries(value: unknown): ExternalSourceEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ExternalSourceError("外部来源的 runtime.entries 必须是数组");
  return value.map((item, index) => {
    const where = `runtime.entries[${index}]`;
    const source = readObject(item, where);
    const outcome = readString(source, "outcome", where);
    if (outcome !== "observed" && outcome !== "dispatched" && outcome !== "filtered" && outcome !== "dropped") {
      throw new ExternalSourceError(`外部来源的 ${where}.outcome 不认识: ${outcome}`);
    }
    const entry: ExternalSourceEntry = { at: readString(source, "at", where), outcome };
    for (const key of ["reason", "channel", "requester", "runId", "eventId", "detail"] as const) {
      const text = readOptionalString(source, key, where);
      if (text !== undefined) entry[key] = text;
    }
    const droppedKind = readOptionalString(source, "droppedKind", where);
    if (droppedKind !== undefined) {
      if (droppedKind !== "channelGone" && droppedKind !== "channelIgnored") {
        throw new ExternalSourceError(`外部来源的 ${where}.droppedKind 不认识: ${droppedKind}`);
      }
      entry.droppedKind = droppedKind;
    }
    return entry;
  });
}

function parseRuntime(value: unknown): ExternalSourceRuntime {
  if (value === undefined) return emptyExternalSourceRuntime();
  const source = readObject(value, "runtime");
  const status = readString(source, "status", "runtime");
  if (!["setup", "starting", "ready", "error", "off"].includes(status)) {
    throw new ExternalSourceError(`外部来源的 runtime.status 不认识: ${status}`);
  }
  const mode = readString(source, "mode", "runtime");
  if (mode !== "observe" && mode !== "live") {
    throw new ExternalSourceError(`外部来源的 runtime.mode 不认识: ${mode}`);
  }
  return {
    status: status as ExternalSourceStatus,
    mode,
    consecutiveFailures: readInteger(source, "consecutiveFailures", "runtime"),
    seen: parseSeen(source.seen),
    counts: parseCounts(source.counts),
    entries: parseEntries(source.entries),
    ...(readOptionalString(source, "lastPollAt", "runtime") === undefined
      ? {}
      : { lastPollAt: readOptionalString(source, "lastPollAt", "runtime") }),
    ...(readOptionalString(source, "nextPollAt", "runtime") === undefined
      ? {}
      : { nextPollAt: readOptionalString(source, "nextPollAt", "runtime") }),
    ...(readOptionalString(source, "lastError", "runtime") === undefined
      ? {}
      : { lastError: readOptionalString(source, "lastError", "runtime") }),
    ...(readOptionalString(source, "lastDeliveryError", "runtime") === undefined
      ? {}
      : { lastDeliveryError: readOptionalString(source, "lastDeliveryError", "runtime") }),
    ...(readOptionalString(source, "agentLogin", "runtime") === undefined
      ? {}
      : { agentLogin: readOptionalString(source, "agentLogin", "runtime") }),
  };
}

export function parseExternalSourceDocument(text: string): ExternalSourceDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ExternalSourceError(`外部来源配置损坏（${error instanceof Error ? error.message : String(error)}）`);
  }
  const source = readObject(raw, "顶层");
  if (source.schemaVersion !== EXTERNAL_SOURCE_SCHEMA_VERSION) {
    throw new ExternalSourceError(`不支持的外部来源版本: ${String(source.schemaVersion)}（只认 ${EXTERNAL_SOURCE_SCHEMA_VERSION}）`);
  }
  return {
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    revision: readInteger(source, "revision", "顶层"),
    updatedAt: readString(source, "updatedAt", "顶层"),
    updatedBy: readString(source, "updatedBy", "顶层"),
    config: parseConfig(source.config),
    runtime: parseRuntime(source.runtime),
  };
}

export function serializeExternalSourceDocument(document: ExternalSourceDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function externalSourceSnapshotOf(document: ExternalSourceDocument, now: Date = new Date()): ExternalSourceSnapshot {
  const today = document.runtime.counts[dayOf(now)] ?? { ...EMPTY_COUNTS };
  const state = document.runtime.status;
  return {
    configured: true,
    revision: document.revision,
    config: document.config,
    runtime: document.runtime,
    state,
    reason: externalSourceStateReason(state, document.runtime.mode, document.runtime.lastError),
    today,
  };
}

export function externalSourceStateReason(
  state: ExternalSourceStatus,
  mode: ExternalSourceMode,
  lastError?: string,
): string {
  switch (state) {
    case "setup":
      return lastError === undefined ? "来源还没完成 setup：暂不接活。" : `来源 setup 未完成：${lastError}`;
    case "starting":
      return "来源正在启动：暂不接活。";
    case "ready":
      return mode === "observe"
        ? "观察中（observe）：只记账，不建 run、不启子代理。"
        : "执行中（live）：按 allowed/admission 判定后派活。";
    case "error":
      return lastError === undefined ? "来源出错：暂不接活。" : `来源出错：${lastError}`;
    case "off":
      return "来源已停用：请求只会记账，不执行。";
  }
}

/** 记一条账：不动 config revision；counts 按 UTC 日累加，entries 截断到上限。 */
export function recordExternalSourceOutcome(
  document: ExternalSourceDocument,
  entry: Omit<ExternalSourceEntry, "at">,
  now: Date = new Date(),
): ExternalSourceDocument {
  const at = now.toISOString();
  const day = dayOf(now);
  const counts = { ...document.runtime.counts };
  const today = counts[day] ?? { ...EMPTY_COUNTS };
  counts[day] = { ...today, [entry.outcome]: today[entry.outcome] + 1 };
  const cutoff = new Date(now.getTime() - MAX_EXTERNAL_SOURCE_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const key of Object.keys(counts)) {
    if (key < cutoff) delete counts[key];
  }
  return {
    ...document,
    updatedAt: at,
    runtime: {
      ...document.runtime,
      counts,
      entries: [...document.runtime.entries, { ...entry, at }].slice(-MAX_EXTERNAL_SOURCE_ENTRIES),
    },
  };
}

/** 去重键：通知 id + 更新时间 + 最新评论 id。 */
export function externalSeenKey(seen: { notificationId: string; updatedAt: string; commentId?: string }): string {
  return `${seen.notificationId}\u0000${seen.updatedAt}\u0000${seen.commentId ?? ""}`;
}

export function hasSeenExternalEvent(document: ExternalSourceDocument, key: ExternalSourceSeen): boolean {
  const needle = externalSeenKey(key);
  return document.runtime.seen.some((item) => externalSeenKey(item) === needle);
}

export function rememberExternalSeen(document: ExternalSourceDocument, seen: ExternalSourceSeen): ExternalSourceDocument {
  const key = externalSeenKey(seen);
  const filtered = document.runtime.seen.filter((item) => externalSeenKey(item) !== key);
  return {
    ...document,
    runtime: {
      ...document.runtime,
      seen: [...filtered, seen].slice(-MAX_EXTERNAL_SOURCE_SEEN),
    },
  };
}

// ── 文件仓库 ───────────────────────────────────────────────────────────────

export interface ExternalSourceRepositoryOptions {
  dataDir: string;
  now?: () => Date;
}

export class ExternalSourceRepository {
  readonly root: string;
  private readonly filePath: string;
  private readonly now: () => Date;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: ExternalSourceRepositoryOptions) {
    this.root = path.join(options.dataDir, ...EXTERNAL_SOURCE_DIRECTORY.split("/"));
    this.filePath = path.join(this.root, GITHUB_SOURCE_FILE_NAME);
    this.now = options.now ?? (() => new Date());
  }

  get path(): string {
    return this.filePath;
  }

  async load(): Promise<ExternalSourceDocument | undefined> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return parseExternalSourceDocument(text);
  }

  async save(document: ExternalSourceDocument): Promise<ExternalSourceDocument> {
    return this.enqueue(async () => {
      await writeFileAtomic(this.filePath, serializeExternalSourceDocument(document));
      return document;
    });
  }

  /** 状态/账本/去重写入串行化，避免轮询与面板动作互相覆盖。 */
  async mutate(fn: (document: ExternalSourceDocument) => ExternalSourceDocument | undefined): Promise<ExternalSourceDocument> {
    return this.enqueue(async () => {
      const current = await this.load();
      if (current === undefined) throw new ExternalSourceError("外部来源还没配置");
      const next = fn(current);
      if (next === undefined) return current;
      await writeFileAtomic(this.filePath, serializeExternalSourceDocument(next));
      return next;
    });
  }

  /**
   * 允许「首次配置」：文件不存在时把 `undefined` 交给回调，由回调决定新建什么。
   *
   * 面板要在没有 `github.json` 时也能保存第一份配置；`mutate` 的「没配置就拒绝」
   * 语义不能放宽（轮询/账本写入必须 fail-closed），所以单独开一条口子。
   */
  async upsert(
    fn: (document: ExternalSourceDocument | undefined) => ExternalSourceDocument,
  ): Promise<ExternalSourceDocument> {
    return this.enqueue(async () => {
      const current = await this.load();
      const next = fn(current);
      await writeFileAtomic(this.filePath, serializeExternalSourceDocument(next));
      return next;
    });
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  /** 面板侧：坏文件不抛，返回 error 快照（由调用方决定怎么显示）。 */
  trySnapshot(): Promise<ExternalSourceSnapshot | undefined> {
    return this.load()
      .then((document) => document === undefined ? undefined : externalSourceSnapshotOf(document, this.now()))
      .catch(() => undefined);
  }
}

export function externalSourceFilePath(dataDir: string, id: ExternalSourceId = "github"): string {
  const name = id === "github" ? GITHUB_SOURCE_FILE_NAME : FEISHU_SOURCE_FILE_NAME;
  return path.join(dataDir, ...EXTERNAL_SOURCE_DIRECTORY.split("/"), name);
}
