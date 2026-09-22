/**
 * Minimal snapshot of Star delegation team topology vocabulary.
 * Source: packages/belldandy-skills/src/delegation-protocol.ts.
 * Only the roster/authority types are carried; the full DelegationProtocol
 * (intent/contextPolicy/expectedDeliverable/aggregationPolicy/launchDefaults)
 * is deferred to the void-legion MVP.
 */

export type DelegationTeamMode =
  | "parallel_subtasks"
  | "parallel_patch"
  | "research_grid"
  | "verify_swarm"
  | "plan_execute_verify";

export type LaunchRole = "default" | "commander" | "coder" | "researcher" | "verifier";

export type AuthorityRelation = "self" | "superior" | "peer" | "subordinate" | "unknown";

/**
 * 三种调度语义（方案文档 §15.3）：同时干 / 按顺序干 / 分阶段干。
 *
 * 它与 {@link DelegationTeamMode} 是两件事：mode 是业务词汇（Star 的
 * `parallel_subtasks` / `plan_execute_verify` …），schedule 才是执行语义。
 * **不从 mode 推导 schedule**——拿业务名字当执行语义用，等于让调用方猜
 * 「这个模式到底会并发还是串行」，那正是方案文档反对的隐藏第二份权威。
 */
export const TEAM_SCHEDULES = ["parallel", "sequential", "staged"] as const;
export type TeamSchedule = (typeof TEAM_SCHEDULES)[number];

export interface DelegationTeamMember {
  laneId: string;
  agentId?: string;
  role?: LaunchRole;
  identityLabel?: string;
  authorityRelationToManager?: AuthorityRelation;
  reportsTo?: string[];
  mayDirect?: string[];
  scopeSummary?: string;
  /**
   * 逐任务的模型路由（§15.3「不同模型路由实收」）。
   *
   * 它落在**成员**上而不是队伍上：同一支队伍里「便宜的活给便宜模型、验收给强模型」
   * 是常态，挂在队伍上就只能全队一个模型。空着表示跟随调用方默认路由。
   */
  modelRef?: string;
  dependsOn?: string[];
  handoffTo?: string[];
  /**
   * 这个任务在哪个工作区干活。空着表示本次 run 的默认工作区。
   *
   * 工作区是**锁的键**（§15.3）：同一个工作区上的写任务串行，显式分了
   * 已隔离工作区/worktree 的才并发。
   */
  workspace?: string;
  /**
   * 这个任务会不会改工作区。
   *
   * **默认 `true`（当写任务）**，而不是默认只读。理由在 §15.3：工作区并发写入
   * 不能靠「它们是不同任务」自动安全。不声明就当写任务，最多是慢；声明错了
   * 是两个人同时改一个文件。要并发的只读任务必须自己写 `writes: false`。
   */
  writes?: boolean;
  /**
   * 分阶段调度里的阶段号（从 1 开始）。只有 `staged` 队伍要求每人都写，
   * 其余调度写了就拒绝——不留一个「写了但不生效」的字段。
   */
  stage?: number;
}

export interface DelegationTeamMetadata {
  id: string;
  mode: DelegationTeamMode;
  sharedGoal?: string;
  managerAgentId?: string;
  managerIdentityLabel?: string;
  currentLaneId?: string;
  memberRoster: DelegationTeamMember[];
  /** 调度方式；不写按 `parallel`。 */
  schedule?: TeamSchedule;
  /** 人数上限（含指挥者与临时成员）；不写按 8。 */
  memberLimit?: number;
  /** 本服务总并发上限（§15.3）；不写按 4。派活时冻结进运行记录。 */
  maxConcurrentTasks?: number;
}
