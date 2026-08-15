import { Service, type Context } from "@deepseek-ai/cordis";

declare module "@deepseek-ai/cordis" {
  interface Context {
    voidGreeter: VoidGreeterService;
  }
}

/**
 * Service Definition: owns the `ctx.voidGreeter` key and its vocabulary.
 * This is role 1 of the three-role capability seam.
 */
export class VoidGreeterService extends Service {
  constructor(ctx: Context) {
    super(ctx, "voidGreeter");
  }

  greet(who: string): string {
    return `[void] hello, ${who}!`;
  }
}
