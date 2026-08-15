import { Service, type Context } from "@deepseek-ai/cordis";
import type { DelegationTeamMetadata, DelegationTeamMember } from "./team.js";

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
 * Topologically order a roster by `dependsOn` (Kahn's algorithm). Lanes with no
 * dependencies come first; a dependency on an unknown lane is ignored.
 */
export function topoSortRoster(roster: readonly DelegationTeamMember[]): string[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const member of roster) {
    indegree.set(member.laneId, 0);
  }
  for (const member of roster) {
    for (const dep of member.dependsOn ?? []) {
      if (!indegree.has(dep)) continue;
      indegree.set(member.laneId, (indegree.get(member.laneId) ?? 0) + 1);
      const list = dependents.get(dep);
      if (list) list.push(member.laneId);
      else dependents.set(dep, [member.laneId]);
    }
  }
  const queue = roster.filter((m) => (indegree.get(m.laneId) ?? 0) === 0).map((m) => m.laneId);
  const order: string[] = [];
  while (queue.length > 0) {
    const laneId = queue.shift()!;
    order.push(laneId);
    for (const dependent of dependents.get(laneId) ?? []) {
      const next = (indegree.get(dependent) ?? 1) - 1;
      indegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }
  return order;
}

/** 缺省 worker：无实际执行，仅记录进度（保持 launch 开箱可用）。 */
const defaultWorker: LaneWorker = async () => ({ done: true });

/**
 * Service Definition: the Void legion seam. Owns `ctx.voidTeam` — the single
 * source of truth for team topology. `launch` is the execution engine: dispatch
 * lanes in `dependsOn` order, run each lane's worker, record real checkpoints,
 * and fail-fast downstream lanes whose upstream lane failed.
 */
export class VoidTeam extends Service {
  private readonly teams = new Map<string, DelegationTeamMetadata>();
  private readonly checkpoints = new Map<string, Map<string, LaneStatus>>();

  constructor(ctx: Context) {
    super(ctx, "voidTeam");
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

  /**
   * 执行引擎：按 dependsOn 拓扑顺序逐 lane 派发 worker，记录真实 checkpoint。
   * 上游 lane 失败 → 其下游（直接依赖）lane 标记 failed 且不派发（fail-fast 传播）。
   */
  async launch(teamId: string, options: LaunchOptions = {}): Promise<LaunchResult> {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`team "${teamId}" is not defined`);
    const order = topoSortRoster(team.memberRoster);
    const byLane = new Map(team.memberRoster.map((m) => [m.laneId, m]));
    const worker = options.worker ?? defaultWorker;
    const task = options.task ?? "";
    const outputs = new Map<string, unknown>();
    const failed = new Set<string>();
    const results: LaneResult[] = [];

    for (const laneId of order) {
      const member = byLane.get(laneId)!;
      const deps = member.dependsOn ?? [];
      if (deps.some((dep) => failed.has(dep))) {
        this.checkpoint(teamId, laneId, "failed");
        failed.add(laneId);
        results.push({ laneId, status: "failed", error: "blocked by failed upstream lane" });
        continue;
      }
      const upstream = Object.fromEntries(deps.map((dep) => [dep, outputs.get(dep)]));
      this.checkpoint(teamId, laneId, "in_progress");
      try {
        const output = await worker({ laneId, teamId, task, member, upstream });
        outputs.set(laneId, output);
        this.checkpoint(teamId, laneId, "completed");
        results.push({ laneId, status: "completed", output });
      } catch (error) {
        this.checkpoint(teamId, laneId, "failed");
        failed.add(laneId);
        results.push({
          laneId,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      order,
      results,
      checkpoints: order.map((laneId) => ({ laneId, status: this.getCheckpoint(teamId, laneId) ?? "pending" })),
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

export default VoidTeam;
