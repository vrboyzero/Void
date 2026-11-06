/**
 * 派活来源（B3）与「沉默账本」（B5）。
 *
 * 这一层回答两个问题：
 *
 * 1. **这次派活是接还是不接？** `live` 正常执行；`observe` 走完解析与授权判断，
 *    只记一条「本来会派什么」，**不建 run、不启子代理**；来源停用时一律不执行。
 * 2. **为什么没动静？** 每次放行、观察、拒绝都落一条账：谁、哪支队伍、几个 lane、
 *    什么原因。没有账本时「军团今天没动静」与「军团在怠工」分不出来。
 *
 * 内向来源（会话里的派活请求）是 B3 的唯一实现；外部 GitHub/飞书来源留到 B8，
 * 但状态机与账本形状先按通用来源设计，避免 B8 再长一套。
 *
 * @module @void/void-legion/dispatch-source
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./atomic-file.js";
import { DispatchPolicyError } from "./dispatch-policy.js";

export const DISPATCH_SOURCE_SCHEMA_VERSION = 1;
export const DISPATCH_SOURCE_FILE_NAME = "dispatch-source.json";
export const DISPATCH_SOURCE_DIRECTORY = "legion";

/** 账本最多保留多少条（更早的靠当日计数，不靠逐条历史）。 */
export const MAX_SOURCE_ENTRIES = 200;
/** 当日计数最多保留多少天；超出只留最近的，防止文件无限长。 */
export const MAX_SOURCE_DAYS = 30;

/**
 * 来源状态机（§22.5）。内向来源实际只用到 ready / paused / off / error；
 * missing / setup / starting 留给 B8 的外部来源，先定义好，面板文案不必改。
 */
export const DISPATCH_SOURCE_STATES = [
  "missing",
  "off",
  "error",
  "setup",
  "starting",
  "paused",
  "ready",
] as const;
export type DispatchSourceState = (typeof DISPATCH_SOURCE_STATES)[number];

export type DispatchSourceMode = "live" | "observe";
export type DispatchOutcome = "observed" | "dispatched" | "filtered";

/** 一条账。任务正文只留预览，不把完整提示词抄进账本。 */
export interface DispatchSourceEntry {
  at: string;
  outcome: DispatchOutcome;
  reason?: string;
  teamId?: string;
  actorId?: string;
  taskPreview?: string;
  lanes?: string[];
  runId?: string;
  detail?: string;
  /** 外部来源（B8）用：哪个渠道。内向来源留空。 */
  channel?: string;
  /**
   * 外部来源的「丢掉」原因（B5）。内向来源不用；留好字段，B8 不必再改账本格式。
   * `channelGone` = 渠道没了；`channelIgnored` = 渠道不在接收范围。
   */
  droppedKind?: "channelGone" | "channelIgnored";
}

export interface DispatchSourceCounts {
  observed: number;
  dispatched: number;
  filtered: number;
}

export interface DispatchSourceDocument {
  schemaVersion: number;
  /** 配置修订号：只有改来源模式/启停才 +1；账本记录不动它。 */
  revision: number;
  updatedAt: string;
  updatedBy: string;
  enabled: boolean;
  mode: DispatchSourceMode;
  /** 按 UTC 日期（YYYY-MM-DD）计。 */
  counts: Record<string, DispatchSourceCounts>;
  entries: DispatchSourceEntry[];
}

/** 读出来的有效视图。`state` 已经把 enabled/mode/损坏三种情况合成了人能读的一档。 */
export interface DispatchSourceSnapshot {
  configured: boolean;
  state: DispatchSourceState;
  reason: string;
  enabled: boolean;
  mode: DispatchSourceMode;
  revision: number;
  today: DispatchSourceCounts;
  counts: Readonly<Record<string, DispatchSourceCounts>>;
  entries: readonly DispatchSourceEntry[];
}

export class DispatchSourceError extends DispatchPolicyError {
  constructor(message: string) {
    super(message);
    this.name = "DispatchSourceError";
  }
}

const EMPTY_COUNTS: DispatchSourceCounts = { observed: 0, dispatched: 0, filtered: 0 };

function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function countsOf(source: Record<string, DispatchSourceCounts> | undefined, day: string): DispatchSourceCounts {
  return source?.[day] ?? { ...EMPTY_COUNTS };
}

export function emptyDispatchSourceSnapshot(now: Date = new Date()): DispatchSourceSnapshot {
  return {
    configured: false,
    // 没配置过 = 沿用既有行为（正常派活），不是 observe。要观察必须显式切。
    state: "ready",
    reason: "还没配置派活来源，默认执行（live）。",
    enabled: true,
    mode: "live",
    revision: 0,
    today: { ...EMPTY_COUNTS },
    counts: {},
    entries: [],
  };
}

export function dispatchSourceSnapshotOf(
  document: DispatchSourceDocument | undefined,
  now: Date = new Date(),
): DispatchSourceSnapshot {
  if (document === undefined) return emptyDispatchSourceSnapshot(now);
  const today = dayOf(now);
  const state: DispatchSourceState = !document.enabled ? "off" : document.mode === "observe" ? "paused" : "ready";
  return {
    configured: true,
    state,
    reason: sourceStateReason(state, document.mode),
    enabled: document.enabled,
    mode: document.mode,
    revision: document.revision,
    today: countsOf(document.counts, today),
    counts: document.counts,
    entries: document.entries,
  };
}

export function sourceStateReason(state: DispatchSourceState, mode: DispatchSourceMode = "live"): string {
  switch (state) {
    case "missing":
      return "来源还没配置：没有可接的入口。";
    case "off":
      return "派活来源已停用：请求只会记账，不会执行。";
    case "error":
      return "派活来源配置损坏：拒绝派活，先修好来源文件。";
    case "setup":
      return "来源还没完成 setup：暂不接活。";
    case "starting":
      return "来源正在启动：暂不接活。";
    case "paused":
      return "观察中（observe）：只记录「本来会派什么」，不建 run、不启子代理。";
    case "ready":
      return mode === "observe"
        ? "观察中（observe）：只记录，不执行。"
        : "执行中（live）：请求按名单、身份与队伍门禁正常派发。";
  }
}

/** 错的来源文件不可信：读失败时也返回一个可展示的 error 视图，不装作 ready。 */
function errorSnapshot(reason: string): DispatchSourceSnapshot {
  return {
    configured: true,
    state: "error",
    reason,
    enabled: false,
    mode: "live",
    revision: 0,
    today: { ...EMPTY_COUNTS },
    counts: {},
    entries: [],
  };
}

// ── 解析与序列化 ───────────────────────────────────────────────────────────

function readObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DispatchSourceError(`派活来源的 ${where} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function readString(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new DispatchSourceError(`派活来源的 ${where}.${key} 必须是非空字符串`);
  }
  return value;
}

function readOptionalString(source: Record<string, unknown>, key: string, where: string): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new DispatchSourceError(`派活来源的 ${where}.${key} 必须是字符串`);
  return value;
}

function readBoolean(source: Record<string, unknown>, key: string, where: string): boolean {
  const value = source[key];
  if (typeof value !== "boolean") throw new DispatchSourceError(`派活来源的 ${where}.${key} 必须是布尔值`);
  return value;
}

function readInteger(source: Record<string, unknown>, key: string, where: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new DispatchSourceError(`派活来源的 ${where}.${key} 必须是非负整数`);
  }
  return value;
}

function readCounts(source: Record<string, unknown>, where: string): Record<string, DispatchSourceCounts> {
  const value = readObject(source[where], where);
  const counts: Record<string, DispatchSourceCounts> = {};
  for (const [day, raw] of Object.entries(value)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new DispatchSourceError(`派活来源的 ${where} 日期不合法: ${day}`);
    const item = readObject(raw, `${where}.${day}`);
    counts[day] = {
      observed: readInteger(item, "observed", `${where}.${day}`),
      dispatched: readInteger(item, "dispatched", `${where}.${day}`),
      filtered: readInteger(item, "filtered", `${where}.${day}`),
    };
  }
  return counts;
}

function parseEntry(value: unknown, index: number): DispatchSourceEntry {
  const where = `entries[${index}]`;
  const source = readObject(value, where);
  const outcome = readString(source, "outcome", where);
  if (outcome !== "observed" && outcome !== "dispatched" && outcome !== "filtered") {
    throw new DispatchSourceError(`派活来源的 ${where}.outcome 不认识: ${outcome}`);
  }
  const entry: DispatchSourceEntry = {
    at: readString(source, "at", where),
    outcome,
  };
  for (const key of ["reason", "teamId", "actorId", "taskPreview", "runId", "detail", "channel"] as const) {
    const text = readOptionalString(source, key, where);
    if (text !== undefined) entry[key] = text;
  }
  const droppedKind = readOptionalString(source, "droppedKind", where);
  if (droppedKind !== undefined) {
    if (droppedKind !== "channelGone" && droppedKind !== "channelIgnored") {
      throw new DispatchSourceError(`派活来源的 ${where}.droppedKind 不认识: ${droppedKind}`);
    }
    entry.droppedKind = droppedKind;
  }
  const lanes = source.lanes;
  if (lanes !== undefined) {
    if (!Array.isArray(lanes) || lanes.some((item) => typeof item !== "string")) {
      throw new DispatchSourceError(`派活来源的 ${where}.lanes 必须是字符串数组`);
    }
    entry.lanes = lanes as string[];
  }
  return entry;
}

export function parseDispatchSourceDocument(text: string): DispatchSourceDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new DispatchSourceError(`派活来源不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const source = readObject(raw, "根");
  if (source.schemaVersion !== DISPATCH_SOURCE_SCHEMA_VERSION) {
    throw new DispatchSourceError(
      `不支持的派活来源版本: ${String(source.schemaVersion)}（本版本只认 ${DISPATCH_SOURCE_SCHEMA_VERSION}）`,
    );
  }
  const mode = readString(source, "mode", "根");
  if (mode !== "live" && mode !== "observe") {
    throw new DispatchSourceError(`派活来源的 mode 不认识: ${mode}（只认 live / observe）`);
  }
  const entries = Array.isArray(source.entries) ? source.entries.map((entry, index) => parseEntry(entry, index)) : [];
  if (entries.length > MAX_SOURCE_ENTRIES) {
    throw new DispatchSourceError(`派活来源账本最多 ${MAX_SOURCE_ENTRIES} 条（文件里有 ${entries.length} 条）`);
  }
  return {
    schemaVersion: DISPATCH_SOURCE_SCHEMA_VERSION,
    revision: readInteger(source, "revision", "根"),
    updatedAt: readString(source, "updatedAt", "根"),
    updatedBy: readString(source, "updatedBy", "根"),
    enabled: readBoolean(source, "enabled", "根"),
    mode,
    counts: readCounts(source, "counts"),
    entries,
  };
}

export function serializeDispatchSourceDocument(document: DispatchSourceDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

// ── 仓库 ───────────────────────────────────────────────────────────────────

export interface DispatchSourceRepositoryOptions {
  dataDir: string;
  now?: (() => Date) | undefined;
}

export class DispatchSourceRepository {
  private readonly dataDir: string;
  private readonly now: () => Date;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: DispatchSourceRepositoryOptions) {
    if (!path.isAbsolute(options.dataDir)) throw new DispatchSourceError("军团数据根必须是绝对路径");
    this.dataDir = path.resolve(options.dataDir);
    this.now = options.now ?? (() => new Date());
  }

  get dataDirPath(): string {
    return this.dataDir;
  }

  get filePath(): string {
    return path.join(this.dataDir, DISPATCH_SOURCE_DIRECTORY, DISPATCH_SOURCE_FILE_NAME);
  }

  async load(): Promise<DispatchSourceDocument | undefined> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new DispatchSourceError(`读取派活来源失败: ${this.filePath}（${error instanceof Error ? error.message : String(error)}）`);
    }
    try {
      return parseDispatchSourceDocument(text);
    } catch (error) {
      throw new DispatchSourceError(`派活来源损坏: ${this.filePath}（${error instanceof Error ? error.message : String(error)}）`);
    }
  }

  /** 严格快照：损坏就抛。工具侧用它判 fail-closed。 */
  async snapshot(): Promise<DispatchSourceSnapshot> {
    return dispatchSourceSnapshotOf(await this.load(), this.now());
  }

  /** 面板侧快照：损坏不抛，返回 state:error 让人看见。 */
  async trySnapshot(): Promise<DispatchSourceSnapshot> {
    try {
      return await this.snapshot();
    } catch (error) {
      return errorSnapshot(error instanceof Error ? error.message : String(error));
    }
  }

  async setMode(input: { mode: DispatchSourceMode; expectedRevision: number }): Promise<DispatchSourceSnapshot> {
    return this.enqueue(async () => {
      const current = await this.load();
      const now = this.now();
      const actual = current?.revision ?? 0;
      if (input.expectedRevision !== actual) {
        throw new DispatchSourceError(`派活来源已被其他保存更新（期望修订 ${input.expectedRevision}，实际 ${actual}），请重读后再改`);
      }
      const next = this.nextConfig(current, now, { mode: input.mode });
      await writeFileAtomic(this.filePath, serializeDispatchSourceDocument(next));
      return dispatchSourceSnapshotOf(next, now);
    });
  }

  async setEnabled(input: { enabled: boolean; expectedRevision: number }): Promise<DispatchSourceSnapshot> {
    return this.enqueue(async () => {
      const current = await this.load();
      const now = this.now();
      const actual = current?.revision ?? 0;
      if (input.expectedRevision !== actual) {
        throw new DispatchSourceError(`派活来源已被其他保存更新（期望修订 ${input.expectedRevision}，实际 ${actual}），请重读后再改`);
      }
      const next = this.nextConfig(current, now, { enabled: input.enabled });
      await writeFileAtomic(this.filePath, serializeDispatchSourceDocument(next));
      return dispatchSourceSnapshotOf(next, now);
    });
  }

  /** 记一条账。**不动配置修订号**——账本记录不该让面板的模式切换撞 409。 */
  async record(entry: Omit<DispatchSourceEntry, "at">): Promise<DispatchSourceSnapshot> {
    return this.enqueue(async () => {
      const current = await this.load();
      const now = this.now();
      const at = now.toISOString();
      const day = dayOf(now);
      const base: DispatchSourceDocument = current ?? {
        schemaVersion: DISPATCH_SOURCE_SCHEMA_VERSION,
        revision: 0,
        updatedAt: at,
        updatedBy: "system",
        enabled: true,
        mode: "live",
        counts: {},
        entries: [],
      };
      const counts = { ...base.counts };
      const today = countsOf(counts, day);
      counts[day] = {
        observed: today.observed + (entry.outcome === "observed" ? 1 : 0),
        dispatched: today.dispatched + (entry.outcome === "dispatched" ? 1 : 0),
        filtered: today.filtered + (entry.outcome === "filtered" ? 1 : 0),
      };
      // 只留最近 MAX_SOURCE_DAYS 天的计数；逐条账保留最近 MAX_SOURCE_ENTRIES 条。
      const days = Object.keys(counts).sort();
      for (const stale of days.slice(0, Math.max(0, days.length - MAX_SOURCE_DAYS))) delete counts[stale];
      const next: DispatchSourceDocument = {
        ...base,
        updatedAt: at,
        counts,
        entries: [...base.entries, { ...entry, at }].slice(-MAX_SOURCE_ENTRIES),
      };
      await writeFileAtomic(this.filePath, serializeDispatchSourceDocument(next));
      return dispatchSourceSnapshotOf(next, now);
    });
  }

  private nextConfig(
    current: DispatchSourceDocument | undefined,
    now: Date,
    patch: { mode?: DispatchSourceMode; enabled?: boolean },
  ): DispatchSourceDocument {
    const base: DispatchSourceDocument = current ?? {
      schemaVersion: DISPATCH_SOURCE_SCHEMA_VERSION,
      revision: 0,
      updatedAt: now.toISOString(),
      updatedBy: "owner",
      enabled: true,
      mode: "live",
      counts: {},
      entries: [],
    };
    return {
      ...base,
      revision: base.revision + 1,
      updatedAt: now.toISOString(),
      updatedBy: "owner",
      ...(patch.mode === undefined ? {} : { mode: patch.mode }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    };
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** 任务正文只留一小段预览：账本是「本来会派什么」的索引，不是第二份提示词库。 */
export function taskPreviewOf(task: string, max = 160): string | undefined {
  const text = task.trim();
  if (text === "") return undefined;
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
