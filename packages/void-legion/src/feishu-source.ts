/**
 * 飞书入站来源（B8-2）：机器人事件 → 准入 → 派活 → 回写。
 *
 * 与 GitHub 源不同，飞书是**事件推送**（WS 长连接），不是轮询；但准入、去重、
 * 账本、observe/live、dispatchExternal、human 验收这些语义与 B8-1 一致。
 *
 * 第一期边界（§23.8）：只做「机器人被 @ / 单聊」的入站，不做全群扫描、不做
 * 配置表单、不引第二套工单库。凭据只存 env 名（appIdEnv/appSecretEnv），
 * 真实值由宿主环境提供。
 *
 * @module @void/void-legion/feishu-source
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./atomic-file.js";
import type { ExternalSourceCounts, ExternalSourceEntry } from "./external-source.js";

export const FEISHU_SOURCE_SCHEMA_VERSION = 1;
export const FEISHU_SOURCE_FILE_NAME = "feishu.json";
export const MAX_FEISHU_SEEN = 500;
const EMPTY_COUNTS: ExternalSourceCounts = { observed: 0, dispatched: 0, filtered: 0, dropped: 0 };

export type FeishuChatRule = "mentions" | "all" | "none";
export type FeishuSourceStatus = "setup" | "starting" | "ready" | "error" | "off";
export type FeishuSourceMode = "observe" | "live";

export class FeishuSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeishuSourceError";
  }
}

export interface FeishuSourceConfig {
  appIdEnv: string;
  appSecretEnv: string;
  domain?: string;
  teamId: string;
  workspace?: string;
  /** 允许下单的发送者 id（open_id/user_id）；空 = 谁都不能下单。 */
  allowed: string[];
  /** 允许触发候选的 bot/app 发送者；空 = 所有 bot 都不接。 */
  bots: string[];
  /** 按群配置；没有列的群按 none。 */
  chats: Record<string, FeishuChatRule>;
  /** 私聊规则。 */
  direct: FeishuChatRule;
}

export interface FeishuSourceRuntime {
  status: FeishuSourceStatus;
  mode: FeishuSourceMode;
  botOpenId?: string;
  lastEventAt?: string;
  lastError?: string;
  lastDeliveryError?: string;
  consecutiveFailures: number;
  seen: string[];
  counts: Record<string, ExternalSourceCounts>;
  entries: ExternalSourceEntry[];
}

export interface FeishuSourceDocument {
  schemaVersion: number;
  revision: number;
  updatedAt: string;
  updatedBy: string;
  config: FeishuSourceConfig;
  runtime: FeishuSourceRuntime;
}

export interface FeishuSourceSnapshot {
  configured: boolean;
  revision: number;
  config: FeishuSourceConfig;
  runtime: FeishuSourceRuntime;
  state: FeishuSourceStatus;
  reason: string;
  today: ExternalSourceCounts;
}

// ── 事件形状与网关 ─────────────────────────────────────────────────────────

export interface FeishuInboundEvent {
  eventId: string;
  messageId: string;
  chatId: string;
  chatType: "group" | "p2p";
  senderId: string;
  senderType: "user" | "bot" | "app";
  text: string;
  mentions: readonly string[];
  timestamp: string;
}

export interface FeishuMember {
  id: string;
  name?: string;
}

/** 真实实现用 Lark SDK 的 WS 长连接；测试用假实现。 */
export interface FeishuGateway {
  checkAuth(): Promise<{ botOpenId: string }>;
  start(onEvent: (event: FeishuInboundEvent) => void): Promise<void>;
  stop(): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<void>;
  listMembers(chatId: string): Promise<FeishuMember[]>;
}

// ── 默认值 / 解析 / 序列化 ─────────────────────────────────────────────────

export function defaultFeishuSourceConfig(input: {
  appIdEnv?: string;
  appSecretEnv?: string;
  teamId: string;
  allowed?: string[];
  bots?: string[];
  chats?: Record<string, FeishuChatRule>;
  direct?: FeishuChatRule;
  workspace?: string;
  domain?: string;
}): FeishuSourceConfig {
  return {
    appIdEnv: input.appIdEnv ?? "VOID_FEISHU_APP_ID",
    appSecretEnv: input.appSecretEnv ?? "VOID_FEISHU_APP_SECRET",
    teamId: input.teamId,
    allowed: [...(input.allowed ?? [])],
    bots: [...(input.bots ?? [])],
    chats: { ...(input.chats ?? {}) },
    direct: input.direct ?? "none",
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    ...(input.domain === undefined ? {} : { domain: input.domain }),
  };
}

export function emptyFeishuRuntime(): FeishuSourceRuntime {
  return {
    status: "setup",
    mode: "observe",
    consecutiveFailures: 0,
    seen: [],
    counts: {},
    entries: [],
  };
}

export function createFeishuSourceDocument(input: {
  config: FeishuSourceConfig;
  now?: Date;
}): FeishuSourceDocument {
  const now = input.now ?? new Date();
  return {
    schemaVersion: FEISHU_SOURCE_SCHEMA_VERSION,
    revision: 0,
    updatedAt: now.toISOString(),
    updatedBy: "owner",
    config: input.config,
    runtime: emptyFeishuRuntime(),
  };
}

function readObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FeishuSourceError(`飞书来源的 ${where} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function readString(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new FeishuSourceError(`飞书来源的 ${where}.${key} 必须是非空字符串`);
  }
  return value;
}

function readOptionalString(source: Record<string, unknown>, key: string, where: string): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new FeishuSourceError(`飞书来源的 ${where}.${key} 必须是字符串`);
  return value;
}

function readStringArray(source: Record<string, unknown>, key: string, where: string): string[] {
  const value = source[key];
  if (!Array.isArray(value)) throw new FeishuSourceError(`飞书来源的 ${where}.${key} 必须是数组`);
  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new FeishuSourceError(`飞书来源的 ${where}.${key}[${index}] 必须是非空字符串`);
    }
    return item;
  });
}

function readRule(value: unknown, where: string): FeishuChatRule {
  if (value !== "mentions" && value !== "all" && value !== "none") {
    throw new FeishuSourceError(`飞书来源的 ${where} 只认 mentions/all/none: ${String(value)}`);
  }
  return value;
}

function parseConfig(value: unknown): FeishuSourceConfig {
  const source = readObject(value, "config");
  const chatsRaw = source.chats;
  const chats: Record<string, FeishuChatRule> = {};
  if (chatsRaw !== undefined) {
    const chatsObject = readObject(chatsRaw, "config.chats");
    for (const [chatId, rule] of Object.entries(chatsObject)) {
      chats[chatId] = readRule(rule, `config.chats.${chatId}`);
    }
  }
  const workspace = readOptionalString(source, "workspace", "config");
  const domain = readOptionalString(source, "domain", "config");
  return {
    appIdEnv: readString(source, "appIdEnv", "config"),
    appSecretEnv: readString(source, "appSecretEnv", "config"),
    teamId: readString(source, "teamId", "config"),
    allowed: readStringArray(source, "allowed", "config"),
    bots: readStringArray(source, "bots", "config"),
    chats,
    direct: source.direct === undefined ? "none" : readRule(source.direct, "config.direct"),
    ...(workspace === undefined ? {} : { workspace }),
    ...(domain === undefined ? {} : { domain }),
  };
}

function parseCounts(value: unknown): Record<string, ExternalSourceCounts> {
  if (value === undefined) return {};
  const source = readObject(value, "runtime.counts");
  const counts: Record<string, ExternalSourceCounts> = {};
  for (const [day, raw] of Object.entries(source)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new FeishuSourceError(`飞书来源的 runtime.counts 日期不合法: ${day}`);
    const item = readObject(raw, `runtime.counts.${day}`);
    const read = (key: string): number => {
      const number = item[key];
      if (typeof number !== "number" || !Number.isInteger(number) || number < 0) {
        throw new FeishuSourceError(`飞书来源的 runtime.counts.${day}.${key} 必须是非负整数`);
      }
      return number;
    };
    counts[day] = { observed: read("observed"), dispatched: read("dispatched"), filtered: read("filtered"), dropped: read("dropped") };
  }
  return counts;
}

function parseEntries(value: unknown): ExternalSourceEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new FeishuSourceError("飞书来源的 runtime.entries 必须是数组");
  return value.map((raw, index) => {
    const where = `runtime.entries[${index}]`;
    const source = readObject(raw, where);
    const outcome = readString(source, "outcome", where);
    if (!["observed", "dispatched", "filtered", "dropped"].includes(outcome)) {
      throw new FeishuSourceError(`飞书来源的 ${where}.outcome 不认识: ${outcome}`);
    }
    const entry: ExternalSourceEntry = { at: readString(source, "at", where), outcome: outcome as ExternalSourceEntry["outcome"] };
    for (const key of ["reason", "channel", "requester", "runId", "eventId", "detail"] as const) {
      const text = readOptionalString(source, key, where);
      if (text !== undefined) entry[key] = text;
    }
    const droppedKind = readOptionalString(source, "droppedKind", where);
    if (droppedKind !== undefined) {
      if (droppedKind !== "channelGone" && droppedKind !== "channelIgnored") {
        throw new FeishuSourceError(`飞书来源的 ${where}.droppedKind 不认识: ${droppedKind}`);
      }
      entry.droppedKind = droppedKind;
    }
    return entry;
  });
}

function parseRuntime(value: unknown): FeishuSourceRuntime {
  if (value === undefined) return emptyFeishuRuntime();
  const source = readObject(value, "runtime");
  const status = readString(source, "status", "runtime");
  if (!["setup", "starting", "ready", "error", "off"].includes(status)) {
    throw new FeishuSourceError(`飞书来源的 runtime.status 不认识: ${status}`);
  }
  const mode = readString(source, "mode", "runtime");
  if (mode !== "observe" && mode !== "live") {
    throw new FeishuSourceError(`飞书来源的 runtime.mode 不认识: ${mode}`);
  }
  const failures = source.consecutiveFailures;
  if (typeof failures !== "number" || !Number.isInteger(failures) || failures < 0) {
    throw new FeishuSourceError("飞书来源的 runtime.consecutiveFailures 必须是非负整数");
  }
  const seen = source.seen === undefined ? [] : readStringArray(source, "seen", "runtime");
  const botOpenId = readOptionalString(source, "botOpenId", "runtime");
  const lastEventAt = readOptionalString(source, "lastEventAt", "runtime");
  const lastError = readOptionalString(source, "lastError", "runtime");
  const lastDeliveryError = readOptionalString(source, "lastDeliveryError", "runtime");
  return {
    status: status as FeishuSourceStatus,
    mode,
    consecutiveFailures: failures,
    seen,
    counts: parseCounts(source.counts),
    entries: parseEntries(source.entries),
    ...(botOpenId === undefined ? {} : { botOpenId }),
    ...(lastEventAt === undefined ? {} : { lastEventAt }),
    ...(lastError === undefined ? {} : { lastError }),
    ...(lastDeliveryError === undefined ? {} : { lastDeliveryError }),
  };
}

export function parseFeishuSourceDocument(text: string): FeishuSourceDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new FeishuSourceError(`飞书来源配置损坏（${error instanceof Error ? error.message : String(error)}）`);
  }
  const source = readObject(raw, "顶层");
  if (source.schemaVersion !== FEISHU_SOURCE_SCHEMA_VERSION) {
    throw new FeishuSourceError(`不支持的飞书来源版本: ${String(source.schemaVersion)}（只认 ${FEISHU_SOURCE_SCHEMA_VERSION}）`);
  }
  const revision = source.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) {
    throw new FeishuSourceError("飞书来源的 revision 必须是非负整数");
  }
  return {
    schemaVersion: FEISHU_SOURCE_SCHEMA_VERSION,
    revision,
    updatedAt: readString(source, "updatedAt", "顶层"),
    updatedBy: readString(source, "updatedBy", "顶层"),
    config: parseConfig(source.config),
    runtime: parseRuntime(source.runtime),
  };
}

export function serializeFeishuSourceDocument(document: FeishuSourceDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function feishuSourceSnapshotOf(document: FeishuSourceDocument, now: Date = new Date()): FeishuSourceSnapshot {
  const today = document.runtime.counts[now.toISOString().slice(0, 10)] ?? { ...EMPTY_COUNTS };
  return {
    configured: true,
    revision: document.revision,
    config: document.config,
    runtime: document.runtime,
    state: document.runtime.status,
    reason: feishuStateReason(document.runtime.status, document.runtime.mode, document.runtime.lastError),
    today,
  };
}

export function feishuStateReason(
  state: FeishuSourceStatus,
  mode: FeishuSourceMode,
  lastError?: string,
): string {
  switch (state) {
    case "setup":
      return lastError === undefined ? "飞书来源还没完成 setup：暂不接活。" : `飞书来源 setup 未完成：${lastError}`;
    case "starting":
      return "飞书来源正在启动：暂不接活。";
    case "ready":
      return mode === "observe"
        ? "观察中（observe）：只记账，不建 run、不启子代理。"
        : "执行中（live）：按 allowed/chats 判定后派活。";
    case "error":
      return lastError === undefined ? "飞书来源出错：暂不接活。" : `飞书来源出错：${lastError}`;
    case "off":
      return "飞书来源已停用：事件不会执行。";
  }
}

// ── 记账 / 去重 ───────────────────────────────────────────────────────────

function recordEntry(
  document: FeishuSourceDocument,
  entry: Omit<ExternalSourceEntry, "at">,
  now: Date,
): FeishuSourceDocument {
  const at = now.toISOString();
  const day = at.slice(0, 10);
  const today = document.runtime.counts[day] ?? { ...EMPTY_COUNTS };
  return {
    ...document,
    updatedAt: at,
    runtime: {
      ...document.runtime,
      counts: { ...document.runtime.counts, [day]: { ...today, [entry.outcome]: today[entry.outcome] + 1 } },
      entries: [...document.runtime.entries, { ...entry, at }].slice(-200),
    },
  };
}

function rememberSeen(document: FeishuSourceDocument, eventId: string): FeishuSourceDocument {
  return {
    ...document,
    runtime: {
      ...document.runtime,
      seen: [...document.runtime.seen.filter((id) => id !== eventId), eventId].slice(-MAX_FEISHU_SEEN),
    },
  };
}

// ── 文件仓库 ───────────────────────────────────────────────────────────────

export class FeishuSourceRepository {
  readonly root: string;
  readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.root = path.join(dataDir, "legion", "sources");
    this.path = path.join(this.root, FEISHU_SOURCE_FILE_NAME);
  }

  async load(): Promise<FeishuSourceDocument | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return parseFeishuSourceDocument(text);
  }

  async save(document: FeishuSourceDocument): Promise<FeishuSourceDocument> {
    return this.enqueue(async () => {
      await writeFileAtomic(this.path, serializeFeishuSourceDocument(document));
      return document;
    });
  }

  async mutate(fn: (document: FeishuSourceDocument) => FeishuSourceDocument): Promise<FeishuSourceDocument> {
    return this.enqueue(async () => {
      const current = await this.load();
      if (current === undefined) throw new FeishuSourceError("飞书来源还没配置");
      const next = fn(current);
      await writeFileAtomic(this.path, serializeFeishuSourceDocument(next));
      return next;
    });
  }

  async trySnapshot(now = new Date()): Promise<FeishuSourceSnapshot | undefined> {
    return this.load()
      .then((document) => document === undefined ? undefined : feishuSourceSnapshotOf(document, now))
      .catch(() => undefined);
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}

// ── 入站处理 ───────────────────────────────────────────────────────────────

export interface FeishuInboxOptions {
  repository: FeishuSourceRepository;
  gateway: FeishuGateway;
  dispatch: (event: FeishuInboundEvent) => Promise<{ runId: string }>;
  onDispatched?: (event: FeishuInboundEvent, runId: string) => void;
  now?: () => Date;
}

export class FeishuInbox {
  private readonly options: FeishuInboxOptions;
  private started = false;

  constructor(options: FeishuInboxOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const document = await this.options.repository.load();
    if (document === undefined || document.runtime.status === "off") return;
    this.started = true;
    try {
      await this.options.repository.mutate((current) => ({
        ...current,
        runtime: { ...current.runtime, status: "starting" },
      }));
      const auth = await this.options.gateway.checkAuth();
      await this.options.gateway.start((event) => {
        void this.handle(event);
      });
      await this.options.repository.mutate((current) => ({
        ...current,
        runtime: { ...current.runtime, status: "ready", botOpenId: auth.botOpenId, consecutiveFailures: 0, lastError: undefined },
      }));
    } catch (error) {
      await this.options.repository.mutate((current) => ({
        ...current,
        runtime: {
          ...current.runtime,
          status: "error",
          consecutiveFailures: current.runtime.consecutiveFailures + 1,
          lastError: describe(error),
        },
      })).catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.options.gateway.stop().catch(() => undefined);
  }

  async handle(event: FeishuInboundEvent): Promise<void> {
    const document = await this.options.repository.load();
    if (document === undefined || document.runtime.status === "off") return;
    if (document.runtime.seen.includes(event.eventId)) return;
    const now = this.options.now?.() ?? new Date();
    const rule = event.chatType === "p2p" ? document.config.direct : document.config.chats[event.chatId] ?? "none";
    const base: Omit<ExternalSourceEntry, "at"> = {
      outcome: "observed",
      channel: `feishu:${event.chatId}`,
      requester: event.senderId,
      eventId: event.eventId,
    };
    if (rule === "none") {
      await this.options.repository.mutate((current) => rememberSeen(recordEntry(current, {
        ...base,
        outcome: "dropped",
        reason: "这个会话不在接收范围",
        droppedKind: "channelIgnored",
      }, now), event.eventId));
      return;
    }
    if (event.senderType !== "user") {
      if (!document.config.bots.includes(event.senderId)) {
        await this.options.repository.mutate((current) => rememberSeen(recordEntry(current, {
          ...base,
          outcome: "dropped",
          reason: "bot 不在 bots 名单",
          droppedKind: "channelIgnored",
        }, now), event.eventId));
        return;
      }
    } else if (!document.config.allowed.some((id) => id === event.senderId)) {
      await this.options.repository.mutate((current) => rememberSeen(recordEntry(current, {
        ...base,
        outcome: "filtered",
        reason: "发起人不在 allowed",
      }, now), event.eventId));
      return;
    }
    if (rule === "mentions" && document.runtime.botOpenId !== undefined && !event.mentions.includes(document.runtime.botOpenId)) {
      await this.options.repository.mutate((current) => rememberSeen(recordEntry(current, {
        ...base,
        outcome: "filtered",
        reason: "没有 @ 到机器人",
      }, now), event.eventId));
      return;
    }
    if (document.runtime.mode === "observe") {
      await this.options.repository.mutate((current) => rememberSeen(recordEntry(current, {
        ...base,
        outcome: "observed",
        reason: "observe：只记录，不执行",
      }, now), event.eventId));
      return;
    }
    try {
      const dispatched = await this.options.dispatch(event);
      await this.options.repository.mutate((current) => rememberSeen(recordEntry(current, {
        ...base,
        outcome: "dispatched",
        runId: dispatched.runId,
        reason: "已派活",
      }, now), event.eventId));
      this.options.onDispatched?.(event, dispatched.runId);
    } catch (error) {
      await this.options.repository.mutate((current) => rememberSeen(recordEntry(current, {
        ...base,
        outcome: "filtered",
        reason: `派活失败：${describe(error)}`,
      }, now), event.eventId));
    }
  }

  async setMode(mode: FeishuSourceMode, expectedRevision: number): Promise<FeishuSourceSnapshot> {
    return this.mutate(expectedRevision, (document) => ({ ...document, runtime: { ...document.runtime, mode } }));
  }

  async setEnabled(enabled: boolean, expectedRevision: number): Promise<FeishuSourceSnapshot> {
    const next = await this.mutate(expectedRevision, (document) => ({
      ...document,
      runtime: { ...document.runtime, status: enabled ? "setup" : "off" },
    }));
    if (enabled) await this.start();
    else await this.stop();
    return next;
  }

  async syncAllowed(chatId: string, expectedRevision: number): Promise<FeishuSourceSnapshot> {
    const members = await this.options.gateway.listMembers(chatId);
    return this.mutate(expectedRevision, (document) => ({
      ...document,
      config: { ...document.config, allowed: members.map((member) => member.id) },
    }));
  }

  async testAuth(): Promise<{ botOpenId: string }> {
    return this.options.gateway.checkAuth();
  }

  private async mutate(
    expectedRevision: number,
    change: (document: FeishuSourceDocument) => FeishuSourceDocument,
  ): Promise<FeishuSourceSnapshot> {
    const next = await this.options.repository.mutate((document) => {
      if (document.revision !== expectedRevision) {
        throw new FeishuSourceError(`飞书来源已被其他保存更新（期望 ${expectedRevision}，实际 ${document.revision}）`);
      }
      return { ...change(document), revision: document.revision + 1, updatedAt: (this.options.now?.() ?? new Date()).toISOString(), updatedBy: "owner" };
    });
    return feishuSourceSnapshotOf(next);
  }
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 500);
}

/** 新建一份默认飞书来源：默认 observe、allowed 空、只接 @。 */
export function createDefaultFeishuDocument(teamId: string, now = new Date()): FeishuSourceDocument {
  return createFeishuSourceDocument({
    config: defaultFeishuSourceConfig({ teamId, direct: "mentions" }),
    now,
  });
}

export const FEISHU_SOURCE_ID = "feishu";
export { randomUUID as feishuRandomId };
