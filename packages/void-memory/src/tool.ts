import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { VoidMemory } from "./service.js";

export const name = "void-memory-tool";
export const inject = ["tools", "voidMemory"];

/** Consumer: registers the model-facing memory_search tool on ctx.tools. */
export function apply(ctx: Context) {
  const memory = ctx.get("voidMemory") as VoidMemory;
  ctx.tools.register(defineTool({
    name: "memory_search",
    description: "Search the Void memory knowledge layer (FTS5 keyword search).",
    parameters: {
      query: { type: "string", required: true, description: "Keyword query." },
      k: { type: "integer", description: "Number of results (default 5)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          results: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                content: { type: "string", required: true },
                score: { type: "number", required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify((value as { results: unknown[] }).results) }],
    },
    async execute(args) {
      const { query, k = 5 } = args as { query: string; k?: number };
      const results = memory.search(query, k).map((r) => ({ id: r.id, content: r.content, score: r.score }));
      return { results };
    },
  }));
}
