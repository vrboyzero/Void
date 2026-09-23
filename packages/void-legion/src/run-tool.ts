import type { Context } from "@deepseek-ai/cordis";
import { defineTool, type JsonValue } from "@deepseek-ai/dsh-tools";
import type { AuthoritySource } from "@void/void-soul";
import { assertTeamDispatch } from "./authority.js";
import type { RunRecord } from "./run-store.js";
import type { VoidTeam } from "./service.js";

export const name = "void-legion-run-tool";
export const inject = ["tools", "voidTeam"];

/**
 * Consumer: 运行侧的三个问题——**跑到哪了、结果是什么、怎么停**（§15.2）。
 *
 * 单独一个模块的理由：`launch_legion` 只负责派活，进度/结果/取消是读运行记录，
 * 两件事的生命周期不一样（派活一次，之后可能读很多次）。
 */

/** 小产出原样展示；大产出展示引用，由 legion_output 分片读取。 */
function renderRun(record: RunRecord) {
  return {
    runId: record.runId,
    teamId: record.teamId,
    status: record.status,
    schedule: record.schedule,
    task: record.task,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
    memberLimit: record.memberLimit,
    maxConcurrentTasks: record.maxConcurrentTasks,
    tasks: record.tasks.map((task) => ({
      laneId: task.laneId,
      ...(task.agentId === undefined ? {} : { agentId: task.agentId }),
      ...(task.modelRef === undefined ? {} : { modelRef: task.modelRef }),
      status: task.status,
      dependsOn: [...task.dependsOn],
      attempts: task.attempts,
      ...(task.blockedBy === undefined ? {} : { blockedBy: task.blockedBy }),
      // 原生子会话链接：有它才能跳回宿主里那个真实子会话。
      ...(task.childSessionId === undefined ? {} : { childSessionId: task.childSessionId }),
      ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
      ...(task.endedAt === undefined ? {} : { endedAt: task.endedAt }),
      ...(task.output === undefined ? {} : { output: asJson(task.output) }),
      ...(task.outputRef === undefined ? {} : { outputRef: task.outputRef }),
      ...(task.error === undefined ? {} : { error: task.error }),
    })),
    events: record.events.map((event) => ({
      at: event.at,
      kind: event.kind,
      ...(event.laneId === undefined ? {} : { laneId: event.laneId }),
      ...(event.detail === undefined ? {} : { detail: event.detail }),
    })),
  };
}

/**
 * 产出值一定是无损 JSON：`normalizeRunOutput` 已经把它 JSON 往返过一遍，
 * 不能序列化的会被换成 `{unserializable:true, preview}`。所以这个收窄是成立的。
 */
function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

const RUN_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    runId: { type: "string", required: true },
    teamId: { type: "string", required: true },
    status: { type: "string", required: true },
    schedule: { type: "string", required: true },
    task: { type: "string", required: true },
    createdAt: { type: "string", required: true },
    updatedAt: { type: "string", required: true },
    endedAt: { type: "string" },
    memberLimit: { type: "integer", required: true },
    maxConcurrentTasks: { type: "integer", required: true },
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
          dependsOn: { type: "array", required: true, items: { type: "string" } },
          attempts: { type: "integer", required: true },
          blockedBy: { type: "string" },
          childSessionId: { type: "string" },
          startedAt: { type: "string" },
          endedAt: { type: "string" },
          output: { type: "json" },
          outputRef: {
            type: "object",
            additionalProperties: false,
            properties: { bytes: { type: "integer", required: true } },
          },
          error: { type: "string" },
        },
      },
    },
    events: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          at: { type: "string", required: true },
          kind: { type: "string", required: true },
          laneId: { type: "string" },
          detail: { type: "string" },
        },
      },
    },
  },
} as const;

export function apply(ctx: Context): void {
  const team = ctx.get("voidTeam") as VoidTeam;

  const authorize = async (record: RunRecord, sessionId: string | undefined): Promise<void> => {
    if (sessionId === undefined || record.initiatedBy === undefined) {
      throw new Error("运行记录无权访问：缺少执行会话或发起者绑定");
    }
    const authority = ctx.get("voidAuthority") as AuthoritySource | undefined;
    const snapshot = await authority?.forSession(sessionId);
    if (snapshot === undefined || snapshot.actorId !== record.initiatedBy) {
      throw new Error("运行记录无权访问：会话没有绑定发起者档案");
    }
    const actor = snapshot.profiles.get(snapshot.actorId);
    if (actor === undefined) throw new Error("运行记录无权访问：发起者档案不存在");
    assertTeamDispatch({
      snapshot: { members: record.frozenRoster, managerAgentId: record.managerAgentId },
      actor,
      profiles: snapshot.profiles,
      targetLaneIds: record.tasks.map((task) => task.laneId),
    });
  };

  ctx.tools.register(defineTool({
    name: "legion_run",
    description:
      "Read an authorized legion run by runId. Small lane outputs are inline; large outputs carry outputRef and can be read with legion_output. Set wait=true to wait for settlement; default returns the current snapshot.",
    parameters: {
      runId: { type: "string", required: true, description: "The runId returned by launch_legion." },
      wait: {
        type: "boolean",
        description: "Wait until the run settles before returning. Default false (snapshot now).",
      },
    },
    output: {
      schema: RUN_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const { runId, wait = false } = args as { runId: string; wait?: boolean };
      const current = await team.runRecord(runId);
      await authorize(current, exec.agent?.id);
      // 不在本进程里跑的（宿主重启过）也给磁盘上那份，如实报它是什么状态，
      // 不假装等到了结果、也不假装它还在跑。
      const record = wait ? await team.waitForRun(runId) : await team.runRecord(runId);
      if (wait) await authorize(record, exec.agent?.id);
      return renderRun(record);
    },
  }));

  ctx.tools.register(defineTool({
    name: "legion_cancel",
    description:
      "Cancel one lane or the whole legion run. Lanes that have not started are never dispatched; running lanes are aborted. Cancelling does not rework or retry anything.",
    parameters: {
      runId: { type: "string", required: true, description: "The runId returned by launch_legion." },
      laneId: { type: "string", description: "Cancel only this lane. Omit to cancel the whole run." },
      reason: { type: "string", description: "Why it was cancelled (recorded in the run events)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          runId: { type: "string", required: true },
          status: { type: "string", required: true },
          scope: { type: "string", required: true, enum: ["lane", "run"] },
          cancelled: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                laneId: { type: "string", required: true },
                status: { type: "string", required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const { runId, laneId, reason } = args as { runId: string; laneId?: string; reason?: string };
      await authorize(await team.runRecord(runId), exec.agent?.id);
      const record =
        laneId === undefined
          ? await team.cancelRun(runId, reason)
          : await team.cancelLane(runId, laneId, reason);
      const cancelled = record.tasks.filter(
        (task) => task.status === "cancelled" || (laneId !== undefined && task.laneId === laneId),
      );
      return {
        runId: record.runId,
        status: record.status,
        scope: laneId === undefined ? ("run" as const) : ("lane" as const),
        cancelled: cancelled.map((task) => ({ laneId: task.laneId, status: task.status })),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "legion_output",
    description: "Read a bounded byte page of a large saved lane output. Concatenate base64-decoded pages by nextOffset to recover the original UTF-8 JSON. Requires the same live authority as legion_run.",
    parameters: {
      runId: { type: "string", required: true },
      laneId: { type: "string", required: true },
      offset: { type: "integer", required: true },
      length: { type: "integer", description: "Bytes to read (1–16384, default 16384)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          base64: { type: "string", required: true },
          offset: { type: "integer", required: true },
          nextOffset: { type: "integer", required: true },
          bytes: { type: "integer", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const { runId, laneId, offset, length } = args as { runId: string; laneId: string; offset: number; length?: number };
      await authorize(await team.runRecord(runId), exec.agent?.id);
      return team.readRunOutputPage(runId, laneId, offset, length);
    },
  }));
}
