import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { AuthoritySource } from "@void/void-soul";
import { assertTeamDispatch } from "./authority.js";
import { teamMetadataOf } from "./contracts.js";
import { loadMemberPersonas, personaOf } from "./member-identity.js";
import { parseTaskPlan } from "./planner.js";
import type { VoidTeam } from "./service.js";
import { createScheduledWorker } from "./subagent-provider.js";
import type { DelegationTeamMetadata } from "./team.js";

export const name = "void-legion-tool";
export const inject = ["tools", "voidTeam"];

/**
 * Consumer: registers the model-facing `launch_legion` tool.
 *
 * **派活不等跑完**（§15.2）：工具立刻返回 `runId`，执行在后台继续。想等结果的用
 * `legion_run` 的 `wait`，想看进度的用 `legion_run`，想叫停的用 `legion_cancel`。
 * 这不是为了好看——派活方拿不到 runId 就没法看进度、没法叫停、没法取完整产出。
 */
export function apply(ctx: Context): void {
  const team = ctx.get("voidTeam") as VoidTeam;
  ctx.tools.register(defineTool({
    name: "launch_legion",
    description:
      "Dispatch a Void legion (team): every lane becomes a real dsh subagent in dependency order. Returns a runId immediately; the run continues in the background. Use legion_run to read progress and output references, legion_output to page large outputs, legion_cancel to stop it.",
    parameters: {
      teamId: { type: "string", required: true, description: "The team id: one registered via ctx.voidTeam.defineTeam, or one saved on disk (the panel's teams)." },
      task: { type: "string", description: "The shared goal for this run (optional)." },
      plan: {
        type: "string",
        description:
          'Optional manual task plan as JSON: {"goal":"...","tasks":[{"laneId":"...","title":"...","brief":"...","dependsOn":["..."],"stage":1,"modelRef":"provider/model"}]}. The host parses and validates it; an invalid plan is rejected before anything is dispatched.',
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          runId: { type: "string", required: true },
          teamId: { type: "string", required: true },
          status: { type: "string", required: true },
          schedule: { type: "string", required: true },
          conclusion: { type: "string", required: true },
          tasks: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                laneId: { type: "string", required: true },
                agentId: { type: "string" },
                modelRef: { type: "string" },
                status: { type: "string", required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const { teamId, task = "", plan } = args as { teamId: string; task?: string; plan?: string };
      const parent = exec.agent;
      if (parent === undefined) {
        throw new Error("launch_legion requires an agent context (no parent agent)");
      }
      // 身份来自会话绑定，不来自模型说的话：模型自称是主人、在参数里写 agentId 都不算凭证。
      // 解析不出就拒绝派活——绝不退回默认身份。
      const authority = ctx.get("voidAuthority") as AuthoritySource | undefined;
      if (typeof authority?.forSession !== "function") throw new Error("派活缺少权威档案");
      const snapshot = await authority.forSession(parent.id);
      if (snapshot === undefined) throw new Error(`派活缺少权威档案：会话 ${parent.id} 没有绑定灵魂档案`);
      const actor = snapshot.profiles.get(snapshot.actorId);
      if (actor === undefined) throw new Error(`派活者没有权威档案: ${snapshot.actorId}`);
      const observed = await resolveDispatchTeam(team, teamId);

      // 手动计划由 Host 解析与校验：模型只是提议者，计划合法不合法由这里说了算。
      const parsed = plan === undefined ? undefined : parseTaskPlan(plan, `launch_legion(${teamId})`);

      // 逐成员身份表：在 authorize 里（任何 lane 启动之前）填满，之后只读。
      let personas: ReadonlyMap<string, string> = new Map<string, string>();

      const worker = createScheduledWorker(ctx, parent, {
        // 逐子代理身份：取的是每个 lane 成员**自己的**档案，不是派活会话的身份。
        // 表在下面的 authorize 里、任何 lane 启动之前填满；查不到就抛，不静默无名分。
        persona: (context) => personaOf(personas, context.laneId),
        bindChildSession: async (sessionId, agentId) => {
          if (authority.bindChildSession === undefined) throw new Error("子代理缺少会话绑定服务，拒绝首轮执行");
          await authority.bindChildSession(sessionId, agentId);
        },
      });
      const record = await team.dispatch(teamId, {
        task,
        initiatedBy: actor.id,
        worker,
        ...(parsed === undefined ? {} : { plan: parsed }),
        // 权限快照：在派出任何任务之前跑，逐目标检查，不通过就一个子代理都不启动。
        // 检查的是**冻结下来的那份名单**——正是接下来真正要派的那些人。
        authorize: async (roster) => {
          assertTeamDispatch({
            snapshot: { members: [...roster], managerAgentId: observed.managerAgentId },
            actor,
            profiles: snapshot.profiles,
            targetLaneIds: roster.map((member) => member.laneId),
          });
          // 权限过了再取身份：名单里每个成员都必须能取到自己的身份，取不出就整次拒绝
          // （此时一个子代理都还没启动）。
          personas = await loadMemberPersonas({ authority, members: roster });
        },
      });

      return {
        runId: record.runId,
        teamId: record.teamId,
        status: record.status,
        schedule: record.schedule,
        conclusion: `已派发 ${record.tasks.length} 个任务，调度 ${record.schedule}；用 legion_run 看进度`,
        tasks: record.tasks.map((item) => ({
          laneId: item.laneId,
          ...(item.agentId === undefined ? {} : { agentId: item.agentId }),
          ...(item.modelRef === undefined ? {} : { modelRef: item.modelRef }),
          status: item.status,
        })),
      };
    },
  }));
}

/**
 * 解析这次要派的队伍：**内存优先，其次磁盘**。
 *
 * 队伍有两个来源——插件用 `defineTeam` 注册在内存里，面板（P6c）建的只落在磁盘上。
 * 这里以前只查 `observe`（纯内存），于是「面板里看得见、派活说队伍不存在」：2026-09-23
 * 真机派活第一次就撞上了，一个子代理都没起。`dispatch` 自己走的是 `resolveTeam`
 * （内存→磁盘），所以缺陷只在工具这一层。
 *
 * 磁盘也找不到才算「队伍不存在」；没有数据根是配置问题（`loadTeam` 会抛「军团没有数据
 * 根…」），照实往上抛，不伪装成「队伍不存在」。
 */
async function resolveDispatchTeam(team: VoidTeam, teamId: string): Promise<DelegationTeamMetadata> {
  const inMemory = team.observe(teamId);
  if (inMemory !== undefined) return inMemory;
  const saved = await team.loadTeam(teamId);
  if (saved === undefined) throw new Error(`队伍不存在: ${teamId}`);
  return teamMetadataOf(saved);
}
