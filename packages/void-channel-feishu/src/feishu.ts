import type { VoidChannel, VoidChannelConfig, ChannelLifecycleState } from "./channel.js";

/**
 * Mock Feishu channel: an in-memory transport that proves the channel seam
 * shape (receive → ingress → reply). Real Feishu (Lark SDK + webhook) is
 * deferred — see README 已知分叉.
 */
export class MockFeishuChannel implements VoidChannel {
  readonly name = "feishu";
  isRunning = false;
  lifecycleState: ChannelLifecycleState = "stopped";
  private readonly outbound: Array<{ chatId: string; content: string }> = [];

  constructor(private readonly config: VoidChannelConfig) {}

  async start(): Promise<void> {
    this.isRunning = true;
    this.lifecycleState = "running";
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.lifecycleState = "stopped";
  }

  /** Simulate an inbound Feishu message (test hook; real impl reads the webhook). */
  async receive(chatId: string, senderId: string, messageId: string, text: string): Promise<void> {
    await this.config.onMessage({ chatId, senderId, messageId, text });
  }

  async send(chatId: string, content: string): Promise<boolean> {
    this.outbound.push({ chatId, content });
    return true;
  }

  sentCount(): number {
    return this.outbound.length;
  }
}

export const name = "void-channel-feishu";
export const inject = ["voidChannels"];

export function apply(ctx: import("@deepseek-ai/cordis").Context, config: VoidChannelConfig): void {
  ctx.voidChannels.register(new MockFeishuChannel(config));
}
