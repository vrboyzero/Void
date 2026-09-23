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

async function boot(extra: Array<{ id: string; name: string }> = [], includeMemory = true): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(Loader);
  const modules = new Map<string, unknown>([
    ["@void/void-entry", VoidEntry],
    ["@void/void-memory/sqlite", STUB],
    ["@void/void-memory/tool", STUB],
    ["@void/void-dsh-control", STUB],
    ["@void/void-soul/plugin", STUB],
    ["@void/void-memory/provider", STUB],
    ["@void/void-legion/service", STUB],
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
  if (includeMemory) {
    await ctx.loader.create({ id: "void-memory-sqlite", name: "@void/void-memory/sqlite" } as never);
    await ctx.loader.create({ id: "void-memory-tool", name: "@void/void-memory/tool" } as never);
  }
  await ctx.loader.create({ id: "void-dsh-control", name: "@void/void-dsh-control" } as never);
  for (const entry of extra) await ctx.loader.create(entry as never);
  await ctx.loader.await();
  return ctx;
}

function suiteOf(ctx: Context): VoidSuite {
  return ctx.get("voidSuite") as VoidSuite;
}

describe("void-entry toggle (host half)", () => {
  it("toggles a plugin off and back on", async () => {
    context = await boot([{ id: "void-soul", name: "@void/void-soul/plugin" }]);
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

  it("refuses to close an enabled prerequisite or open a dependent without prerequisites", async () => {
    context = await boot([
      { id: "void-soul", name: "@void/void-soul/plugin" },
      { id: "void-legion", name: "@void/void-legion/service" },
    ]);
    const suite = suiteOf(context);

    await expect(suite.setEnabled("@void/void-memory", false)).rejects.toThrow("军团");
    await expect(suite.setEnabled("@void/void-soul", false)).rejects.toThrow("记忆");
    expect(suite.isEnabled("@void/void-memory")).toBe(true);
    expect(suite.isEnabled("@void/void-soul")).toBe(true);

    await suite.setEnabled("@void/void-legion", false);
    await suite.setEnabled("@void/void-memory", false);
    await suite.setEnabled("@void/void-soul", false);
    await expect(suite.setEnabled("@void/void-legion", true)).rejects.toThrow("灵魂");
    await expect(suite.setEnabled("@void/void-memory", true)).rejects.toThrow("灵魂");
    expect(suite.isEnabled("@void/void-legion")).toBe(false);

    await suite.setEnabled("@void/void-soul", true);
    await expect(suite.setEnabled("@void/void-legion", true)).rejects.toThrow("记忆");
    await suite.setEnabled("@void/void-memory", true);
    await suite.setEnabled("@void/void-legion", true);
    expect(suite.isEnabled("@void/void-legion")).toBe(true);
  });

  it("switches the suite in dependency order and rejects missing prerequisites before partial enable", async () => {
    context = await boot([
      { id: "void-soul", name: "@void/void-soul/plugin" },
      { id: "void-legion", name: "@void/void-legion/service" },
    ]);
    const suite = suiteOf(context);
    await suite.setAllEnabled(false);
    expect(suite.list().filter((plugin) => plugin.toggleable).every((plugin) => !plugin.enabled)).toBe(true);
    await suite.setAllEnabled(true);
    expect(suite.list().every((plugin) => plugin.enabled)).toBe(true);
  });

  it("does not partially enable the suite when legion lacks an installed prerequisite", async () => {
    context = await boot([
      { id: "void-soul", name: "@void/void-soul/plugin" },
      { id: "void-legion", name: "@void/void-legion/service" },
    ], false);
    const suite = suiteOf(context);
    await suite.setAllEnabled(false);
    await expect(suite.setAllEnabled(true)).rejects.toThrow("记忆");
    expect(suite.list().filter((plugin) => plugin.toggleable).every((plugin) => !plugin.enabled)).toBe(true);
  });

  it("serializes concurrent requests so a dependent can close before its prerequisite", async () => {
    context = await boot([
      { id: "void-soul", name: "@void/void-soul/plugin" },
      { id: "void-legion", name: "@void/void-legion/service" },
    ]);
    const suite = suiteOf(context);
    await Promise.all([
      suite.setEnabled("@void/void-legion", false),
      suite.setEnabled("@void/void-memory", false),
    ]);
    expect(suite.isEnabled("@void/void-legion")).toBe(false);
    expect(suite.isEnabled("@void/void-memory")).toBe(false);
    expect(suite.isEnabled("@void/void-soul")).toBe(true);
  });

  it("treats a partially disabled dependent as active and rolls back failed multi-entry toggles", async () => {
    context = await boot([{ id: "void-soul", name: "@void/void-soul/plugin" }]);
    const suite = suiteOf(context);
    const entries = [...context.loader.entries()].filter((entry) => suite.listEntryIds("@void/void-memory").includes(entry.options.id));
    const failing = entries[1]!;
    const originalUpdate = failing.update.bind(failing);
    failing.update = async (options) => {
      if (options.disabled === true) throw new Error("simulated update failure");
      return originalUpdate(options);
    };
    await expect(suite.setEnabled("@void/void-memory", false)).rejects.toThrow("simulated update failure");
    expect(suite.isEnabled("@void/void-memory")).toBe(true);
    await entries[0]!.update({ disabled: true });
    await expect(suite.setEnabled("@void/void-soul", false)).rejects.toThrow("记忆");
  });

  it("returns a conflict from the guarded API and accepts a single ordered suite request", async () => {
    context = await boot([
      { id: "void-soul", name: "@void/void-soul/plugin" },
      { id: "void-legion", name: "@void/void-legion/service" },
    ]);
    const suite = suiteOf(context);
    const send = async (pluginId: string, enabled: boolean) => {
      const request = {
        headers: { "content-type": "application/json", "x-void-request": "1" },
        async *[Symbol.asyncIterator]() { yield JSON.stringify({ pluginId, enabled }); },
      };
      const response = { statusCode: 0, body: "", setHeader() {}, end(body: string) { this.body = body; } };
      await (suite as unknown as { handleToggle(req: typeof request, res: typeof response): Promise<void> })
        .handleToggle(request, response);
      return { statusCode: response.statusCode, payload: JSON.parse(response.body) as { error?: string; plugins?: Array<{ id: string; enabled: boolean }> } };
    };
    const rejected = await send("@void/void-soul", false);
    expect(rejected.statusCode).toBe(409);
    expect(rejected.payload.error).toContain("记忆");
    const disabled = await send("*", false);
    expect(disabled.statusCode).toBe(200);
    expect(disabled.payload.plugins?.filter((plugin) => plugin.id !== "@void/void-entry").every((plugin) => !plugin.enabled)).toBe(true);
  });
});
