import type { Context } from "@deepseek-ai/cordis";

export const name = "void-greeter-consumer";
export const inject = ["voidGreeter"];

/**
 * Consumer: declares a hard dependency on the service via `inject`. It stays
 * PENDING until a provider mounts `voidGreeter`, and unloads if the provider
 * disappears. This is role 3 of the seam. In a real Void plugin this would
 * register a model-facing tool (e.g. `ctx.tools.register(...)`).
 */
export function apply(ctx: Context) {
  const greeter = ctx.get("voidGreeter") as { greet(who: string): string };
  greeter.greet("spike");
}
