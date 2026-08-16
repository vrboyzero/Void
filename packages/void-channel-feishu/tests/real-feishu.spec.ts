import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";

// mock 飞书 SDK：真实 SDK 会发网络请求，测试用 mock 验证调用形状。
const { messageCreate, clientOpts } = vi.hoisted(() => ({
  messageCreate: vi.fn(),
  clientOpts: [] as unknown[],
}));

vi.mock("@larksuiteoapi/node-sdk", () => ({
  Client: class {
    im = { message: { create: messageCreate } };
    constructor(opts: unknown) {
      clientOpts.push(opts);
    }
  },
}));

import { RealFeishuChannel, apply } from "../src/real-feishu.js";

describe("RealFeishuChannel (真实飞书发消息侧)", () => {
  beforeEach(() => {
    messageCreate.mockReset().mockResolvedValue({ code: 0 });
    clientOpts.length = 0;
    delete process.env.VOID_FEISHU_APP_ID;
    delete process.env.VOID_FEISHU_APP_SECRET;
  });

  afterEach(() => {
    delete process.env.VOID_FEISHU_APP_ID;
    delete process.env.VOID_FEISHU_APP_SECRET;
  });

  it("fail-closed：缺凭据时 apply 抛错，不静默降级", () => {
    const ctx = { voidChannels: { register: vi.fn() } } as unknown as Context;
    expect(() => apply(ctx)).toThrow(/VOID_FEISHU_APP_ID/);
  });

  it("从 VOID_* 环境变量读凭据并注册（config 缺省时）", () => {
    process.env.VOID_FEISHU_APP_ID = "cli_test";
    process.env.VOID_FEISHU_APP_SECRET = "secret_test";
    const register = vi.fn();
    const ctx = { voidChannels: { register } } as unknown as Context;
    apply(ctx);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]![0]).toBeInstanceOf(RealFeishuChannel);
  });

  it("send 用 SDK 发文本消息到指定 chat_id", async () => {
    const channel = new RealFeishuChannel({
      appId: "cli_test",
      appSecret: "secret_test",
      onMessage: () => {},
    });
    const ok = await channel.send("oc_chat_1", "hello void");
    expect(ok).toBe(true);
    expect(messageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_chat_1",
        content: JSON.stringify({ text: "hello void" }),
        msg_type: "text",
      },
    });
  });

  it("SDK 抛错时 send 返回 false（不回显凭据）", async () => {
    messageCreate.mockRejectedValueOnce(new Error("invalid app secret"));
    const channel = new RealFeishuChannel({
      appId: "cli_test",
      appSecret: "bad_secret",
      onMessage: () => {},
    });
    const ok = await channel.send("oc_chat_1", "hello");
    expect(ok).toBe(false);
  });
});
