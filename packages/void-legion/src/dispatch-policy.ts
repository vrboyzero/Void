/**
 * 派活名单：把「谁能派活」从插件配置里搬出来，变成一份带修订号的运营数据。
 *
 * 这一层**只收窄，不放宽**（方案文档 §22.3 第 1 条边界）：
 * 派活仍然要同时通过 `authority.ts` 的身份许可与队伍 `mayDirect`，名单是第三道
 * 交集条件。名单里没有的人一定派不动；名单里有的人也不一定能派——另外两道照旧判。
 *
 * 三条硬规则：
 *
 * 1. **默认收着**：没有配置文件、或名单为空，都按「当前没人能派活」处理，绝不静默
 *    变成全放行（§22.3 第 2 条）。
 * 2. **改名单是管理动作**：面板（主人通道）随时可改；Agent 只有在 `mode: "agent"`
 *    且持有一份未过期、未撤销、范围匹配的授权时才能改（§22.10 第 2 条）。
 * 3. **写盘带修订号**：每次改动 `revision + 1`，面板拿旧修订保存会被 409 挡住；
 *    改动同时留下「谁改的、依据哪份授权」的痕迹。
 *
 * @module @void/void-legion/dispatch-policy
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./atomic-file.js";

/** 派活名单落盘格式版本。与队伍配置分版本：它们是两份独立的文件。 */
export const DISPATCH_POLICY_SCHEMA_VERSION = 1;

/** 数据根下的相对路径：与 `legion/teams`、`legion/runs` 同族。 */
export const DISPATCH_POLICY_FILE_NAME = "dispatch-policy.json";
export const DISPATCH_POLICY_DIRECTORY = "legion";

/** 面板里的派活名单是「全档案共用一份」，所以只有一个固定条目。 */
export const DISPATCH_POLICY_ITEM_ID = "dispatch";

/** 名单最多几个档案。不是业务上限，只是防止有人把整份档案库灌进来。 */
export const MAX_POLICY_ALLOWLIST = 64;
/** 授权记录最多几份（撤销的也算，留 Audit）。 */
export const MAX_POLICY_GRANTS = 64;
/** 留痕最多保留最近多少条。面板只展示最近 20 条。 */
export const MAX_POLICY_HISTORY = 100;

/**
 * Agent 档案 id 的形状。必须与 void-soul 的 `ID_PATTERN` 一致：
 * 名单里写的是档案 id，不是显示名、不是会话 id。
 */
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const GRANT_ID_PATTERN = /^grant-[A-Za-z0-9-]{1,96}$/;

export class DispatchPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchPolicyError";
  }
}

/** 谁能改名单。`owner` = 只有面板；`agent` = 面板 + 已授权的 Agent。 */
export type DispatchPolicyMode = "owner" | "agent";

/**
 * 授权的范围。B1 时期只有内向派活一种源/名单；字段先留成结构化，
 * 将来 B3/B8 加 Source 时按范围判，不用把授权改成「一开就通吃」。
 */
export interface DispatchPolicyGrantScope {
  source: "internal";
  lists: readonly "dispatch"[];
}

export interface DispatchPolicyGrant {
  grantId: string;
  /** 授权人。当前只有主人；将来别的主体要显式加，不伪装成主人。 */
  grantedBy: "owner";
  /** 被授权的 Agent 档案 id。 */
  agentId: string;
  scope: DispatchPolicyGrantScope;
  createdAt: string;
  /** 到期时间；缺省表示不过期。 */
  expiresAt?: string;
  /** 撤销时间；缺省表示未撤销。撤销记录不删，留痕。 */
  revokedAt?: string;
}

export type DispatchPolicyEventAction = "save" | "grant" | "revoke" | "mode";

/** 改动留痕。`actor` 是 `owner` 或 `agent:<档案 id>`，绝不把 Agent 动作伪装成主人。 */
export interface DispatchPolicyEvent {
  at: string;
  action: DispatchPolicyEventAction;
  actor: string;
  grantId?: string;
  detail: string;
}

/** 落盘的完整文档。 */
export interface DispatchPolicyDocument {
  schemaVersion: number;
  revision: number;
  updatedAt: string;
  updatedBy: string;
  mode: DispatchPolicyMode;
  allowlist: string[];
  grants: DispatchPolicyGrant[];
  history: DispatchPolicyEvent[];
}

/**
 * 读出来的有效视图。`configured` 用于区分「还没保存过」与「保存了一份空名单」：
 * 两者都不放行，但面板要说清是哪一种，否则人会以为保存失败了。
 */
export interface DispatchPolicySnapshot {
  configured: boolean;
  revision: number;
  updatedAt?: string;
  updatedBy?: string;
  mode: DispatchPolicyMode;
  allowlist: readonly string[];
  grants: readonly DispatchPolicyGrant[];
  history: readonly DispatchPolicyEvent[];
}

export class DispatchPolicyConflictError extends DispatchPolicyError {
  constructor(message: string) {
    super(message);
    this.name = "DispatchPolicyConflictError";
  }
}

export function emptyDispatchPolicySnapshot(): DispatchPolicySnapshot {
  return {
    configured: false,
    revision: 0,
    mode: "owner",
    allowlist: [],
    grants: [],
    history: [],
  };
}

export function dispatchPolicySnapshotOf(document: DispatchPolicyDocument | undefined): DispatchPolicySnapshot {
  if (document === undefined) return emptyDispatchPolicySnapshot();
  return {
    configured: true,
    revision: document.revision,
    updatedAt: document.updatedAt,
    updatedBy: document.updatedBy,
    mode: document.mode,
    allowlist: document.allowlist,
    grants: document.grants,
    history: document.history,
  };
}

/** 有效的授权：未撤销、未过期、范围覆盖内向派活名单。 */
export function activePolicyGrants(policy: DispatchPolicySnapshot, now: Date = new Date()): DispatchPolicyGrant[] {
  const at = now.getTime();
  return policy.grants.filter((grant) => grantIsActive(grant, at));
}

/** 到期时间读不懂也按「已失效」处理：一份坏授权不能被当成永久授权。 */
function grantIsExpired(grant: DispatchPolicyGrant, at: number): boolean {
  if (grant.expiresAt === undefined) return false;
  const expires = Date.parse(grant.expiresAt);
  return Number.isNaN(expires) || expires <= at;
}

function grantIsActive(grant: DispatchPolicyGrant, at: number): boolean {
  if (grant.revokedAt !== undefined) return false;
  if (grantIsExpired(grant, at)) return false;
  return grant.scope.source === "internal" && grant.scope.lists.includes("dispatch");
}

/** 某个 Agent 当前的有效授权；没有就返回 undefined。 */
export function activePolicyGrantFor(
  policy: DispatchPolicySnapshot,
  agentId: string,
  now: Date = new Date(),
): DispatchPolicyGrant | undefined {
  if (policy.mode !== "agent") return undefined;
  return policy.grants.find((grant) => grant.agentId === agentId && grantIsActive(grant, now.getTime()));
}

/**
 * 派活门槛：名单为空/未配置都拒绝，名单里没有这个人也拒绝。
 *
 * @returns 拒绝原因；`undefined` 表示名单这一关放行（另外两道权威还要照旧判）。
 */
export function dispatchDenialReason(input: {
  policy: DispatchPolicySnapshot;
  actorId: string;
  now?: Date;
}): string | undefined {
  const actorId = input.actorId.trim();
  if (actorId === "") return "派活缺少发起者档案 id";
  if (input.policy.allowlist.length === 0) {
    return input.policy.configured
      ? "派活名单为空：当前没人能派活（在「虚空(Void) Agents → 派活名单」里加一个档案并保存）"
      : "派活名单还没配置：当前没人能派活（打开「虚空(Void) Agents → 派活名单」加一个档案并保存）";
  }
  if (!input.policy.allowlist.includes(actorId)) {
    return `派活名单里没有 ${actorId}：名单由主人在「虚空(Void) Agents → 派活名单」维护，移出后当场生效`;
  }
  return undefined;
}

/** 改名单的门槛；拒绝时一定说清是「没放开」还是「没有有效授权」。 */
export function policyEditDenialReason(input: {
  policy: DispatchPolicySnapshot;
  actorId: string;
  now?: Date;
}): string | undefined {
  const actorId = input.actorId.trim();
  if (actorId === "") return "改派活名单缺少发起者档案 id";
  if (input.policy.mode !== "agent") {
    return "只有主人能在面板里改派活名单（当前没有放开 Agent 改名单）";
  }
  if (activePolicyGrantFor(input.policy, actorId, input.now) === undefined) {
    return `Agent ${actorId} 没有有效的改名单授权（可能已过期、已撤销，或不在授权范围内）`;
  }
  return undefined;
}

/** 取出授权；没有就抛，带可读原因。 */
export function requirePolicyEditGrant(
  policy: DispatchPolicySnapshot,
  actorId: string,
  now: Date = new Date(),
): DispatchPolicyGrant {
  const reason = policyEditDenialReason({ policy, actorId, now });
  if (reason !== undefined) throw new DispatchPolicyError(reason);
  const grant = activePolicyGrantFor(policy, actorId, now);
  if (grant === undefined) throw new DispatchPolicyError(`Agent ${actorId} 没有有效的改名单授权`);
  return grant;
}

/** 名单条目的形状校验。写盘、工具、面板三条路共用同一个判据。 */
export function assertDispatchPolicyAgentId(value: string): string {
  const id = value.trim();
  if (id === "") throw new DispatchPolicyError("派活名单里的档案 id 不能为空");
  if (!AGENT_ID_PATTERN.test(id)) {
    throw new DispatchPolicyError(`派活名单里的档案 id 不合法: ${value}（只接受字母、数字、下划线与连字符，最长 64 位）`);
  }
  return id;
}

/**
 * 规范化交上来的名单：去空行、去首尾空白、去重、逐条校验形状。
 *
 * 面板的行表格整组提交，用户清空一行再保存就是「移掉这个账号」——空行必须按
 * 不存在处理，不能写进磁盘再让下一次读取报「档案 id 不合法」。
 */
export function normalizeDispatchPolicyAllowlist(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const allowlist: string[] = [];
  for (const value of values) {
    const raw = value.trim();
    if (raw === "") continue;
    const id = assertDispatchPolicyAgentId(raw);
    if (seen.has(id)) continue;
    seen.add(id);
    allowlist.push(id);
  }
  if (allowlist.length > MAX_POLICY_ALLOWLIST) {
    throw new DispatchPolicyError(`派活名单最多 ${MAX_POLICY_ALLOWLIST} 个档案（收到 ${allowlist.length} 个）`);
  }
  return allowlist;
}

/** 到期时间：必须是未来时间。接受任何 `Date.parse` 认得的写法，落盘统一成 ISO。 */
export function normalizePolicyExpiry(value: string | undefined, now: Date): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (text === "") return undefined;
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) throw new DispatchPolicyError(`授权的到期时间读不懂: ${value}（请写 ISO 时间，例如 2026-12-31T23:59:59+08:00）`);
  if (parsed <= now.getTime()) throw new DispatchPolicyError(`授权的到期时间必须晚于现在: ${value}`);
  return new Date(parsed).toISOString();
}

// ── 解析与序列化 ───────────────────────────────────────────────────────────

function readObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DispatchPolicyError(`派活名单的 ${where} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function readString(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new DispatchPolicyError(`派活名单的 ${where}.${key} 必须是非空字符串`);
  }
  return value;
}

function readOptionalString(source: Record<string, unknown>, key: string, where: string): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new DispatchPolicyError(`派活名单的 ${where}.${key} 必须是字符串`);
  return value.trim() === "" ? undefined : value;
}

function readTimestamp(source: Record<string, unknown>, key: string, where: string): string {
  const value = readString(source, key, where);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new DispatchPolicyError(`派活名单的 ${where}.${key} 不是合法时间: ${value}`);
  return new Date(parsed).toISOString();
}

function readOptionalTimestamp(source: Record<string, unknown>, key: string, where: string): string | undefined {
  const value = readOptionalString(source, key, where);
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new DispatchPolicyError(`派活名单的 ${where}.${key} 不是合法时间: ${value}`);
  return new Date(parsed).toISOString();
}

function readStringArray(source: Record<string, unknown>, key: string, where: string): string[] {
  const value = source[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new DispatchPolicyError(`派活名单的 ${where}.${key} 必须是字符串数组`);
  }
  return value as string[];
}

function parseGrant(value: unknown, index: number): DispatchPolicyGrant {
  const where = `grants[${index}]`;
  const source = readObject(value, where);
  const grantId = readString(source, "grantId", where);
  if (!GRANT_ID_PATTERN.test(grantId)) throw new DispatchPolicyError(`派活名单的 ${where}.grantId 形状不合法: ${grantId}`);
  if (readString(source, "grantedBy", where) !== "owner") {
    throw new DispatchPolicyError(`派活名单的 ${where}.grantedBy 只认 owner`);
  }
  const agentId = assertDispatchPolicyAgentId(readString(source, "agentId", where));
  const scope = readObject(source.scope, `${where}.scope`);
  if (readString(scope, "source", `${where}.scope`) !== "internal") {
    throw new DispatchPolicyError(`派活名单的 ${where}.scope.source 只认 internal`);
  }
  const lists = readStringArray(scope, "lists", `${where}.scope`);
  if (lists.length === 0 || lists.some((item) => item !== "dispatch")) {
    throw new DispatchPolicyError(`派活名单的 ${where}.scope.lists 只认 dispatch`);
  }
  const grant: DispatchPolicyGrant = {
    grantId,
    grantedBy: "owner",
    agentId,
    scope: { source: "internal", lists: ["dispatch"] },
    createdAt: readTimestamp(source, "createdAt", where),
  };
  const expiresAt = readOptionalTimestamp(source, "expiresAt", where);
  if (expiresAt !== undefined) grant.expiresAt = expiresAt;
  const revokedAt = readOptionalTimestamp(source, "revokedAt", where);
  if (revokedAt !== undefined) grant.revokedAt = revokedAt;
  return grant;
}

function parseEvent(value: unknown, index: number): DispatchPolicyEvent {
  const where = `history[${index}]`;
  const source = readObject(value, where);
  const at = readTimestamp(source, "at", where);
  const action = readString(source, "action", where);
  if (action !== "save" && action !== "grant" && action !== "revoke" && action !== "mode") {
    throw new DispatchPolicyError(`派活名单的 ${where}.action 不认识: ${action}`);
  }
  const actor = readString(source, "actor", where);
  const grantId = readOptionalString(source, "grantId", where);
  const detail = readString(source, "detail", where);
  const event: DispatchPolicyEvent = { at, action, actor, detail };
  if (grantId !== undefined) event.grantId = grantId;
  return event;
}

/** 解析落盘文档。版本或结构不认识就抛，不按默认值补齐后放行。 */
export function parseDispatchPolicyDocument(text: string): DispatchPolicyDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new DispatchPolicyError(`派活名单不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const source = readObject(raw, "根");
  const version = source.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new DispatchPolicyError("派活名单缺少 schemaVersion");
  }
  if (version !== DISPATCH_POLICY_SCHEMA_VERSION) {
    throw new DispatchPolicyError(`不支持的派活名单版本: ${version}（本版本只认 ${DISPATCH_POLICY_SCHEMA_VERSION}）`);
  }
  const revision = source.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) {
    throw new DispatchPolicyError("派活名单的 revision 必须是非负整数");
  }
  const mode = readString(source, "mode", "根");
  if (mode !== "owner" && mode !== "agent") {
    throw new DispatchPolicyError(`派活名单的 mode 不认识: ${mode}（只认 owner / agent）`);
  }
  const allowlist = readStringArray(source, "allowlist", "根").map((value) => assertDispatchPolicyAgentId(value));
  if (new Set(allowlist).size !== allowlist.length) throw new DispatchPolicyError("派活名单的 allowlist 里有重复档案");
  if (allowlist.length > MAX_POLICY_ALLOWLIST) {
    throw new DispatchPolicyError(`派活名单最多 ${MAX_POLICY_ALLOWLIST} 个档案（文件里有 ${allowlist.length} 个）`);
  }
  const rawGrants = source.grants;
  if (!Array.isArray(rawGrants)) throw new DispatchPolicyError("派活名单的 grants 必须是数组");
  if (rawGrants.length > MAX_POLICY_GRANTS) throw new DispatchPolicyError(`派活名单最多 ${MAX_POLICY_GRANTS} 份授权`);
  const grants = rawGrants.map((grant, index) => parseGrant(grant, index));
  const grantIds = new Set(grants.map((grant) => grant.grantId));
  if (grantIds.size !== grants.length) throw new DispatchPolicyError("派活名单的 grants 里有重复 grantId");
  const rawHistory = source.history;
  if (!Array.isArray(rawHistory)) throw new DispatchPolicyError("派活名单的 history 必须是数组");
  const history = rawHistory.map((event, index) => parseEvent(event, index));
  const document: DispatchPolicyDocument = {
    schemaVersion: version,
    revision,
    updatedAt: readTimestamp(source, "updatedAt", "根"),
    updatedBy: readString(source, "updatedBy", "根"),
    mode,
    allowlist,
    grants,
    history,
  };
  return document;
}

export function serializeDispatchPolicyDocument(document: DispatchPolicyDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

// ── 仓库：落盘 + 修订锁 + 授权判定 ────────────────────────────────────────

export interface DispatchPolicyRepositoryOptions {
  dataDir: string;
  now?: (() => Date) | undefined;
  /** 测试可注入；生产用随机 UUID。 */
  newGrantId?: (() => string) | undefined;
}

/**
 * 派活名单仓库。一个实例对应一个数据根；重启后新建实例即可读回。
 *
 * 同一进程内的读改写全部串行（{@link enqueue}）：面板保存、Agent 工具改名单可能
 * 同时发生，光靠 `writeFileAtomic` 的写串行挡不住「两边都读到旧修订各自写一次」。
 * 跨进程仍然没有分布式锁——与队伍配置同一取舍，部署时须保持单宿主实例。
 */
export class DispatchPolicyRepository {
  private readonly dataDir: string;
  private readonly now: () => Date;
  private readonly newGrantId: () => string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: DispatchPolicyRepositoryOptions) {
    if (!path.isAbsolute(options.dataDir)) throw new DispatchPolicyError("军团数据根必须是绝对路径");
    this.dataDir = path.resolve(options.dataDir);
    this.now = options.now ?? (() => new Date());
    this.newGrantId = options.newGrantId ?? (() => `grant-${randomUUID()}`);
  }

  get dataDirPath(): string {
    return this.dataDir;
  }

  get filePath(): string {
    return path.join(this.dataDir, DISPATCH_POLICY_DIRECTORY, DISPATCH_POLICY_FILE_NAME);
  }

  /** 文件不存在返回 undefined——「还没配置」不是错误，交给调用方决定怎么说。 */
  async load(): Promise<DispatchPolicyDocument | undefined> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new DispatchPolicyError(`读取派活名单失败: ${this.filePath}（${error instanceof Error ? error.message : String(error)}）`);
    }
    try {
      return parseDispatchPolicyDocument(text);
    } catch (error) {
      throw new DispatchPolicyError(`派活名单损坏: ${this.filePath}（${error instanceof Error ? error.message : String(error)}）`);
    }
  }

  async snapshot(): Promise<DispatchPolicySnapshot> {
    return dispatchPolicySnapshotOf(await this.load());
  }

  /** 面板保存名单。`actor` 由服务层固定为 `owner`，Agent 走 `mutateAsAgent`。 */
  async saveAllowlist(input: {
    allowlist: readonly string[];
    expectedRevision: number;
    detail?: string | undefined;
  }): Promise<DispatchPolicySnapshot> {
    return this.enqueue(async () => {
      const current = await this.load();
      const allowlist = normalizeDispatchPolicyAllowlist(input.allowlist);
      const now = this.now();
      return this.write({
        current,
        expectedRevision: input.expectedRevision,
        now,
        actor: "owner",
        next: { allowlist, mode: current?.mode ?? "owner", grants: current?.grants ?? [] },
        event: { action: "save", detail: input.detail ?? describeAllowlistChange(current, allowlist) },
      });
    });
  }

  /**
   * 授权一个 Agent 改名单。
   *
   * 这是主人动作，绕开 `mode` 检查——但**只有面板会调用它**（Agent 工具没有这个动作，
   * 也不能转授）。首次授权会把 `mode` 一起打开，避免「授权了却还要再拨一次开关」。
   */
  async grant(input: {
    agentId: string;
    expiresAt?: string | undefined;
    expectedRevision: number;
  }): Promise<DispatchPolicySnapshot> {
    return this.enqueue(async () => {
      const current = await this.load();
      const now = this.now();
      const agentId = assertDispatchPolicyAgentId(input.agentId);
      const expiresAt = normalizePolicyExpiry(input.expiresAt, now);
      const policy = dispatchPolicySnapshotOf(current);
      // 同一 Agent 同时只留一份有效授权：两份范围相同的授权只会让「依据哪份」变含糊。
      // 已过期/已撤销的不算，可以重新授权（历史记录仍在）。
      if (activePolicyGrantFor({ ...policy, mode: "agent" }, agentId, now) !== undefined) {
        throw new DispatchPolicyError(`Agent ${agentId} 已经有一份有效授权；要改范围或到期时间，先撤销再新建`);
      }
      const grant: DispatchPolicyGrant = {
        grantId: this.newGrantId(),
        grantedBy: "owner",
        agentId,
        scope: { source: "internal", lists: ["dispatch"] },
        createdAt: now.toISOString(),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      };
      let grants = [...(current?.grants ?? []), grant];
      if (grants.length > MAX_POLICY_GRANTS) {
        // 只裁最老的**已撤销**记录：授权与撤销动作本身已经在 history 里留过痕，
        // 不删有效授权。这样反复授权/撤销不会把文件撑大，也不会把还在生效的授权误删。
        const at = now.getTime();
        const active = grants.filter((item) => item.revokedAt === undefined && !grantIsExpired(item, at));
        if (active.length > MAX_POLICY_GRANTS) {
          throw new DispatchPolicyError(`有效授权最多 ${MAX_POLICY_GRANTS} 份；先撤销一些不再需要的授权`);
        }
        const overflow = grants.length - MAX_POLICY_GRANTS;
        // 撤销的、过期的都能丢：授权/撤销/到期本身已在 history 里留痕。只留有效授权，
        // 否则「反复授权到过期」会把文件撑到解析器都读不进来。
        const dropped = new Set(
          grants
            .filter((item) => item.revokedAt !== undefined || grantIsExpired(item, at))
            .slice(0, overflow)
            .map((item) => item.grantId),
        );
        grants = grants.filter((item) => !dropped.has(item.grantId));
        if (grants.length > MAX_POLICY_GRANTS) {
          throw new DispatchPolicyError(`授权记录已满，而且没有可清理的已撤销/已过期记录；请先撤销不再需要的授权`);
        }
      }
      return this.write({
        current,
        expectedRevision: input.expectedRevision,
        now,
        actor: "owner",
        next: { allowlist: current?.allowlist ?? [], mode: "agent", grants },
        event: {
          action: "grant",
          grantId: grant.grantId,
          detail: `授权 ${agentId} 改派活名单${expiresAt === undefined ? "（不过期）" : `（到期 ${expiresAt}）`}`,
        },
      });
    });
  }

  /** 撤销一份授权。撤销记录保留；没有有效授权时 `mode` 自动回落到 owner。 */
  async revoke(input: { grantId: string; expectedRevision: number }): Promise<DispatchPolicySnapshot> {
    return this.enqueue(async () => {
      const current = await this.load();
      const now = this.now();
      const grants = [...(current?.grants ?? [])];
      const index = grants.findIndex((grant) => grant.grantId === input.grantId);
      if (index < 0) throw new DispatchPolicyError(`没有这份授权: ${input.grantId}`);
      const target = grants[index]!;
      if (target.revokedAt !== undefined) throw new DispatchPolicyError(`这份授权已经撤销过: ${input.grantId}`);
      const revokedAt = now.toISOString();
      grants[index] = { ...target, revokedAt };
      const policy = dispatchPolicySnapshotOf(current);
      const stillActive = activePolicyGrants({ ...policy, grants }, now).length > 0;
      return this.write({
        current,
        expectedRevision: input.expectedRevision,
        now,
        actor: "owner",
        next: {
          allowlist: current?.allowlist ?? [],
          mode: stillActive ? (current?.mode ?? "agent") : "owner",
          grants,
        },
        event: {
          action: "revoke",
          grantId: input.grantId,
          detail: `撤销 ${target.agentId} 的改名单授权${stillActive ? "" : "；已没有有效授权，改名单权限收回主人"}`,
        },
      });
    });
  }

  /** 主人拨开/收回 Agent 改名单的开关。收回不删授权，只让它们暂时失效。 */
  async setMode(input: { mode: DispatchPolicyMode; expectedRevision: number }): Promise<DispatchPolicySnapshot> {
    return this.enqueue(async () => {
      const current = await this.load();
      const now = this.now();
      if (input.mode === "agent") {
        const policy = dispatchPolicySnapshotOf(current);
        if (activePolicyGrants({ ...policy, mode: "agent" }, now).length === 0) {
          throw new DispatchPolicyError("没有有效授权，放开 Agent 改名单也没人能改；先在面板里授权一个 Agent");
        }
      }
      return this.write({
        current,
        expectedRevision: input.expectedRevision,
        now,
        actor: "owner",
        next: {
          allowlist: current?.allowlist ?? [],
          grants: current?.grants ?? [],
          mode: input.mode,
        },
        event: {
          action: "mode",
          detail: input.mode === "agent" ? "放开：已授权的 Agent 也能改派活名单" : "收回：只有主人能改派活名单（保留授权记录）",
        },
      });
    });
  }

  /**
   * Agent 改名单：先核有效授权，再改，再把「哪个 Agent、依据哪份授权」写进留痕。
   *
   * @returns `changed: false` 表示本来就如此（重复 add / remove），仍然返回当前快照；
   *          调用方自己决定要不要说「没变化」。
   */
  async mutateAsAgent(input: {
    actorId: string;
    action: "add" | "remove";
    agentId: string;
  }): Promise<{ snapshot: DispatchPolicySnapshot; changed: boolean; grantId: string }> {
    return this.enqueue(async () => {
      const current = await this.load();
      const now = this.now();
      const policy = dispatchPolicySnapshotOf(current);
      const actorId = assertDispatchPolicyAgentId(input.actorId);
      const agentId = assertDispatchPolicyAgentId(input.agentId);
      const grant = requirePolicyEditGrant(policy, actorId, now);
      const allowlist = [...policy.allowlist];
      const index = allowlist.indexOf(agentId);
      const present = index >= 0;
      if (input.action === "add" && present) {
        return { snapshot: policy, changed: false, grantId: grant.grantId };
      }
      if (input.action === "remove" && !present) {
        return { snapshot: policy, changed: false, grantId: grant.grantId };
      }
      if (input.action === "add") allowlist.push(agentId);
      else allowlist.splice(index, 1);
      const snapshot = await this.write({
        current,
        now,
        actor: `agent:${actorId}`,
        next: { allowlist, mode: policy.mode, grants: current?.grants ?? [] },
        event: {
          action: "save",
          grantId: grant.grantId,
          detail: `${input.action === "add" ? "加入" : "移出"} ${agentId}（依据授权 ${grant.grantId}${allowlist.length === 0 ? "；名单已空，当前没人能派活" : ""}）`,
        },
      });
      return { snapshot, changed: true, grantId: grant.grantId };
    });
  }

  /** 同进程内串行；前一次失败不阻断后一次。 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async write(input: {
    current: DispatchPolicyDocument | undefined;
    expectedRevision?: number | undefined;
    now: Date;
    actor: string;
    next: { allowlist: string[]; mode: DispatchPolicyMode; grants: DispatchPolicyGrant[] };
    event: { action: DispatchPolicyEventAction; grantId?: string | undefined; detail: string };
  }): Promise<DispatchPolicySnapshot> {
    const actual = input.current?.revision ?? 0;
    if (input.expectedRevision !== undefined && input.expectedRevision !== actual) {
      throw new DispatchPolicyConflictError(
        `派活名单已被其他保存更新（期望修订 ${input.expectedRevision}，实际 ${actual}），请重读后再改`,
      );
    }
    const revision = actual + 1;
    const history = [
      ...(input.current?.history ?? []),
      {
        at: input.now.toISOString(),
        action: input.event.action,
        actor: input.actor,
        ...(input.event.grantId === undefined ? {} : { grantId: input.event.grantId }),
        detail: input.event.detail,
      },
    ].slice(-MAX_POLICY_HISTORY);
    const document: DispatchPolicyDocument = {
      schemaVersion: DISPATCH_POLICY_SCHEMA_VERSION,
      revision,
      updatedAt: input.now.toISOString(),
      updatedBy: input.actor,
      mode: input.next.mode,
      allowlist: input.next.allowlist,
      grants: input.next.grants,
      history,
    };
    await writeFileAtomic(this.filePath, serializeDispatchPolicyDocument(document));
    return dispatchPolicySnapshotOf(document);
  }
}

function describeAllowlistChange(
  current: DispatchPolicyDocument | undefined,
  next: readonly string[],
): string {
  const before = new Set(current?.allowlist ?? []);
  const after = new Set(next);
  const added = next.filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !after.has(id));
  if (added.length === 0 && removed.length === 0) return "保存名单（内容未变）";
  const parts: string[] = [];
  if (added.length > 0) parts.push(`加入 ${added.join("、")}`);
  if (removed.length > 0) parts.push(`移出 ${removed.join("、")}`);
  if (next.length === 0) parts.push("名单已空，当前没人能派活");
  return parts.join("；");
}
