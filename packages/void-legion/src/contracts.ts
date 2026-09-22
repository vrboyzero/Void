/**
 * 军团持久化契约：队伍文档的版本号、解析与序列化。
 *
 * 队伍配置要「存下来复用」（L10）并且重启后还在，就必须有一个**带版本号的磁盘
 * 格式**。这里只做格式与取值合法性，不管关系图是否自洽——那是 `plan-validator.ts`
 * 的事，两者分开，报错才能各自说清是哪一类问题。
 *
 * 所有落盘文档都带 `schemaVersion`；遇到不认识的版本**明确报错**，不尝试兼容解析，
 * 也不静默降级成默认值（方案文档 §17.2）。
 *
 * @module @void/void-legion/contracts
 */
import type { DelegationTeamMember, DelegationTeamMetadata, DelegationTeamMode, LaunchRole, TeamSchedule } from "./team.js";
import { TEAM_SCHEDULES } from "./team.js";

export { TEAM_SCHEDULES, type TeamSchedule } from "./team.js";

/** 本版本能读写的队伍文档版本。 */
export const LEGION_SCHEMA_VERSION = 1;

/** 军团配置类错误的总基类，便于调用方一次捕获。 */
export class LegionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegionContractError";
  }
}

/** 文档版本或结构不认识。绝不在这里猜字段。 */
export class LegionSchemaError extends LegionContractError {
  constructor(message: string) {
    super(message);
    this.name = "LegionSchemaError";
  }
}

/** 名单取值本身不合法（id 形状、人数上限、调度名）。 */
export class LegionRosterError extends LegionContractError {
  constructor(message: string) {
    super(message);
    this.name = "LegionRosterError";
  }
}

// 首字符必须是字母或数字：这样 `.`、`..`、`-x` 都进不来，id 可以直接当文件名用。
export const TEAM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/;
// lane id 沿用 Star 的下划线风格（`lane_plan`），所以这里比队伍 id 多允许 `_`。
export const LANE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const MIN_MEMBER_LIMIT = 1;
export const MAX_MEMBER_LIMIT = 64;
/** 没写上限时的人数上限。够组一支小队，又不会把宿主一次打满。 */
export const DEFAULT_MEMBER_LIMIT = 8;

/**
 * 同时在跑的任务数上限（§15.3 的第三个计数：人数上限 / 并发上限 / provider 容量，
 * 三者都要算，且都要含指挥者与临时成员）。
 *
 * 它与人数上限是**两个**限制：八个人的队伍不代表要同时开八个请求。默认 4 是
 * 「比默认人数少一半」，让并发默认不是满员。
 */
export const MIN_MAX_CONCURRENT_TASKS = 1;
export const MAX_MAX_CONCURRENT_TASKS = 64;
export const DEFAULT_MAX_CONCURRENT_TASKS = 4;

export function assertMaxConcurrentTasks(value: number): number {
  if (!Number.isInteger(value) || value < MIN_MAX_CONCURRENT_TASKS || value > MAX_MAX_CONCURRENT_TASKS) {
    throw new LegionRosterError(
      `并发上限必须是 ${MIN_MAX_CONCURRENT_TASKS}–${MAX_MAX_CONCURRENT_TASKS} 的整数: ${String(value)}`,
    );
  }
  return value;
}

/**
 * 三种调度语义见 {@link TeamSchedule}（在 `team.ts` 里定义，这里只转出）。
 * 默认调度是 `parallel`：**不从 mode 推导**，理由见 `team.ts` 的注释。
 */
export const DEFAULT_TEAM_SCHEDULE: TeamSchedule = "parallel";

export const TEAM_MODES: readonly DelegationTeamMode[] = [
  "parallel_subtasks",
  "parallel_patch",
  "research_grid",
  "verify_swarm",
  "plan_execute_verify",
];

export const LAUNCH_ROLES: readonly LaunchRole[] = ["default", "commander", "coder", "researcher", "verifier"];

/** 一支可保存、可复用的队伍。`revision` 是并发保存的乐观锁。 */
export interface TeamDocument {
  schemaVersion: number;
  id: string;
  mode: DelegationTeamMode;
  schedule: TeamSchedule;
  sharedGoal?: string;
  managerAgentId?: string;
  managerIdentityLabel?: string;
  /** 人数上限；L13 要求它是可设置的变量。 */
  memberLimit: number;
  /**
   * 本服务总并发上限（§15.3 三个量里的第二个，默认 4）。
   *
   * 存在队伍上而不是全局配置上：不同队伍的「能同时跑几个」本来就不一样。派活时
   * 冻结进运行记录，之后改队伍不影响已经在跑的那一次。
   */
  maxConcurrentTasks: number;
  members: DelegationTeamMember[];
  /** 每次成功保存 +1。并发保存靠它挡住覆盖。 */
  revision: number;
  updatedAt: string;
}

export function assertTeamId(teamId: string): void {
  if (!TEAM_ID_PATTERN.test(teamId)) {
    throw new LegionRosterError(`队伍 id 不合法: ${teamId}（只接受小写字母、数字、下划线和连字符，3–64 位，首字符是字母或数字）`);
  }
}

export function assertLaneId(laneId: string): void {
  if (!LANE_ID_PATTERN.test(laneId)) {
    throw new LegionRosterError(`成员 lane id 不合法: ${laneId}（只接受小写字母、数字、下划线和连字符，最长 64 位，首字符是字母或数字）`);
  }
}

export function assertMemberLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < MIN_MEMBER_LIMIT || limit > MAX_MEMBER_LIMIT) {
    throw new LegionRosterError(`人数上限不合法: ${String(limit)}（必须是 ${MIN_MEMBER_LIMIT}–${MAX_MEMBER_LIMIT} 的整数）`);
  }
}

function assertSchedule(schedule: string): asserts schedule is TeamSchedule {
  if (!(TEAM_SCHEDULES as readonly string[]).includes(schedule)) {
    throw new LegionRosterError(`不认识的调度方式: ${schedule}（只接受 ${TEAM_SCHEDULES.join(" / ")}）`);
  }
}

function assertMode(mode: string): asserts mode is DelegationTeamMode {
  if (!(TEAM_MODES as readonly string[]).includes(mode)) {
    throw new LegionRosterError(`不认识的队伍模式: ${mode}（只接受 ${TEAM_MODES.join(" / ")}）`);
  }
}

/** 把一份队伍配置序列化成落盘文本。末尾留换行，便于人工直接看和改。 */
export function serializeTeamDocument(document: TeamDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function readObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LegionSchemaError(`队伍文档的 ${where} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function readString(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new LegionSchemaError(`队伍文档的 ${where}.${key} 必须是非空字符串`);
  }
  return value;
}

function readOptionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new LegionSchemaError(`队伍文档的 ${key} 必须是字符串`);
  return value.length === 0 ? undefined : value;
}

function readStringArray(source: Record<string, unknown>, key: string, where: string): string[] | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new LegionSchemaError(`队伍文档的 ${where}.${key} 必须是非空字符串数组`);
  }
  return value as string[];
}

function readPositiveInteger(source: Record<string, unknown>, key: string, where: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new LegionSchemaError(`队伍文档的 ${where}.${key} 必须是整数`);
  }
  return value;
}

function parseMember(value: unknown, index: number): DelegationTeamMember {
  const where = `members[${index}]`;
  const source = readObject(value, where);
  const member: DelegationTeamMember = { laneId: readString(source, "laneId", where) };
  const agentId = readOptionalString(source, "agentId");
  if (agentId !== undefined) member.agentId = agentId;
  const role = readOptionalString(source, "role");
  if (role !== undefined) {
    if (!(LAUNCH_ROLES as readonly string[]).includes(role)) {
      throw new LegionSchemaError(`队伍文档的 ${where}.role 不认识: ${role}`);
    }
    member.role = role as LaunchRole;
  }
  const identityLabel = readOptionalString(source, "identityLabel");
  if (identityLabel !== undefined) member.identityLabel = identityLabel;
  const scopeSummary = readOptionalString(source, "scopeSummary");
  if (scopeSummary !== undefined) member.scopeSummary = scopeSummary;
  const modelRef = readOptionalString(source, "modelRef");
  if (modelRef !== undefined) member.modelRef = modelRef;
  const workspace = readOptionalString(source, "workspace");
  if (workspace !== undefined) member.workspace = workspace;
  if (source.writes !== undefined) {
    if (typeof source.writes !== "boolean") throw new LegionSchemaError(`队伍文档的 ${where}.writes 必须是布尔值`);
    member.writes = source.writes;
  }
  for (const key of ["reportsTo", "mayDirect", "dependsOn", "handoffTo"] as const) {
    const list = readStringArray(source, key, where);
    if (list !== undefined) member[key] = list;
  }
  if (source.stage !== undefined) {
    const stage = readPositiveInteger(source, "stage", where);
    if (stage < 1) throw new LegionSchemaError(`队伍文档的 ${where}.stage 必须从 1 开始`);
    member.stage = stage;
  }
  return member;
}

/**
 * 解析一份落盘的队伍文档。
 *
 * 版本不认识就抛 {@link LegionSchemaError}——不猜测、不按默认值补齐后放行：
 * 放行一份读不懂的配置，等于让调度器去执行一份没人验证过的名单。
 */
export function parseTeamDocument(text: string): TeamDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new LegionSchemaError(`队伍配置不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const source = readObject(raw, "根");
  const version = source.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new LegionSchemaError("队伍配置缺少 schemaVersion");
  }
  if (version !== LEGION_SCHEMA_VERSION) {
    throw new LegionSchemaError(`不支持的队伍配置版本: ${version}（本版本只认 ${LEGION_SCHEMA_VERSION}）`);
  }
  const id = readString(source, "id", "根");
  const mode = readString(source, "mode", "根");
  assertMode(mode);
  const schedule = readOptionalString(source, "schedule") ?? DEFAULT_TEAM_SCHEDULE;
  assertSchedule(schedule);
  const memberLimit = readPositiveInteger(source, "memberLimit", "根");
  assertMemberLimit(memberLimit);
  // 老队伍文档没写这一项时按默认值走：这是加字段，不是改语义，没必要让已经存下来的
  // 队伍因为缺一个可选上限而读不出来。
  const maxConcurrentTasks = source.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS;
  if (typeof maxConcurrentTasks !== "number") {
    throw new LegionSchemaError("队伍文档的 maxConcurrentTasks 必须是整数");
  }
  assertMaxConcurrentTasks(maxConcurrentTasks);
  const revision = readPositiveInteger(source, "revision", "根");
  if (revision < 0) throw new LegionSchemaError("队伍文档的 revision 不能是负数");
  const rawMembers = source.members;
  if (!Array.isArray(rawMembers)) throw new LegionSchemaError("队伍文档的 members 必须是数组");
  const document: TeamDocument = {
    schemaVersion: version,
    id,
    mode,
    schedule,
    memberLimit,
    maxConcurrentTasks,
    members: rawMembers.map((member, index) => parseMember(member, index)),
    revision,
    updatedAt: readString(source, "updatedAt", "根"),
  };
  const sharedGoal = readOptionalString(source, "sharedGoal");
  if (sharedGoal !== undefined) document.sharedGoal = sharedGoal;
  const managerAgentId = readOptionalString(source, "managerAgentId");
  if (managerAgentId !== undefined) document.managerAgentId = managerAgentId;
  const managerIdentityLabel = readOptionalString(source, "managerIdentityLabel");
  if (managerIdentityLabel !== undefined) document.managerIdentityLabel = managerIdentityLabel;
  return document;
}

/** 新建一份还没保存过的队伍文档（revision 0）。 */
export function createTeamDocument(input: {
  id: string;
  mode: DelegationTeamMode;
  members?: readonly DelegationTeamMember[];
  schedule?: TeamSchedule;
  sharedGoal?: string;
  managerAgentId?: string;
  managerIdentityLabel?: string;
  memberLimit?: number;
  maxConcurrentTasks?: number;
  now?: Date;
}): TeamDocument {
  assertTeamId(input.id);
  assertMode(input.mode);
  const schedule = input.schedule ?? DEFAULT_TEAM_SCHEDULE;
  assertSchedule(schedule);
  const memberLimit = input.memberLimit ?? DEFAULT_MEMBER_LIMIT;
  assertMemberLimit(memberLimit);
  const maxConcurrentTasks = input.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS;
  assertMaxConcurrentTasks(maxConcurrentTasks);
  const document: TeamDocument = {
    schemaVersion: LEGION_SCHEMA_VERSION,
    id: input.id,
    mode: input.mode,
    schedule,
    memberLimit,
    maxConcurrentTasks,
    members: [...(input.members ?? [])],
    revision: 0,
    updatedAt: (input.now ?? new Date()).toISOString(),
  };
  if (input.sharedGoal !== undefined) document.sharedGoal = input.sharedGoal;
  if (input.managerAgentId !== undefined) document.managerAgentId = input.managerAgentId;
  if (input.managerIdentityLabel !== undefined) document.managerIdentityLabel = input.managerIdentityLabel;
  return document;
}

/** 队伍文档 → 运行时拓扑。组织图与权限检查读的是同一份快照。 */
export function teamMetadataOf(document: TeamDocument): DelegationTeamMetadata {  return {
    id: document.id,
    mode: document.mode,
    ...(document.sharedGoal === undefined ? {} : { sharedGoal: document.sharedGoal }),
    ...(document.managerAgentId === undefined ? {} : { managerAgentId: document.managerAgentId }),
    ...(document.managerIdentityLabel === undefined ? {} : { managerIdentityLabel: document.managerIdentityLabel }),
    memberRoster: document.members.map((member) => ({ ...member })),
    schedule: document.schedule,
    memberLimit: document.memberLimit,
    maxConcurrentTasks: document.maxConcurrentTasks,
  };
}

/**
 * 人数计数：**包含指挥者与临时成员，按 agentId 去重**（方案文档 §15.2）。
 *
 * 同一个档案占两个 lane 只算一个人——否则「人数上限」会被 lane 数量虚增，
 * 上限就挡不住真正想挡的东西。没写 agentId 的成员各算一个。
 */
export function countTeamMembers(members: readonly DelegationTeamMember[]): number {
  const identified = new Set<string>();
  let anonymous = 0;
  for (const member of members) {
    if (member.agentId === undefined || member.agentId.length === 0) anonymous += 1;
    else identified.add(member.agentId);
  }
  return identified.size + anonymous;
}

/** 运行时拓扑 → 队伍文档（保存或冻结快照时用）。 */
export function teamDocumentOf(
  metadata: DelegationTeamMetadata,
  options: { revision?: number; now?: Date } = {},
): TeamDocument {
  const schedule = metadata.schedule ?? DEFAULT_TEAM_SCHEDULE;
  assertSchedule(schedule);
  const memberLimit = metadata.memberLimit ?? DEFAULT_MEMBER_LIMIT;
  assertMemberLimit(memberLimit);
  const maxConcurrentTasks = metadata.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS;
  assertMaxConcurrentTasks(maxConcurrentTasks);
  return {
    schemaVersion: LEGION_SCHEMA_VERSION,
    id: metadata.id,
    mode: metadata.mode,
    schedule,
    memberLimit,
    maxConcurrentTasks,
    members: metadata.memberRoster.map((member) => ({ ...member })),
    revision: options.revision ?? 0,
    updatedAt: (options.now ?? new Date()).toISOString(),
    ...(metadata.sharedGoal === undefined ? {} : { sharedGoal: metadata.sharedGoal }),
    ...(metadata.managerAgentId === undefined ? {} : { managerAgentId: metadata.managerAgentId }),
    ...(metadata.managerIdentityLabel === undefined ? {} : { managerIdentityLabel: metadata.managerIdentityLabel }),
  };
}
