import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "void-greeter-tool";
export const inject = ["tools"];

/**
 * Consumer tool: registers a model-facing tool on `ctx.tools`. This is the
 * "Consumer 工具" role of the three-role seam — the same shape as dsh's own
 * `tool-todo` consumer (`inject = ['tools']` + `ctx.tools.register(defineTool(...))`).
 * `register()` is already an effect, so the tool unregisters when this plugin
 * unloads (HMR-safe).
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: "void_greet",
    description: "Greet someone through the Void capability seam.",
    parameters: {
      who: { type: "string", required: true, description: "Who to greet." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { greeting: { type: "string", required: true } },
      },
      render: (_args, value) => [{ type: "text", text: (value as { greeting: string }).greeting }],
    },
    async execute(args) {
      const who = (args as { who: string }).who;
      return { greeting: `[void] hello, ${who}!` };
    },
  }));
}
