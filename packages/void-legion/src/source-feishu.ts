/**
 * 把飞书入站来源接到真实宿主：WS 网关、派活父会话、dispatchExternal、回写。
 *
 * 只禁用自己：缺数据根/凭据/authority/agents 时本来源标 error，不影响内部派活
 * 与 GitHub 源。
 *
 * @module @void/void-legion/source-feishu
 */
import { randomUUID } from "node:crypto";
import { Service, type Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { AuthoritySource } from "@void/void-soul";
import {
  FeishuInbox,
  FeishuSourceRepository,
  createFeishuSourceDocument,
  feishuSourceSnapshotOf,
  parseFeishuSourceDocument,
  serializeFeishuSourceDocument,
  type FeishuInboundEvent,
  type FeishuSourceConfig,
  type FeishuSourceDocument,
  type FeishuSourceSnapshot,
} from "./feishu-source.js";
import { FeishuWsGateway } from "./feishu-ws-gateway.js";
import { deliveryComment } from "./github-source.js";
import { loadMemberPersonas, personaOf } from "./member-identity.js";
import { createScheduledWorker } from "./subagent-provider.js";
import type { VoidTeam } from "./service.js";

export const name = "void-legion-source-feishu";
export const inject = ["voidTeam"];

interface HostAgents {
  create(input: {
    sessionId: string;
    meta: Record<string, unknown>;
    agentOptions?: { provider?: string; model?: string };
    setup?: (ctx: unknown) => Promise<void>;
  }): Promise<{ agent: unknown }>;
}
interface HostPresets {
  resolve(id?: string): Promise<{ id: string }>;
  mount(ctx: unknown, id?: string): Promise<unknown>;
}
interface HostDefaultModel {
  currentSelection(): { provider?: string; model?: string } | undefined;
}

export class FeishuSourceService extends Service {
  private readonly team: VoidTeam;
  private readonly repository: FeishuSourceRepository | undefined;
  private inbox: FeishuInbox | undefined;
  private gateway: FeishuWsGateway | undefined;
  private parent: Agent | undefined;

  constructor(ctx: Context) {
    super(ctx, "voidFeishuSource");
    this.team = ctx.get("voidTeam") as VoidTeam;
    this.repository = this.team.dataRoot === undefined
      ? undefined
      : new FeishuSourceRepository(this.team.dataRoot);
    // 视图由 `void-legion-source-panel` 统一登记（GitHub + 飞书合成一页）。
  }

  async start(): Promise<void> {
    const inbox = await this.ensureInbox();
    if (inbox === undefined) return;
    await inbox.start();
  }

  async readSnapshot(): Promise<FeishuSourceSnapshot | undefined> {
    return this.repository?.trySnapshot();
  }

  /** 面板保存飞书配置；文件还不存在时创建（status=off，等用户显式启用）。 */
  async saveConfig(config: FeishuSourceConfig, expectedRevision: number): Promise<FeishuSourceSnapshot> {
    if (this.repository === undefined) throw new Error("飞书来源缺少数据根");
    const next = await this.repository.upsert((document) => {
      const now = new Date().toISOString();
      if (document === undefined) {
        if (expectedRevision !== 0) {
          throw new Error("飞书来源还没配置（期望修订 0，实际 0），请刷新后重试");
        }
        const created = createFeishuSourceDocument({ config });
        const candidate: FeishuSourceDocument = {
          ...created,
          revision: 1,
          updatedAt: now,
          runtime: { ...created.runtime, status: "off", mode: "observe" },
        };
        parseFeishuSourceDocument(serializeFeishuSourceDocument(candidate));
        return candidate;
      }
      if (document.revision !== expectedRevision) {
        throw new Error(`飞书来源已被其他保存更新（期望 ${expectedRevision}，实际 ${document.revision}）`);
      }
      const candidate: FeishuSourceDocument = {
        ...document,
        config,
        revision: document.revision + 1,
        updatedAt: now,
        updatedBy: "owner",
      };
      parseFeishuSourceDocument(serializeFeishuSourceDocument(candidate));
      return candidate;
    });
    return feishuSourceSnapshotOf(next);
  }

  async setMode(mode: "observe" | "live", expectedRevision: number): Promise<FeishuSourceSnapshot> {
    return (await this.requireInbox()).setMode(mode, expectedRevision);
  }

  async setEnabled(enabled: boolean, expectedRevision: number): Promise<FeishuSourceSnapshot> {
    return (await this.requireInbox()).setEnabled(enabled, expectedRevision);
  }

  async syncAllowed(chatId: string, expectedRevision: number): Promise<FeishuSourceSnapshot> {
    return (await this.requireInbox()).syncAllowed(chatId, expectedRevision);
  }

  async testAuth(): Promise<{ botOpenId: string }> {
    return (await this.ensureGateway()).checkAuth();
  }

  private async ensureGateway(): Promise<FeishuWsGateway> {
    if (this.gateway !== undefined) return this.gateway;
    if (this.repository === undefined) throw new Error("飞书来源缺少数据根");
    const document = await this.repository.load();
    if (document === undefined) throw new Error("飞书来源还没配置");
    this.gateway = new FeishuWsGateway({
      appId: process.env[document.config.appIdEnv] ?? "",
      appSecret: process.env[document.config.appSecretEnv] ?? "",
      ...(document.config.domain === undefined ? {} : { domain: document.config.domain }),
    });
    return this.gateway;
  }

  private async requireInbox(): Promise<FeishuInbox> {
    const inbox = await this.ensureInbox();
    if (inbox === undefined) throw new Error("飞书来源未配置或已停用");
    return inbox;
  }

  private async ensureInbox(): Promise<FeishuInbox | undefined> {
    if (this.inbox !== undefined) return this.inbox;
    if (this.repository === undefined) {
      this.ctx.logger?.warn?.("飞书来源缺少数据根，已禁用（不影响内部派活）");
      return undefined;
    }
    const document = await this.repository.load();
    if (document === undefined || document.runtime.status === "off") return undefined;
    const gateway = await this.ensureGateway();
    const inbox = new FeishuInbox({
      repository: this.repository,
      gateway,
      dispatch: (event) => this.dispatch(document, event),
      onDispatched: (event, runId) => this.deliver(event, runId, gateway),
    });
    this.inbox = inbox;
    this.ctx.effect(() => () => { void inbox.stop(); }, "void-legion-source-feishu.stop()");
    return inbox;
  }

  private async ensureParent(document: FeishuSourceDocument): Promise<Agent> {
    if (this.parent !== undefined) return this.parent;
    const agents = this.ctx.get("agents") as HostAgents | undefined;
    if (agents === undefined || typeof agents.create !== "function") {
      throw new Error("飞书来源缺少 agents 服务，拒绝启动派活父会话");
    }
    const presets = this.ctx.get("agentPresets") as HostPresets | undefined;
    const preset = presets === undefined ? undefined : await presets.resolve();
    const selection = (this.ctx.get("agentDefaultModel") as HostDefaultModel | undefined)?.currentSelection?.();
    const { agent } = await agents.create({
      sessionId: `source-feishu-${randomUUID()}`,
      meta: {
        cwd: document.config.workspace ?? process.cwd(),
        ...(preset === undefined ? {} : { agentPreset: preset.id }),
      },
      ...(selection === undefined || selection.provider === undefined || selection.model === undefined
        ? {}
        : { agentOptions: { provider: selection.provider, model: selection.model } }),
      ...(preset === undefined
        ? {}
        : { setup: async (agentCtx: unknown) => { await presets!.mount(agentCtx, preset.id); } }),
    });
    this.parent = agent as unknown as Agent;
    return this.parent;
  }

  private async dispatch(document: FeishuSourceDocument, event: FeishuInboundEvent): Promise<{ runId: string }> {
    const authority = this.ctx.get("voidAuthority") as AuthoritySource | undefined;
    if (authority === undefined) throw new Error("飞书来源缺少 voidAuthority，拒绝按无名分派任务");
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
      task: [
        `外部飞书触发：${event.chatId}`,
        `发起人：${event.senderId}`,
        "",
        event.text.trim() || "（正文为空）",
      ].join("\n"),
      source: {
        id: "feishu",
        channel: `feishu:${event.chatId}`,
        requester: event.senderId,
        eventId: event.eventId,
      },
      worker,
      authorize: async (roster) => {
        personas = await loadMemberPersonas({ authority, members: roster });
      },
    });
    return { runId: record.runId };
  }

  private deliver(event: FeishuInboundEvent, runId: string, gateway: FeishuWsGateway): void {
    void (async () => {
      const record = await this.team.waitForRun(runId);
      const completed = record.tasks.filter((task) => task.status === "completed").length;
      await gateway.sendMessage(event.chatId, deliveryComment({
        runId,
        status: record.status,
        conclusion: `已结算 ${completed}/${record.tasks.length}`,
        acceptance: record.acceptance,
      }));
    })().catch(async (error: unknown) => {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      if (this.repository !== undefined) {
        await this.repository.mutate((document) => ({
          ...document,
          runtime: { ...document.runtime, lastDeliveryError: message },
        })).catch(() => undefined);
      }
    });
  }
}

export function apply(ctx: Context): void {
  ctx.inject(["voidTeam"], (teamCtx) => {
    const service = new FeishuSourceService(teamCtx);
    void service.start().catch((error: unknown) => {
      teamCtx.logger?.warn?.(`飞书来源启动失败（只禁用本来源）: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
}

export default apply;
