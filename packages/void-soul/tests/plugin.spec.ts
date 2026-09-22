import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import * as VoidEntry from "../../void-entry/src/index.js";
import { saveSessionBindings } from "../src/index.js";
import { dataRootOptions, readProfileDirectory, tryResolveVoidDataRoot, type FrozenSection } from "../src/index.js";
import * as VoidSoul from "../src/plugin.js";
import { attachFrozenFacet, freezeCreatedAgent, readContextWindow, registerFrozenFacetListener, resolvePromptBudget } from "../src/plugin.js";

let context: Context | undefined;

afterEach(async () => {
  await context?.fiber.dispose();
  context = undefined;
});

/**
 * 假入口：`effect` 按宿主语义立即执行并收下返回的撤销函数。
 *
 * 三类监听器分开收：`agent/created` 与 `agent/disposed` 收 `{ agent }` 载荷，装配瀑布上的
 * 钩子签名不同（`(assembly, context, next)`），混在一个集合里没法按同一套叫起来。
 */
function suiteContext() {
  const listeners = new Set<(payload: { agent: { id: string } }) => void>();
  const hooks = new Set<(assembly: unknown, context: unknown, next: () => Promise<unknown>) => Promise<unknown>>();
  const disposals = new Set<(payload: { agent: { id: string } }) => void>();
  const disposers: (() => void)[] = [];
  const logged: string[] = [];
  const sources: { id: string; list(): Promise<{ items: Array<Record<string, unknown>>; note?: string }> }[] = [];
  const suite = {
    sources,
    registerNotificationSource(source: (typeof sources)[number]) {
      sources.push(source);
      return () => { const at = sources.indexOf(source); if (at >= 0) sources.splice(at, 1); };
    },
  };
  const scope = {
    get: (name: string) => (name === "voidSuite" ? suite : undefined),
    effect: (fn: () => unknown) => { const dispose = fn(); if (typeof dispose === "function") disposers.push(dispose as () => void); },
  };
  const ctx = {
    logger: () => ({
      error: (...args: unknown[]) => {
        const [format, ...rest] = args;
        let index = 0;
        logged.push(String(format).replace(/%s/g, () => String(rest[index++])));
      },
      info: () => undefined,
      warn: () => undefined,
      debug: () => undefined,
    }),
    on: (name: string, listener: (payload: { agent: { id: string } }) => void) => {
      if (name === "system-prompt/assemble") {
        const hook = listener as unknown as (assembly: unknown, context: unknown, next: () => Promise<unknown>) => Promise<unknown>;
        hooks.add(hook);
        return () => hooks.delete(hook);
      }
      if (name === "agent/disposed") {
        const hook = listener as unknown as (payload: { agent: { id: string } }) => void;
        disposals.add(hook);
        return () => disposals.delete(hook);
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    inject: (_names: string[], callback: (scope: unknown) => void) => { callback(scope); },
  };
  return { ctx, suite, listeners, hooks, disposals, disposers, logged };
}

describe("attachFrozenFacet", () => {
  it("registers the saved facet for the bound agent and leaves another agent untouched", async () => {
    const sections: string[] = [];
    const frozen = await attachFrozenFacet({
      agent: { id: "agent-a", ctx: { systemPrompt: { section: (input) => { sections.push(input.text); return () => undefined; } } } },
      sessionId: "s1",
      bindings: new Map([["s1", "xiaobei"]]),
      records: new Map([["xiaobei", { id: "xiaobei", directoryName: "小贝", soulPath: "SOUL.md", frontMatter: { id: "xiaobei", name: "小贝", summary: "统筹" }, body: "底线" }]]),
      cards: new Map([["dev", { id: "dev", frontMatter: { id: "dev", name: "开发专家", summary: "写代码" }, body: "角色" }]]),
      loadView: async () => ({ agentId: "xiaobei", saved: { kind: "saved", facetId: "dev", name: "开发专家", summary: "写代码", selectionRevision: 4, pending: false }, applied: null, firstMeetingDone: false }),
    });
    expect(sections).toEqual(["底线", "角色"]);
    expect(frozen.applied?.facetId).toBe("dev");
  });

  it("keeps two concurrent agents on their own souls and rejects a missing profile", async () => {
    const records = new Map([
      ["xiaobei", { id: "xiaobei", directoryName: "小贝", soulPath: "a", frontMatter: { id: "xiaobei", name: "小贝", summary: "统筹" }, body: "底线A" }],
      ["xiaoma", { id: "xiaoma", directoryName: "小码", soulPath: "b", frontMatter: { id: "xiaoma", name: "小码", summary: "开发" }, body: "底线B" }],
    ]);
    const bindings = new Map([["s1", "xiaobei"], ["s2", "xiaoma"]]);
    const seen = new Map<string, string[]>();
    await Promise.all(["s1", "s2"].map((sessionId) => attachFrozenFacet({
      agent: { id: sessionId, ctx: { systemPrompt: { section: (input) => { seen.set(sessionId, [...(seen.get(sessionId) ?? []), input.text]); return () => undefined; } } } },
      sessionId,
      bindings,
      records,
      cards: new Map(),
      loadView: async (record) => ({ agentId: record.id, saved: { kind: "saved", facetId: null, name: null, summary: null, selectionRevision: 1, pending: false }, applied: null, firstMeetingDone: false }),
    })));
    expect(seen.get("s1")).toEqual(["底线A"]);
    expect(seen.get("s2")).toEqual(["底线B"]);
    const sections: string[] = [];
    await expect(attachFrozenFacet({
      agent: { id: "s4", ctx: { systemPrompt: { section: (input) => { sections.push(input.text); return () => undefined; } } } },
      sessionId: "s1",
      bindings,
      records,
      cards: new Map(),
      maxCharacters: 1,
      loadView: async (record) => ({ agentId: record.id, saved: { kind: "saved", facetId: null, name: null, summary: null, selectionRevision: 1, pending: false }, applied: null, firstMeetingDone: false }),
    })).rejects.toThrow(/超出本次上下文预算/);
    expect(sections).toEqual([]);
    await expect(attachFrozenFacet({
      agent: { id: "s3", ctx: { systemPrompt: { section: () => () => undefined } } },
      sessionId: "s3",
      bindings: new Map([["s3", "missing"]]),
      records,
      cards: new Map(),
      loadView: async () => { throw new Error("不应读取"); },
    })).rejects.toThrow(/没有这份档案/);
  });

  it("registers the listener on agent creation and removes it on dispose", async () => {
    const listeners = new Set<(payload: { agent: { id: string } }) => void>();
    const seen: string[] = [];
    const dispose = registerFrozenFacetListener({
      on: (_name, listener) => {
        listeners.add(listener as (payload: { agent: { id: string } }) => void);
        return () => listeners.delete(listener as (payload: { agent: { id: string } }) => void);
      },
    }, async (agent) => { seen.push(agent.id); });
    listeners.forEach((listener) => listener({ agent: { id: "agent-a" } }));
    await Promise.resolve();
    dispose();
    expect(seen).toEqual(["agent-a"]);
    expect(listeners.size).toBe(0);
  });

  it("hands a rejection to the reporter instead of swallowing it", async () => {
    const listeners = new Set<(payload: { agent: { id: string } }) => void>();
    const reported: string[] = [];
    registerFrozenFacetListener({
      on: (_name, listener) => {
        listeners.add(listener as (payload: { agent: { id: string } }) => void);
        return () => listeners.delete(listener as (payload: { agent: { id: string } }) => void);
      },
    }, async () => { throw new Error("说明书超出本次上下文预算，已拒绝发送"); }, (error, agent) => { reported.push(`${agent.id}: ${(error as Error).message}`); });
    listeners.forEach((listener) => listener({ agent: { id: "agent-a" } }));
    await Promise.resolve();
    await Promise.resolve();
    expect(reported).toEqual(["agent-a: 说明书超出本次上下文预算，已拒绝发送"]);
  });

  it("skips an unbound new agent instead of attaching a default soul", async () => {
    const sections: string[] = [];
    const attached = await freezeCreatedAgent({
      id: "unbound",
      ctx: { systemPrompt: { section: (input) => { sections.push(input.text); return () => undefined; } } },
    }, {});
    expect(attached).toBe(false);
    expect(sections).toEqual([]);
  });
});

describe("prompt budget", () => {
  it("没配就用默认值，配了就以配置为准，模型窗口只能收紧不能放大", () => {
    expect(resolvePromptBudget({})).toEqual({ maxCharacters: 100_000, source: "default" });
    expect(resolvePromptBudget({ maxCharacters: 12 })).toEqual({ maxCharacters: 12, source: "configured" });
    expect(resolvePromptBudget({ contextWindow: 1000 })).toEqual({ maxCharacters: 500, source: "context-window" });
    // 窗口比配置小 → 用窗口；窗口比配置大 → 仍用配置（配置是硬上限）。
    expect(resolvePromptBudget({ maxCharacters: 900, contextWindow: 1000 })).toEqual({ maxCharacters: 500, source: "context-window" });
    expect(resolvePromptBudget({ maxCharacters: 100, contextWindow: 1000 })).toEqual({ maxCharacters: 100, source: "configured" });
    // 窗口不可用（0、负数、NaN）不算数：不猜，回退到默认或配置。
    for (const contextWindow of [0, -1, Number.NaN]) {
      expect(resolvePromptBudget({ contextWindow })).toEqual({ maxCharacters: 100_000, source: "default" });
      expect(resolvePromptBudget({ maxCharacters: 7, contextWindow })).toEqual({ maxCharacters: 7, source: "configured" });
    }
  });

  it("读不到窗口就不猜：只有宿主真给出正数才用它", () => {
    const ctx = { systemPrompt: { section: () => () => undefined } };
    expect(readContextWindow({ id: "a", ctx })).toBeUndefined();
    expect(readContextWindow({ id: "a", ctx, session: {} })).toBeUndefined();
    expect(readContextWindow({ id: "a", ctx, session: { requestContext: () => undefined } })).toBeUndefined();
    expect(readContextWindow({ id: "a", ctx, session: { requestContext: () => ({}) } })).toBeUndefined();
    expect(readContextWindow({ id: "a", ctx, session: { requestContext: () => ({ contextWindow: 0 }) } })).toBeUndefined();
    expect(readContextWindow({ id: "a", ctx, session: { requestContext: () => ({ contextWindow: 8192 }) } })).toBe(8192);
  });

  it("窗口预算不够时拒绝进入模型，拒绝信息写明预算来自窗口，且不登记任何段", async () => {
    const sections: string[] = [];
    await expect(attachFrozenFacet({
      agent: { id: "s1", ctx: { systemPrompt: { section: (input) => { sections.push(input.text); return () => undefined; } } } },
      sessionId: "s1",
      bindings: new Map([["s1", "xiaobei"]]),
      records: new Map([["xiaobei", { id: "xiaobei", directoryName: "小贝", soulPath: "SOUL.md", frontMatter: { id: "xiaobei", name: "小贝", summary: "统筹" }, body: "底".repeat(20) }]]),
      cards: new Map(),
      budget: resolvePromptBudget({ contextWindow: 8 }),
      loadView: async () => ({ agentId: "xiaobei", saved: { kind: "saved", facetId: null, name: null, summary: null, selectionRevision: 1, pending: false }, applied: null, firstMeetingDone: false }),
    })).rejects.toThrow(/预算来自 context-window/);
    expect(sections).toEqual([]);
  });

  it("freezeCreatedAgent 也吃窗口与配置：窗口太小就拒绝，给足预算才登记", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "void-soul-budget-"));
    const dataDir = path.join(home, "void-data", "web");
    const agent = path.join(dataDir, "agents", "小贝");
    await mkdir(path.join(dataDir, "runtime"), { recursive: true });
    await mkdir(agent, { recursive: true });
    await writeFile(path.join(agent, "SOUL.md"), `---\nid: xiaobei\nname: 小贝\nsummary: 统筹\n---\n${"底".repeat(200)}\n`, "utf8");
    await saveSessionBindings(dataDir, new Map([["s1", "xiaobei"]]));
    const env = { DSH_HOME: home, DSH_PROFILE: "web" };
    const sections: string[] = [];
    const target = { id: "s1", ctx: { systemPrompt: { section: (input: { text: string }) => { sections.push(input.text); return () => undefined; } } } };
    // 窗口 8 token → 预算 4 字 → 200 字的 SOUL 放不下，拒绝且不登记。
    await expect(freezeCreatedAgent({ ...target, session: { requestContext: () => ({ contextWindow: 8 }) } }, env)).rejects.toThrow(/预算来自 context-window.*超出/);
    expect(sections).toEqual([]);
    // 配置给足预算 → 正常登记；配置是硬上限，窗口再大也不放大。
    await expect(freezeCreatedAgent(target, env, { maxCharacters: 10_000 })).resolves.toBe(true);
    expect(sections.map((text) => text.trimEnd())).toEqual(["底".repeat(200)]);
    await expect(freezeCreatedAgent(target, env, { maxCharacters: 10 })).rejects.toThrow(/预算来自 configured.*超出/);
    expect(sections.map((text) => text.trimEnd())).toEqual(["底".repeat(200)]);
  });
});

describe("真机档案认领：宿主从不设 DSH_PROFILE", () => {
  it("只有宿主给的档案目录也认得出数据根，段照装且记进交接记录", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "void-soul-anchor-"));
    const profileDir = path.join(home, "profiles", "web");
    const dataDir = path.join(home, "void-data", "web");
    const agent = path.join(dataDir, "agents", "小贝");
    await mkdir(path.join(dataDir, "runtime"), { recursive: true });
    await mkdir(agent, { recursive: true });
    await writeFile(path.join(agent, "SOUL.md"), "---\nid: xiaobei\nname: 小贝\nsummary: 统筹\n---\n只认主人手里的钥匙\n", "utf8");
    await saveSessionBindings(dataDir, new Map([["s1", "xiaobei"]]));

    const sections: FrozenSection[] = [];
    const registered: string[] = [];
    const target = {
      id: "s1",
      ctx: { systemPrompt: { section: (input: { text: string }) => { registered.push(input.text.trimEnd()); return () => undefined; } } },
    };
    // 真机情形：环境里没有 DSH_PROFILE（宿主压根不设），只有 `ctx.baseUrl`。
    await expect(freezeCreatedAgent(target, {}, { baseUrl: pathToFileURL(profileDir).href, sections })).resolves.toBe(true);
    expect(registered).toEqual(["只认主人手里的钥匙"]);
    // 交接记录与登记内容一致：装配补段就靠它（见 prompt-recovery.ts）。
    expect(sections.map((section) => section.name)).toEqual(["void:soul"]);
    expect(sections[0]?.text.trimEnd()).toBe("只认主人手里的钥匙");
  });

  it("认不出档案目录就当没配：绝不猜一个默认档案去读别人的数据", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "void-soul-anchor-"));
    const sections: FrozenSection[] = [];
    const target = { id: "s1", ctx: { systemPrompt: { section: () => () => undefined } } };
    // 宿主 home 本身（不是 `<home>/profiles/<档案名>/`）。
    await expect(freezeCreatedAgent(target, {}, { baseUrl: pathToFileURL(home).href, sections })).resolves.toBe(false);
    // 档案名非法、路径不是绝对路径，同样不算数。
    await expect(freezeCreatedAgent(target, {}, { baseUrl: pathToFileURL(path.join(home, "profiles", "..", "web")).href, sections })).resolves.toBe(false);
    await expect(freezeCreatedAgent(target, {}, { baseUrl: "profiles/web", sections })).resolves.toBe(false);
    // 一条来源都没有：跳过，不报错（没配 ≠ 配错）。
    await expect(freezeCreatedAgent(target, {}, { sections })).resolves.toBe(false);
    expect(sections).toEqual([]);
  });

  it("显式数据根仍然最优先，环境变量压过档案目录", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "void-soul-anchor-"));
    const other = await mkdtemp(path.join(tmpdir(), "void-soul-anchor-"));
    const baseUrl = pathToFileURL(path.join(home, "profiles", "web")).href;
    expect(dataRootOptions({ baseUrl }, {})).toEqual({ baseUrl });
    expect(dataRootOptions({ baseUrl }, { dataDir: path.join(other, "custom") })).toEqual({ dataDir: path.join(other, "custom"), baseUrl });
    expect(tryResolveVoidDataRoot({ env: { DSH_HOME: other, DSH_PROFILE: "soulmem" }, baseUrl })).toBe(path.join(other, "void-data", "soulmem"));
    expect(tryResolveVoidDataRoot({ env: {}, baseUrl })).toBe(path.join(home, "void-data", "web"));
    // 取不到 `ctx.baseUrl`（别的宿主、别的加载方式）就是没配。
    expect(readProfileDirectory({})).toBeUndefined();
    expect(readProfileDirectory(undefined)).toBeUndefined();
    expect(readProfileDirectory({ baseUrl: "" })).toBeUndefined();
  });
});

describe("void-soul registration", () => {
  it("registers the read-only source when the entry is present and removes it on dispose", async () => {
    const ctx = new Context();
    context = ctx;
    await ctx.plugin(Loader);
    const modules = new Map<string, unknown>([
      ["@void/void-entry", VoidEntry],
      ["@void/void-soul/plugin", VoidSoul],
    ]);
    ctx.loader.internal = {
      version: "v2",
      async import(specifier: string) { return modules.get(specifier); },
    } as never;
    await ctx.loader.create({ name: "@void/void-entry" });
    await ctx.loader.create({ id: "void-soul", name: "@void/void-soul/plugin" });
    await ctx.loader.await();
    const suite = ctx.get("voidSuite") as { facetVersions?: unknown };
    expect(suite.facetVersions).toBeTypeOf("object");
    const fiber = [...ctx.registry.values()].flatMap((runtime) => [...runtime.fibers]).find((item) => item.name === "void-soul");
    await fiber?.dispose();
    expect(suite.facetVersions).toBeUndefined();
  });

  it("returns saved and not-yet-applied lines through the entry route", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "void-soul-home-"));
    const agent = path.join(home, "void-data", "web", "agents", "小贝");
    await mkdir(path.join(home, "void-data", "web", "agents", "facets"), { recursive: true });
    await mkdir(agent, { recursive: true });
    await writeFile(path.join(home, "void-data", "web", "agents", "facets", "dev.md"), "---\nid: dev\nname: 开发专家\nsummary: 写代码\n---\n# 开发\n", "utf8");
    await writeFile(path.join(agent, "SOUL.md"), "---\nid: xiaobei\nname: 小贝\nsummary: 统筹\n---\n# 底线\n", "utf8");
    await writeFile(path.join(agent, "state.json"), JSON.stringify({ schemaVersion: 1, activeFacetId: "dev", selectionRevision: 2 }), "utf8");
    const ctx = new Context();
    context = ctx;
    await ctx.plugin(Loader);
    const modules = new Map<string, unknown>([["@void/void-entry", VoidEntry], ["@void/void-soul/plugin", VoidSoul]]);
    ctx.loader.internal = { version: "v2", async import(specifier: string) { return modules.get(specifier); } } as never;
    await ctx.loader.create({ name: "@void/void-entry" });
    await ctx.loader.create({ id: "void-soul", name: "@void/void-soul/plugin" });
    await ctx.loader.await();
    const response = { statusCode: 0, body: "", setHeader() {}, end(body: string) { this.body = body; } };
    const webCtx = { get: (name: string) => name === "profileContext" ? { home, name: "web" } : undefined };
    await (ctx.get("voidSuite") as unknown as { handleFacetVersions(webCtx: Context, res: typeof response): Promise<void> }).handleFacetVersions(webCtx, response);
    expect(JSON.parse(response.body).versions[0]).toMatchObject({ id: "void-soul:facet-version:xiaobei", agentId: "xiaobei", selectionRevision: 2, lines: ["已保存：开发专家（写代码）", "本次生效：还没有请求"] });
  });

  it("记下真装进模型的那一版：请求之后面板不再说「还没有请求」", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "void-soul-home-"));
    const dataDir = path.join(home, "void-data", "web");
    const agentDir = path.join(dataDir, "agents", "小贝");
    await mkdir(path.join(dataDir, "agents", "facets"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(dataDir, "agents", "facets", "dev.md"), "---\nid: dev\nname: 开发专家\nsummary: 写代码\n---\n# 开发\n", "utf8");
    await writeFile(path.join(agentDir, "SOUL.md"), "---\nid: xiaobei\nname: 小贝\nsummary: 统筹\n---\n# 底线\n", "utf8");
    await writeFile(path.join(agentDir, "state.json"), JSON.stringify({ schemaVersion: 1, activeFacetId: "dev", selectionRevision: 2 }), "utf8");
    await saveSessionBindings(dataDir, new Map([["session-a", "xiaobei"]]));
    // 插件读的是 process.env（宿主真实环境），这里临时摆出档案位置。
    const previous = { home: process.env.DSH_HOME, profile: process.env.DSH_PROFILE };
    process.env.DSH_HOME = home;
    process.env.DSH_PROFILE = "web";
    try {
      const ctx = new Context();
      context = ctx;
      await ctx.plugin(Loader);
      const modules = new Map<string, unknown>([["@void/void-entry", VoidEntry], ["@void/void-soul/plugin", VoidSoul]]);
      ctx.loader.internal = { version: "v2", async import(specifier: string) { return modules.get(specifier); } } as never;
      await ctx.loader.create({ name: "@void/void-entry" });
      await ctx.loader.create({ id: "void-soul", name: "@void/void-soul/plugin" });
      await ctx.loader.await();

      // 宿主发 agent/created（它不等监听器），插件在监听器里读盘、冻结、并把这一版记进内存。
      const sections: string[] = [];
      ctx.emit("agent/created", { agent: { id: "session-a", ctx: { systemPrompt: { section: (input: { text: string }) => { sections.push(input.text); return () => undefined; } } } } });
      for (let i = 0; i < 40 && sections.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(sections.join("|")).toContain("# 开发");

      const response = { statusCode: 0, body: "", setHeader() {}, end(body: string) { this.body = body; } };
      const webCtx = { get: (name: string) => name === "profileContext" ? { home, name: "web" } : undefined };
      await (ctx.get("voidSuite") as unknown as { handleFacetVersions(webCtx: Context, res: typeof response): Promise<void> }).handleFacetVersions(webCtx, response);
      expect(JSON.parse(response.body).versions[0]).toMatchObject({
        agentId: "xiaobei",
        selectionRevision: 2,
        lines: ["已保存：开发专家（写代码）", "本次生效：开发专家（写代码）"],
      });
    } finally {
      if (previous.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous.home;
      if (previous.profile === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = previous.profile;
    }
  });

  it("同会话的第二次装配用新正文：改完正文，下一次请求就生效（13.3 第 2 条）", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "void-soul-refresh-"));
    const dataDir = path.join(home, "void-data", "web");
    const agentDir = path.join(dataDir, "agents", "小贝");
    const facetPath = path.join(dataDir, "agents", "facets", "dev.md");
    await mkdir(path.dirname(facetPath), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(facetPath, "---\nid: dev\nname: 开发专家\nsummary: 写代码\n---\n# 开发\n\n旧正文。\n", "utf8");
    await writeFile(path.join(agentDir, "SOUL.md"), "---\nid: xiaobei\nname: 小贝\nsummary: 统筹\n---\n# 底线\n", "utf8");
    await writeFile(path.join(agentDir, "state.json"), JSON.stringify({ schemaVersion: 1, activeFacetId: "dev", selectionRevision: 2 }), "utf8");
    await saveSessionBindings(dataDir, new Map([["s1", "xiaobei"]]));
    const previous = { home: process.env.DSH_HOME, profile: process.env.DSH_PROFILE };
    process.env.DSH_HOME = home;
    process.env.DSH_PROFILE = "web";
    try {
      const { ctx, hooks, listeners } = suiteContext();
      VoidSoul.apply(ctx as never, {});
      const registered: { name: string; text: string }[] = [];
      listeners.forEach((listener) => listener({
        agent: { id: "s1", ctx: { systemPrompt: { section: (input: { name: string; text: string }) => { registered.push({ name: input.name, text: input.text }); return () => undefined; } } } },
      }));
      for (let index = 0; index < 200 && registered.length === 0; index += 1) await new Promise((resolve) => setTimeout(resolve, 1));
      expect(registered.map((section) => section.name)).toEqual(["void:soul", "void:facet"]);

      // 宿主每轮装配都拿 Agent 身上登记的那一份：这里照它的样子拼一份快照交给瀑布。
      const assemble = async () => {
        const hook = [...hooks][0]!;
        const assembly = { sections: [{ name: "deployment:persona-prefix", text: "人设" }] };
        const next = async () => ({ sections: [...assembly.sections, ...registered.map((section) => ({ name: section.name, text: section.text }))] });
        return await hook(assembly, { agent: { id: "s1" } }, next) as { sections: { name: string; text: string }[] };
      };
      const first = await assemble();
      expect(first.sections.find((section) => section.name === "void:facet")?.text).toContain("旧正文");

      // 人在面板上（或编辑器里）改了正文：同会话的下一次装配就得用新的。
      await writeFile(facetPath, "---\nid: dev\nname: 开发专家\nsummary: 写代码\n---\n# 开发\n\n新正文。\n", "utf8");
      const second = await assemble();
      expect(second.sections.find((section) => section.name === "void:facet")?.text).toContain("新正文");
      expect(second.sections.map((section) => section.name)).toEqual(["deployment:persona-prefix", "void:soul", "void:facet"]);
    } finally {
      if (previous.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous.home;
      if (previous.profile === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = previous.profile;
    }
  });
});

describe("void-soul entry policy wiring", () => {
  function fakeContext(options: { withShell?: boolean } = {}) {
    const effects: (() => void)[] = [];
    const registered: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[] = [];
    const registry = {
      register(tool: unknown) { registered.push(tool as (typeof registered)[number]); return () => undefined; },
    };
    const shell = { async run() { return "ran"; }, start() { return "started"; } };
    const scope = {
      get: (name: string) => name === "tools" ? registry : options.withShell === true && name === "shell" ? shell : undefined,
      effect: (fn: () => void) => { effects.push(fn); },
    };
    const logger = () => ({ error: () => undefined, info: () => undefined, warn: () => undefined, debug: () => undefined });
    return { ctx: { logger, on: () => () => undefined, inject: (_names: string[], callback: (s: unknown) => void) => { callback(scope); } }, registry, registered, effects, shell };
  }

  it("leaves the tool registry alone unless the entry policy is switched on", async () => {
    const { ctx, registry, registered, effects } = fakeContext();
    VoidSoul.apply(ctx as never, {});
    let reached = false;
    registry.register({ name: "write", execute: async () => { reached = true; return "done"; } });
    // 默认不装门禁：注册原样透传，写工具照常执行，也没有留下任何 effect。
    await expect(registered[0]!.execute({}, {})).resolves.toBe("done");
    expect(reached).toBe(true);
    expect(effects).toEqual([]);
  });

  it("rejects a write tool through the registry once switched on, and restores on dispose", async () => {
    const { ctx, registry, registered, effects } = fakeContext();
    VoidSoul.apply(ctx as never, { entryPolicy: { enabled: true, isolation: { readIsolated: false, writeIsolated: true } } });
    let reached = false;
    registry.register({ name: "write", execute: async () => { reached = true; return "done"; } });
    expect(registered).toHaveLength(1);
    // 工具照常注册（模型看得见），但一调用就拒绝，且原实现不会被碰到。
    await expect(registered[0]!.execute({}, {})).rejects.toThrow(/工具 write 属于写入入口，需要读隔离执行环境，本机没有，已拒绝/);
    expect(reached).toBe(false);
    // 只读工具照常可用。
    registry.register({ name: "read", execute: async () => "ok" });
    await expect(registered[1]!.execute({}, {})).resolves.toBe("ok");
    expect(effects).toHaveLength(1);
    effects.forEach((fn) => fn());
  });

  it("still refuses a host-private tool even with the explicit switch on", async () => {
    const { ctx, registry, registered } = fakeContext();
    VoidSoul.apply(ctx as never, {
      entryPolicy: { enabled: true, allowUnisolated: true, isolation: { readIsolated: true, writeIsolated: true } },
    });
    registry.register({ name: "session_search", execute: async () => "leak" });
    await expect(registered[0]!.execute({}, {})).rejects.toThrow(/会读到 Host 私人数据/);
  });

  it("把 entryPolicy 的隔离声明同时交给 shell 门禁：工具入口与底层 shell 不分叉", async () => {
    const { ctx, registry, registered, shell } = fakeContext({ withShell: true });
    VoidSoul.apply(ctx as never, { entryPolicy: { enabled: true, isolation: { readIsolated: true, writeIsolated: true } } });
    registry.register({ name: "pwsh", execute: async () => "done" });
    await expect(registered[0]!.execute({}, {})).resolves.toBe("done");
    await expect(shell.run({ command: "pwd" })).resolves.toBe("ran");
  });

  it("allowUnisolated 同样同时放行工具入口与底层 shell", async () => {
    const { ctx, registry, registered, shell } = fakeContext({ withShell: true });
    VoidSoul.apply(ctx as never, { entryPolicy: { enabled: true, allowUnisolated: true } });
    registry.register({ name: "write", execute: async () => "done" });
    await expect(registered[0]!.execute({}, {})).resolves.toBe("done");
    await expect(shell.run({ command: "pwd" })).resolves.toBe("ran");
  });

  it("门禁没打开时只装 shell 门禁，底层 shell 照旧拒绝原始命令", async () => {
    const { ctx, shell, effects } = fakeContext({ withShell: true });
    VoidSoul.apply(ctx as never, {});
    await expect(shell.run({ command: "pwd" })).rejects.toThrow(/缺少读隔离/);
    // 只装 shell 门禁，不装工具入口门禁——和改动前一样。
    expect(effects).toHaveLength(1);
  });

  it("声明了隔离但门禁没打开时也不放行底层 shell（缺省最保守）", async () => {
    const { ctx, shell } = fakeContext({ withShell: true });
    VoidSoul.apply(ctx as never, { entryPolicy: { isolation: { readIsolated: true, writeIsolated: true } } });
    await expect(shell.run({ command: "pwd" })).rejects.toThrow(/缺少读隔离/);
  });
});

describe("prompt variables", () => {
  const records = new Map([["xiaobei", { id: "xiaobei", directoryName: "小贝", soulPath: "SOUL.md", frontMatter: { id: "xiaobei", name: "小贝", summary: "统筹" }, body: "你在 {{model}} 上跑，目录 {{cwd}}" }]]);
  const loadView = async () => ({ agentId: "xiaobei", saved: { kind: "saved" as const, facetId: null, name: null, summary: null, selectionRevision: 1, pending: false }, applied: null, firstMeetingDone: false });

  it("按宿主的口径读三个变量：provider/model 来自 AgentOptions，cwd 来自会话头", () => {
    expect(VoidSoul.readPromptValues({ id: "a", ctx: {} as never, options: { provider: "deepseek", model: "deepseek-chat" }, session: { header: { cwd: "E:\\proj" } } }))
      .toEqual({ provider: "deepseek", model: "deepseek-chat", cwd: "E:\\proj" });
    // 宿主那边取不到就抛错，这里也不编默认值。
    expect(VoidSoul.readPromptValues({ id: "a", ctx: {} as never })).toEqual({ provider: undefined, model: undefined, cwd: undefined });
    expect(VoidSoul.readPromptValues({ id: "a", ctx: {} as never, options: {}, session: {} })).toEqual({ provider: undefined, model: undefined, cwd: undefined });
  });

  it("变量取不到值时拒绝装进模型，并说清宿主会怎么炸", async () => {
    const sections: string[] = [];
    const agent = { id: "s1", ctx: { systemPrompt: { section: (input: { text: string }) => { sections.push(input.text); return () => undefined; } } }, options: { provider: "deepseek" } };
    await expect(attachFrozenFacet({ agent, sessionId: "s1", bindings: new Map([["s1", "xiaobei"]]), records, cards: new Map(), loadView }))
      .rejects.toThrow(/说明书变量 \{\{model\}\} 在当前 Agent 上没有值/);
    expect(sections).toEqual([]);
  });

  it("值齐全时照常登记，变量原样交给宿主插值", async () => {
    const sections: string[] = [];
    const agent = { id: "s1", ctx: { systemPrompt: { section: (input: { text: string }) => { sections.push(input.text); return () => undefined; } } }, options: { provider: "deepseek", model: "deepseek-chat" }, session: { header: { cwd: "E:\\proj" } } };
    await attachFrozenFacet({ agent, sessionId: "s1", bindings: new Map([["s1", "xiaobei"]]), records, cards: new Map(), loadView });
    // 本插件不自己替换：宿主 dsh-system-prompt 在组装时做一次性严格插值。
    expect(sections).toEqual(["你在 {{model}} 上跑，目录 {{cwd}}"]);
  });
});

describe("首次见面引导", () => {
  const records = new Map([["xiaobei", { id: "xiaobei", directoryName: "小贝", soulPath: "SOUL.md", frontMatter: { id: "xiaobei", name: "小贝", summary: "统筹", firstMeeting: "先自我介绍，再问主人怎么称呼。" }, body: "底线" }]]);
  const view = (firstMeetingDone: boolean) => async () => ({
    agentId: "xiaobei",
    saved: { kind: "saved" as const, facetId: null, name: null, summary: null, selectionRevision: 0, pending: false },
    applied: null,
    firstMeetingDone,
  });
  const target = (sections: string[]) => ({ id: "s1", ctx: { systemPrompt: { section: (input: { text: string }) => { sections.push(input.text); return () => undefined; } } } });

  it("还没引导过就跟着说明书一起装进模型，顺序排在灵魂与模组之后", async () => {
    const sections: string[] = [];
    await attachFrozenFacet({ agent: target(sections), sessionId: "s1", bindings: new Map([["s1", "xiaobei"]]), records, cards: new Map(), loadView: view(false) });
    expect(sections).toEqual(["底线", "先自我介绍，再问主人怎么称呼。"]);
  });

  it("标过完成就不再装；档案没写引导时也不装", async () => {
    const done: string[] = [];
    await attachFrozenFacet({ agent: target(done), sessionId: "s1", bindings: new Map([["s1", "xiaobei"]]), records, cards: new Map(), loadView: view(true) });
    expect(done).toEqual(["底线"]);
    const bare: string[] = [];
    const withoutGuide = new Map([["xiaobei", { id: "xiaobei", directoryName: "小贝", soulPath: "SOUL.md", frontMatter: { id: "xiaobei", name: "小贝", summary: "统筹" }, body: "底线" }]]);
    await attachFrozenFacet({ agent: target(bare), sessionId: "s1", bindings: new Map([["s1", "xiaobei"]]), records: withoutGuide, cards: new Map(), loadView: view(false) });
    expect(bare).toEqual(["底线"]);
  });

  it("引导撑爆预算时整份拒绝，不装一半，并在拒绝信息里点名首次见面", async () => {
    const sections: string[] = [];
    await expect(
      attachFrozenFacet({ agent: target(sections), sessionId: "s1", bindings: new Map([["s1", "xiaobei"]]), records, cards: new Map(), loadView: view(false), maxCharacters: 4 }),
    ).rejects.toThrow(/\+ 首次见面 15 字/);
    expect(sections).toEqual([]);
  });
});

describe("灵魂拒绝的通知面", () => {
  /** 假入口：`effect` 按宿主语义立即执行并收下返回的撤销函数。 */
  it("入口在时把来源登记上去，卸载时撤掉；没有拒绝时如实说明", async () => {
    const { ctx, suite, disposers } = suiteContext();
    VoidSoul.apply(ctx as never, {});
    expect(suite.sources).toHaveLength(1);
    expect(suite.sources[0]?.id).toBe("void-soul:refusals");
    const listed = await suite.sources[0]!.list();
    expect(listed.items).toEqual([]);
    expect(listed.note).toMatch(/还没有拒绝过/);
    disposers.forEach((dispose) => dispose());
    expect(suite.sources).toHaveLength(0);
  });

  it("装不进模型时留下一条危险通知：查得到档案名，原因就是拒绝原文", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "void-soul-refusal-"));
    const dataDir = path.join(home, "void-data", "web");
    await mkdir(path.join(dataDir, "runtime"), { recursive: true });
    await mkdir(path.join(dataDir, "agents", "小贝"), { recursive: true });
    await writeFile(path.join(dataDir, "agents", "小贝", "SOUL.md"), `---\nid: xiaobei\nname: 小贝\nsummary: 统筹\n---\n${"底".repeat(200)}\n`, "utf8");
    await saveSessionBindings(dataDir, new Map([["s1", "xiaobei"]]));
    const previous = { home: process.env.DSH_HOME, profile: process.env.DSH_PROFILE };
    process.env.DSH_HOME = home;
    process.env.DSH_PROFILE = "web";
    try {
      const { ctx, suite, listeners, logged } = suiteContext();
      // 预算 10 字，SOUL 200 字 → 一定拒绝。
      VoidSoul.apply(ctx as never, { prompt: { maxCharacters: 10 } });
      listeners.forEach((listener) => listener({ agent: { id: "s1", ctx: { systemPrompt: { section: () => () => undefined } } } }));
      let items: Array<Record<string, unknown>> = [];
      for (let index = 0; index < 200 && items.length === 0; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        items = (await suite.sources[0]!.list()).items;
      }
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id: "s1#1",
        title: "档案 xiaobei 的说明书没装进模型",
        level: "danger",
        meta: { 会话: "s1", 档案: "xiaobei" },
        read: false,
      });
      expect(String(items[0]?.summary)).toMatch(/超出本次上下文预算.*预算来自 configured/s);
      // 同一件事也进宿主日志（留档），两处都写。
      expect(logged.join("\n")).toMatch(/拒绝把说明书装进模型（会话 s1）/);
    } finally {
      if (previous.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous.home;
      if (previous.profile === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = previous.profile;
    }
  });

  it("会话没绑定档案时不报通知：那不是拒绝，是本来就不该装", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "void-soul-unbound-"));
    await mkdir(path.join(home, "void-data", "web", "runtime"), { recursive: true });
    await saveSessionBindings(path.join(home, "void-data", "web"), new Map([["other", "xiaobei"]]));
    const previous = { home: process.env.DSH_HOME, profile: process.env.DSH_PROFILE };
    process.env.DSH_HOME = home;
    process.env.DSH_PROFILE = "web";
    try {
      const { ctx, suite, listeners, logged } = suiteContext();
      VoidSoul.apply(ctx as never, {});
      listeners.forEach((listener) => listener({ agent: { id: "s1", ctx: { systemPrompt: { section: () => () => undefined } } } }));
      for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setTimeout(resolve, 1));
      expect((await suite.sources[0]!.list()).items).toEqual([]);
      expect(logged).toEqual([]);
    } finally {
      if (previous.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous.home;
      if (previous.profile === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = previous.profile;
    }
  });

  it("首次挂载失败之后留着再试：文件修好，同一个会话的下一轮装配就把段补上", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "void-soul-retry-"));
    const dataDir = path.join(home, "void-data", "web");
    const agentDir = path.join(dataDir, "agents", "小贝");
    const soulPath = path.join(agentDir, "SOUL.md");
    await mkdir(path.join(dataDir, "runtime"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    // 坏字节：Node 的 readFile("utf8") 不报错，只有我们自己的解码器拦得下（A5 真机那条）。
    await writeFile(
      soulPath,
      Buffer.concat([
        Buffer.from("---\nid: xiaobei\nname: 小贝\nsummary: 统筹\n---\n", "utf8"),
        Buffer.from([0xff, 0xfe]),
        Buffer.from("\n", "utf8"),
      ]),
    );
    await saveSessionBindings(dataDir, new Map([["s1", "xiaobei"]]));
    const previous = { home: process.env.DSH_HOME, profile: process.env.DSH_PROFILE };
    process.env.DSH_HOME = home;
    process.env.DSH_PROFILE = "web";
    try {
      const { ctx, suite, hooks, listeners, logged } = suiteContext();
      VoidSoul.apply(ctx as never, {});
      const registered: string[] = [];
      const target = {
        agent: {
          id: "s1",
          ctx: { systemPrompt: { section: (input: { text: string }) => { registered.push(input.text); return () => undefined; } } },
        },
      };
      listeners.forEach((listener) => listener(target));
      const items = async (): Promise<Array<Record<string, unknown>>> => {
        for (let index = 0; index < 200; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          const list = (await suite.sources[0]!.list()).items;
          if (list.length > 0) return list;
        }
        return (await suite.sources[0]!.list()).items;
      };
      expect(await items()).toHaveLength(1);
      expect(String((await items())[0]?.summary)).toMatch(/不是有效的 UTF-8 文本/);

      // 宿主的装配瀑布：把快照送进去，看补出来的段。
      const assemble = async (): Promise<Array<{ name: string; text: string }>> => {
        let out: { sections: Array<{ name: string; text: string }> } = {
          sections: [{ name: "deployment:persona-prefix", text: "宿主的人设" }],
        };
        for (const hook of hooks) {
          out = (await hook(out, { agent: { id: "s1" } }, () => Promise.resolve(out))) as typeof out;
        }
        return out.sections;
      };
      // 还没修：灵魂段补不出来，同一条原因也不再重复报（第一次那条已经报过了）。
      expect((await assemble()).map((section) => section.name)).toEqual(["deployment:persona-prefix"]);
      expect((await suite.sources[0]!.list()).items).toHaveLength(1);

      // 人把文件另存成 UTF-8：同一个会话的下一轮装配当场补上，不必换会话或重启宿主。
      await writeFile(soulPath, "---\nid: xiaobei\nname: 小贝\nsummary: 统筹\n---\n只认主人手里的钥匙\n", "utf8");
      const healed = await assemble();
      expect(healed.map((section) => section.name)).toEqual(["deployment:persona-prefix", "void:soul"]);
      expect(healed[1]?.text).toContain("只认主人手里的钥匙");
      expect(registered.join("\n")).toContain("只认主人手里的钥匙");
      expect(logged.join("\n")).toMatch(/拒绝把说明书装进模型（会话 s1）/);
    } finally {
      if (previous.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous.home;
      if (previous.profile === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = previous.profile;
    }
  });
});

describe("停用/启用（2026-09-23：进模型被拒，但一个字节都不删）", () => {
  const SOUL_TEXT = "只认主人手里的钥匙";

  /** 一个真实数据根：绑定到 s1 的档案 + 它自己的 state.json（停用位就住在那里）。 */
  async function realRoot(state: Record<string, unknown> = {}): Promise<{ home: string; statePath: string }> {
    const home = await mkdtemp(path.join(tmpdir(), "void-soul-suspended-"));
    const dataDir = path.join(home, "void-data", "web");
    const agentDir = path.join(dataDir, "agents", "小贝");
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "SOUL.md"), `---\nid: xiaobei\nname: 小贝\nsummary: 统筹\n---\n${SOUL_TEXT}\n`, "utf8");
    await writeFile(path.join(agentDir, "state.json"), JSON.stringify(facetState(state)), "utf8");
    await saveSessionBindings(dataDir, new Map([["s1", "xiaobei"]]));
    return { home, statePath: path.join(agentDir, "state.json") };
  }

  function facetState(state: Record<string, unknown>): Record<string, unknown> {
    return { schemaVersion: 1, activeFacetId: null, selectionRevision: 0, firstMeetingDone: false, suspended: false, ...state };
  }

  /** 宿主的装配瀑布：照它每轮拿 Agent 身上登记的那一份快照拼一份出来。 */
  function assembleHook(hooks: Set<(assembly: unknown, context: unknown, next: () => Promise<unknown>) => Promise<unknown>>) {
    return async (): Promise<string[]> => {
      let out: { sections: Array<{ name: string; text: string }> } = { sections: [{ name: "deployment:persona-prefix", text: "宿主的人设" }] };
      for (const hook of hooks) out = (await hook(out, { agent: { id: "s1" } }, () => Promise.resolve(out))) as typeof out;
      return out.sections.map((section) => section.name);
    };
  }

  it("装进去之后才停用：下一轮装配就把灵魂段摘掉，不沿用上一份；启用回来当场自愈", async () => {
    const { home, statePath } = await realRoot();
    const previous = { home: process.env.DSH_HOME, profile: process.env.DSH_PROFILE };
    process.env.DSH_HOME = home;
    process.env.DSH_PROFILE = "web";
    try {
      const { ctx, suite, hooks, listeners } = suiteContext();
      VoidSoul.apply(ctx as never, {});
      const registered: { name: string; text: string }[] = [];
      listeners.forEach((listener) => listener({
        agent: { id: "s1", ctx: { systemPrompt: { section: (input: { name: string; text: string }) => { registered.push(input); return () => undefined; } } } },
      }));
      for (let index = 0; index < 200 && registered.length === 0; index += 1) await new Promise((resolve) => setTimeout(resolve, 1));
      expect(registered.map((section) => section.name)).toEqual(["void:soul"]);
      const assemble = assembleHook(hooks);
      const refusals = async (): Promise<Array<Record<string, unknown>>> => (await suite.sources[0]!.list()).items;

      expect(await assemble()).toEqual(["deployment:persona-prefix", "void:soul"]);

      // 人在面板上按了停用：这一轮装配就得摘掉，而不是沿用上一次装进去的段。
      await writeFile(statePath, JSON.stringify(facetState({ suspended: true })), "utf8");
      expect(await assemble()).toEqual(["deployment:persona-prefix"]);
      // 连着两轮：同一条原因只报一次，别把通知栏刷满。
      expect(await assemble()).toEqual(["deployment:persona-prefix"]);
      const items = await refusals();
      expect(items).toHaveLength(1);
      expect(String(items[0]?.title)).toContain("xiaobei");
      expect(String(items[0]?.summary)).toMatch(/档案已停用，拒绝进入模型: xiaobei/);
      expect(String(items[0]?.summary)).toContain("在面板上「启用这份档案」就恢复");

      // 再按启用：同一个会话的下一轮装配就把段装回来，正文一个字节没改。
      await writeFile(statePath, JSON.stringify(facetState({ suspended: false })), "utf8");
      expect(await assemble()).toEqual(["deployment:persona-prefix", "void:soul"]);
      expect(registered.at(-1)?.text).toContain(SOUL_TEXT);
    } finally {
      if (previous.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous.home;
      if (previous.profile === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = previous.profile;
    }
  });

  it("停着的时候开会话：首次冻结就拒绝，段一个都不装，拒绝进通知栏；启用后下一轮补上", async () => {
    const { home, statePath } = await realRoot({ suspended: true });
    const previous = { home: process.env.DSH_HOME, profile: process.env.DSH_PROFILE };
    process.env.DSH_HOME = home;
    process.env.DSH_PROFILE = "web";
    try {
      const { ctx, suite, hooks, listeners, logged } = suiteContext();
      VoidSoul.apply(ctx as never, {});
      const registered: string[] = [];
      listeners.forEach((listener) => listener({
        agent: { id: "s1", ctx: { systemPrompt: { section: (input: { text: string }) => { registered.push(input.text); return () => undefined; } } } },
      }));
      const items = async (): Promise<Array<Record<string, unknown>>> => {
        for (let index = 0; index < 200; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          const list = (await suite.sources[0]!.list()).items;
          if (list.length > 0) return list;
        }
        return (await suite.sources[0]!.list()).items;
      };
      expect(registered).toEqual([]);
      expect(String((await items())[0]?.summary)).toMatch(/档案已停用，拒绝进入模型: xiaobei/);
      expect(logged.join("\n")).toMatch(/拒绝把说明书装进模型（会话 s1）/);

      const assemble = assembleHook(hooks);
      expect(await assemble()).toEqual(["deployment:persona-prefix"]);

      // 人启用之后，同一个会话不必换、宿主也不必重启。
      await writeFile(statePath, JSON.stringify(facetState({ suspended: false })), "utf8");
      const healed = await assemble();
      expect(healed).toEqual(["deployment:persona-prefix", "void:soul"]);
      expect(registered.join("\n")).toContain(SOUL_TEXT);
    } finally {
      if (previous.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous.home;
      if (previous.profile === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = previous.profile;
    }
  });
});
