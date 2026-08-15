import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import InvariantRegistry from "@deepseek-ai/dsh-invariants";
import * as VoidInvariant from "../src/invariant.js";

// ACTIVE (2); `FiberState` is a const enum erased at runtime.
const ACTIVE = 2;

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
    ["@deepseek-ai/dsh-invariants", InvariantRegistry],
    ["@void/void-seam-demo/invariant", VoidInvariant],
  ]);
  ctx.loader.internal = {
    version: "v2",
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`);
      return modules.get(specifier);
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>;
  await ctx.loader.create({ name: "@deepseek-ai/dsh-invariants" });
  await ctx.loader.create({ name: "@void/void-seam-demo/invariant" });
  await ctx.loader.await();
  return ctx;
}

describe("void invariant companion through the Loader", () => {
  it("registers the package invariant companion (apply resolves)", async () => {
    context = await boot();
    // ACTIVE means `apply` resolved, i.e. `ctx.invariants.register(PACKAGE_NAME, install)` succeeded.
    expect(findFiber(context, "void-seam-demo-invariant")?.state).toBe(ACTIVE);
  });
});
