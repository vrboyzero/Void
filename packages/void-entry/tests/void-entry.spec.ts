import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import * as VoidEntry from "../src/index.js";
import type { VoidSuite } from "../src/index.js";

let context: Context | undefined;

afterEach(async () => {
  await context?.fiber.dispose();
  context = undefined;
});

async function boot(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(Loader);
  const modules = new Map<string, unknown>([["@void/void-entry", VoidEntry]]);
  ctx.loader.internal = {
    version: "v2",
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`);
      return modules.get(specifier);
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>;
  await ctx.loader.create({ name: "@void/void-entry" });
  await ctx.loader.await();
  return ctx;
}

describe("void-entry host half (VoidSuite)", () => {
  it("exposes the Void suite catalog", async () => {
    context = await boot();
    const suite = context.get("voidSuite") as VoidSuite;
    expect(suite).toBeDefined();

    const plugins = suite.list();
    expect(plugins.map((p) => p.id)).toEqual([
      "void-memory",
      "void-tools",
      "void-legion",
      "void-channel-feishu",
      "void-entry",
    ]);
    // 入口插件自身不可关；其余可独立开关。
    expect(plugins.find((p) => p.id === "void-entry")!.toggleable).toBe(false);
    expect(plugins.filter((p) => p.toggleable).length).toBe(4);
  });
});
