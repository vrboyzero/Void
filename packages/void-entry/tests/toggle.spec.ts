import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import * as VoidEntry from "../src/index.js";
import * as VoidMemorySqlite from "@void/void-memory/sqlite";
import * as VoidMemoryTool from "@void/void-memory/tool";
import type { VoidSuite } from "../src/index.js";

let context: Context | undefined;

afterEach(async () => {
  await context?.fiber.dispose();
  context = undefined;
});

async function boot(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(Loader);
  const modules = new Map<string, unknown>([
    ["@deepseek-ai/dsh-system-prompt", SystemPrompt],
    ["@deepseek-ai/dsh-tools", ToolRuntime],
    ["@void/void-entry", VoidEntry],
    ["@void/void-memory/sqlite", VoidMemorySqlite],
    ["@void/void-memory/tool", VoidMemoryTool],
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
  await ctx.loader.create({ name: "@void/void-entry" });
  // 显式 entry id，模拟 profile 的 cordis.patch.yml 行（runtime 传 id，绕过类型 Omit）。
  await ctx.loader.create({ id: "void-memory-sqlite", name: "@void/void-memory/sqlite" } as never);
  await ctx.loader.create({ id: "void-memory-tool", name: "@void/void-memory/tool" } as never);
  await ctx.loader.await();
  return ctx;
}

describe("void-entry toggle (host half)", () => {
  it("toggles a plugin off and back on", async () => {
    context = await boot();
    const suite = context.get("voidSuite") as VoidSuite;
    expect(suite.isEnabled("void-memory")).toBe(true);

    await suite.setEnabled("void-memory", false);
    expect(suite.isEnabled("void-memory")).toBe(false);

    await suite.setEnabled("void-memory", true);
    expect(suite.isEnabled("void-memory")).toBe(true);
  });

  it("toggles the whole suite (except the entry itself)", async () => {
    context = await boot();
    const suite = context.get("voidSuite") as VoidSuite;
    await suite.setAllEnabled(false);
    expect(suite.isEnabled("void-memory")).toBe(false);
    // 入口自身不可关。
    expect(suite.isEnabled("void-entry")).toBe(true);
  });
});
