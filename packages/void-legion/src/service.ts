import path from "node:path";
import { Service, type Context } from "@deepseek-ai/cordis";
import { profileLocationFromBaseUrl, readProfileDirectory } from "@void/void-soul";
import { teamDocumentOf, teamMetadataOf, type TeamDocument } from "./contracts.js";
import { laneOrder } from "./plan-validator.js";
import type { TaskPlan } from "./planner.js";
import { RunCoordinator, type LegionRunProgress } from "./run-coordinator.js";
import { LEGION_RUN_TERMINAL_EVENT, LegionNotificationStore } from "./notifications.js";
import { RunStore, type ExternalRunSource, type RunRecord, type RunTaskStatus } from "./run-store.js";
import { DispatchPolicyError, DispatchPolicyRepository, dispatchDenialReason, type DispatchPolicyMode, type DispatchPolicySnapshot } from "./dispatch-policy.js";
import {
  DispatchSourceError,
  DispatchSourceRepository,
  sourceStateReason,
  type DispatchSourceEntry,
  type DispatchSourceMode,
  type DispatchSourceSnapshot,
} from "./dispatch-source.js";
import { DispatchGate, type ScheduleWorker } from "./scheduler.js";
import { TeamRepository, resolveLegionDataDir } from "./team-repository.js";
import type { AcceptanceMode, DelegationTeamMember, DelegationTeamMetadata } from "./team.js";
import { WorktreeManager } from "./worktree.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    voidTeam: VoidTeam;
  }
}

export type LaneStatus = "pending" | "in_progress" | "completed" | "failed";

/** 单个 lane 的 worker（执行引擎的可注入执行体）。 */
export type LaneWorker = (input: LaneWorkerInput) => Promise<unknown>;

export interface LaneWorkerInput {
  laneId: string;
  teamId: string;
  task: string;
  member: DelegationTeamMember;
  /** 上游（dependsOn）lane 的输出，按 laneId 键。 */
  upstream: Record<string, unknown>;
}

export interface LaunchOptions {
  task?: string;
  worker?: LaneWorker;
}

export interface LaneResult {
  laneId: string;
  status: LaneStatus;
  output?: unknown;
  error?: string;
}

export interface LaunchResult {
  /** lane IDs in dependency-respecting execution order. */
  order: string[];
  results: LaneResult[];
  checkpoints: Array<{ laneId: string; status: LaneStatus }>;
}

/**
 * Topologically order a roster by `dependsOn` (Kahn's algorithm).
 *
 * 这是**宽松**版本：未知依赖被忽略，成环的成员会被静默丢掉。它保留下来只为
 * 兼容不参与派发的调用方；派活路径一律走 `orderLanes`（严格，见 plan-validator.ts）。
 */
export function topoSortRoster(roster: readonly DelegationTeamMember[]): string[] {
  return laneOrder(roster, { strict: false });
}

/** `VoidTeam` 的装配配置。 */
export interface VoidTeamConfig {
  /** 显式数据根（绝对路径）。给了就不再解析 DSH_HOME / profile。 */
  dataDir?: string | undefined;
  dshHome?: string | undefined;
  profile?: string | undefined;
  now?: (() => Date) | undefined;
  /** 全服务并发槽位（§15.3 第二个量）；缺省 4，可按队伍覆盖。 */
  maxConcurrentTasks?: number | undefined;
  /** 独立检出（B6）的仓库目录；默认 process.cwd()。相对路径按进程目录解析。 */
  worktreeRepo?: string | undefined;
  /** 关掉独立检出能力；默认开（成员仍要显式 `checkout: "worktree"` 才用）。 */
  worktree?: boolean | undefined;
}

/** P5 派活选项：**立刻返回 runId**，执行在后台继续。 */
export interface DispatchOptions {
  task?: string;
  initiatedBy?: string;
  /** 真实执行体（`createScheduledWorker` 的产物）。 */
  worker: ScheduleWorker;
  /** 手动计划（Host 校验后才派）。 */
  plan?: TaskPlan;
  /** 本次临时成员：只进这一次的名单（L14）。 */
  temporaryMembers?: readonly DelegationTeamMember[];
  signal?: AbortSignal;
  /** 权限快照校验，在派出任何任务之前跑（P4 门禁）。 */
  authorize?: (roster: readonly DelegationTeamMember[]) => void | Promise<void>;
  maxConcurrentTasks?: number;
  /**
   * 单次 run 的验收模式覆盖（§22.4）。可信调用方用；`launch_legion` 不暴露它，
   * 派活的档案不能自己把闸门关掉。
   */
  acceptance?: AcceptanceMode;
}

/** 外部触发来源的派活输入（B8）。只有来源适配层会构造它。 */
export interface ExternalDispatchOptions {
  teamId: string;
  task?: string | undefined;
  source: ExternalRunSource;
  worker: ScheduleWorker;
  signal?: AbortSignal | undefined;
  maxConcurrentTasks?: number | undefined;
  /** 逐成员身份预载（可信来源入口仍要保证子代理有自己的身份）。 */
  authorize?: ((roster: readonly DelegationTeamMember[]) => void | Promise<void>) | undefined;
}

/**
 * Service Definition: the Void legion seam. Owns `ctx.voidTeam` — the single
 * source of truth for team topology. `launch` is the execution engine: dispatch
 * lanes in `dependsOn` order, run each lane's worker, record real checkpoints,
 * and fail-fast downstream lanes whose upstream lane failed.
 *
 * 队伍有两个来源，优先级固定：**先看内存里 defineTeam 注册的，再看磁盘上保存的**。
 * 内存那层是给「程序里现搭一支队伍」用的，磁盘那层是 L10「存下来复用」。
 * 派活时两层的名单都先过 `validateTeamPlan`，不存在「因为来源不同就少校验一项」。
 */
export class VoidTeam extends Service {
  private readonly teams = new Map<string, DelegationTeamMetadata>();
  private readonly checkpoints = new Map<string, Map<string, LaneStatus>>();
  private readonly repository: TeamRepository | undefined;
  /** 派活名单仓库。与队伍仓库同根，独立文件、独立修订号。 */
  private readonly policy: DispatchPolicyRepository | undefined;
  /** 派活来源与沉默账本（B3/B5）。与队伍仓库同根。 */
  private readonly source: DispatchSourceRepository | undefined;
  /** 独立检出（B6）；没有数据根或显式关掉时为 undefined。 */
  private readonly worktree: WorktreeManager | undefined;
  private readonly runs: RunCoordinator | undefined;
  private readonly notices: LegionNotificationStore | undefined;
  private readonly now: () => Date;
  /** 重启结算的结果（在跑的 run 被标 interrupted 的数量），供工具如实汇报。 */
  private settledCount: number | undefined;

  constructor(ctx: Context, config: VoidTeamConfig = {}) {
    super(ctx, "voidTeam");
    this.now = config.now ?? (() => new Date());
    this.repository = buildRepository(config, ctx);
    this.policy =
      this.repository === undefined
        ? undefined
        : new DispatchPolicyRepository({ dataDir: this.repository.dataDirPath, now: this.now });
    this.source =
      this.repository === undefined
        ? undefined
        : new DispatchSourceRepository({ dataDir: this.repository.dataDirPath, now: this.now });
    this.worktree =
      this.repository === undefined || config.worktree === false
        ? undefined
        : new WorktreeManager({
            repoDir: path.resolve(config.worktreeRepo ?? process.cwd()),
            rootDir: path.join(this.repository.dataDirPath, "legion", "worktrees"),
          });
    // 终态通知与运行记录同根：有数据根才有通知（没有数据根就没有「重连补读」可言）。
    this.notices =
      this.repository === undefined
        ? undefined
        : new LegionNotificationStore({
            dataDir: this.repository.dataDirPath,
            ...(config.now === undefined ? {} : { now: config.now }),
          });
    // 有数据根就落盘，没有就只活在内存里——**不假装存下来了**（见 RunCoordinator.persistent）。
    this.runs = new RunCoordinator({
      ...(this.repository === undefined
        ? {}
        : {
            store: new RunStore({
              dataDir: this.repository.dataDirPath,
              ...(config.now === undefined ? {} : { now: config.now }),
            }),
          }),
      ...(this.notices === undefined ? {} : { notifications: this.notices }),
      ...(this.worktree === undefined ? {} : { worktree: this.worktree }),
      // 终态事件：谁在听谁投递（P6g 的 control 适配）。没装 control 时只是没人听。
      onTerminal: (event) => {
        this.ctx.emit(LEGION_RUN_TERMINAL_EVENT, event);
      },
      ...(config.maxConcurrentTasks === undefined
        ? {}
        : { gate: new DispatchGate({ maxConcurrentTasks: config.maxConcurrentTasks }) }),
      ...(config.now === undefined ? {} : { now: config.now }),
    });
    // 重启结算：上一轮没跑完的 run 标 interrupted，不假装它还在跑、也不自动重跑。
    // 构造器里是后台跑：失败不该让整个插件装不上；显式调用 settleRuns() 时会照实抛。
    void this.settleRuns().catch(() => undefined);
  }

  /** 队伍配置仓库；数据根没配好时为 undefined（此时只有内存队伍可用）。 */
  get teamRepository(): TeamRepository | undefined {
    return this.repository;
  }

  /** 派活名单仓库；数据根没配好时为 undefined（此时派活按 fail-closed 拒绝）。 */
  get dispatchPolicyRepository(): DispatchPolicyRepository | undefined {
    return this.policy;
  }

  /** 派活来源仓库；数据根没配好时为 undefined（此时按 fail-closed 拒绝派活）。 */
  get dispatchSourceRepository(): DispatchSourceRepository | undefined {
    return this.source;
  }

  /** 独立检出管理器（B6）；没有数据根或显式关掉时为 undefined。 */
  get worktreeManager(): WorktreeManager | undefined {
    return this.worktree;
  }

  private requireSourceRepository(): DispatchSourceRepository {
    if (this.source === undefined) {
      throw new DispatchSourceError("军团没有数据根，无法核对派活来源：需要配置 dataDir，或提供 profile（DSH_PROFILE）");
    }
    return this.source;
  }

  /** 面板读来源：损坏时返回 state:error，不把整块面板打崩。 */
  async readDispatchSource(): Promise<DispatchSourceSnapshot> {
    return this.requireSourceRepository().trySnapshot();
  }

  /**
   * 派活前读来源；来源不可用（off/error/setup/starting/missing）就抛。
   *
   * `paused`（observe）**不抛**：调用方要拿它走观察路径。
   */
  async requireDispatchSourceReady(): Promise<DispatchSourceSnapshot> {
    const snapshot = await this.requireSourceRepository().snapshot();
    if (snapshot.state === "ready" || snapshot.state === "paused") return snapshot;
    const reason = sourceStateReason(snapshot.state, snapshot.mode);
    throw new DispatchSourceError(`${reason}（来源状态: ${snapshot.state}）`);
  }

  /** 面板切 live/observe。observe 是显式动作；从 observe 切回 live 同样是显式动作。 */
  async setDispatchSourceMode(input: {
    mode: DispatchSourceMode;
    expectedRevision: number;
  }): Promise<DispatchSourceSnapshot> {
    return this.requireSourceRepository().setMode(input);
  }

  /** 面板停用/启用来源。停用后请求只记账、不执行。 */
  async setDispatchSourceEnabled(input: {
    enabled: boolean;
    expectedRevision: number;
  }): Promise<DispatchSourceSnapshot> {
    return this.requireSourceRepository().setEnabled(input);
  }

  /** 记一条来源账。失败时由调用方决定是「观察没写成」还是「拒绝原因已经报出去了」。 */
  async recordDispatchSource(entry: Omit<DispatchSourceEntry, "at">): Promise<DispatchSourceSnapshot> {
    return this.requireSourceRepository().record(entry);
  }

  private requirePolicyRepository(): DispatchPolicyRepository {
    if (this.policy === undefined) {
      throw new DispatchPolicyError("军团没有数据根，无法核对派活名单：需要配置 dataDir，或提供 profile（DSH_PROFILE）");
    }
    return this.policy;
  }

  /** 读派活名单的有效视图。没配置过时 `configured: false`，不是「全放行」。 */
  async readDispatchPolicy(): Promise<DispatchPolicySnapshot> {
    return this.requirePolicyRepository().snapshot();
  }

  /**
   * 派活与运行操作的第三道门：名单里没有这个人就拒绝。
   *
   * 每次调用重读磁盘——主人刚在面板里移掉一个账号，下一次派活当场生效，不重启。
   * 这里只判名单；身份许可 ∩ 队伍许可仍由 `authority.ts` 照旧判。
   */
  async assertActorMayDispatch(actorId: string): Promise<void> {
    const policy = await this.readDispatchPolicy();
    const reason = dispatchDenialReason({ policy, actorId, now: this.now() });
    if (reason !== undefined) throw new DispatchPolicyError(reason);
  }

  /** 面板保存名单（主人通道）。 */
  async saveDispatchPolicy(input: {
    allowlist: readonly string[];
    expectedRevision: number;
    detail?: string | undefined;
  }): Promise<DispatchPolicySnapshot> {
    return this.requirePolicyRepository().saveAllowlist(input);
  }

  /** 面板授权一个 Agent 改名单（主人通道；Agent 工具没有这个动作）。 */
  async grantDispatchPolicyEdit(input: {
    agentId: string;
    expiresAt?: string | undefined;
    expectedRevision: number;
  }): Promise<DispatchPolicySnapshot> {
    return this.requirePolicyRepository().grant(input);
  }

  /** 面板撤销一份授权。 */
  async revokeDispatchPolicyEdit(input: { grantId: string; expectedRevision: number }): Promise<DispatchPolicySnapshot> {
    return this.requirePolicyRepository().revoke(input);
  }

  /** 面板拨开/收回 Agent 改名单的开关（不删授权记录）。 */
  async setDispatchPolicyMode(input: {
    mode: DispatchPolicyMode;
    expectedRevision: number;
  }): Promise<DispatchPolicySnapshot> {
    return this.requirePolicyRepository().setMode(input);
  }

  /** Agent 经 `legion_policy` 工具改名单；仓库里再核一次有效授权并留痕。 */
  async mutateDispatchPolicyAsAgent(input: {
    actorId: string;
    action: "add" | "remove";
    agentId: string;
  }): Promise<{ snapshot: DispatchPolicySnapshot; changed: boolean; grantId: string }> {
    return this.requirePolicyRepository().mutateAsAgent(input);
  }

  /**
   * 本服务实际使用的数据根；没配好时为 undefined。
   *
   * 业务视图拿它核对「面板问的档案」与「服务在用的那一份」是不是同一个——装了两份
   * 档案时，面板安静地显示另一份的队伍比报错难查得多。
   */
  get dataRoot(): string | undefined {
    return this.repository?.dataDirPath;
  }

  /** 运行记录仓库；数据根没配好时为 undefined。 */
  get runCoordinator(): RunCoordinator | undefined {
    return this.runs;
  }

  /**
   * 终态通知仓库；数据根没配好时为 undefined。
   *
   * 面板的「军团运行」通知来源读它：断线时跑完的那一次，重连后按未读补读（§16.2 L9 第五条）。
   */
  get notifications(): LegionNotificationStore | undefined {
    return this.notices;
  }

  private requireCoordinator(): RunCoordinator {
    if (this.runs === undefined) {
      throw new Error("军团没有数据根，无法派活留档：需要配置 dataDir，或提供 profile（DSH_PROFILE）");
    }
    return this.runs;
  }

  /**
   * 重启结算：把磁盘上还是 `running` 的 run 结清。构造时自动跑一次，也可手动再跑。
   *
   * **不吞错误**：读盘真坏了就照实抛，否则「以为结算过了」比没结算更糟。
   */
  async settleRuns(): Promise<number> {
    if (this.runs === undefined) return 0;
    const settled = await this.runs.settleInterrupted();
    this.settledCount = settled.length;
    return settled.length;
  }

  /** 上次重启结算把几个 run 标成了 interrupted。 */
  get lastSettleResult(): number | undefined {
    return this.settledCount;
  }

  /** Register one team topology (the single source of truth). Returns disposer. */
  defineTeam(metadata: DelegationTeamMetadata): () => void {
    return this.ctx.effect(() => {
      this.teams.set(metadata.id, metadata);
      return () => {
        this.teams.delete(metadata.id);
      };
    }, "voidTeam.defineTeam()");
  }

  /** Observe a team's roster + authority graph. */
  observe(teamId: string): DelegationTeamMetadata | undefined {
    return this.teams.get(teamId);
  }

  private requireRepository(): TeamRepository {
    if (this.repository === undefined) {
      throw new Error("军团没有数据根，无法读写保存的队伍：需要配置 dataDir，或提供 profile（DSH_PROFILE）");
    }
    return this.repository;
  }

  /** 保存（新建或覆盖）一支队伍。并发覆盖由 revision 挡住。 */
  async saveTeam(document: TeamDocument, options: { expectedRevision?: number | undefined } = {}): Promise<TeamDocument> {
    return this.requireRepository().save({
      document,
      ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
    });
  }

  /** 把内存里注册的队伍落盘保存。 */
  async saveDefinedTeam(teamId: string, options: { expectedRevision?: number | undefined } = {}): Promise<TeamDocument> {
    const metadata = this.teams.get(teamId);
    if (metadata === undefined) throw new Error(`team "${teamId}" is not defined`);
    return this.saveTeam(teamDocumentOf(metadata), options);
  }

  async loadTeam(teamId: string): Promise<TeamDocument | undefined> {
    return this.requireRepository().load(teamId);
  }

  async listTeams(): Promise<TeamDocument[]> {
    return this.requireRepository().list();
  }

  async removeTeam(teamId: string, options: { expectedRevision?: number | undefined } = {}): Promise<void> {
    return this.requireRepository().remove(teamId, options);
  }

  /** 改人数上限（L13）。 */
  async setMemberLimit(teamId: string, input: { memberLimit: number; expectedRevision?: number | undefined }): Promise<TeamDocument> {
    return this.requireRepository().setMemberLimit(teamId, input);
  }

  /** 改本服务总并发上限（§15.3）。只影响之后的派活，不强杀在跑的。 */
  async setMaxConcurrentTasks(
    teamId: string,
    input: { maxConcurrentTasks: number; expectedRevision?: number | undefined },
  ): Promise<TeamDocument> {
    return this.requireRepository().setMaxConcurrentTasks(teamId, input);
  }

  /** 解析一支队伍的运行时拓扑：内存优先，其次磁盘。 */
  async resolveTeam(teamId: string): Promise<DelegationTeamMetadata> {
    const inMemory = this.teams.get(teamId);
    if (inMemory !== undefined) return inMemory;
    const saved = await this.loadTeam(teamId);
    if (saved === undefined) throw new Error(`team "${teamId}" is not defined`);
    return teamMetadataOf(saved);
  }

  /**
   * P5 执行引擎：**立刻返回 runId**，执行在后台继续。
   *
   * 派活前一次性冻结：名单（含本次临时成员）、人数上限、并发上限、调度方式、逐任务
   * 模型路由与工作区、权限快照。之后改队伍配置不影响已经在跑的这一次（§15.2）。
   *
   * 与旧 `launch` 的根本区别：旧实现同步跑完才返回，派活方拿不到 runId，中途没法叫停，
   * 也看不到跑到哪；而且没有运行记录，重启就全丢。
   */
  async dispatch(teamId: string, options: DispatchOptions): Promise<RunRecord> {
    // 名单是派活路径的第三道门。模型工具一定带 `initiatedBy`，所以工具层之外
    // 的代码调用只要声明了发起者也同样受管；**没有发起者的是可信代码路径**
    // （宿主内部的 `launch` 兼容层、测试），不能凭空安一个身份去判。
    if (options.initiatedBy !== undefined) await this.assertActorMayDispatch(options.initiatedBy);
    const team = await this.resolveTeam(teamId);
    const coordinator = this.requireCoordinator();
    return coordinator.dispatch({
      teamId,
      team,
      ...(options.initiatedBy === undefined ? {} : { initiatedBy: options.initiatedBy }),
      ...(options.task === undefined ? {} : { task: options.task }),
      ...(options.plan === undefined ? {} : { plan: options.plan }),
      ...(options.temporaryMembers === undefined ? {} : { temporaryMembers: options.temporaryMembers }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
      ...(options.maxConcurrentTasks === undefined
        ? {}
        : { maxConcurrentTasks: options.maxConcurrentTasks }),
      ...(options.acceptance === undefined ? {} : { acceptance: options.acceptance }),
      worker: options.worker,
    });
  }

  /**
   * 外部触发来源的派活入口（B8）。
   *
   * 这是**可信代码路径**：来源适配层已经按自己的 `allowed` / `bots` 判过授权，
   * 这里不再走 B1 的「Agent 派活名单」门；但队伍解析、计划校验、运行记录、
   * 工作区锁、验收默认值（强制 `human`）一样不少。模型工具不可达这个入口——
   * `launch_legion` 仍走 `dispatch`，名单照判。
   */
  async dispatchExternal(input: ExternalDispatchOptions): Promise<RunRecord> {
    const team = await this.resolveTeam(input.teamId);
    const coordinator = this.requireCoordinator();
    return coordinator.dispatch({
      teamId: input.teamId,
      team,
      initiatedBy: `source:${input.source.id}`,
      source: input.source,
      ...(input.task === undefined ? {} : { task: input.task }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.maxConcurrentTasks === undefined ? {} : { maxConcurrentTasks: input.maxConcurrentTasks }),
      ...(input.authorize === undefined ? {} : { authorize: input.authorize }),
      // 外部触发不是主人亲手派的：验收永远默认 human（§22.7.8），来源侧不能覆盖。
      acceptance: "human",
      worker: input.worker,
    });
  }

  /** 等一次运行落定（工具与测试用；派活路径本身不等）。 */
  async waitForRun(runId: string): Promise<RunRecord> {
    const coordinator = this.requireCoordinator();
    return coordinator.waitFor(runId);
  }

  /** 进度：当前任务、已结算/总数、最近活动时间、原生子会话 id，不编百分比。 */
  async runProgress(runId: string): Promise<LegionRunProgress> {
    return this.requireCoordinator().progress(runId);
  }

  /** 取完整运行记录（含每人的完整产出）。 */
  async runRecord(runId: string): Promise<RunRecord> {
    return this.requireCoordinator().require(runId);
  }

  async readRunOutputPage(runId: string, laneId: string, offset: number, length?: number) {
    return this.requireCoordinator().readOutputPage(runId, laneId, offset, length);
  }

  async listRuns(): Promise<RunRecord[]> {
    return this.requireCoordinator().list();
  }

  async listRunsByTeam(teamId: string): Promise<RunRecord[]> {
    return this.requireCoordinator().listByTeam(teamId);
  }

  /** 取消一个成员：没轮到的直接不派，在跑的走它自己的取消通道。 */
  async cancelLane(runId: string, laneId: string, reason?: string): Promise<RunRecord> {
    return this.requireCoordinator().cancelLane(runId, laneId, reason);
  }

  /** 全队取消。 */
  async cancelRun(runId: string, reason?: string): Promise<RunRecord> {
    return this.requireCoordinator().cancelRun(runId, reason);
  }

  /** 人工验收：待验收 → 已完成（§22.4）。 */
  async acceptRun(runId: string, acceptedBy: "human" | "auto" = "human", note?: string): Promise<RunRecord> {
    return this.requireCoordinator().acceptRun(runId, acceptedBy, note);
  }

  /** 翻案：自动确认的已完成 → 待验收。 */
  async reopenRun(runId: string, reason?: string): Promise<RunRecord> {
    return this.requireCoordinator().reopenRun(runId, reason);
  }

  /** 改全服务并发槽位（L13）。 */
  setCapacity(value: number): void {
    this.runs?.setCapacity(value);
  }

  /**
   * 同步派活（兼容路径）：走**同一个**引擎与同一份运行记录，只是等到落定才返回。
   *
   * 保留它是为了不参与后台运行的调用方（以及老的 `LaneWorker` 回调式执行体）；
   * 新代码应该用 `dispatch`。
   */
  async launch(teamId: string, options: LaunchOptions = {}): Promise<LaunchResult> {
    const worker = options.worker;
    if (worker === undefined) {
      throw new Error(`派活缺少执行体：team "${teamId}" 的 launch 必须提供 worker，拒绝空跑成功`);
    }
    const record = await this.dispatch(teamId, {
      ...(options.task === undefined ? {} : { task: options.task }),
      worker: adaptLaneWorker(worker),
    });
    const settled = await this.waitForRun(record.runId);
    // 同步路径的老调用方读的是这张按 team 的最新 checkpoint 表；运行记录才是权威。
    for (const task of settled.tasks) {
      this.checkpoint(teamId, task.laneId, toLaneStatus(task.status));
    }
    return {
      order: laneOrder(settled.frozenRoster, { strict: true }),
      results: settled.tasks.map((task) => ({
        laneId: task.laneId,
        status: toLaneStatus(task.status),
        ...(task.output === undefined ? {} : { output: task.output }),
        ...(task.error === undefined ? {} : { error: task.error }),
      })),
      checkpoints: settled.tasks.map((task) => ({ laneId: task.laneId, status: toLaneStatus(task.status) })),
    };
  }

  /** Record a lane checkpoint (the machine-readable progress heartbeat). */
  checkpoint(teamId: string, laneId: string, status: LaneStatus): void {
    let lanes = this.checkpoints.get(teamId);
    if (!lanes) {
      lanes = new Map();
      this.checkpoints.set(teamId, lanes);
    }
    lanes.set(laneId, status);
  }

  getCheckpoint(teamId: string, laneId: string): LaneStatus | undefined {
    return this.checkpoints.get(teamId)?.get(laneId);
  }
}

/**
 * 数据根没配好时返回 undefined，而不是让 service 加载失败：军团的内存能力
 * （defineTeam / launch）不依赖磁盘，宿主不一定需要持久化。
 *
 * 但**显式配错**不在此列：给了 dataDir 或 profile 却解析不出来，就照实报错。
 * 把配置错误静默降级成「只有内存队伍」，会让人以为队伍存下来了。
 */
function buildRepository(config: VoidTeamConfig, ctx?: unknown): TeamRepository | undefined {
  const baseUrl = readProfileDirectory(ctx);
  const explicit = config.dataDir?.trim();
  if (explicit === undefined || explicit.length === 0) {
    const profile = config.profile?.trim() ?? process.env.DSH_PROFILE?.trim() ?? profileLocationFromBaseUrl(baseUrl)?.name;
    if (profile === undefined || profile.length === 0) return undefined;
  }
  const dataDir = resolveLegionDataDir({
    ...(config.dataDir === undefined ? {} : { dataDir: config.dataDir }),
    ...(config.dshHome === undefined ? {} : { dshHome: config.dshHome }),
    ...(config.profile === undefined ? {} : { profile: config.profile }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  });
  return new TeamRepository({ dataDir, ...(config.now === undefined ? {} : { now: config.now }) });
}

/**
 * 把老的 `LaneWorker`（回调式执行体）接成调度器的 worker。
 *
 * 这只是形状转换：`TaskRunContext` 比 `LaneWorkerInput` 多出的东西（runId、逐任务
 * signal、工作区归属）老接口接不住，所以**取消在同步路径上只有全队取消才生效**——
 * 这是老接口的限制，不是引擎的限制。
 */
function adaptLaneWorker(worker: LaneWorker): ScheduleWorker {
  return (context) =>
    worker({
      laneId: context.laneId,
      teamId: context.teamId,
      task: context.task,
      member: context.member,
      upstream: context.upstream,
    });
}

/** 运行记录的逐任务状态 → 老的 lane 状态（同步路径的调用方读这个）。 */
function toLaneStatus(status: RunTaskStatus): LaneStatus {
  if (status === "completed") return "completed";
  if (status === "running") return "in_progress";
  if (status === "pending") return "pending";
  // blocked / failed / cancelled / interrupted 对老调用方都是「这个 lane 没干成」。
  return "failed";
}

export default VoidTeam;
