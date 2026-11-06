import { describe, expect, it } from "vitest";
import { FeishuWsGateway, normalizeEvent } from "../src/feishu-ws-gateway.js";
import type { FeishuInboundEvent } from "../src/feishu-source.js";

function sdk() {
  const state = {
    sent: [] as Array<Record<string, unknown>>,
    memberPages: [
      { items: [{ member_id: "alice", name: "Alice" }], has_more: true, page_token: "p2" },
      { items: [{ member_id: "bob" }], has_more: false },
    ],
    handler: undefined as ((data: unknown) => void) | undefined,
    closed: false,
  };
  class Client {
    request = async () => ({ bot: { open_id: "bot-open" } });
    im = {
      message: {
        create: async (payload: Record<string, unknown>) => { state.sent.push(payload); },
      },
      chatMembers: {
        get: async () => ({ data: state.memberPages.shift() }),
      },
    };
  }
  class EventDispatcher {
    register(handles: Record<string, (data: unknown) => void>) {
      state.handler = handles["im.message.receive_v1"];
      return this;
    }
  }
  class WSClient {
    async start() {}
    close() { state.closed = true; }
  }
  return { state, module: { Client, EventDispatcher, WSClient } as never };
}

function rawEvent() {
  return {
    event_id: "evt-1",
    sender: { sender_id: { open_id: "alice" }, sender_type: "user" },
    message: {
      message_id: "msg-1",
      chat_id: "chat-1",
      chat_type: "group",
      content: JSON.stringify({ text: "@bot 看一下" }),
      mentions: [{ id: { open_id: "bot-open" }, name: "bot" }],
      create_time: "1793940000000",
    },
  };
}

describe("normalizeEvent", () => {
  it("收窄事件：chatType / sender / text / mentions", () => {
    const event = normalizeEvent(rawEvent());
    expect(event).toMatchObject({
      eventId: "evt-1",
      messageId: "msg-1",
      chatId: "chat-1",
      chatType: "group",
      senderId: "alice",
      senderType: "user",
      mentions: ["bot-open"],
    });
    expect(event?.text).toContain("@bot");
  });

  it("不认识的形状返回 undefined，不抛", () => {
    expect(normalizeEvent(null)).toBeUndefined();
    expect(normalizeEvent({})).toBeUndefined();
    expect(normalizeEvent({ sender: {}, message: {} })).toBeUndefined();
  });
});

describe("FeishuWsGateway", () => {
  it("checkAuth 取 bot open_id", async () => {
    const fake = sdk();
    const gateway = new FeishuWsGateway({ appId: "a", appSecret: "s", sdk: fake.module });
    await expect(gateway.checkAuth()).resolves.toEqual({ botOpenId: "bot-open" });
  });

  it("start 把 SDK 事件转给 onEvent", async () => {
    const fake = sdk();
    const gateway = new FeishuWsGateway({ appId: "a", appSecret: "s", sdk: fake.module });
    const events: FeishuInboundEvent[] = [];
    await gateway.start((event) => events.push(event));
    fake.state.handler?.(rawEvent());
    expect(events[0]).toMatchObject({ eventId: "evt-1", senderId: "alice" });
  });

  it("sendMessage 用 chat_id 文本消息", async () => {
    const fake = sdk();
    const gateway = new FeishuWsGateway({ appId: "a", appSecret: "s", sdk: fake.module });
    await gateway.sendMessage("chat-1", "已接单");
    expect(fake.state.sent[0]).toMatchObject({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: "chat-1", msg_type: "text" },
    });
  });

  it("listMembers 翻页取全量", async () => {
    const fake = sdk();
    const gateway = new FeishuWsGateway({ appId: "a", appSecret: "s", sdk: fake.module });
    await expect(gateway.listMembers("chat-1")).resolves.toEqual([
      { id: "alice", name: "Alice" },
      { id: "bob" },
    ]);
  });

  it("stop 关闭 WS", async () => {
    const fake = sdk();
    const gateway = new FeishuWsGateway({ appId: "a", appSecret: "s", sdk: fake.module });
    await gateway.start(() => {});
    await gateway.stop();
    expect(fake.state.closed).toBe(true);
  });
});
