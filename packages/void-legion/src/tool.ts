import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { VoidTeam } from "./service.js";
import { createSubagentWorker } from "./subagent-worker.js";

export const name = "void-legion-tool";
export const inject = ["tools", "voidTeam"];

/**
 * Consumer: registers the model-facing `launch_legion` tool. It reads the
 * already-defined team (via `ctx.voidTeam.defineTeam`) and dispatches every
 * lane to a real dsh subagent in `dependsOn` order — the concrete closure of
 * the "real ctx.subagents worker" stage: model calls `launch_legion` → the
 * tool's `exec.agent` is the parent → `createSubagentWorker` spawns a child
 * per lane through `ctx.subagents.start`.
 */
export function apply(ctx: Context): void {
  const team = ctx.get("voidTeam") as VoidTeam;
  ctx.tools.register(defineTool({
    name: "launch_legion",
    description: "Launch a Void legion (team) by dispatching each lane to a real dsh subagent in dependency order.",
    parameters: {
      teamId: { type: "string", required: true, description: "The team id defined via ctx.voidTeam.defineTeam." },
      task: { type: "string", description: "The shared task delivered to every lane (optional)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          order: { type: "array", required: true, items: { type: "string" } },
          results: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                laneId: { type: "string", required: true },
                status: { type: "string", required: true, enum: ["pending", "in_progress", "completed", "failed"] },
                error: { type: "string" },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const { teamId, task = "" } = args as { teamId: string; task?: string };
      const parent = exec.agent;
      if (parent === undefined) {
        throw new Error("launch_legion requires an agent context (no parent agent)");
      }
      const worker = createSubagentWorker(ctx, parent, { signal: exec.signal });
      const result = await team.launch(teamId, { task, worker });
      return {
        order: result.order,
        results: result.results.map((r) => ({
          laneId: r.laneId,
          status: r.status,
          ...(r.error === undefined ? {} : { error: r.error }),
        })),
      };
    },
  }));
}
