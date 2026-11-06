import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { AuthoritySource } from "@void/void-soul";
import { assertTeamDispatch } from "./authority.js";
import { teamMetadataOf } from "./contracts.js";
import { taskPreviewOf } from "./dispatch-source.js";
import { loadMemberPersonas, personaOf } from "./member-identity.js";
import { parseTaskPlan } from "./planner.js";
import { resolveDispatchRoster } from "./run-coordinator.js";
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
 *
 * **观察模式（B3）**：来源切到 `observe` 时，同一个请求走完解析与授权判断后
 * **只写一条账、不建 run、不启子代理**；返回 `observed: true`、没有 `runId`。
 * 切回 live 是主人的显式动作，不做「观察够了自动放开」。
 */
export function apply(ctx: Context): void {
  const team = ctx.get("voidTeam") as VoidTeam;
  ctx.tools.register(defineTool({
    name: "launch_legion",
    description:
      "Dispatch a Void legion (team): every lane becomes a real dsh subagent in dependency order. In live mode it returns a runId immediately and the run continues in the background; in observe mode it only records what would be dispatched (observed: true, no runId, no subagents). Use legion_run to read progress and output references, legion_output to page large outputs, legion_cancel to stop it.",
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
          // 观察模式没有 run；live 模式一定有。
          runId: { type: "string" },
          observed: { type: "boolean", required: true },
          teamId: { type: "string", required: true },
          status: { type: "string", required: true },
          schedule: { type: "string", required: true },
          conclusion: { type: "string", required: true },
          /** 账本没写成时的警告；派活本身已经成立，不因此假装失败。 */
          ledgerWarning: { type: "string" },
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
      // 失败时也要记账：写清「哪支队伍、谁、为什么没派出去」。账本自己写不进去时
      // 不能盖掉原始拒绝（见 `recordFiltered`）。
      const context: { teamId: string; task: string; actorId?: string; lanes?: string[] } = { teamId, task };
      try {
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
        context.actorId = actor.id;
        // 第三道门：派活名单。未配置或为空都拒绝（§22.3 fail-closed）；这里只判名单，
        // 身份许可 ∩ 队伍许可仍由下面的 `assertTeamDispatch` 照旧判，名单不放宽任何一条。
        await team.assertActorMayDispatch(actor.id);
        const observed = await resolveDispatchTeam(team, teamId);

        // 手动计划由 Host 解析与校验：模型只是提议者，计划合法不合法由这里说了算。
        const parsed = plan === undefined ? undefined : parseTaskPlan(plan, `launch_legion(${teamId})`);

        // 名单解析与授权检查在**任何执行体之前**做一遍：observe 路径不经过
        // `team.dispatch` 的 authorize，必须自己走同一套判断，账本才不是另编一份。
        const roster = resolveDispatchRoster({
          team: observed,
          ...(parsed === undefined ? {} : { plan: parsed }),
        });
        context.lanes = roster.map((member) => member.laneId);
        assertTeamDispatch({
          snapshot: { members: roster, managerAgentId: observed.managerAgentId },
          actor,
          profiles: snapshot.profiles,
          targetLaneIds: roster.map((member) => member.laneId),
        });

        // 来源状态：off/error/setup/starting 直接拒（top catch 会记一条 filtered）；
        // paused = observe，往下走观察分支。
        const source = await team.requireDispatchSourceReady();
        const ledgerBase = {
          teamId,
          actorId: actor.id,
          ...(taskPreviewOf(task) === undefined ? {} : { taskPreview: taskPreviewOf(task) }),
          lanes: roster.map((member) => member.laneId),
        };

        if (source.mode === "observe") {
          const schedule = observed.schedule ?? "parallel";
          try {
            await team.recordDispatchSource({
              ...ledgerBase,
              outcome: "observed",
              detail: `observe：本来会派 ${roster.length} 个任务（调度 ${schedule}），没有建 run、没有启动子代理`,
            });
          } catch (error) {
            throw new Error(
              `观察记录没写成，不能假装观察过：${error instanceof Error ? error.message : String(error)}`,
            );
          }
          return {
            observed: true,
            teamId,
            status: "observed",
            schedule,
            conclusion: `观察中：本来会派 ${roster.length} 个任务，没有建 run、没有启动子代理`,
            tasks: roster.map((member) => ({
              laneId: member.laneId,
              ...(member.agentId === undefined ? {} : { agentId: member.agentId }),
              ...(member.modelRef === undefined ? {} : { modelRef: member.modelRef }),
              status: "pending",
            })),
          };
        }

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
          authorize: async (finalRoster) => {
            assertTeamDispatch({
              snapshot: { members: [...finalRoster], managerAgentId: observed.managerAgentId },
              actor,
              profiles: snapshot.profiles,
              targetLaneIds: finalRoster.map((member) => member.laneId),
            });
            // 权限过了再取身份：名单里每个成员都必须能取到自己的身份，取不出就整次拒绝
            // （此时一个子代理都还没启动）。
            personas = await loadMemberPersonas({ authority, members: finalRoster });
          },
        });

        let ledgerWarning: string | undefined;
        try {
          await team.recordDispatchSource({
            ...ledgerBase,
            outcome: "dispatched",
            runId: record.runId,
            detail: `已派发 run ${record.runId}`,
          });
        } catch (error) {
          // 派活已经成立，账本没记上不能反过来判失败；但必须把这件事带回去。
          ledgerWarning = `派活成功，但来源账本没写成：${error instanceof Error ? error.message : String(error)}`;
        }

        return {
          runId: record.runId,
          observed: false,
          teamId: record.teamId,
          status: record.status,
          schedule: record.schedule,
          conclusion: `已派发 ${record.tasks.length} 个任务，调度 ${record.schedule}；用 legion_run 看进度`,
          ...(ledgerWarning === undefined ? {} : { ledgerWarning }),
          tasks: record.tasks.map((item) => ({
            laneId: item.laneId,
            ...(item.agentId === undefined ? {} : { agentId: item.agentId }),
            ...(item.modelRef === undefined ? {} : { modelRef: item.modelRef }),
            status: item.status,
          })),
        };
      } catch (error) {
        await recordFiltered(team, {
          ...context,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  }));
}

/** 拒绝也要留痕；账本自己坏掉时只吞账本错误，不吞原始拒绝。 */
async function recordFiltered(
  team: VoidTeam,
  input: { teamId: string; task: string; actorId?: string; lanes?: string[]; error: string },
): Promise<void> {
  try {
    const preview = taskPreviewOf(input.task);
    await team.recordDispatchSource({
      outcome: "filtered",
      teamId: input.teamId,
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      ...(preview === undefined ? {} : { taskPreview: preview }),
      ...(input.lanes === undefined ? {} : { lanes: input.lanes }),
      reason: input.error.slice(0, 300),
    });
  } catch {
    // 账本不可写不能盖掉原始拒绝；原始错误由调用方照常抛出。
  }
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
