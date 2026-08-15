import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// `FiberState` is a `const enum` in @deepseek-ai/cordis and is erased at
// runtime (no emitted export), so mirror the numeric values for assertions.
const PENDING = 0;
const ACTIVE = 2;

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function findFiber(ctx: Context, pluginName: string) {
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers) {
      if (fiber.name === pluginName) return fiber;
    }
  }
  return undefined;
}

/**
 * Boot the seam through the real Cordis Loader (not hand-built `ctx.plugin`).
 *
 * Note: entries are created sequentially on purpose. Loading them through the
 * Include plugin (a `cordis.yml` file) fans child entries out via
 * `Promise.allSettled` in `EntryGroup.update`, and that concurrent path drops
 * the provider fiber when its `apply()` mounts the nested `VoidGreeterService`
 * while the consumer loads in parallel. Sequential `loader.create()` is
 * deterministic; the concurrent Include path is a documented Spike finding.
 */
async function loadSeam(ctx: Context): Promise<void> {
  await ctx.plugin(Loader);
  await ctx.loader.create({ name: "../../lib/provider.js" });
  await ctx.loader.create({ name: "../../lib/consumer.js" });
  await ctx.loader.await();
}

describe("void seam through the Loader", () => {
  it("provides the service and loads the consumer", async () => {
    const ctx = new Context();
    ctx.baseUrl = pathToFileURL(fixtureDir).href + "/";
    try {
      await loadSeam(ctx);
      const greeter = ctx.get("voidGreeter") as { greet(who: string): string } | undefined;
      expect(greeter).toBeDefined();
      expect(greeter!.greet("spike")).toBe("[void] hello, spike!");
      expect(findFiber(ctx, "void-greeter-consumer")?.state).toBe(ACTIVE);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("releases the service when the provider is disposed (HMR-safe)", async () => {
    const ctx = new Context();
    ctx.baseUrl = pathToFileURL(fixtureDir).href + "/";
    try {
      await loadSeam(ctx);
      expect(ctx.get("voidGreeter")).toBeDefined();

      const provider = findFiber(ctx, "void-greeter-provider");
      expect(provider).toBeDefined();
      await provider!.dispose();

      expect(ctx.get("voidGreeter")).toBeUndefined();
      expect(findFiber(ctx, "void-greeter-consumer")?.state).toBe(PENDING);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
