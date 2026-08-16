import { Client } from "@larksuiteoapi/node-sdk";
import type { Context } from "@deepseek-ai/cordis";
import type { VoidChannel, VoidChannelConfig, ChannelLifecycleState } from "./channel.js";

/**
 * 真实飞书渠道（发消息侧）：用飞书官方 SDK 主动发送消息到指定 chat。
 *
 * - 凭据（appId/appSecret）从 `VOID_FEISHU_APP_ID` / `VOID_FEISHU_APP_SECRET`
 *   环境变量读取，或经 config 显式传入；绝不硬编码、绝不回显、绝不落库。
 * - 缺凭据 fail-closed（apply 直接抛错），不静默降级为 mock。
 * - 收消息侧（webhook 事件订阅 + 回调路由）是完整闭环的另一半，需要飞书
 *   开放平台回调地址 + Void webhook 路由，留待后续；本类只实现「发消息」。
 */
export interface RealFeishuChannelOptions extends VoidChannelConfig {
  appId: string;
  appSecret: string;
  /** 可选 SDK domain，默认官方 open.feishu.cn。 */
  domain?: string;
}

export class RealFeishuChannel implements VoidChannel {
  readonly name = "feishu";
  isRunning = false;
  lifecycleState: ChannelLifecycleState = "stopped";
  private readonly client: Client;
  private readonly options: RealFeishuChannelOptions;

  constructor(options: RealFeishuChannelOptions) {
    this.options = options;
    // SDK 内部自动管理 tenant_access_token；首次 create 时凭据无效会抛错。
    this.client = new Client({
      appId: options.appId,
      appSecret: options.appSecret,
      ...(options.domain === undefined ? {} : { domain: options.domain }),
    });
  }

  async start(): Promise<void> {
    this.isRunning = true;
    this.lifecycleState = "running";
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.lifecycleState = "stopped";
  }

  /** 主动发送文本消息到指定 chat_id；失败返回 false（不回显凭据，只记错误信息）。 */
  async send(chatId: string, content: string): Promise<boolean> {
    try {
      await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text: content }),
          msg_type: "text",
        },
      });
      return true;
    } catch (error) {
      console.error(`[${this.name}] send failed:`, error instanceof Error ? error.message : String(error));
      return false;
    }
  }
}

export const name = "void-channel-feishu-real";
export const inject = ["voidChannels"];

export interface RealFeishuPluginConfig {
  onMessage?: VoidChannelConfig["onMessage"];
  appId?: string;
  appSecret?: string;
  domain?: string;
}

export function apply(ctx: Context, config: RealFeishuPluginConfig = {}): void {
  const appId = config.appId ?? process.env.VOID_FEISHU_APP_ID;
  const appSecret = config.appSecret ?? process.env.VOID_FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error(
      "VOID_FEISHU_APP_ID and VOID_FEISHU_APP_SECRET are required for the real Feishu channel (fail-closed)",
    );
  }
  const onMessage = config.onMessage ?? (() => {});
  ctx.voidChannels.register(new RealFeishuChannel({
    appId,
    appSecret,
    ...(config.domain === undefined ? {} : { domain: config.domain }),
    onMessage,
  }));
}
