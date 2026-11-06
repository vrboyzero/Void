/**
 * 飞书真网关：Lark SDK 的 WS 长连接（收事件）+ IM API（发消息/列群成员）。
 *
 * 凭据只从环境变量读（appIdEnv/appSecretEnv 由来源配置给变量名），不写文件、
 * 不回显、不进日志。真实连接需要自建应用已发布并开启机器人能力；测试用假网关。
 *
 * @module @void/void-legion/feishu-ws-gateway
 */
import type { FeishuGateway, FeishuInboundEvent, FeishuMember } from "./feishu-source.js";

interface LarkSdk {
  Client: new (options: Record<string, unknown>) => any;
  WSClient: new (options: Record<string, unknown>) => any;
  EventDispatcher: new (options: Record<string, unknown>) => any;
}

async function loadSdk(): Promise<LarkSdk> {
  const module = await import("@larksuiteoapi/node-sdk") as unknown as LarkSdk;
  return module;
}

export interface FeishuWsGatewayOptions {
  appId: string;
  appSecret: string;
  domain?: string;
  /** 测试注入。 */
  sdk?: LarkSdk | undefined;
}

export class FeishuWsGateway implements FeishuGateway {
  private readonly options: FeishuWsGatewayOptions;
  private client: any;
  private ws: any;
  private starting: Promise<void> | undefined;

  constructor(options: FeishuWsGatewayOptions) {
    this.options = options;
  }

  private async ensureClient(): Promise<any> {
    if (this.client !== undefined) return this.client;
    const sdk = this.options.sdk ?? await loadSdk();
    this.client = new sdk.Client({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      ...(this.options.domain === undefined ? {} : { domain: this.options.domain }),
    });
    return this.client;
  }

  async checkAuth(): Promise<{ botOpenId: string }> {
    const client = await this.ensureClient();
    const response = await client.request({ method: "GET", url: "/open-apis/bot/v3/info" });
    const openId = response?.bot?.open_id ?? response?.data?.bot?.open_id;
    if (typeof openId !== "string" || openId === "") {
      throw new Error("飞书 bot info 没有返回 open_id");
    }
    return { botOpenId: openId };
  }

  async start(onEvent: (event: FeishuInboundEvent) => void): Promise<void> {
    if (this.starting !== undefined) return this.starting;
    this.starting = (async () => {
      const sdk = this.options.sdk ?? await loadSdk();
      const dispatcher = new sdk.EventDispatcher({});
      dispatcher.register({
        "im.message.receive_v1": (data: any) => {
          const event = normalizeEvent(data);
          if (event !== undefined) onEvent(event);
        },
      });
      this.ws = new sdk.WSClient({
        appId: this.options.appId,
        appSecret: this.options.appSecret,
        ...(this.options.domain === undefined ? {} : { domain: this.options.domain }),
      });
      await this.ws.start({ eventDispatcher: dispatcher });
    })();
    return this.starting;
  }

  async stop(): Promise<void> {
    this.starting = undefined;
    this.ws?.close?.({ force: true });
    this.ws = undefined;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    const client = await this.ensureClient();
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, content: JSON.stringify({ text }), msg_type: "text" },
    });
  }

  async listMembers(chatId: string): Promise<FeishuMember[]> {
    const client = await this.ensureClient();
    const members: FeishuMember[] = [];
    let pageToken: string | undefined;
    do {
      const response = await client.im.chatMembers.get({
        params: { member_id_type: "open_id", page_size: 100, ...(pageToken === undefined ? {} : { page_token: pageToken }) },
        path: { chat_id: chatId },
      });
      for (const item of response?.data?.items ?? []) {
        if (typeof item?.member_id === "string" && item.member_id !== "") {
          members.push({ id: item.member_id, ...(typeof item.name === "string" ? { name: item.name } : {}) });
        }
      }
      pageToken = response?.data?.has_more === true ? response.data.page_token : undefined;
    } while (pageToken !== undefined);
    return members;
  }
}

/** 把 Lark 事件收窄成内部形状；不认识的 message_type 只取 text。 */
export function normalizeEvent(input: unknown): FeishuInboundEvent | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const data = input as Record<string, any>;
  const message = data.message;
  if (typeof message !== "object" || message === null) return undefined;
  const sender = data.sender;
  if (typeof sender !== "object" || sender === null) return undefined;
  const ids = sender.sender_id ?? {};
  const senderId = ids.open_id ?? ids.user_id ?? ids.union_id;
  if (typeof senderId !== "string" || senderId === "") return undefined;
  const messageId = message.message_id;
  if (typeof messageId !== "string" || messageId === "") return undefined;
  const eventId = data.event_id ?? data.uuid ?? messageId;
  const chatId = message.chat_id;
  if (typeof chatId !== "string" || chatId === "") return undefined;
  const mentions: string[] = [];
  for (const mention of message.mentions ?? []) {
    const mentionId = mention?.id?.open_id ?? mention?.id?.user_id ?? mention?.id?.union_id;
    if (typeof mentionId === "string" && mentionId !== "") mentions.push(mentionId);
  }
  const text = textOfContent(message.content);
  return {
    eventId: String(eventId),
    messageId,
    chatId,
    chatType: message.chat_type === "p2p" ? "p2p" : "group",
    senderId,
    senderType: sender.sender_type === "app" ? "bot" : "user",
    text,
    mentions,
    timestamp: typeof message.create_time === "string" ? message.create_time : new Date().toISOString(),
  };
}

function textOfContent(content: unknown): string {
  if (typeof content !== "string" || content === "") return "";
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    return "";
  }
}
