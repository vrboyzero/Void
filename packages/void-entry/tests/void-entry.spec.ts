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

/** 起一个真实 Loader，只把模块解析换成测试替身。 */
async function boot(entries: Array<{ id?: string; name: string }>): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(Loader);
  const modules = new Map<string, unknown>(
    entries.map((entry) => [entry.name, entry.name === "@void/void-entry" ? VoidEntry : STUB]),
  );
  ctx.loader.internal = {
    version: "v2",
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`);
      return modules.get(specifier);
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>;
  for (const entry of entries) {
    await ctx.loader.create(entry as never);
  }
  await ctx.loader.await();
  return ctx;
}

/** 只有一个 Void 入口、没有其他 Void 插件的基线。 */
const ENTRY_ONLY = [{ name: "@void/void-entry" }];

function suiteOf(ctx: Context): VoidSuite {
  const suite = ctx.get("voidSuite") as VoidSuite;
  expect(suite).toBeDefined();
  return suite;
}

describe("void-entry host half (VoidSuite)", () => {
  it("discovers installed Void plugins instead of a hardcoded list", async () => {
    context = await boot([
      ...ENTRY_ONLY,
      { name: "@deepseek-ai/dsh-tools" },
      { name: "@void/void-dsh-control", id: "void-dsh-control" },
    ]);
    const plugins = suiteOf(context).list();

    // 只收录 @void/*，且 id 用包名。
    expect(plugins.map((p) => p.id)).toEqual(["@void/void-dsh-control", "@void/void-entry"]);
    // 目录表里的展示元数据生效。
    expect(plugins[0]!.name).toBe("灵榜控制面");
    expect(plugins[0]!.description).toContain("MCP");
    expect(plugins[1]!.toggleable).toBe(false);
    expect(plugins[0]!.toggleable).toBe(true);
  });

  it("lists nothing but the entry when no other Void plugin is installed", async () => {
    context = await boot(ENTRY_ONLY);
    expect(suiteOf(context).list().map((p) => p.id)).toEqual(["@void/void-entry"]);
  });

  it("collapses subpath entries of one package into a single row", async () => {
    // void-memory 在 profile 里是两条 entry 行，说明符带子路径。
    context = await boot([
      ...ENTRY_ONLY,
      { id: "void-memory-sqlite", name: "@void/void-memory/sqlite" },
      { id: "void-memory-tool", name: "@void/void-memory/tool" },
    ]);
    const suite = suiteOf(context);

    expect(suite.list().map((p) => p.id)).toEqual(["@void/void-memory", "@void/void-entry"]);
    // 一个插件的全部 entry 行都要能定位到，否则关不干净。
    expect(suite.listEntryIds("@void/void-memory").sort()).toEqual([
      "void-memory-sqlite",
      "void-memory-tool",
    ]);
  });

  it("falls back to the bare package name for an uncatalogued plugin", async () => {
    context = await boot([...ENTRY_ONLY, { name: "@void/void-brand-new", id: "void-brand-new" }]);
    const fresh = suiteOf(context).list().find((p) => p.id === "@void/void-brand-new")!;
    expect(fresh.name).toBe("void-brand-new");
    expect(fresh.description).toBe("");
  });

  it("reports a plugin with no entry as not enabled", async () => {
    context = await boot(ENTRY_ONLY);
    // 没登记过的包：开关没有意义，不能默认报「开」。
    expect(suiteOf(context).isEnabled("@void/void-dsh-control")).toBe(false);
  });
});

describe("void-entry host routes (webServer is optional and late)", () => {
  /** 一个只在被 load 后才 provide webServer 的假宿主插件。 */
  const FakeWebServer = {
    name: "fake-web-server",
    provide: ["webServer"],
    apply(ctx: Context) {
      const routes = new Map<string, (req: unknown, res: unknown) => void>();
      ctx.provide("webServer", {
        register(route: { path: string; handler: (req: unknown, res: unknown) => void }) {
          routes.set(route.path, route.handler);
          return () => routes.delete(route.path);
        },
        routes,
      } as never);
    },
  };

  it("registers its routes even though webServer is provided by a later plugin", async () => {
    const ctx = new Context();
    context = ctx;
    await ctx.plugin(Loader);
    const modules = new Map<string, unknown>([
      ["@void/void-entry", VoidEntry],
      ["fake-web-server", FakeWebServer],
    ]);
    ctx.loader.internal = {
      version: "v2",
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`);
        return modules.get(specifier);
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>;

    await ctx.loader.create({ name: "@void/void-entry" });
    // webServer 在入口**之后**才出现：构造函数里的 ctx.get 探测在这个顺序下必然失败，
    // 所以路由必须靠 ctx.inject 等出来。这条测试锁住的就是那个顺序 bug。
    await ctx.loader.create({ name: "fake-web-server" });
    await ctx.loader.await();

    const webServer = ctx.get("webServer") as unknown as { routes: Map<string, unknown> };
    expect([...webServer.routes.keys()].sort()).toEqual(["/void/api/panels", "/void/api/status", "/void/api/toggle"]);
  });

  it("does not fail to load when no webServer ever appears (headless)", async () => {
    context = await boot(ENTRY_ONLY);
    // 没有 webServer 也要能提供目录服务；否则 headless profile 连 voidSuite 都没有。
    expect(suiteOf(context).list().map((p) => p.id)).toEqual(["@void/void-entry"]);
  });
});
