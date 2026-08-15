import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import * as VoidTool from "../src/tool.js";

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

/**
 * Boot the tool consumer through the Cordis Loader, mocking only the module
 * resolver (no `node-addon-require-builtin` here). Entries load SEQUENTIALLY:
 * the Include plugin's `Promise.allSettled` fan-out drops entries whose
 * `apply()` mounts a nested service while siblings load in parallel (a Spike
 * finding); sequential `loader.create()` is deterministic.
 */
async function boot(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(Loader);
  const modules = new Map<string, unknown>([
    ["@deepseek-ai/dsh-system-prompt", SystemPrompt],
    ["@deepseek-ai/dsh-tools", ToolRuntime],
    ["@void/void-seam-demo/tool", VoidTool],
  ]);
  ctx.loader.internal = {
    version: "v2",
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`);
      return modules.get(specifier);
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>;
  await ctx.loader.create({ name: "@deepseek-ai/dsh-system-prompt" });
  await ctx.loader.create({ name: "@deepseek-ai/dsh-tools" });
  await ctx.loader.create({ name: "@void/void-seam-demo/tool" });
  await ctx.loader.await();
  return ctx;
}

describe("void tool through a real cordis.yml", () => {
  it("registers the void_greet tool on ctx.tools and makes it model-visible", async () => {
    context = await boot();
    const tool = context.tools.get("void_greet");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("void_greet");
    expect(context.tools.schemas().some((schema) => schema.name === "void_greet")).toBe(true);
  });

  it("unregisters the tool when the consumer fiber is disposed (HMR-safe)", async () => {
    context = await boot();
    expect(context.tools.get("void_greet")).toBeDefined();

    const consumer = findFiber(context, "void-greeter-tool");
    expect(consumer).toBeDefined();
    await consumer!.dispose();

    expect(context.tools.get("void_greet")).toBeUndefined();
    expect(context.tools.schemas().some((schema) => schema.name === "void_greet")).toBe(false);
  });
});
