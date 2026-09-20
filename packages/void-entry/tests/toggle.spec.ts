import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import * as VoidEntry from "../src/index.js";
import type { VoidSuite } from "../src/index.js";

/** 最小合法 Cordis 插件替身：只用来占住一条 entry 行。 */
const STUB = { apply: () => {} };
let context: Context | undefined;

afterEach(async () => {
  await context?.fiber.dispose();
  context = undefined;
});

async function boot(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(Loader);
  const modules = new Map<string, unknown>([
    ["@void/void-entry", VoidEntry],
    ["@void/void-memory/sqlite", STUB],
    ["@void/void-memory/tool", STUB],
    ["@void/void-dsh-control", STUB],
  ]);
  ctx.loader.internal = {
    version: "v2",
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`);
      return modules.get(specifier);
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>;
  await ctx.loader.create({ name: "@void/void-entry" });
  // 显式 entry id，模拟 profile 的 cordis.patch.yml 行（runtime 传 id，绕过类型 Omit）。
  await ctx.loader.create({ id: "void-memory-sqlite", name: "@void/void-memory/sqlite" } as never);
  await ctx.loader.create({ id: "void-memory-tool", name: "@void/void-memory/tool" } as never);
  await ctx.loader.create({ id: "void-dsh-control", name: "@void/void-dsh-control" } as never);
  await ctx.loader.await();
  return ctx;
}

function suiteOf(ctx: Context): VoidSuite {
  return ctx.get("voidSuite") as VoidSuite;
}

describe("void-entry toggle (host half)", () => {
  it("toggles a plugin off and back on", async () => {
    context = await boot();
    const suite = suiteOf(context);
    expect(suite.isEnabled("@void/void-memory")).toBe(true);

    await suite.setEnabled("@void/void-memory", false);
    expect(suite.isEnabled("@void/void-memory")).toBe(false);

    await suite.setEnabled("@void/void-memory", true);
    expect(suite.isEnabled("@void/void-memory")).toBe(true);
  });

  it("toggles every entry line of a multi-entry plugin together", async () => {
    context = await boot();
    const suite = suiteOf(context);
    const ids = suite.listEntryIds("@void/void-memory");

    await suite.setEnabled("@void/void-memory", false);
    // 只关掉其中一条 entry 会让插件半死，所以两条都必须落盘。
    for (const entry of context.loader.entries()) {
      if (ids.includes(entry.options.id)) expect(entry.disabled).toBe(true);
    }
  });

  it("toggles the whole suite (except the entry itself)", async () => {
    context = await boot();
    const suite = suiteOf(context);

    await suite.setAllEnabled(false);
    expect(suite.isEnabled("@void/void-memory")).toBe(false);
    expect(suite.isEnabled("@void/void-dsh-control")).toBe(false);
    // 入口自身不可关。
    expect(suite.isEnabled("@void/void-entry")).toBe(true);
  });
});
