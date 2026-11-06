/**
 * 一次派活的运行记录（run）：状态、逐任务进度、完整产出、事件流水。
 *
 * 旧实现把 checkpoint 存在 `Map<teamId, Map<laneId, status>>` 里：同一支队伍第二次
 * 派活会直接覆盖第一次的进度，重启后什么都没有，worker 的产出被丢掉。这里给每次
 * 派活一个 `runId`，落到 `<数据根>/legion/runs/<runId>.json`，于是「同队多 run 不
 * 覆盖」「重启能结算」「产出不丢」三件事同时成立（方案文档 §17.2 的 P5 行）。
 *
 * 两条硬规矩：
 * 1. **运行配置冻结**：run 里存一份名单快照。run 起来之后有人改了队伍配置，
 *    不影响这次 run 已经派出去的任务——否则「同一支队伍」在不同时刻是两份权威。
 * 2. **重启结算**：进程被杀时正在跑的 run，重启后标记为 `interrupted`，
 *    而不是假装还在跑或者悄悄变回 `pending`。没有自动返工（§17.2）。
 *
 * @module @void/void-legion/run-store
 */
import { open, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./atomic-file.js";
import { assertLaneId, DEFAULT_MAX_CONCURRENT_TASKS } from "./contracts.js";
import type { AcceptanceMode, DelegationTeamMember, TeamSchedule } from "./team.js";

/**
 * 本版本写出的运行记录版本。
 *
 * B2 起新增 `awaiting_acceptance` 状态与 `acceptance` / `acceptedBy` 字段。版本号
 * 往上走，但**仍读得进版本 1 的旧记录**：旧记录没有验收字段，一律按最保守的
 * `human` 处理（§22.4「旧记录缺 acceptance 字段按 human」），不猜自动放行。
 */
export const RUN_SCHEMA_VERSION = 2;

/** 本版本仍能正确读取的旧版本。只做「缺字段补默认」，不改写旧文件。 */
export const READABLE_RUN_SCHEMA_VERSIONS: readonly number[] = [1, RUN_SCHEMA_VERSION];

/** run id 直接当文件名用，所以形状比队伍 id 更严（首字符字母/数字，无路径分隔符）。 */
export const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,82}$/;

/** 超过此值的 JSON 产出移入独立文件，运行记录只留引用。 */
export const MAX_RUN_OUTPUT_BYTES = 262_144;
export const MAX_RUN_OUTPUT_PAGE_BYTES = 16_384;

export class LegionRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegionRunError";
  }
}

/** 运行记录版本或结构不认识。绝不在这里猜字段。 */
export class LegionRunSchemaError extends LegionRunError {
  constructor(message: string) {
    super(message);
    this.name = "LegionRunSchemaError";
  }
}

export class LegionRunNotFoundError extends LegionRunError {
  constructor(message: string) {
    super(message);
    this.name = "LegionRunNotFoundError";
  }
}

/**
 * 一次 run 的状态。
 *
 * `awaiting_acceptance`（B2）是「执行体跑完了，但人还没签收」：它不是 `running`，
 * 也不是 `completed`。执行侧已经停下，所以算终态；但**不算验收通过**，要人点确认
 * （或 auto 模式下自动确认）才转 `completed`。
 */
export type RunStatus =
  | "running"
  | "awaiting_acceptance"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/** 谁签收的。`auto` 必须能被翻案，不能伪装成人工验收。 */
export type RunAcceptedBy = "human" | "auto";

/** 单个任务的终态集合；`pending`/`running` 之外都算结束。 */
export type RunTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "interrupted";

/**
 * `blocked` 与 `failed` 是两件事：`failed` 是这个任务自己跑挂了，`blocked` 是它
 * 根本没跑（上游先挂了）。分开记，才答得上「是它不行还是没轮到它」（§17.2
 * 「失败阻塞准确」）。
 */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "awaiting_acceptance",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

/**
 * 验收层：`awaiting_acceptance` 与 `completed` 之间可以来回（人验收 / 翻案），
 * 其余终态不许改。运行记录落盘的「终态不倒退」检查必须放行这两者之间的迁移，
 * 否则人工验收那一步会被自己的存储层挡住。
 */
export const ACCEPTANCE_RUN_STATUSES: readonly RunStatus[] = ["awaiting_acceptance", "completed"];

export function isAcceptanceRunStatus(status: RunStatus): boolean {
  return ACCEPTANCE_RUN_STATUSES.includes(status);
}
export const TERMINAL_TASK_STATUSES: readonly RunTaskStatus[] = [
  "completed",
  "failed",
  "blocked",
  "cancelled",
  "interrupted",
];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export function isTerminalTaskStatus(status: RunTaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

/**
 * 人工验收的默认超时（7 天，§22.4「验收不是无限期悬挂」）。
 *
 * 超时只用于**提示**：仍然算「待验收」，绝不自动通过。要改时限就改这个常量；
 * 把它做成队伍字段属于另一层配置，B2 不做。
 */
export const ACCEPTANCE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

/** 待验收的截止时间；不是待验收、或没有结束时间时返回 undefined。 */
export function acceptanceDeadline(record: RunRecord): string | undefined {
  if (record.status !== "awaiting_acceptance" || record.endedAt === undefined) return undefined;
  const ended = Date.parse(record.endedAt);
  if (Number.isNaN(ended)) return undefined;
  return new Date(ended + ACCEPTANCE_TIMEOUT_MS).toISOString();
}

/** 是否已过人工验收时限。**超时不是自动通过**，只是面板/工具要说得出来。 */
export function acceptanceOverdue(record: RunRecord, now: Date = new Date()): boolean {
  const deadline = acceptanceDeadline(record);
  if (deadline === undefined) return false;
  return now.getTime() > Date.parse(deadline);
}

/** 一条任务记录。`attempts` 恒为 1——失败不自动返工（§17.2）。 */
export interface RunTaskRecord {
  laneId: string;
  agentId?: string;
  stage?: number;
  /** 逐任务模型路由（§15.3「不同模型路由实收」）。 */
  modelRef?: string;
  status: RunTaskStatus;
  dependsOn: string[];
  attempts: number;
  /**
   * 这次派活的原生子会话 id（§15.2「原生 child session 链接」）。
   *
   * 有它才能从运行记录跳回宿主里那个真实子会话，而不是只看到「某个 lane 跑完了」。
   */
  childSessionId?: string;
  /** 独立检出（B6）：路径与分支，便于事后审计/回滚。shared 成员没有。 */
  checkoutPath?: string;
  checkoutBranch?: string;
  startedAt?: string;
  endedAt?: string;
  /** 小产出原样存储；大产出在独立文件，这里只留预览。 */
  output?: unknown;
  outputRef?: { bytes: number };
  error?: string;
  /** 被上游拖住时，记下是哪个 lane 先挂的。 */
  blockedBy?: string;
}

export type RunEventKind =
  | "run_started"
  | "task_started"
  | "task_completed"
  | "task_failed"
  | "task_blocked"
  | "task_cancelling"
  | "task_cancelled"
  /** 独立检出已建立（B6）。 */
  | "task_worktree_created"
  /** 独立检出清理失败（B6）：不会静默留下一个没人知道的检出。 */
  | "task_worktree_cleanup_failed"
  | "task_output_truncated"
  | "run_finished"
  | "run_cancelled"
  | "run_settled"
  /** 人工验收通过（B2）：`awaiting_acceptance` → `completed`。 */
  | "run_accepted"
  /** 自动确认被人翻案（B2）：`completed` → `awaiting_acceptance`。 */
  | "run_reopened"
  /** 运行记录没写进磁盘（磁盘满了、目录被删了……）。内存里那份仍然是最新的。 */
  | "run_persist_failed"
  /** 终态通知没写进磁盘。**不影响运行结果**，只留痕：面板里看得到「通知没记上」。 */
  | "run_notify_failed";

export interface RunEvent {
  at: string;
  kind: RunEventKind;
  laneId?: string;
  detail?: string;
}

export interface RunRecord {
  schemaVersion: number;
  runId: string;
  teamId: string;
  /** 模型工具发起者；旧记录没有此字段时，工具层拒绝读取和取消。 */
  initiatedBy?: string;
  managerAgentId?: string;
  task: string;
  schedule: TeamSchedule;
  status: RunStatus;
  /**
   * 本次 run 的验收模式（§22.4）。派活时从队伍默认值（或可信调用方的单次覆盖）
   * 冻结进来；旧记录没有这个字段时解析成 `human`，不猜自动放行。
   */
  acceptance: AcceptanceMode;
  /** 谁签收的；只有 `completed` 才应该有值。人工与自动必须分得清。 */
  acceptedBy?: RunAcceptedBy;
  /** 签收时间；与 `endedAt`（执行结束）分开，别把「跑完」当「验收」。 */
  acceptedAt?: string;
  /** 最近一次被人工翻案的时间（自动确认被改回待验收）。 */
  reopenedAt?: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
  /** 运行配置冻结：本次 run 的名单快照。 */
  frozenRoster: DelegationTeamMember[];
  memberLimit: number;
  maxConcurrentTasks: number;
  tasks: RunTaskRecord[];
  events: RunEvent[];
}

export function assertRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new LegionRunError(`运行 id 不合法: ${JSON.stringify(runId)}（只允许小写字母、数字、下划线、连字符，3–83 位）`);
  }
  return runId;
}

/**
 * 运行 id：`<teamId>-<UTC 时间戳>-<序号>`。
 *
 * 用时间戳而不是随机数，是为了让 `list()` 按名字排出来就是发生顺序；序号用来
 * 挡住同一秒内的两次派活（同队多 run 不覆盖）。
 */
export function nextRunId(teamId: string, at: Date, sequence: number): string {
  const stamp = [
    at.getUTCFullYear().toString().padStart(4, "0"),
    (at.getUTCMonth() + 1).toString().padStart(2, "0"),
    at.getUTCDate().toString().padStart(2, "0"),
    at.getUTCHours().toString().padStart(2, "0"),
    at.getUTCMinutes().toString().padStart(2, "0"),
    at.getUTCSeconds().toString().padStart(2, "0"),
  ].join("");
  return assertRunId(`${teamId}-${stamp}-${sequence.toString().padStart(2, "0")}`);
}

export interface CreateRunInput {
  runId: string;
  teamId: string;
  initiatedBy?: string;
  managerAgentId?: string;
  task?: string | undefined;
  schedule: TeamSchedule;
  roster: readonly DelegationTeamMember[];
  memberLimit: number;
  maxConcurrentTasks?: number | undefined;
  acceptance?: AcceptanceMode;
  at: Date;
}

export function createRunRecord(input: CreateRunInput): RunRecord {
  const at = input.at.toISOString();
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId: assertRunId(input.runId),
    teamId: input.teamId,
    ...(input.initiatedBy === undefined ? {} : { initiatedBy: input.initiatedBy }),
    ...(input.managerAgentId === undefined ? {} : { managerAgentId: input.managerAgentId }),
    task: input.task ?? "",
    schedule: input.schedule,
    status: "running",
    acceptance: input.acceptance ?? "human",
    createdAt: at,
    updatedAt: at,
    frozenRoster: input.roster.map((member) => structuredClone(member)),
    memberLimit: input.memberLimit,
    maxConcurrentTasks: input.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS,
    tasks: input.roster.map((member) => ({
      laneId: member.laneId,
      ...(member.agentId === undefined ? {} : { agentId: member.agentId }),
      ...(member.stage === undefined ? {} : { stage: member.stage }),
      ...(member.modelRef === undefined ? {} : { modelRef: member.modelRef }),
      status: "pending" as RunTaskStatus,
      dependsOn: [...(member.dependsOn ?? [])],
      attempts: 1,
    })),
    events: [{ at, kind: "run_started", detail: `${input.roster.length} 个任务，调度 ${input.schedule}` }],
  };
}

/** 进度摘要：给工具和面板看的一行数字，不代替完整记录。 */
export interface RunSummary {
  runId: string;
  teamId: string;
  status: RunStatus;
  acceptance: AcceptanceMode;
  acceptedBy?: RunAcceptedBy;
  schedule: TeamSchedule;
  total: number;
  completed: number;
  failed: number;
  blocked: number;
  cancelled: number;
  running: number;
  pending: number;
}

export function summarizeRun(record: RunRecord): RunSummary {
  const count = (status: RunTaskStatus): number => record.tasks.filter((task) => task.status === status).length;
  return {
    runId: record.runId,
    teamId: record.teamId,
    status: record.status,
    acceptance: record.acceptance,
    ...(record.acceptedBy === undefined ? {} : { acceptedBy: record.acceptedBy }),
    schedule: record.schedule,
    total: record.tasks.length,
    completed: count("completed"),
    failed: count("failed"),
    blocked: count("blocked"),
    cancelled: count("cancelled"),
    running: count("running"),
    pending: count("pending"),
  };
}

/** 派活的最终结论：只有全部 completed 才算成功，`blocked` 也算没干成。 */
export function runConclusion(record: RunRecord): RunStatus {
  if (!isTerminalRunStatus(record.status)) return "running";
  return record.status;
}

function parseTask(raw: unknown, runId: string): RunTaskRecord {
  if (typeof raw !== "object" || raw === null) {
    throw new LegionRunSchemaError(`运行记录损坏: ${runId}（任务项不是对象）`);
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.laneId !== "string" || value.laneId.length === 0) {
    throw new LegionRunSchemaError(`运行记录损坏: ${runId}（任务缺少 laneId）`);
  }
  const status = value.status;
  if (typeof status !== "string" || !isRunTaskStatus(status)) {
    throw new LegionRunSchemaError(`运行记录损坏: ${runId}（任务 ${value.laneId} 的状态不认识: ${String(status)}）`);
  }
  return value as unknown as RunTaskRecord;
}

function isRunTaskStatus(value: string): value is RunTaskStatus {
  return (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "blocked" ||
    value === "cancelled" ||
    value === "interrupted"
  );
}

function isRunStatus(value: string): value is RunStatus {
  return (
    value === "running" ||
    value === "awaiting_acceptance" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "interrupted"
  );
}

function isAcceptedBy(value: string): value is RunAcceptedBy {
  return value === "human" || value === "auto";
}

/**
 * 解析一份运行记录。版本不符就报错，**不尝试兼容解析**（§17.2：回滚包时保留新
 * 运行记录待新版本读取，不篡改成旧格式）。
 */
export function parseRunRecord(text: string, source: string): RunRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new LegionRunSchemaError(`运行记录损坏: ${source}（${error instanceof Error ? error.message : String(error)}）`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new LegionRunSchemaError(`运行记录损坏: ${source}（顶层不是对象）`);
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.schemaVersion !== "number" || !READABLE_RUN_SCHEMA_VERSIONS.includes(value.schemaVersion)) {
    throw new LegionRunSchemaError(
      `不支持的运行记录版本: ${String(value.schemaVersion)}（本版本只认 ${READABLE_RUN_SCHEMA_VERSIONS.join(" / ")}）`,
    );
  }
  if (typeof value.runId !== "string" || typeof value.teamId !== "string") {
    throw new LegionRunSchemaError(`运行记录损坏: ${source}（缺少 runId 或 teamId）`);
  }
  if (typeof value.status !== "string" || !isRunStatus(value.status)) {
    throw new LegionRunSchemaError(`运行记录损坏: ${source}（运行状态不认识: ${String(value.status)}）`);
  }
  if (!Array.isArray(value.tasks)) {
    throw new LegionRunSchemaError(`运行记录损坏: ${source}（缺少 tasks）`);
  }
  const acceptance = value.acceptance;
  if (acceptance !== undefined && acceptance !== "human" && acceptance !== "auto") {
    throw new LegionRunSchemaError(`运行记录损坏: ${source}（acceptance 不认识: ${String(acceptance)}）`);
  }
  const acceptedBy = value.acceptedBy;
  if (acceptedBy !== undefined && (typeof acceptedBy !== "string" || !isAcceptedBy(acceptedBy))) {
    throw new LegionRunSchemaError(`运行记录损坏: ${source}（acceptedBy 不认识: ${String(acceptedBy)}）`);
  }
  for (const key of ["acceptedAt", "reopenedAt"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new LegionRunSchemaError(`运行记录损坏: ${source}（${key} 必须是时间字符串）`);
    }
  }
  const record = value as unknown as RunRecord;
  record.tasks = value.tasks.map((task) => parseTask(task, record.runId));
  if (!Array.isArray(record.events)) record.events = [];
  if (!Array.isArray(record.frozenRoster)) record.frozenRoster = [];
  // 旧版本没有验收字段：一律按最保守的 human 补齐。写入时顺手升到当前版本，
  // 旧文件下一次被保存就会带上新字段（不猜测、不改写历史文件本身）。
  record.schemaVersion = RUN_SCHEMA_VERSION;
  record.acceptance = acceptance === "auto" ? "auto" : "human";
  if (acceptedBy === undefined) delete record.acceptedBy;
  return record;
}

export function serializeRunRecord(record: RunRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * 把 worker 的产出整理成能落盘的值。
 *
 * 能序列化就原样交给存储层；超限时由 RunStore 单独落盘。
 * 循环引用无法 JSON 序列化，只能显式标记，不能假称已保存完整产出。
 */
export function normalizeRunOutput(output: unknown): { value: unknown; truncated: boolean; bytes: number } {
  let text: string;
  try {
    text = JSON.stringify(output ?? null) ?? "null";
  } catch {
    return { value: { unserializable: true, preview: String(output).slice(0, 4096) }, truncated: true, bytes: 0 };
  }
  const bytes = Buffer.byteLength(text, "utf8");
  return { value: JSON.parse(text) as unknown, truncated: false, bytes };
}

export interface RunStoreOptions {
  dataDir: string;
  now?: (() => Date) | undefined;
}

const runSaveTails = new Map<string, Promise<void>>();

/**
 * 运行记录仓库。一个实例对应一个数据根；重启后新建实例，`settleInterrupted()`
 * 把上一轮没跑完的 run 结清。
 */
export class RunStore {
  private readonly dataDir: string;
  private readonly now: () => Date;

  constructor(options: RunStoreOptions) {
    this.dataDir = options.dataDir;
    this.now = options.now ?? (() => new Date());
  }

  get dataDirPath(): string {
    return this.dataDir;
  }

  /** `<数据根>/legion/runs`，与队伍配置的 `legion/teams` 并列。 */
  get root(): string {
    return path.join(this.dataDir, "legion", "runs");
  }

  pathOf(runId: string): string {
    return path.join(this.root, `${assertRunId(runId)}.json`);
  }

  private outputPath(runId: string, laneId: string): string {
    assertLaneId(laneId);
    return path.join(this.root, `${assertRunId(runId)}.outputs`, `${laneId}.json`);
  }

  async save(record: RunRecord): Promise<RunRecord> {
    const target = this.pathOf(record.runId);
    const previous = runSaveTails.get(target) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.saveOnce(record));
    const guarded = current.catch(() => undefined);
    runSaveTails.set(target, guarded);
    try {
      await current;
      return record;
    } finally {
      if (runSaveTails.get(target) === guarded) runSaveTails.delete(target);
    }
  }

  private async saveOnce(record: RunRecord): Promise<void> {
    const existing = await this.load(record.runId);
    // 验收层允许来回：待验收 → 已完成（人点确认）、已完成 → 待验收（翻案）。
    // 其余终态不许改——旧快照不能把已结算的失败/取消盖回去。
    const acceptanceTransition =
      existing !== undefined && isAcceptanceRunStatus(existing.status) && isAcceptanceRunStatus(record.status);
    if (existing !== undefined && isTerminalRunStatus(existing.status) && existing.status !== record.status && !acceptanceTransition) {
      throw new LegionRunError(`运行记录已是终态 ${existing.status}，拒绝旧快照覆盖: ${record.runId}`);
    }
    for (const task of record.tasks) {
      if (task.output === undefined || task.outputRef !== undefined) continue;
      const text = JSON.stringify(task.output);
      if (text === undefined || Buffer.byteLength(text, "utf8") <= MAX_RUN_OUTPUT_BYTES) continue;
      const bytes = Buffer.byteLength(text, "utf8");
      await writeFileAtomic(this.outputPath(record.runId, task.laneId), text);
      task.outputRef = { bytes };
      task.output = { external: true, bytes, preview: text.slice(0, 4096) };
    }
    record.updatedAt = this.now().toISOString();
    await writeFileAtomic(this.pathOf(record.runId), serializeRunRecord(record));
  }

  async readOutputPage(runId: string, laneId: string, offset: number, length = MAX_RUN_OUTPUT_PAGE_BYTES): Promise<{
    base64: string; offset: number; nextOffset: number; bytes: number;
  }> {
    const record = await this.require(runId);
    const task = record.tasks.find((item) => item.laneId === laneId);
    if (task?.outputRef === undefined) throw new LegionRunError(`任务没有独立产出: ${laneId}`);
    const bytes = task.outputRef.bytes;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(offset) || offset < 0 || offset > bytes ||
      !Number.isSafeInteger(length) || length < 1 || length > MAX_RUN_OUTPUT_PAGE_BYTES) {
      throw new LegionRunError("产出分页边界不合法");
    }
    const buffer = Buffer.alloc(Math.min(length, bytes - offset));
    const file = await open(this.outputPath(runId, laneId), "r");
    try {
      const result = await file.read(buffer, 0, buffer.length, offset);
      if (result.bytesRead !== buffer.length) throw new LegionRunError(`任务产出文件不完整: ${laneId}`);
    } finally {
      await file.close();
    }
    return { base64: buffer.toString("base64"), offset, nextOffset: offset + buffer.length, bytes };
  }

  async load(runId: string): Promise<RunRecord | undefined> {
    const target = this.pathOf(runId);
    let text: string;
    try {
      text = await readFile(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return parseRunRecord(text, target);
  }

  async require(runId: string): Promise<RunRecord> {
    const record = await this.load(runId);
    if (record === undefined) throw new LegionRunNotFoundError(`运行记录不存在: ${runId}`);
    return record;
  }

  /** 全部运行记录，按 runId 排序（id 里带时间戳，所以就是发生顺序）。 */
  async list(): Promise<RunRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const ids = names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length));
    ids.sort();
    const records: RunRecord[] = [];
    for (const id of ids) records.push(await this.require(id));
    return records;
  }

  /** 同一支队伍的历史 run，最新在前。 */
  async listByTeam(teamId: string): Promise<RunRecord[]> {
    return (await this.list()).filter((record) => record.teamId === teamId).reverse();
  }

  /**
   * 重启结算：把还写着 `running` 的 run 及其未结束任务标成 `interrupted`。
   *
   * 这些任务**不会被自动重跑**——Host 重启不是「重试一次」的理由，自动返工正是
   * §17.2 点名要去掉的行为。返回结算过的记录，调用方自己决定怎么告诉人。
   */
  async settleInterrupted(): Promise<RunRecord[]> {
    const settled: RunRecord[] = [];
    for (const record of await this.list()) {
      if (isTerminalRunStatus(record.status)) continue;
      const at = this.now().toISOString();
      for (const task of record.tasks) {
        if (isTerminalTaskStatus(task.status)) continue;
        task.status = "interrupted";
        task.endedAt = at;
        task.error = "宿主重启，本次任务没有跑完，未自动重跑";
      }
      record.status = "interrupted";
      record.endedAt = at;
      record.events.push({ at, kind: "run_settled", detail: "宿主重启结算：未结束的任务标记为 interrupted" });
      settled.push(await this.save(record));
    }
    return settled;
  }
}
