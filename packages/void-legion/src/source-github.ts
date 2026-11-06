/**
 * 把 GitHub 来源接到真实宿主：lazy gh gateway、父会话、`dispatchExternal` 与评论回写。
 *
 * 只在装了军团与灵魂的编辑里工作；缺 `voidTeam.dataRoot` / `voidAuthority` / `agents`
 * 时本来源自禁用（**只禁用自己**），不影响内部派活与其它来源。
 *
 * @module @void/void-legion/source-github
 */
import { randomUUID } from "node:crypto";
import { Service, type Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { AuthoritySource } from "@void/void-soul";
import { ExternalSourceRepository, type ExternalSourceDocument } from "./external-source.js";
import { GhCliGateway } from "./gh-cli-gateway.js";
import { deliveryComment, type GitHubGateway, type GitHubTicket } from "./github-source.js";
import { GitHubSourceRunner } from "./github-source-runner.js";
import { loadMemberPersonas, personaOf } from "./member-identity.js";
import { createScheduledWorker } from "./subagent-provider.js";
import type { VoidTeam } from "./service.js";

export const name = "void-legion-source-github";
export const inject = ["voidTeam"];

/** 宿主 `agents` / `agentPresets` / `agentDefaultModel` 的形状（0.2.1+）。 */
interface SourceAgent {
  readonly id: string;
  readonly session: unknown;
}
interface HostAgents {
  create(input: {
    sessionId: string;
    meta: Record<string, unknown>;
    agentOptions?: { provider?: string; model?: string };
    setup?: (ctx: unknown) => Promise<void>;
  }): Promise<{ agent: SourceAgent }>;
}
interface HostPresets {
  resolve(id?: string): Promise<{ id: string }>;
  mount(ctx: unknown, id?: string): Promise<unknown>;
}
interface HostDefaultModel {
  currentSelection(): { provider?: string; model?: string } | undefined;
}

export class GitHubSourceService extends Service {
  private readonly team: VoidTeam;
  private readonly repository: ExternalSourceRepository | undefined;
  private readonly lazyGateway: GitHubGateway;
  private runner: GitHubSourceRunner | undefined;
  private gatewayCache: { key: string; gateway: GhCliGateway } | undefined;
  private parent: Agent | undefined;

  constructor(ctx: Context) {
    super(ctx, "voidGitHubSource");
    this.team = ctx.get("voidTeam") as VoidTeam;
    const dataRoot = this.team.dataRoot;
    this.repository = dataRoot === undefined ? undefined : new ExternalSourceRepository({ dataDir: dataRoot });
    // 网关配置（ghConfigDir/tokenEnv）在来源文件里，可能被面板改；每次调用时按当前配置取。
    this.lazyGateway = {
      checkAuth: async (repo, signal) => (await this.gateway()).checkAuth(repo, signal),
      listNotifications: async (signal) => (await this.gateway()).listNotifications(signal),
      getContext: async (notification, options) => (await this.gateway()).getContext(notification, options),
      comment: async (channel, body, signal) => (await this.gateway()).comment(channel, body, signal),
    };
  }

  get dataRoot(): string | undefined {
    return this.team.dataRoot;
  }

  private async gateway(): Promise<GhCliGateway> {
    if (this.repository === undefined) throw new Error("GitHub 来源缺少数据根");
    const document = await this.repository.load();
    const key = `${document?.config.ghConfigDir ?? ""}\u0000${document?.config.tokenEnv ?? ""}`;
    if (this.gatewayCache?.key !== key) {
      this.gatewayCache = {
        key,
        gateway: new GhCliGateway({
          ...(document?.config.ghConfigDir === undefined ? {} : { ghConfigDir: document.config.ghConfigDir }),
          ...(document?.config.tokenEnv === undefined ? {} : { tokenEnv: document.config.tokenEnv }),
        }),
      };
    }
    return this.gatewayCache.gateway;
  }

  async start(): Promise<void> {
    if (this.repository === undefined) {
      this.ctx.logger?.warn?.("GitHub 来源缺少数据根，已禁用（不影响内部派活）");
      return;
    }
    const runner = new GitHubSourceRunner({
      repository: this.repository,
      gateway: this.lazyGateway,
      dispatch: (ticket) => this.dispatch(ticket),
      onDispatched: (ticket, runId) => this.deliver(ticket, runId),
      logger: {
        info: (message) => this.ctx.logger?.info?.(message),
        warn: (message) => this.ctx.logger?.warn?.(message),
      },
    });
    this.runner = runner;
    this.ctx.effect(() => () => runner.stop(), "void-legion-source-github.stop()");
    await runner.start();
  }

  /** 面板「立即轮询」/测试用。 */
  async pollNow(): Promise<unknown> {
    if (this.runner === undefined) {
      await this.start();
    }
    return this.runner?.pollNow();
  }

  async snapshot(): Promise<unknown> {
    return this.repository?.trySnapshot();
  }

  private async ensureParent(document: ExternalSourceDocument): Promise<Agent> {
    if (this.parent !== undefined) return this.parent;
    const agents = this.ctx.get("agents") as HostAgents | undefined;
    if (agents === undefined || typeof agents.create !== "function") {
      throw new Error("外部来源缺少 agents 服务，拒绝启动派活父会话");
    }
    const presets = this.ctx.get("agentPresets") as HostPresets | undefined;
    const preset = presets === undefined ? undefined : await presets.resolve();
    const selection = (this.ctx.get("agentDefaultModel") as HostDefaultModel | undefined)?.currentSelection?.();
    const { agent } = await agents.create({
      sessionId: `source-github-${randomUUID()}`,
      meta: {
        cwd: document.config.workspace ?? process.cwd(),
        ...(preset === undefined ? {} : { agentPreset: preset.id }),
      },
      ...(selection === undefined || selection.provider === undefined || selection.model === undefined
        ? {}
        : { agentOptions: { provider: selection.provider, model: selection.model } }),
      ...(preset === undefined
        ? {}
        : {
            setup: async (agentCtx: unknown) => {
              await presets!.mount(agentCtx, preset.id);
            },
          }),
    });
    this.parent = agent as unknown as Agent;
    return this.parent;
  }

  private async dispatch(ticket: GitHubTicket): Promise<{ runId: string }> {
    if (this.repository === undefined) throw new Error("GitHub 来源缺少数据根");
    const document = await this.repository.load();
    if (document === undefined) throw new Error("GitHub 来源还没配置");
    const authority = this.ctx.get("voidAuthority") as AuthoritySource | undefined;
    if (authority === undefined) throw new Error("外部来源缺少 voidAuthority，拒绝按无名分派任务");
    const parent = await this.ensureParent(document);
    let personas: ReadonlyMap<string, string> = new Map();
    const worker = createScheduledWorker(this.ctx, parent, {
      persona: (context) => personaOf(personas, context.laneId),
      bindChildSession: async (sessionId, agentId) => {
        if (authority.bindChildSession === undefined) throw new Error("子代理缺少会话绑定服务");
        await authority.bindChildSession(sessionId, agentId);
      },
    });
    const record = await this.team.dispatchExternal({
      teamId: document.config.teamId,
      task: this.taskOf(ticket),
      source: {
        id: "github",
        channel: ticket.channel,
        requester: ticket.requester,
        eventId: ticket.eventId,
        url: ticket.url,
      },
      worker,
      authorize: async (roster) => {
        personas = await loadMemberPersonas({ authority, members: roster });
      },
    });
    return { runId: record.runId };
  }

  private taskOf(ticket: GitHubTicket): string {
    const lines = [
      `外部 GitHub 触发：${ticket.channel}`,
      `发起人：${ticket.requester}`,
      `标题：${ticket.title}`,
      "",
      ticket.body.trim() || "（正文为空）",
    ];
    if (ticket.comments.length > 0) {
      lines.push("", `最近评论（${ticket.comments.length} 条）：`);
      for (const comment of ticket.comments.slice(-3)) {
        lines.push(`- ${comment.author}：${comment.body.slice(0, 500)}`);
      }
    }
    return lines.join("\n");
  }

  private deliver(ticket: GitHubTicket, runId: string): void {
    void (async () => {
      const record = await this.team.waitForRun(runId);
      const total = record.tasks.length;
      const completed = record.tasks.filter((task) => task.status === "completed").length;
      const text = deliveryComment({
        runId,
        status: record.status,
        conclusion: `已结算 ${completed}/${total}`,
        acceptance: record.acceptance,
      });
      await this.lazyGateway.comment(ticket.channel, text);
    })().catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (this.repository !== undefined) {
        await this.repository.mutate((document) => ({
          ...document,
          runtime: { ...document.runtime, lastDeliveryError: message.slice(0, 500) },
        })).catch(() => undefined);
      }
    });
  }
}

export function apply(ctx: Context): void {
  const service = new GitHubSourceService(ctx);
  void service.start().catch((error: unknown) => {
    ctx.logger?.warn?.(`GitHub 来源启动失败（只禁用本来源）: ${error instanceof Error ? error.message : String(error)}`);
  });
}

export default apply;
