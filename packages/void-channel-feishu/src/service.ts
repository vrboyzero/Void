import { Service, type Context } from "@deepseek-ai/cordis";
import type { VoidChannel } from "./channel.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    voidChannels: VoidChannels;
  }
}

/**
 * Service Definition: the Void channel registry. A channel host/adapter
 * registers here; the dsh side (message ingress → agent loop) consumes by name.
 * This is the "host/adapter + MessageSource"承载点 from the plan.
 */
export class VoidChannels extends Service {
  private readonly channels = new Map<string, VoidChannel>();

  constructor(ctx: Context) {
    super(ctx, "voidChannels");
  }

  register(channel: VoidChannel): () => void {
    return this.ctx.effect(() => {
      this.channels.set(channel.name, channel);
      return () => {
        this.channels.delete(channel.name);
      };
    }, "voidChannels.register()");
  }

  get(name: string): VoidChannel | undefined {
    return this.channels.get(name);
  }

  list(): string[] {
    return [...this.channels.keys()];
  }
}

export default VoidChannels;
