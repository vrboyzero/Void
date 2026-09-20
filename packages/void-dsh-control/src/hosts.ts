/**
 * DSH host adapter for the Lingbang control plane.
 *
 * This module is the only place that touches `ctx.workspaceController`,
 * `ctx.sessionController` and `ctx.agent`. Everything above it works against
 * {@link HostPorts}, which keeps the admission chain testable without booting a
 * model provider and keeps host-version drift confined to one file.
 *
 * @module @void/void-dsh-control/hosts
 */
import type { Context } from "@deepseek-ai/cordis";
import { ApiSessionNotFound } from "@deepseek-ai/dsh-api-session-controller";
// Type-only side-effect imports: they load the `declare module` augmentations
// that put `sessionController` / `workspaceController` on `Context`.
import type {} from "@deepseek-ai/dsh-api-workspace-controller";
import type {} from "@deepseek-ai/dsh-commands";
import { SessionId } from "@deepseek-ai/dsh-session";
import { WorkspaceId } from "@deepseek-ai/dsh-workspace";
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import { brandString } from "@deepseek-ai/dsh-brand";
import type { SessionRequestId } from "@deepseek-ai/dsh-api-session-controller/types";
import { ControlError } from "./protocol.js";
import type { HostPorts, HostSession, HostWorkspace } from "./orchestrator.js";

/** Plugin name recorded as the producer of injected context. */
export const PLUGIN_NAME = "void-dsh-control";

/** A signal that never aborts; used for bounded, single-shot host reads. */
function neverAbort(): AbortSignal {
  return new AbortController().signal;
}

/**
 * Read the complete Workspace baseline.
 *
 * `workspaceController.follow()` is a stream, but the first frame is a complete
 * baseline. Reading exactly that frame and then closing the stream gives a
 * stateless snapshot without caching registry state in the plugin.
 *
 * @param ctx - Host context carrying the Workspace controller.
 * @returns Every registered Workspace row.
 */
async function readWorkspaceBaseline(ctx: Context): Promise<readonly HostWorkspace[]> {
  const controller = new AbortController();
  try {
    for await (const frame of ctx.workspaceController.follow(controller.signal)) {
      if (frame.type !== "baseline") continue;
      return frame.value.items.map((item) => ({
        workspaceId: String(item.workspaceId),
        path: item.path,
        title: item.title,
        sessionIds: item.sessionIds.map((id) => String(id)),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }));
    }
    return [];
  } finally {
    controller.abort();
  }
}

/**
 * Translate a host failure into a stable control error.
 *
 * Host error messages are not forwarded: they can embed filesystem paths and
 * internal identifiers that the caller has no business seeing.
 *
 * @param error - Failure raised by a host service.
 * @param context - What the plugin was doing, for the stable message.
 * @returns The control error to throw.
 */
function toControlError(error: unknown, context: string): ControlError {
  if (error instanceof ControlError) return error;
  if (error instanceof ApiSessionNotFound) {
    return new ControlError("dsh-control/session-not-found", "session does not exist and is not resumable");
  }
  const name = error instanceof Error ? error.name : "unknown";
  return new ControlError("dsh-control/host-unavailable", `host rejected the ${context} request`, { host: name });
}

/**
 * Build {@link HostPorts} over the running Web profile.
 *
 * @param ctx - Host context with the Workspace and Session controllers injected.
 * @returns The host port implementation.
 */
export function createHostPorts(ctx: Context): HostPorts {
  return {
    async openWorkspace(path: string): Promise<HostWorkspace> {
      try {
        // `create` registers an existing directory or returns the registration
        // that already covers it; it never creates a directory on disk.
        const value = await ctx.workspaceController.create({ path });
        const workspace = value.workspace;
        return {
          workspaceId: String(workspace.workspaceId),
          path: workspace.path,
          title: workspace.title,
          sessionIds: workspace.sessionIds.map((id) => String(id)),
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
        };
      } catch (error) {
        throw toControlError(error, "openWorkspace");
      }
    },

    async listWorkspaces(): Promise<readonly HostWorkspace[]> {
      try {
        return await readWorkspaceBaseline(ctx);
      } catch (error) {
        throw toControlError(error, "listWorkspaces");
      }
    },

    async getWorkspace(workspaceId: string): Promise<HostWorkspace | undefined> {
      const items = await readWorkspaceBaseline(ctx);
      return items.find((item) => item.workspaceId === workspaceId);
    },

    async listSessions(): Promise<readonly HostSession[]> {
      try {
        const value = await ctx.sessionController.list({}, neverAbort());
        return value.items.map((item) => ({
          sessionId: String(item.sessionId),
          running: item.running,
          blank: item.blank,
          updatedAt: item.updatedAt,
          ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
          ...(item.parentSessionId === undefined ? {} : { parentSessionId: String(item.parentSessionId) }),
        }));
      } catch (error) {
        throw toControlError(error, "listSessions");
      }
    },

    async createSession(request): Promise<{ sessionId: string }> {
      try {
        // The rc.2 host contract accepts exactly one location selector. A
        // Workspace already carries its cwd, so prefer the stable identity when
        // both are supplied by the orchestration layer.
        const location =
          request.workspaceId === undefined
            ? request.cwd === undefined
              ? {}
              : { cwd: request.cwd }
            : { workspaceId: WorkspaceId(request.workspaceId) };
        const value = await ctx.sessionController.create({
          ...location,
          ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
        });
        return { sessionId: String(value.sessionId) };
      } catch (error) {
        throw toControlError(error, "createSession");
      }
    },

    async forkSession(request): Promise<{ sessionId: string }> {
      try {
        const value = await ctx.sessionController.fork({
          sessionId: SessionId(request.sessionId),
          ...(request.atSeq === undefined ? {} : { atSeq: request.atSeq }),
        });
        return { sessionId: String(value.sessionId) };
      } catch (error) {
        throw toControlError(error, "forkSession");
      }
    },

    async inspectSession(sessionId: string): Promise<{ exists: boolean; cwd?: string }> {
      try {
        const inspection = await ctx.sessionController.inspect(SessionId(sessionId), neverAbort());
        const cwd = inspection.meta.cwd;
        return { exists: true, ...(cwd === undefined ? {} : { cwd }) };
      } catch (error) {
        if (error instanceof ApiSessionNotFound) return { exists: false };
        throw toControlError(error, "inspectSession");
      }
    },

    async promptSession(request): Promise<void> {
      try {
        await ctx.sessionController.prompt(
          {
            requestId: brandString<SessionRequestId>(request.requestId),
            sessionId: SessionId(request.sessionId),
            mode: request.mode,
            content: [{ type: "text", text: request.text }],
          },
          neverAbort(),
        );
      } catch (error) {
        throw toControlError(error, "promptSession");
      }
    },

    async planSession(request): Promise<void> {
      try {
        // 空消息不会唤醒 Agent，而 off 是原生命令的退出分支。
        if (request.task.trim() === "" || request.task.trim() === "off") {
          throw new ControlError("dsh-control/invalid-request", "planning requires a non-empty task other than off");
        }
        const commands = ctx.get("commands");
        if (commands === undefined) {
          throw new ControlError("dsh-control/capability-unavailable", "native plan commands are unavailable");
        }
        const resolved = await ctx.sessionController.resolveAgent(SessionId(request.sessionId));
        if ("error" in resolved) {
          throw new ControlError("dsh-control/session-not-found", "session agent could not be resolved");
        }
        // 走 Web 同一命令通道，由 preset 自己应用计划模式和 turn boundary。
        const execution = await commands.execute(resolved.agent, `/plan ${request.task}`, [], neverAbort());
        if (execution === undefined) {
          throw new ControlError("dsh-control/capability-unavailable", "the session preset does not provide the /plan command");
        }
        if (execution.result.kind !== "success") {
          throw new ControlError("dsh-control/host-unavailable", "host rejected the native plan command");
        }
      } catch (error) {
        throw toControlError(error, "planSession");
      }
    },

    async injectContext(request): Promise<void> {
      try {
        // Injection must not wake an idle agent, so it goes through the Agent
        // runtime directly rather than through the prompt entry point.
        const resolved = await ctx.sessionController.resolveAgent(SessionId(request.sessionId));
        if ("error" in resolved) {
          throw new ControlError("dsh-control/session-not-found", "session agent could not be resolved", {
            sessionId: request.sessionId,
          });
        }
        resolved.agent.inject(
          createUserMessage({
            content: [{ type: "text", text: request.text }],
            source: {
              kind: "plugin",
              plugin: PLUGIN_NAME,
              form: "notice",
              summary: boundContextSummary("外部控制面注入的上下文（未唤醒 Agent）"),
            },
          }),
        );
      } catch (error) {
        throw toControlError(error, "injectContext");
      }
    },

    async cancelSession(sessionId: string): Promise<void> {
      try {
        ctx.sessionController.cancel({ sessionId: SessionId(sessionId) });
      } catch (error) {
        throw toControlError(error, "cancelSession");
      }
    },
  };
}
