import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import * as VoidChannelsModule from "../src/service.js";
import * as VoidFeishuModule from "../src/feishu.js";
import type { VoidChannels } from "../src/service.js";

let context: Context | undefined;

afterEach(async () => {
  await context?.fiber.dispose();
  context = undefined;
});

function findFiber(ctx: Context, pluginName: string) {
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers) {
      if (fiber.name === pluginName) return fiber;
    }
  }
  return undefined;
}

async function boot(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(Loader);
  const modules = new Map<string, unknown>([
    ["@void/void-channel-feishu/service", VoidChannelsModule],
    ["@void/void-channel-feishu/feishu", VoidFeishuModule],
  ]);
  ctx.loader.internal = {
    version: "v2",
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`);
      return modules.get(specifier);
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>;
  await ctx.loader.create({ name: "@void/void-channel-feishu/service" });
  await ctx.loader.create({
    name: "@void/void-channel-feishu/feishu",
    config: {
      onMessage: () => {
        received.push("routed");
      },
    },
  });
  await ctx.loader.await();
  return ctx;
}

const received: string[] = [];

describe("void feishu channel seam through the Loader", () => {
  it("registers the channel and routes an inbound message to the ingress hook", async () => {
    received.length = 0;
    context = await boot();
    const channels = context.get("voidChannels") as VoidChannels;
    expect(channels.list()).toContain("feishu");

    const channel = channels.get("feishu") as { receive(chatId: string, senderId: string, messageId: string, text: string): Promise<void> };
    await channel.receive("chat-1", "user-1", "msg-1", "hello void");
    expect(received).toContain("routed");
  });

  it("releases the channel registry when the provider is disposed (HMR-safe)", async () => {
    context = await boot();
    expect(context.get("voidChannels")).toBeDefined();

    const provider = findFiber(context, "VoidChannels");
    expect(provider).toBeDefined();
    await provider!.dispose();
    expect(context.get("voidChannels")).toBeUndefined();
  });
});
