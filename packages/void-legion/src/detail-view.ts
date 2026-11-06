/**
 * 军团的业务详情视图（§16.1）：队伍详情、任务详情与派活名单（B1）。
 *
 * 这两块归军团自己实现：组织图、人数上限、运行进度、取消都只有军团知道语义，入口只
 * 负责转发与渲染。契约按**结构**重述，不 import 入口包——军团在 headless 组合里也要
 * 能装，不该依赖一个只在 web 组合里存在的插件（与 `void-dsh-control` 的面板同一做法）。
 *
 * @module @void/void-legion/detail-view
 */
import path from "node:path";
import { resolveVoidDataRoot } from "@void/void-soul";
import { renderOrgChart } from "./authority.js";
import type { Context } from "@deepseek-ai/cordis";
import {
  DEFAULT_MAX_CONCURRENT_TASKS,
  DEFAULT_MEMBER_LIMIT,
  LEGION_SCHEMA_VERSION,
  TEAM_MODES,
  TEAM_SCHEDULES,
  type TeamDocument,
} from "./contracts.js";
import {
  DISPATCH_POLICY_ITEM_ID,
  activePolicyGrants,
  normalizeDispatchPolicyAllowlist,
  type DispatchPolicyGrant,
  type DispatchPolicyMode,
  type DispatchPolicySnapshot,
} from "./dispatch-policy.js";
import type {
  DispatchSourceEntry,
  DispatchSourceMode,
  DispatchSourceSnapshot,
  DispatchSourceState,
} from "./dispatch-source.js";
import type { LegionRunProgress } from "./run-coordinator.js";
import { hasSuspensionNews, loadSuspensionIndex, memberSuspensions, type SuspensionIndex } from "./suspensions.js";
import {
  TERMINAL_TASK_STATUSES,
  acceptanceDeadline,
  acceptanceOverdue,
  type RunRecord,
  type RunStatus,
  type RunTaskRecord,
  type RunTaskStatus,
} from "./run-store.js";

/** 队伍详情视图 id。 */
export const TEAM_VIEW_ID = "void-legion:teams";
/** 任务详情视图 id。 */
export const RUN_VIEW_ID = "void-legion:runs";
/** 派活名单视图 id（B1：面板里的运营维度，全档案共用一份）。 */
export const POLICY_VIEW_ID = "void-legion:dispatch-policy";

/** 与入口 `VoidDetailSource` 同形的视图契约（结构性重述，避免跨包类型依赖）。 */
export interface ViewProfile {
  home: string;
  name: string;
}

export interface ViewItem {
  id: string;
  title: string;
  summary?: string;
  meta?: string;
}

export interface ViewTextSection {
  id: string;
  title: string;
  kind?: "lines" | "table" | "org";
  columns?: readonly string[];
  rows?: ReadonlyArray<readonly string[]>;
  lines?: readonly string[];
  /**
   * `table` 用：哪些格子其实是一个能点开的原生会话。
   *
   * 键是 `${行号}:${列号}`（都从 0 数），值是宿主原生 child session id。面板不认识这个
   * 字段（或这台宿主没有会话服务）就照旧画纯文本——链接是增强，不是数据本身。
   */
  sessionLinks?: Readonly<Record<string, string>>;
}

/** 可编辑行表格的一列。 */
export interface ViewColumn {
  key: string;
  label: string;
  type?: "text" | "list" | "boolean" | "number";
}

/**
 * 可编辑行表格：一组同形对象（成员名单）。
 *
 * 与入口的 `VoidDetailRowsSection` 同形；`key` 是写回 `changes` 时用的字段名，
 * 不给就是只读表格。
 */
export interface ViewRowsSection {
  id: string;
  title: string;
  kind: "rows";
  columns: readonly ViewColumn[];
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
  key?: string;
  editable?: boolean;
  /** 行级「移除」按钮；只给空行可忽略的名单用（见入口契约的同名字段）。 */
  removable?: boolean;
  addLabel?: string;
  help?: string;
}

export type ViewSection = ViewTextSection | ViewRowsSection;

export interface ViewField {
  key: string;
  label: string;
  value: string | number | null;
  readOnly?: boolean;
  help?: string;
}

export interface ViewAction {
  id: string;
  label: string;
  hint?: string;
  danger?: boolean;
  args?: readonly ViewField[];
}

export interface ViewBody {
  title: string;
  markdown?: string;
  sections: readonly ViewSection[];
  revision?: number | string;
  fields?: readonly ViewField[];
  actions?: readonly ViewAction[];
  /**
   * 这份详情还在动（比如一次运行还在跑）：面板在打开期间会自动重读它。
   *
   * 终态详情不要置这个位——那只会让面板白轮询。
   */
  live?: boolean;
}

export interface ViewSource {
  id: string;
  title: string;
  /** 管理视图：写请求必须来自浏览器面板（入口契约同名字段）。 */
  requireOrigin?: boolean;
  viewActions?: readonly ViewAction[];
  list(input: ViewProfile): Promise<readonly ViewItem[]>;
  detail(input: ViewProfile & { itemId: string }): Promise<ViewBody>;
  save?(
    input: ViewProfile & { itemId: string; expectedRevision: number | string; changes: Readonly<Record<string, unknown>> },
  ): Promise<ViewBody>;
  act?(input: ViewProfile & {
    itemId: string;
    actionId: string;
    args: Readonly<Record<string, unknown>>;
    /** 面板打开这一条时读到的修订：删除这类动作靠它挡「看着旧数据下手」。 */
    expectedRevision?: number | string | undefined;
  }): Promise<ViewBody>;
  actView?(input: ViewProfile & { actionId: string; args: Readonly<Record<string, unknown>> }): Promise<void>;
}

/**
 * 视图用得到的那部分军团服务。
 *
 * 重述成接口而不是直接用 `VoidTeam`：视图只该碰这几个方法，多一个都可能让面板
 * 绕过仓库的校验去改数据；测试也能拿假的顶上，不必为看一个表格装整个服务。
 */
export interface LegionViewHost {
  /** 本服务实际使用的数据根。 */
  readonly dataRoot: string | undefined;
  listTeams(): Promise<TeamDocument[]>;
  loadTeam(teamId: string): Promise<TeamDocument | undefined>;
  /** 整份保存（新建或覆盖）。名单与元信息走这条路，坏名单由仓库在写盘前拦下。 */
  saveTeam(document: TeamDocument, options?: { expectedRevision?: number | undefined }): Promise<TeamDocument>;
  removeTeam(teamId: string, options?: { expectedRevision?: number | undefined }): Promise<void>;
  setMemberLimit(teamId: string, input: { memberLimit: number; expectedRevision?: number | undefined }): Promise<TeamDocument>;
  setMaxConcurrentTasks(
    teamId: string,
    input: { maxConcurrentTasks: number; expectedRevision?: number | undefined },
  ): Promise<TeamDocument>;
  listRuns(): Promise<RunRecord[]>;
  runRecord(runId: string): Promise<RunRecord>;
  runProgress(runId: string): Promise<LegionRunProgress>;
  cancelRun(runId: string, reason?: string): Promise<RunRecord>;
  cancelLane(runId: string, laneId: string, reason?: string): Promise<RunRecord>;
  /** 人工验收（B2）：待验收 → 已完成。 */
  acceptRun(runId: string, acceptedBy: "human" | "auto", note?: string): Promise<RunRecord>;
  /** 翻案（B2）：自动确认的已完成 → 待验收。 */
  reopenRun(runId: string, reason?: string): Promise<RunRecord>;
  /** 派活来源与账本（B3/B5）。 */
  readDispatchSource(): Promise<DispatchSourceSnapshot>;
  setDispatchSourceMode(input: {
    mode: DispatchSourceMode;
    expectedRevision: number;
  }): Promise<DispatchSourceSnapshot>;
  setDispatchSourceEnabled(input: {
    enabled: boolean;
    expectedRevision: number;
  }): Promise<DispatchSourceSnapshot>;
  /** 派活名单（B1）。面板是主人通道，所以这里的写操作一律按 owner 记。 */
  readDispatchPolicy(): Promise<DispatchPolicySnapshot>;
  saveDispatchPolicy(input: {
    allowlist: readonly string[];
    expectedRevision: number;
  }): Promise<DispatchPolicySnapshot>;
  grantDispatchPolicyEdit(input: {
    agentId: string;
    expiresAt?: string | undefined;
    expectedRevision: number;
  }): Promise<DispatchPolicySnapshot>;
  revokeDispatchPolicyEdit(input: { grantId: string; expectedRevision: number }): Promise<DispatchPolicySnapshot>;
  setDispatchPolicyMode(input: {
    mode: DispatchPolicyMode;
    expectedRevision: number;
  }): Promise<DispatchPolicySnapshot>;
}

const SCHEDULE_LABELS: Record<string, string> = {
  parallel: "并行",
  sequential: "顺序",
  staged: "分阶段",
};

function scheduleLabel(schedule: string): string {
  return SCHEDULE_LABELS[schedule] ?? schedule;
}

/**
 * 运行与任务状态的中文说法。
 *
 * 面板是给人看的：通知栏早就说「被宿主重启中断」，同一个 run 的详情却写 `interrupted`，
 * 会让人以为两处在说两件事。状态不认识时**照原样显示**，不猜也不吞——磁盘上的原始值
 * 仍留在运行记录与 `legion_run` 的返回里，这里只负责界面上那一格。
 */
const RUN_STATUS_LABELS: Record<string, string> = {
  running: "在跑",
  awaiting_acceptance: "待验收",
  completed: "已跑完",
  failed: "有任务失败",
  cancelled: "已取消",
  interrupted: "被宿主重启中断",
};

const TASK_STATUS_LABELS: Record<string, string> = {
  pending: "还没轮到",
  running: "在跑",
  completed: "已完成",
  failed: "失败",
  blocked: "被上游堵住",
  cancelled: "已取消",
  interrupted: "被宿主重启中断",
};

function runStatusLabel(status: RunStatus): string {
  return RUN_STATUS_LABELS[status] ?? status;
}

function taskStatusLabel(status: RunTaskStatus): string {
  return TASK_STATUS_LABELS[status] ?? status;
}

/** 验收模式/签收来源的中文说法。自动确认绝不写成「人工验收」。 */
function acceptanceLabel(value: string): string {
  if (value === "human") return "人工验收";
  if (value === "auto") return "自动确认";
  return value;
}

function settledCount(record: RunRecord): number {
  return record.tasks.filter((task) => TERMINAL_TASK_STATUSES.includes(task.status)).length;
}

/** 一行「已结算 x/y」，不是百分比——进度只按真实结算数说（§15.2）。 */
function settledLine(record: RunRecord): string {
  return `已结算 ${settledCount(record)}/${record.tasks.length}`;
}

function previewOutput(output: unknown): string {
  if (output === undefined) return "—";
  let text: string;
  try {
    text = JSON.stringify(output) ?? String(output);
  } catch {
    return "（产出不是可序列化的 JSON）";
  }
  return text.length > 240 ? `${text.slice(0, 240)}…（共 ${text.length} 字符）` : text;
}

/**
 * 核对面板问的档案就是本服务在用的那一份。
 *
 * 不核对的话，装了两份档案时面板会**安静地**显示另一份的队伍——看起来一切正常，
 * 而人按它改的是别处的数据。所以宁可拒绝。
 */
function assertProfileMatches(host: LegionViewHost, profile: ViewProfile): void {
  const root = host.dataRoot;
  if (root === undefined) {
    throw new Error("军团没有数据根，业务视图没有可读的队伍与运行：需要配置 dataDir，或提供 profile（DSH_PROFILE）");
  }
  const expected = resolveVoidDataRoot({ dshHome: profile.home, profile: profile.name });
  if (path.resolve(root) !== path.resolve(expected)) {
    throw new Error(`业务视图的档案与军团数据根不一致：请求 ${profile.name}（${expected}），实际 ${root}`);
  }
}

function readInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label}必须是整数: ${JSON.stringify(value) ?? String(value)}`);
  }
  return value;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label}是必填`);
  }
  return value.trim();
}

function readOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * 队伍修订是自增整数。
 *
 * 面板回传字符串说明它拿的不是这份修订（或者来源换成了按内容哈希设栅的视图），
 * 猜一个数字出来只会让栅形同虚设——直接拒绝。
 */
function readRevision(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value.trim())) return Number(value.trim());
  throw new Error(`队伍修订必须是整数: ${JSON.stringify(value) ?? String(value)}`);
}

function readMode(value: unknown): TeamDocument["mode"] {
  const mode = readString(value, "模式");
  if (!(TEAM_MODES as readonly string[]).includes(mode)) {
    throw new Error(`队伍模式不认识: ${mode}（只认 ${TEAM_MODES.join(" / ")}）`);
  }
  return mode as TeamDocument["mode"];
}

function readSchedule(value: unknown): TeamDocument["schedule"] {
  const schedule = readString(value, "调度");
  if (!(TEAM_SCHEDULES as readonly string[]).includes(schedule)) {
    throw new Error(`队伍调度不认识: ${schedule}（只认 ${TEAM_SCHEDULES.join(" / ")}）`);
  }
  return schedule as TeamDocument["schedule"];
}

/**
 * 成员表格的列。
 *
 * `type` 同时决定面板给什么控件、以及把填进来的文本转回什么值（`list` 按逗号切、
 * `boolean` 认「是/否」）。成员字段本身是开放的（`modelRef`、`workspace` 这些），
 * 所以这里逐列列出，面板照着画。
 */
const MEMBER_COLUMNS: readonly ViewColumn[] = [
  { key: "laneId", label: "成员" },
  { key: "agentId", label: "档案" },
  { key: "identityLabel", label: "称呼" },
  { key: "role", label: "角色" },
  { key: "stage", label: "阶段", type: "number" },
  { key: "reportsTo", label: "汇报", type: "list" },
  { key: "mayDirect", label: "可指挥", type: "list" },
  { key: "dependsOn", label: "依赖", type: "list" },
  { key: "handoffTo", label: "交接", type: "list" },
  { key: "modelRef", label: "模型" },
  { key: "workspace", label: "工作区" },
  { key: "checkout", label: "检出" },
  { key: "writes", label: "写文件", type: "boolean" },
];

/** 成员行认的字段。多余的一律拒绝：静默丢掉会让人以为改上了。 */
const MEMBER_KEYS: readonly string[] = MEMBER_COLUMNS.map((column) => column.key);

/** 一行成员：原样交出去，面板只画自己认识的列。 */
function memberCells(member: TeamDocument["members"][number]): Record<string, unknown> {
  return { ...member };
}

/**
 * 面板交上来的成员名单。
 *
 * 这里只查形状（数组、每行是对象、字段名认识、有成员 id），字段类型交给仓库的解析器：
 * 它是队伍文档的唯一权威，把规则抄一份到这里，迟早两边不一致。
 */
function readMembers(value: unknown): TeamDocument["members"] {
  if (!Array.isArray(value)) {
    throw new Error(`成员名单必须是数组: ${JSON.stringify(value) ?? String(value)}`);
  }
  return value.map((row, index) => {
    const at = `成员名单第 ${index + 1} 行`;
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`${at}不是对象`);
    }
    const record = row as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!MEMBER_KEYS.includes(key)) throw new Error(`${at}有不认识的字段: ${key}`);
    }
    if (typeof record.laneId !== "string" || record.laneId.trim() === "") {
      throw new Error(`${at}缺少成员 id（lane）`);
    }
    return { ...record, laneId: record.laneId.trim() } as TeamDocument["members"][number];
  });
}

/** 改这些字段要整份重写队伍文档；只改人数/并发上限则走仓库的单字段 setter。 */
const STRUCTURAL_TEAM_KEYS: readonly string[] = [
  "members",
  "sharedGoal",
  "managerIdentityLabel",
  "mode",
  "schedule",
  "acceptance",
];

/**
 * 可空文本：面板交空串表示「清掉它」，交非空文本表示「设成这个」。
 *
 * 返回 `undefined` 时调用方要把整个键删掉——`sharedGoal: undefined` 在对象上留着，
 * 会让「有没有这个键」的判断走岔。
 */
function clearableText(value: unknown, label: string): string | undefined {
  if (typeof value !== "string") {
    throw new Error(`${label}必须是文本: ${JSON.stringify(value) ?? String(value)}`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 任务表的列。子会话那列要给出可点入口，所以列名单独取一次下标，别在代码里写死 5。 */
const TASK_COLUMNS: readonly string[] = ["任务", "档案", "状态", "依赖", "尝试", "子会话", "开始", "结束", "产出 / 错误"];
const TASK_CHILD_SESSION_COLUMN = TASK_COLUMNS.indexOf("子会话");

/**
 * 任务表里哪些格子能跳到原生子会话。
 *
 * 只有真拿到 `childSessionId` 的格子才给链接：没跑起来的任务没有会话可跳，编一个点不动的
 * 入口比不显示更坏。面板不认识这个字段时照旧画纯文本。
 */
function taskSessionLinks(tasks: readonly RunTaskRecord[]): Record<string, string> {
  const links: Record<string, string> = {};
  tasks.forEach((task, index) => {
    if (task.childSessionId !== undefined) links[`${index}:${TASK_CHILD_SESSION_COLUMN}`] = task.childSessionId;
  });
  return links;
}

function taskRow(task: RunTaskRecord): string[] {
  const outcome = task.error ?? previewOutput(task.output);
  return [
    task.laneId,
    task.agentId ?? "—",
    taskStatusLabel(task.status),
    task.dependsOn.length === 0 ? "—" : task.dependsOn.join(", "),
    String(task.attempts),
    task.childSessionId ?? "—",
    task.startedAt ?? "—",
    task.endedAt ?? "—",
    outcome,
  ];
}

function eventLine(event: RunRecord["events"][number]): string {
  const lane = event.laneId === undefined ? "" : ` ${event.laneId}`;
  const detail = event.detail === undefined ? "" : ` — ${event.detail}`;
  return `${event.at} ${event.kind}${lane}${detail}`;
}

/**
 * 队伍面板要用的停用表（A17）。
 *
 * 数据根没有时不编：面板别的部分已经在 `assertProfileMatches` 里拒过了，这里返回 `undefined`
 * 只表示「这块看不了」，不是「都没停用」。
 */
async function suspensionIndexOf(host: LegionViewHost): Promise<SuspensionIndex | undefined> {
  const root = host.dataRoot;
  if (root === undefined) return undefined;
  return loadSuspensionIndex(root);
}

/**
 * 「停用的成员」那一节的正文（A17）。
 *
 * 为什么单开一节、而不是在名单表格里加一列：名单那张表是**可编辑**的（整份交上去覆盖），
 * 往里塞一个算出来的列，保存时会把它当字段回写进队伍文件。停用位不是队伍配置，不能混进去。
 */
function suspensionLines(document: TeamDocument, index: SuspensionIndex): string[] {
  const lines: string[] = [];
  for (const report of memberSuspensions({ members: document.members, index })) {
    if (report.suspended) {
      lines.push(
        `已停用：${report.laneId} 的 ${report.agentId} —— 派活会被拒（在灵魂档案面板上「启用这份档案」就恢复，记忆与聊天记录一个字节都没动）`,
      );
    } else {
      lines.push(`读不出停用状态：${report.laneId} 的 ${report.agentId}（${report.reason ?? "原因不明"}）——这一处不算「没停用」。`);
    }
  }
  for (const problem of index.problems) {
    // 登记表自己的问题（`谁（id）：为什么` / `档案登记表读不动：为什么`）已经自带主语，不再套一层前缀。
    lines.push(`${problem}——这一处不算「没停用」。`);
  }
  if (lines.length > 0) {
    lines.push(
      "停用只改那份档案 state.json 里的一个布尔值，名单一个字节都不动：要临时换人就改上面的名单，想让它回来就去灵魂档案面板启用。",
    );
  }
  return lines;
}

/** 有话要说才出这一节：没人停用、也没有读不动的，就不占面板地方。 */
function suspensionSection(document: TeamDocument, index: SuspensionIndex | undefined): readonly ViewTextSection[] {
  if (index === undefined || !hasSuspensionNews({ members: document.members, index })) return [];
  return [{ id: "suspensions", title: "停用的成员", kind: "lines", lines: suspensionLines(document, index) }];
}

function teamBody(host: LegionViewHost, teamId: string): Promise<ViewBody> {
  return (async () => {
    const document = await host.loadTeam(teamId);
    if (document === undefined) throw new Error(`队伍不存在: ${teamId}`);
    const index = await suspensionIndexOf(host);
    const runs = (await host.listRuns())
      .filter((run) => run.teamId === teamId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 10);
    return {
      title: document.managerIdentityLabel ?? document.id,
      ...(document.sharedGoal === undefined ? {} : { markdown: `## 共同目标\n\n${document.sharedGoal}` }),
      revision: document.revision,
      sections: [
        { id: "org", title: "指挥关系", kind: "org", lines: renderOrgChart(document) },
        {
          id: "members",
          title: "名单",
          kind: "rows",
          key: "members",
          editable: true,
          addLabel: "加一个成员",
          help: "改完点保存：整份名单一次交上去，汇报与可指挥写成员 id，多个用逗号分开。检出写 shared（默认，共享工作区写锁）或 worktree（独立 git 检出，需军团配置的仓库目录是 git 仓库）。",
          columns: MEMBER_COLUMNS,
          rows: document.members.map(memberCells),
        },
        ...suspensionSection(document, index),
        {
          id: "runs",
          title: "最近的运行",
          kind: "table",
          columns: ["运行", "状态", "调度", "已结算", "最近活动"],
          rows: runs.map((run) => [run.runId, runStatusLabel(run.status), scheduleLabel(run.schedule), settledLine(run), run.updatedAt]),
        },
      ],
      fields: [
        {
          key: "sharedGoal",
          label: "共同目标",
          value: document.sharedGoal ?? null,
          help: "派活时每个成员都会看到的一句话目标；留空就是没有。",
        },
        {
          key: "mode",
          label: "模式",
          value: document.mode,
          help: `只认 ${TEAM_MODES.join(" / ")}。`,
        },
        {
          key: "schedule",
          label: "调度",
          value: document.schedule,
          help: `只认 ${TEAM_SCHEDULES.join(" / ")}；调度不从模式推出来，得自己写。`,
        },
        {
          key: "acceptance",
          label: "验收模式",
          value: document.acceptance ?? "human",
          help: "human = 跑完只到「待验收」，人点确认才算完成；auto = 跑完自动确认（记 acceptedBy: auto，可被翻案）。缺省 human，改这里只影响之后的派活。",
        },
        {
          key: "managerIdentityLabel",
          label: "负责人称呼",
          value: document.managerIdentityLabel ?? null,
          help: "只是显示用的称呼，不改负责人是谁；留空就用队伍 id。",
        },
        {
          key: "memberLimit",
          label: "人数上限",
          value: document.memberLimit,
          help: "含负责人与临时成员。调低不会强杀正在跑的成员。",
        },
        {
          key: "maxConcurrentTasks",
          label: "并发上限",
          value: document.maxConcurrentTasks,
          help: "只影响之后的派活，不改已经在跑的那一次。",
        },
        { key: "revision", label: "修订", value: document.revision, readOnly: true },
        { key: "updatedAt", label: "最后修改", value: document.updatedAt, readOnly: true },
      ],
      actions: [
        {
          id: "delete-team",
          label: "删除这支队伍",
          hint: `要删就再敲一遍 ${document.id}：删错了没有回收站，运行记录也只会留在原处。`,
          danger: true,
          args: [{ key: "confirmTeamId", label: "再敲一遍队伍 id", value: null }],
        },
      ],
    };
  })();
}

/**
 * 进度区块的正文：当前任务、已结算/总数、最近活动时间、原生子会话 id（§15.4）。
 *
 * 不编百分比：进度只能如实说「跑到哪了」，算一个假的比例比不显示更坏。
 */
function progressLines(record: RunRecord, progress: LegionRunProgress): string[] {
  const lines: string[] = [
    progress.conclusion,
    `${settledLine(record)}，在跑 ${progress.running.length}，还没轮到 ${progress.pending.length}`,
  ];
  // 在跑与还没轮到的逐条列出来：只给数字的话，「在跑 1」是哪一条还得去下面的表里找。
  for (const lane of progress.running) {
    const who = lane.agentId === undefined ? "" : `（${lane.agentId}）`;
    const started = lane.startedAt === undefined ? "" : `，开始 ${lane.startedAt}`;
    const child = lane.childSessionId === undefined ? "" : `，子会话 ${lane.childSessionId}`;
    lines.push(`在跑：${lane.laneId}${who}${started}${child}`);
  }
  for (const lane of progress.pending) {
    const who = lane.agentId === undefined ? "" : `（${lane.agentId}）`;
    const blocked = lane.blockedBy === undefined ? "" : `，等 ${lane.blockedBy}`;
    lines.push(`还没轮到：${lane.laneId}${who}${blocked}`);
  }
  lines.push(`最近活动 ${progress.lastActivityAt}`);
  return lines;
}

async function runBody(host: LegionViewHost, runId: string): Promise<ViewBody> {
  const record = await host.runRecord(runId);
  const progress = await host.runProgress(runId);
  return {
    title: `运行 ${record.runId}`,
    markdown: [`队伍 ${record.teamId}`, `调度 ${scheduleLabel(record.schedule)}`, `任务 ${record.task}`].join("\n\n"),
    // 还在跑就让面板自己重读：不然面板上的「进度」只是打开那一刻的快照。
    ...(record.status === "running" ? { live: true } : {}),
    sections: [
      {
        id: "progress",
        title: "进度",
        kind: "lines",
        lines: progressLines(record, progress),
      },
      {
        id: "tasks",
        title: "任务",
        kind: "table",
        columns: TASK_COLUMNS,
        rows: record.tasks.map(taskRow),
        // 子会话那一格不只是给人看的：面板照这个把格子画成能点开的入口（§16.1）。
        sessionLinks: taskSessionLinks(record.tasks),
      },
      {
        id: "events",
        title: "事件",
        kind: "lines",
        lines: record.events.length === 0 ? ["（还没有事件）"] : record.events.map(eventLine),
      },
    ],
    fields: [
      {
        key: "status",
        label: "状态",
        value: runStatusLabel(record.status),
        readOnly: true,
        help: `磁盘上的原始值：${record.status}。`,
      },
      {
        key: "acceptance",
        label: "验收模式",
        value: acceptanceLabel(record.acceptance),
        readOnly: true,
        help: "队伍设置的默认值，派活时冻结进本次 run；改队伍只影响之后的派活。",
      },
      ...(record.acceptedBy === undefined
        ? []
        : [{
            key: "acceptedBy",
            label: "签收来源",
            value: acceptanceLabel(record.acceptedBy),
            readOnly: true,
            help: "自动确认不会伪装成人工验收。",
          }]),
      ...(record.acceptedAt === undefined
        ? []
        : [{ key: "acceptedAt", label: "签收时间", value: record.acceptedAt, readOnly: true }]),
      ...(record.reopenedAt === undefined
        ? []
        : [{ key: "reopenedAt", label: "最近翻案", value: record.reopenedAt, readOnly: true }]),
      ...(record.status === "awaiting_acceptance"
        ? [{
            key: "acceptanceDeadline",
            label: "验收时限",
            value: acceptanceDeadline(record) ?? "—",
            readOnly: true,
            help: `超时只提示、**不会自动通过**${acceptanceOverdue(record) ? "；当前已逾期" : ""}。`,
          }]
        : []),
      { key: "schedule", label: "调度", value: scheduleLabel(record.schedule), readOnly: true },
      { key: "memberLimit", label: "人数上限", value: record.memberLimit, readOnly: true },
      { key: "maxConcurrentTasks", label: "并发上限", value: record.maxConcurrentTasks, readOnly: true },
      { key: "createdAt", label: "开始", value: record.createdAt, readOnly: true },
      { key: "updatedAt", label: "最近活动", value: record.updatedAt, readOnly: true },
      { key: "endedAt", label: "结束", value: record.endedAt ?? null, readOnly: true },
    ],
    // 运行记录不是可编辑对象（没有 revision 栅），所以只给动作，不给字段编辑。
    actions: [
      // 执行体还在跑时才能取消；终态上的取消按钮点了也只会报「不在本进程里跑」。
      ...(record.status === "running"
        ? [
            {
              id: "cancel-lane",
              label: "停一个任务",
              hint: "只停这一个；它下游还没派发的任务会被记成「被取消带走」，不会假装成功。",
              args: [
                { key: "laneId", label: "任务 lane", value: null },
                { key: "reason", label: "原因", value: null },
              ],
            } satisfies ViewAction,
            {
              id: "cancel-run",
              label: "停全队",
              hint: "本次运行里还没派发的任务都不会再派。已经跑起来的会收到取消信号。",
              danger: true,
              args: [{ key: "reason", label: "原因", value: null }],
            } satisfies ViewAction,
          ]
        : []),
      ...(record.status === "awaiting_acceptance"
        ? [{
            id: "accept-run",
            label: "验收通过（人工）",
            hint: "只把本地状态转成已完成，并记下是人工签收；不代表可以推送、合并或发布。",
            args: [{ key: "note", label: "备注（可空）", value: null }],
          } satisfies ViewAction]
        : []),
      ...(record.status === "completed" && record.acceptedBy === "auto"
        ? [{
            id: "reopen-run",
            label: "翻案：退回待验收",
            hint: "自动确认的 run 可以被人推回待验收；不重跑成员任务，也不改执行结果。",
            danger: true,
            args: [{ key: "reason", label: "原因（可空）", value: null }],
          } satisfies ViewAction]
        : []),
    ],
  };
}

// ── 派活名单（B1） ─────────────────────────────────────────────────────────

const POLICY_ACTION_LABELS: Record<string, string> = {
  save: "改名单",
  grant: "授权",
  revoke: "撤销授权",
  mode: "拨开关",
};

function policySummary(policy: DispatchPolicySnapshot): string {
  if (!policy.configured) return "还没配置：当前没人能派活";
  if (policy.allowlist.length === 0) return "名单为空：当前没人能派活";
  return `${policy.allowlist.length} 个档案可以派活`;
}

function policyModeLabel(policy: DispatchPolicySnapshot): string {
  if (policy.mode === "owner") return "只有主人（面板）";
  const active = activePolicyGrants(policy).length;
  return active === 0
    ? "已放开，但当前没有有效授权（实际仍只有主人能改）"
    : `主人 + ${active} 个已授权的 Agent`;
}

function policyActorLabel(actor: string): string {
  if (actor === "owner") return "主人（面板）";
  if (actor.startsWith("agent:")) return `Agent：${actor.slice("agent:".length)}`;
  return actor;
}

function policyGrantStatus(grant: DispatchPolicyGrant, mode: DispatchPolicyMode, now: Date): string {
  if (grant.revokedAt !== undefined) return "已撤销";
  if (grant.expiresAt !== undefined) {
    const expires = Date.parse(grant.expiresAt);
    if (Number.isNaN(expires)) return "到期时间读不懂";
    if (expires <= now.getTime()) return "已过期";
  }
  if (grant.scope.source !== "internal" || !grant.scope.lists.includes("dispatch")) return "范围不匹配";
  return mode === "agent" ? "有效" : "有效（开关已收回，暂不生效）";
}

const SOURCE_OUTCOME_LABELS: Record<string, string> = {
  observed: "观察",
  dispatched: "已派发",
  filtered: "被拒",
};

/** 来源状态的中文说法。七态都在，内向来源实际只会出现 ready/paused/off/error。 */
function sourceStateLabel(state: DispatchSourceState): string {
  switch (state) {
    case "missing":
      return "还没配置";
    case "off":
      return "已停用";
    case "error":
      return "配置损坏";
    case "setup":
      return "还没 setup";
    case "starting":
      return "启动中";
    case "paused":
      return "观察中（observe）";
    case "ready":
      return "执行中（live）";
  }
}

function sourceModeLabel(mode: DispatchSourceMode): string {
  return mode === "observe" ? "观察中（只记账，不执行）" : "执行中（live，正常派发）";
}

function sourceEntryLine(entry: DispatchSourceEntry): string {
  const prefix = entry.channel === undefined ? "" : `${entry.channel} · `;
  const dropped =
    entry.droppedKind === "channelGone"
      ? "渠道没了"
      : entry.droppedKind === "channelIgnored"
        ? "渠道不在接收范围"
        : undefined;
  const text =
    entry.reason !== undefined && entry.reason !== ""
      ? entry.reason
      : entry.detail !== undefined && entry.detail !== ""
        ? entry.detail
        : entry.taskPreview ?? "—";
  return `${prefix}${dropped === undefined ? "" : `[${dropped}] `}${text}`;
}

/**
 * 名单详情。面板按这些结构化数据渲染，不额外解释业务语义。
 *
 * 名单没有单独的「添加/删除」动作：行表格本来就是整组替换，点行尾的「移除」或把
 * 这一行清空再保存就是移掉它。这样导入、批量改、清空都是同一条保存路径，也天然带修订锁。
 *
 * 来源（B3/B5）也挂在这张详情里：派活名单与「这次接不接、为什么没接」是同一件事的
 * 两面，分成两个面板只会让人来回找。来源动作的 CAS 用来源自己的 revision（面板打开
 * 时读到的那个），不复用名单的修订号——两份文件的修订号互不相干。
 */
function policyBody(policy: DispatchPolicySnapshot, source: DispatchSourceSnapshot): ViewBody {
  const now = new Date();
  const grants = [...policy.grants].reverse();
  const history = policy.history.slice(-20).reverse();
  const modeAction: ViewAction =
    policy.mode === "owner"
      ? {
          id: "mode-agent",
          label: "放开：已授权的 Agent 也能改名单",
          hint: "要先有至少一份有效授权；放开之后 Agent 真的能自己改，不是代主人伸手。",
        }
      : {
          id: "mode-owner",
          label: "收回：只有主人能改名单",
          hint: "立即生效；授权记录保留，但 Agent 改不了名单，重新放开不需要再授权一次。",
        };
  const sourceActions: ViewAction[] = [];
  if (source.state === "ready") {
    sourceActions.push({
      id: "source-observe",
      label: "切到观察（只记账，不执行）",
      hint: "同一个派活请求只写一条「本来会派什么」，不建 run、不启子代理；切回 live 是显式动作。",
    });
  }
  if (source.state === "paused") {
    sourceActions.push({
      id: "source-live",
      label: "切回执行（live）",
      hint: "观察档显式退出；之后同样的请求会正常派发。",
    });
  }
  if (source.state === "off") {
    sourceActions.push({
      id: "source-on",
      label: "启用派活来源",
      hint: "启用后请求按 live/observe 当前模式处理。",
    });
  }
  if (source.state === "ready" || source.state === "paused") {
    sourceActions.push({
      id: "source-off",
      label: "停用派活来源",
      hint: "停用后请求只记账、不执行；已派出的 run 不受影响。",
      danger: true,
    });
  }
  return {
    title: "派活名单",
    markdown:
      "名单只能收窄，不能扩大：派活仍要同时通过「身份许可 ∩ 队伍许可」。\n\n未配置或名单为空都按「当前没人能派活」处理，不会静默全放行。",
    revision: policy.revision,
    sections: [
      {
        id: "allowlist",
        title: "可派活的档案",
        kind: "rows",
        key: "allowlist",
        editable: true,
        removable: true,
        addLabel: "加一个档案",
        columns: [{ key: "agentId", label: "档案 id" }],
        rows: policy.allowlist.map((agentId) => ({ agentId })),
        help: "写 SOUL.md front matter 里的 id，不是显示名。点行尾「移除」或把这一行清空再保存 = 移掉它；整份名单留空 = 当前没人能派活。",
      },
      {
        id: "grants",
        title: "改名单授权",
        kind: "rows",
        columns: [
          { key: "grantId", label: "授权" },
          { key: "agentId", label: "档案" },
          { key: "scope", label: "范围" },
          { key: "expiresAt", label: "到期" },
          { key: "status", label: "状态" },
        ],
        rows: grants.map((grant) => ({
          grantId: grant.grantId,
          agentId: grant.agentId,
          scope: `${grant.scope.source}/${grant.scope.lists.join(",")}`,
          expiresAt: grant.expiresAt ?? "不过期",
          status: policyGrantStatus(grant, policy.mode, now),
        })),
      },
      {
        id: "history",
        title: "近期改动（最近 20 条）",
        kind: "rows",
        columns: [
          { key: "at", label: "时间" },
          { key: "action", label: "动作" },
          { key: "actor", label: "来源" },
          { key: "grantId", label: "授权" },
          { key: "detail", label: "说明" },
        ],
        rows: history.map((event) => ({
          at: event.at,
          action: POLICY_ACTION_LABELS[event.action] ?? event.action,
          actor: policyActorLabel(event.actor),
          grantId: event.grantId ?? "—",
          detail: event.detail,
        })),
      },
      {
        id: "source-ledger",
        title: "派活账本（最近 20 条）",
        kind: "rows",
        columns: [
          { key: "at", label: "时间" },
          { key: "outcome", label: "结果" },
          { key: "teamId", label: "队伍" },
          { key: "detail", label: "说明" },
        ],
        rows: source.entries.slice(-20).reverse().map((entry) => ({
          at: entry.at,
          outcome: SOURCE_OUTCOME_LABELS[entry.outcome] ?? entry.outcome,
          teamId: entry.teamId ?? "—",
          detail: sourceEntryLine(entry),
        })),
      },
    ],
    fields: [
      {
        key: "sourceState",
        label: "派活来源",
        value: sourceStateLabel(source.state),
        readOnly: true,
        help: source.reason,
      },
      {
        key: "sourceMode",
        label: "来源模式",
        value: sourceModeLabel(source.mode),
        readOnly: true,
        help: "observe 是显式校准档：只记账不执行；切回 live 也是显式动作，不会自动放开。",
      },
      {
        key: "sourceToday",
        label: "今天",
        value: `观察 ${source.today.observed} / 派发 ${source.today.dispatched} / 被拒 ${source.today.filtered}`,
        readOnly: true,
      },
      {
        key: "mode",
        label: "谁能改名单",
        value: policyModeLabel(policy),
        readOnly: true,
        help: "默认只有主人；主人可以授权 Agent，但这个开关本身只有主人能拨。",
      },
      { key: "summary", label: "当前状态", value: policySummary(policy), readOnly: true },
      { key: "revision", label: "修订", value: policy.revision, readOnly: true },
      { key: "updatedAt", label: "最后修改", value: policy.updatedAt ?? "（还没保存过）", readOnly: true },
      {
        key: "updatedBy",
        label: "最后修改来源",
        value: policy.updatedBy === undefined ? "—" : policyActorLabel(policy.updatedBy),
        readOnly: true,
      },
    ],
    actions: [
      ...sourceActions,
      {
        id: "grant-edit",
        label: "授权一个 Agent 改名单",
        hint: "授权的范围是「内向派活名单」；到期时间可留空（不过期）。授权本身只有主人能拨。",
        args: [
          { key: "agentId", label: "要授权的档案 id", value: null },
          { key: "expiresAt", label: "到期（可空，ISO 时间）", value: null },
        ],
      },
      ...(policy.grants.length === 0
        ? []
        : [
            {
              id: "revoke-edit",
              label: "撤销一份授权",
              hint: "撤销记录保留；没有有效授权时开关自动回落到「只有主人」。",
              args: [{ key: "grantId", label: "授权 id（见上表）", value: null }],
            } satisfies ViewAction,
          ]),
      modeAction,
    ],
  };
}

/** 面板提交的 allowlist 行 → 档案 id 列表。清空的行按「移掉」处理。 */
function readPolicyAllowlist(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("派活名单必须是一组行");
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("派活名单的每一行必须是对象");
    }
    const record = item as Record<string, unknown>;
    const agentId = record.agentId;
    if (agentId === undefined) continue;
    if (typeof agentId !== "string") throw new Error("派活名单的档案 id 必须是文本");
    if (agentId.trim() === "") continue;
    values.push(agentId);
  }
  return normalizeDispatchPolicyAllowlist(values);
}

function readPolicyRevision(value: number | string | undefined): number {
  if (value === undefined) throw new Error("派活名单动作缺少修订号：请重新打开这一条再试");
  return readRevision(value);
}

/**
 * 造出军团的业务视图。
 *
 * @param host - 取军团服务；服务还没起来时返回 undefined（视图会如实报错，不是给空表）。
 * @returns 三个视图来源：队伍、运行与派活名单。
 */
export function createLegionViews(host: () => LegionViewHost | undefined): readonly ViewSource[] {
  const requireHost = (): LegionViewHost => {
    const service = host();
    if (service === undefined) throw new Error("军团服务没装上，业务视图不可用");
    return service;
  };
  // 每个操作都先核对档案。只查列表是不够的：直接按 id 打详情、保存、动作都能绕过核对，
  // 拿另一个档案的请求去读写本档案的队伍。
  const checked = (profile: ViewProfile): LegionViewHost => {
    const service = requireHost();
    assertProfileMatches(service, profile);
    return service;
  };

  const teams: ViewSource = {
    id: TEAM_VIEW_ID,
    title: "军团队伍",
    viewActions: [
      {
        id: "new-team",
        label: "新建一支队伍",
        hint: "队伍 id 只认小写字母、数字、下划线与连字符（3–64 位）；新队伍先有一个成员，之后再在名单里加。",
        args: [
          { key: "teamId", label: "队伍 id", value: null },
          { key: "laneId", label: "第一个成员的 lane", value: null },
          { key: "agentId", label: "第一个成员的档案（可留空）", value: null },
          { key: "mode", label: `模式（${TEAM_MODES.join(" / ")}）`, value: null },
          { key: "schedule", label: `调度（${TEAM_SCHEDULES.join(" / ")}，留空按并行）`, value: null },
          { key: "sharedGoal", label: "共同目标（可留空）", value: null },
        ],
      },
    ],
    async list(profile) {
      const service = checked(profile);
      const documents = await service.listTeams();
      // 一眼看出哪支队伍派不出活：停用的成员在列表上就标出来（A17）。读不动时不标——
      // 详情里会把「读不出来」如实报出来，列表这一格不猜。
      const index = await suspensionIndexOf(service);
      return documents
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((document) => {
          const stopped =
            index === undefined
              ? 0
              : memberSuspensions({ members: document.members, index }).filter((report) => report.suspended).length;
          const mark = stopped === 0 ? "" : ` · ${stopped} 个成员已停用`;
          return {
            id: document.id,
            title: document.managerIdentityLabel ?? document.id,
            summary: `${document.mode} · ${scheduleLabel(document.schedule)} · ${document.members.length}/${document.memberLimit} 人${mark}`,
            meta: `修订 ${document.revision}`,
          };
        });
    },
    async detail(input) {
      return teamBody(checked(input), input.itemId);
    },
    async save(input) {
      const service = checked(input);
      const allowed = [
        "members",
        "sharedGoal",
        "managerIdentityLabel",
        "mode",
        "schedule",
        "acceptance",
        "memberLimit",
        "maxConcurrentTasks",
      ];
      const keys = Object.keys(input.changes);
      for (const key of keys) {
        if (!allowed.includes(key)) throw new Error(`队伍详情不接受这个改动: ${key}`);
      }
      if (keys.length === 0) throw new Error("没有要保存的改动");
      let revision = readRevision(input.expectedRevision);
      // 名单、模式这些是结构：它们得合成一整份文档交给仓库（先校验再比修订），
      // 所以先做结构改动，再用它返回的新修订去改两个上限。
      if (STRUCTURAL_TEAM_KEYS.some((key) => keys.includes(key))) {
        const current = await service.loadTeam(input.itemId);
        if (current === undefined) throw new Error(`队伍不存在: ${input.itemId}`);
        const next: TeamDocument = {
          ...current,
          members: input.changes.members === undefined ? current.members : readMembers(input.changes.members),
          mode: input.changes.mode === undefined ? current.mode : readMode(input.changes.mode),
          schedule: input.changes.schedule === undefined ? current.schedule : readSchedule(input.changes.schedule),
        };
        // 可空文本：面板交空串是「清掉它」，不是「设成空字符串」。
        if (input.changes.sharedGoal !== undefined) {
          const goal = clearableText(input.changes.sharedGoal, "共同目标");
          if (goal === undefined) delete next.sharedGoal;
          else next.sharedGoal = goal;
        }
        if (input.changes.managerIdentityLabel !== undefined) {
          const label = clearableText(input.changes.managerIdentityLabel, "负责人称呼");
          if (label === undefined) delete next.managerIdentityLabel;
          else next.managerIdentityLabel = label;
        }
        if (input.changes.acceptance !== undefined) {
          const acceptance = readString(input.changes.acceptance, "验收模式");
          if (acceptance !== "human" && acceptance !== "auto") {
            throw new Error(`验收模式只认 human / auto: ${acceptance}`);
          }
          next.acceptance = acceptance;
        }
        const saved = await service.saveTeam(next, { expectedRevision: revision });
        revision = saved.revision;
      }
      // 仓库的两个 setter 各自带 revision 栅、各自把修订 +1，所以一次提交两处改动时，
      // 第二次要用第一次返回的新修订——否则会被自己刚写下的那一次挡下。
      if (input.changes.memberLimit !== undefined) {
        const saved = await service.setMemberLimit(input.itemId, {
          memberLimit: readInteger(input.changes.memberLimit, "人数上限"),
          expectedRevision: revision,
        });
        revision = saved.revision;
      }
      if (input.changes.maxConcurrentTasks !== undefined) {
        const saved = await service.setMaxConcurrentTasks(input.itemId, {
          maxConcurrentTasks: readInteger(input.changes.maxConcurrentTasks, "并发上限"),
          expectedRevision: revision,
        });
        revision = saved.revision;
      }
      return teamBody(service, input.itemId);
    },
    async act(input) {
      const service = checked(input);
      if (input.actionId !== "delete-team") throw new Error(`队伍详情不认识这个动作: ${input.actionId}`);
      const confirm = readString(input.args.confirmTeamId, "确认用的队伍 id");
      if (confirm !== input.itemId) {
        throw new Error(`确认的队伍 id 和要删的不是同一支: ${confirm} ≠ ${input.itemId}`);
      }
      // 删除是破坏性的：用面板打开这一条时读到的修订设栅，别人改过就不删。
      const expectedRevision = input.expectedRevision === undefined ? undefined : readRevision(input.expectedRevision);
      await service.removeTeam(input.itemId, expectedRevision === undefined ? {} : { expectedRevision });
      return { title: `已删除 ${input.itemId}`, sections: [] };
    },
    async actView(input) {
      const service = checked(input);
      if (input.actionId !== "new-team") throw new Error(`队伍列表不认识这个动作: ${input.actionId}`);
      const teamId = readString(input.args.teamId, "队伍 id");
      // 仓库的栅也挡得住（`expectedRevision: 0` 对上一支已有队伍必然冲突），但那时报的是
      // 「期望修订 0，实际 3」——不如直说这个 id 已经有人占了。
      if ((await service.loadTeam(teamId)) !== undefined) throw new Error(`队伍 id 已经被占用: ${teamId}`);
      const agentId = readOptionalString(input.args.agentId);
      const sharedGoal = readOptionalString(input.args.sharedGoal);
      const document: TeamDocument = {
        schemaVersion: LEGION_SCHEMA_VERSION,
        id: teamId,
        mode: readMode(input.args.mode),
        schedule: input.args.schedule === undefined ? "parallel" : readSchedule(input.args.schedule),
        members: [{ laneId: readString(input.args.laneId, "第一个成员的 lane"), ...(agentId === undefined ? {} : { agentId }) }],
        memberLimit: DEFAULT_MEMBER_LIMIT,
        maxConcurrentTasks: DEFAULT_MAX_CONCURRENT_TASKS,
        // 新队伍默认要人验收（§22.4）；要放开再在详情里改。
        acceptance: "human",
        // 修订与更新时间由仓库在写盘时定：这里填的只是占位，传 0 表示「我认为这是新队伍」。
        revision: 0,
        updatedAt: new Date(0).toISOString(),
        ...(sharedGoal === undefined ? {} : { sharedGoal }),
      };
      await service.saveTeam(document, { expectedRevision: 0 });
    },
  };

  const runs: ViewSource = {
    id: RUN_VIEW_ID,
    title: "军团运行",
    async list(profile) {
      const service = checked(profile);
      const records = await service.listRuns();
      // §22.4：待验收优先顶到最前；同为待验收再按最近活动排。
      const rank = (record: RunRecord): number => (record.status === "awaiting_acceptance" ? 0 : 1);
      return records
        .sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 50)
        .map((record) => ({
          id: record.runId,
          title: `${record.teamId} · ${scheduleLabel(record.schedule)}`,
          summary: `${runStatusLabel(record.status)}${record.status === "awaiting_acceptance" && acceptanceOverdue(record) ? "（已逾期）" : ""} · ${settledLine(record)}`,
          meta: `更新 ${record.updatedAt}`,
        }));
    },
    async detail(input) {
      return runBody(checked(input), input.itemId);
    },
    async act(input) {
      const service = checked(input);
      if (input.actionId === "cancel-lane") {
        const laneId = readString(input.args.laneId, "任务 lane");
        const record = await service.cancelLane(input.itemId, laneId, readOptionalString(input.args.reason));
        return runBody(service, record.runId);
      }
      if (input.actionId === "cancel-run") {
        const record = await service.cancelRun(input.itemId, readOptionalString(input.args.reason));
        return runBody(service, record.runId);
      }
      if (input.actionId === "accept-run") {
        const record = await service.acceptRun(input.itemId, "human", readOptionalString(input.args.note));
        return runBody(service, record.runId);
      }
      if (input.actionId === "reopen-run") {
        const record = await service.reopenRun(input.itemId, readOptionalString(input.args.reason));
        return runBody(service, record.runId);
      }
      throw new Error(`运行详情不认识这个动作: ${input.actionId}`);
    },
  };

  const policy: ViewSource = {
    id: POLICY_VIEW_ID,
    title: "派活名单",
    // 改名单/授权是管理动作：入口会拒绝无 Origin 的本机脚本写请求。
    requireOrigin: true,
    async list(profile) {
      const service = checked(profile);
      const snapshot = await service.readDispatchPolicy();
      return [
        {
          id: DISPATCH_POLICY_ITEM_ID,
          title: "派活名单",
          summary: policySummary(snapshot),
          meta: `修订 ${snapshot.revision}`,
        },
      ];
    },
    async detail(input) {
      const service = checked(input);
      if (input.itemId !== DISPATCH_POLICY_ITEM_ID) throw new Error(`派活名单没有这个条目: ${input.itemId}`);
      return policyBody(await service.readDispatchPolicy(), await service.readDispatchSource());
    },
    async save(input) {
      const service = checked(input);
      const keys = Object.keys(input.changes);
      if (keys.length === 0) throw new Error("没有要保存的改动");
      for (const key of keys) {
        if (key !== "allowlist") throw new Error(`派活名单不接受这个改动: ${key}`);
      }
      const snapshot = await service.saveDispatchPolicy({
        allowlist: readPolicyAllowlist(input.changes.allowlist),
        expectedRevision: readPolicyRevision(input.expectedRevision),
      });
      return policyBody(snapshot, await service.readDispatchSource());
    },
    async act(input) {
      const service = checked(input);
      const expectedRevision = readPolicyRevision(input.expectedRevision);
      if (input.actionId === "source-observe" || input.actionId === "source-live") {
        // 来源动作的 CAS 用来源自己的 revision；名单的修订号与它无关。
        const current = await service.readDispatchSource();
        const source = await service.setDispatchSourceMode({
          mode: input.actionId === "source-observe" ? "observe" : "live",
          expectedRevision: current.revision,
        });
        return policyBody(await service.readDispatchPolicy(), source);
      }
      if (input.actionId === "source-off" || input.actionId === "source-on") {
        const current = await service.readDispatchSource();
        const source = await service.setDispatchSourceEnabled({
          enabled: input.actionId === "source-on",
          expectedRevision: current.revision,
        });
        return policyBody(await service.readDispatchPolicy(), source);
      }
      if (input.actionId === "grant-edit") {
        const agentId = readString(input.args.agentId, "要授权的档案 id");
        const expiresAt = readOptionalString(input.args.expiresAt);
        const snapshot = await service.grantDispatchPolicyEdit({
          agentId,
          ...(expiresAt === undefined ? {} : { expiresAt }),
          expectedRevision,
        });
        return policyBody(snapshot, await service.readDispatchSource());
      }
      if (input.actionId === "revoke-edit") {
        const grantId = readString(input.args.grantId, "授权 id");
        const snapshot = await service.revokeDispatchPolicyEdit({ grantId, expectedRevision });
        return policyBody(snapshot, await service.readDispatchSource());
      }
      if (input.actionId === "mode-owner" || input.actionId === "mode-agent") {
        const snapshot = await service.setDispatchPolicyMode({
          mode: input.actionId === "mode-owner" ? "owner" : "agent",
          expectedRevision,
        });
        return policyBody(snapshot, await service.readDispatchSource());
      }
      throw new Error(`派活名单不认识这个动作: ${input.actionId}`);
    },
  };

  return [teams, runs, policy];
}

/** 入口 `VoidSuite.registerDetail` 的结构契约（重述，避免跨包类型依赖）。 */
interface DetailHost {
  registerDetail(source: ViewSource): () => void;
}

export const name = "void-legion-detail";
export const inject = ["voidSuite", "voidTeam"];

/**
 * 把三个视图登记进入口。
 *
 * 只在 web 组合里生效：headless 组合没有 `voidSuite`，这个 entry 的回调就永不执行，
 * 军团本身照常工作（§16.2 最后一条）。
 */
export function apply(ctx: Context): void {
  ctx.inject(["voidSuite", "voidTeam"], (viewCtx) => {
    const suite = viewCtx.get("voidSuite") as DetailHost | undefined;
    if (suite === undefined || typeof suite.registerDetail !== "function") return;
    const host = (): LegionViewHost | undefined => viewCtx.get("voidTeam") as LegionViewHost | undefined;
    for (const source of createLegionViews(host)) {
      viewCtx.effect(() => suite.registerDetail(source), `void-legion: detail view ${source.id}`);
    }
  });
}
