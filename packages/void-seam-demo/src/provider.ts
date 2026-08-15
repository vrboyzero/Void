import type { Context } from "@deepseek-ai/cordis";
import { VoidGreeterService } from "./service.js";

export const name = "void-greeter-provider";

/**
 * Provider: mounts the Service Definition as an effect, so unloading this
 * plugin removes the service (HMR-safe). This is role 2 of the seam.
 */
export function apply(ctx: Context) {
  ctx.plugin(VoidGreeterService);
}
