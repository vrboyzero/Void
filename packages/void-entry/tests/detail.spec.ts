import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import * as VoidEntry from "../src/index.js";
import {
  VOID_REQUEST_HEADER,
  assertSameOrigin,
  assertTrustedMutation,
  requestHeader,
} from "../src/detail.js";
import type { VoidDetailBody, VoidDetailSource, VoidSuite } from "../src/index.js";

/** 一个只在被 load 后才 provide webServer 的假宿主插件（与 void-entry.spec.ts 同一做法）。 */
const FakeWebServer = {
  name: "fake-web-server",
  provide: ["webServer"],
  apply(ctx: Context) {
    const routes = new Map<string, (req: unknown, res: unknown) => void | Promise<void>>();
    ctx.provide("webServer", {
      register(route: { path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }) {
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
      routes,
    } as never);
  },
};

const PROFILE = { home: "E:/isolated", name: "web" };
let context: Context | undefined;

beforeEach(() => {
  // 位置解析必须走 profileContext，不能让跑测试的机器上的 DSH_* 环境变量漏进来。
  delete process.env.DSH_HOME;
  delete process.env.DSH_PROFILE;
});

afterEach(async () => {
  await context?.fiber.dispose();
  context = undefined;
});

async function boot(): Promise<Context> {
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
  await ctx.loader.create({ name: "fake-web-server" });
  await ctx.loader.await();
  return ctx;
}

function suiteOf(ctx: Context): VoidSuite {
  const suite = ctx.get("voidSuite") as VoidSuite;
  expect(suite).toBeDefined();
  return suite;
}

function routeOf(ctx: Context): (req: unknown, res: unknown) => Promise<void> {
  const webServer = ctx.get("webServer") as unknown as {
    routes: Map<string, (req: unknown, res: unknown) => void | Promise<void>>;
  };
  const handler = webServer.routes.get("/void/api/detail");
  expect(handler).toBeDefined();
  // 路由注册用的是 `void this.handleDetail(...)`（fire-and-forget），handler 立刻返回、
  // 处理还在微任务里跑。所以调用方必须等事件循环转几圈，才能看到响应真的写上去。
  return async (req, res) => {
    await handler!(req, res);
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
}

function fakeRequest(input: {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[]>;
  body?: unknown;
} = {}): unknown {
  const text = input.body === undefined ? "" : JSON.stringify(input.body);
  return {
    method: input.method ?? "GET",
    url: input.url ?? "/void/api/detail",
    headers: input.headers ?? {},
    async *[Symbol.asyncIterator]() {
      if (text !== "") yield Buffer.from(text);
    },
  };
}

interface FakeResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

function fakeResponse(): FakeResponse {
  return {
    statusCode: 0,
    body: "",
    headers: {},
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    end(body?: string) {
      this.body = body ?? "";
    },
  };
}

function json(response: FakeResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

const SAME_ORIGIN = { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" };
const TRUSTED = { ...SAME_ORIGIN, [VOID_REQUEST_HEADER]: "1", "content-type": "application/json; charset=utf-8" };

const BODY: VoidDetailBody = { title: "示例", sections: [{ id: "s", title: "段", lines: ["一行"] }] };

function fakeSource(overrides: Partial<VoidDetailSource> = {}): VoidDetailSource & { calls: unknown[] } {
  const calls: unknown[] = [];
  const source: VoidDetailSource = {
    id: "fake:view",
    title: "假视图",
    async list() {
      return [{ id: "a", title: "甲" }];
    },
    async detail(input) {
      calls.push({ kind: "detail", input });
      return BODY;
    },
    ...overrides,
  };
  return Object.assign(source, { calls });
}

describe("void-entry request guards", () => {
  it("lets a request with no Origin through (curl and non-browser clients)", () => {
    expect(() => assertSameOrigin({ headers: { host: "127.0.0.1:3080" } })).not.toThrow();
  });

  it("accepts the browser's own origin", () => {
    expect(() => assertSameOrigin({ headers: SAME_ORIGIN })).not.toThrow();
  });

  it("rejects a cross-site origin with both values named", () => {
    expect(() => assertSameOrigin({ headers: { host: "127.0.0.1:3080", origin: "http://evil.test" } })).toThrow(
      "跨站请求被拒绝：Origin evil.test 与 Host 127.0.0.1:3080 不一致",
    );
  });

  it("refuses to guess when Origin is present but Host is missing", () => {
    expect(() => assertSameOrigin({ headers: { origin: "http://127.0.0.1:3080" } })).toThrow("请求缺少 Host，无法核对同源");
  });

  it("reports an unparsable Origin instead of treating it as same-site", () => {
    expect(() => assertSameOrigin({ headers: { host: "h", origin: "not a url" } })).toThrow("Origin 不是合法地址: not a url");
  });

  it("reads a repeated header as its first value", () => {
    expect(requestHeader({ headers: { origin: ["http://a", "http://b"] } }, "origin")).toBe("http://a");
    expect(requestHeader({ headers: {} }, "origin")).toBeUndefined();
  });

  it("requires the custom header and a JSON content type for mutations", () => {
    expect(() => assertTrustedMutation({ headers: SAME_ORIGIN })).toThrow("缺少同源标记（x-void-request），拒绝改动");
    expect(() => assertTrustedMutation({ headers: { ...SAME_ORIGIN, [VOID_REQUEST_HEADER]: "1", "content-type": "text/plain" } })).toThrow(
      "改动请求必须是 application/json：收到 text/plain",
    );
    expect(() => assertTrustedMutation({ headers: { ...SAME_ORIGIN, [VOID_REQUEST_HEADER]: "1" } })).toThrow(
      "改动请求必须是 application/json：收到 空",
    );
    expect(() => assertTrustedMutation({ headers: TRUSTED })).not.toThrow();
  });
});

describe("void-entry business detail route", () => {
  it("lists the registered views", async () => {
    const ctx = await boot();
    const suite = suiteOf(ctx);
    suite.registerDetail(fakeSource());
    expect(suite.detailViewIds()).toEqual(["fake:view"]);
  });

  it("refuses a duplicate view id instead of silently replacing it", async () => {
    const ctx = await boot();
    const suite = suiteOf(ctx);
    suite.registerDetail(fakeSource());
    expect(() => suite.registerDetail(fakeSource())).toThrow("业务视图 id 重复: fake:view");
  });

  it("unregisters the view when the registering plugin goes away", async () => {
    const ctx = await boot();
    const suite = suiteOf(ctx);
    const disposer = suite.registerDetail(fakeSource());
    expect(suite.detailViewIds()).toEqual(["fake:view"]);
    disposer();
    expect(suite.detailViewIds()).toEqual([]);
  });

  it("serves the list and one item over GET", async () => {
    const ctx = await boot();
    ctx.provide("profileContext", PROFILE as never);
    const source = fakeSource();
    suiteOf(ctx).registerDetail(source);
    const handler = routeOf(ctx);

    const listResponse = fakeResponse();
    await handler(fakeRequest({ url: "/void/api/detail?view=fake:view" }), listResponse);
    expect(listResponse.statusCode).toBe(200);
    expect(json(listResponse)).toEqual({ view: "fake:view", title: "假视图", items: [{ id: "a", title: "甲" }] });

    const detailResponse = fakeResponse();
    await handler(fakeRequest({ url: "/void/api/detail?view=fake:view&itemId=a" }), detailResponse);
    expect(detailResponse.statusCode).toBe(200);
    expect(json(detailResponse)).toEqual({ view: "fake:view", title: "假视图", detail: BODY });
    expect(source.calls).toEqual([{ kind: "detail", input: { ...PROFILE, itemId: "a" } }]);
  });

  it("hands a search term to the view and echoes the view's own list note", async () => {
    const ctx = await boot();
    ctx.provide("profileContext", PROFILE as never);
    const seen: unknown[] = [];
    suiteOf(ctx).registerDetail(
      fakeSource({
        search: { label: "检索记忆", hint: "只查索引，不全量扫描" },
        async list(input) {
          seen.push(input);
          return { items: [{ id: "a", title: "甲" }], note: "每个档案最多列出最近 20 条，更早的用检索找" };
        },
      }),
    );
    const handler = routeOf(ctx);

    const response = fakeResponse();
    await handler(fakeRequest({ url: "/void/api/detail?view=fake:view&q=%E5%B0%8F%E8%B4%9D" }), response);
    expect(response.statusCode).toBe(200);
    expect(json(response)).toEqual({
      view: "fake:view",
      title: "假视图",
      items: [{ id: "a", title: "甲" }],
      query: "小贝",
      note: "每个档案最多列出最近 20 条，更早的用检索找",
      search: { label: "检索记忆", hint: "只查索引，不全量扫描" },
    });
    expect(seen).toEqual([{ ...PROFILE, query: "小贝" }]);
  });

  it("leaves the search box and the list note out for a view that just returns an array", async () => {
    const ctx = await boot();
    ctx.provide("profileContext", PROFILE as never);
    const seen: unknown[] = [];
    suiteOf(ctx).registerDetail(
      fakeSource({
        async list(input) {
          seen.push(input);
          return [{ id: "a", title: "甲" }];
        },
      }),
    );
    const handler = routeOf(ctx);

    const response = fakeResponse();
    await handler(fakeRequest({ url: "/void/api/detail?view=fake:view" }), response);
    expect(json(response)).toEqual({ view: "fake:view", title: "假视图", items: [{ id: "a", title: "甲" }] });
    // 没检索时不给 `query`：给了空串，视图就分不清「没检索」和「检索了一个空词」。
    expect(seen).toEqual([{ ...PROFILE }]);
  });

  it("names the missing parameter instead of returning an empty list", async () => {
    const ctx = await boot();
    ctx.provide("profileContext", PROFILE as never);
    suiteOf(ctx).registerDetail(fakeSource());
    const handler = routeOf(ctx);

    const noView = fakeResponse();
    await handler(fakeRequest({ url: "/void/api/detail" }), noView);
    expect(noView.statusCode).toBe(400);
    expect(json(noView).error).toBe("缺少业务视图 id（?view=）");

    const unknown = fakeResponse();
    await handler(fakeRequest({ url: "/void/api/detail?view=nope" }), unknown);
    expect(unknown.statusCode).toBe(404);
    expect(json(unknown).error).toBe("没有这个业务视图: nope");
  });

  it("reports an unresolvable profile as an error rather than an empty list", async () => {
    const ctx = await boot();
    suiteOf(ctx).registerDetail(fakeSource());
    const response = fakeResponse();
    await routeOf(ctx)(fakeRequest({ url: "/void/api/detail?view=fake:view" }), response);
    expect(response.statusCode).toBe(404);
    expect(json(response).error).toBe("无法确定档案位置：需要 profileContext、宿主给的档案目录（ctx.baseUrl），或 DSH_HOME + DSH_PROFILE");
  });

  it("rejects a cross-site read and a mutation without the same-origin marker", async () => {
    const ctx = await boot();
    ctx.provide("profileContext", PROFILE as never);
    suiteOf(ctx).registerDetail(fakeSource({ async save() { return BODY; } }));
    const handler = routeOf(ctx);

    const crossSite = fakeResponse();
    await handler(fakeRequest({ url: "/void/api/detail?view=fake:view", headers: { host: "127.0.0.1:3080", origin: "http://evil.test" } }), crossSite);
    expect(crossSite.statusCode).toBe(403);
    expect(json(crossSite).error).toContain("跨站请求被拒绝");

    const noMarker = fakeResponse();
    await handler(
      fakeRequest({ method: "POST", headers: { ...SAME_ORIGIN, "content-type": "application/json" }, body: { view: "fake:view", itemId: "a", expectedRevision: 1, changes: { x: 1 } } }),
      noMarker,
    );
    expect(noMarker.statusCode).toBe(403);
    expect(json(noMarker).error).toBe("缺少同源标记（x-void-request），拒绝改动");
  });

  it("saves through POST and hands the source the parsed changes", async () => {
    const ctx = await boot();
    ctx.provide("profileContext", PROFILE as never);
    const saved: unknown[] = [];
    const source = fakeSource({
      async save(input) {
        saved.push(input);
        return { ...BODY, revision: 4 };
      },
    });
    suiteOf(ctx).registerDetail(source);
    const response = fakeResponse();
    await routeOf(ctx)(
      fakeRequest({ method: "POST", headers: TRUSTED, body: { view: "fake:view", itemId: "a", expectedRevision: 3, changes: { memberLimit: 5 } } }),
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(json(response)).toEqual({ ok: true, view: "fake:view", detail: { ...BODY, revision: 4 } });
    expect(saved).toEqual([{ ...PROFILE, itemId: "a", expectedRevision: 3, changes: { memberLimit: 5 } }]);
  });

  it("keeps validation failures and source conflicts distinguishable from success", async () => {
    const ctx = await boot();
    ctx.provide("profileContext", PROFILE as never);
    const source = fakeSource({
      async save() {
        throw new Error("队伍配置已被其他保存更新（期望修订 1，实际 2），请重读后再改");
      },
    });
    suiteOf(ctx).registerDetail(source);
    const handler = routeOf(ctx);

    const conflict = fakeResponse();
    await handler(fakeRequest({ method: "POST", headers: TRUSTED, body: { view: "fake:view", itemId: "a", expectedRevision: 1, changes: {} } }), conflict);
    // 409：面板对「冲突」与「校验失败」是同一套处理——保留草稿、显示原因。
    expect(conflict.statusCode).toBe(409);
    expect(json(conflict).error).toBe("队伍配置已被其他保存更新（期望修订 1，实际 2），请重读后再改");

    const noRevision = fakeResponse();
    await handler(fakeRequest({ method: "POST", headers: TRUSTED, body: { view: "fake:view", itemId: "a", changes: {} } }), noRevision);
    expect(noRevision.statusCode).toBe(400);
    expect(json(noRevision).error).toBe("expectedRevision 必须是整数或非空字符串");

    const badChanges = fakeResponse();
    await handler(fakeRequest({ method: "POST", headers: TRUSTED, body: { view: "fake:view", itemId: "a", expectedRevision: 1, changes: [] } }), badChanges);
    expect(badChanges.statusCode).toBe(400);
    expect(json(badChanges).error).toBe("changes 必须是对象");
  });

  it("refuses to save a view that has no save path, and an unknown op", async () => {
    const ctx = await boot();
    ctx.provide("profileContext", PROFILE as never);
    suiteOf(ctx).registerDetail(fakeSource());
    const handler = routeOf(ctx);

    const readOnly = fakeResponse();
    await handler(fakeRequest({ method: "POST", headers: TRUSTED, body: { view: "fake:view", itemId: "a", expectedRevision: 1, changes: {} } }), readOnly);
    expect(readOnly.statusCode).toBe(400);
    expect(json(readOnly).error).toBe("这个视图不支持保存: fake:view");

    const unknownOp = fakeResponse();
    await handler(fakeRequest({ method: "POST", headers: TRUSTED, body: { view: "fake:view", itemId: "a", op: "add" } }), unknownOp);
    expect(unknownOp.statusCode).toBe(400);
    expect(json(unknownOp).error).toBe("不认识的 op: add（只认 save / act）");
  });

  it("runs an action with defaulted args and refuses a view without actions", async () => {
    const ctx = await boot();
    ctx.provide("profileContext", PROFILE as never);
    const acted: unknown[] = [];
    const source = fakeSource({
      async act(input) {
        acted.push(input);
        return BODY;
      },
    });
    suiteOf(ctx).registerDetail(source);
    const handler = routeOf(ctx);

    const ok = fakeResponse();
    await handler(fakeRequest({ method: "POST", headers: TRUSTED, body: { view: "fake:view", itemId: "a", op: "act", actionId: "cancel-run" } }), ok);
    expect(ok.statusCode).toBe(200);
    expect(acted).toEqual([{ ...PROFILE, itemId: "a", actionId: "cancel-run", args: {} }]);

    const noActionId = fakeResponse();
    await handler(fakeRequest({ method: "POST", headers: TRUSTED, body: { view: "fake:view", itemId: "a", op: "act" } }), noActionId);
    expect(noActionId.statusCode).toBe(400);
    expect(json(noActionId).error).toBe("actionId 是必填");

    const badArgs = fakeResponse();
    await handler(fakeRequest({ method: "POST", headers: TRUSTED, body: { view: "fake:view", itemId: "a", op: "act", actionId: "x", args: [] } }), badArgs);
    expect(badArgs.statusCode).toBe(400);
    expect(json(badArgs).error).toBe("args 必须是对象");

    // 没有 act 的视图要如实说「不支持动作」，而不是当成功吞掉。
    suiteOf(ctx).registerDetail(fakeSource({ id: "fake:readonly" }));
    const withoutAct = fakeResponse();
    await handler(fakeRequest({ method: "POST", headers: TRUSTED, body: { view: "fake:readonly", itemId: "a", op: "act", actionId: "x" } }), withoutAct);
    expect(withoutAct.statusCode).toBe(400);
    expect(json(withoutAct).error).toBe("这个视图不支持动作: fake:readonly");
  });

  it("requires view and itemId on a write, and rejects other methods", async () => {
    const ctx = await boot();
    ctx.provide("profileContext", PROFILE as never);
    suiteOf(ctx).registerDetail(fakeSource({ async save() { return BODY; } }));
    const handler = routeOf(ctx);

    const noView = fakeResponse();
    await handler(fakeRequest({ method: "POST", headers: TRUSTED, body: { itemId: "a" } }), noView);
    expect(noView.statusCode).toBe(400);
    expect(json(noView).error).toBe("view 是必填");

    const noItem = fakeResponse();
    await handler(fakeRequest({ method: "POST", headers: TRUSTED, body: { view: "fake:view" } }), noItem);
    expect(noItem.statusCode).toBe(400);
    expect(json(noItem).error).toBe("itemId 是必填");

    const put = fakeResponse();
    await handler(fakeRequest({ method: "PUT" }), put);
    expect(put.statusCode).toBe(405);
    expect(json(put).error).toBe("不支持的方法: PUT");
  });

  it("accepts a string revision (file content hash) as well as an integer", async () => {
    const ctx = await boot();
    ctx.provide("profileContext", PROFILE as never);
    const saved: unknown[] = [];
    suiteOf(ctx).registerDetail(
      fakeSource({
        async save(input) {
          saved.push(input);
          return { ...BODY, revision: "hash-2" };
        },
      }),
    );
    const handler = routeOf(ctx);

    const ok = fakeResponse();
    await handler(
      fakeRequest({ method: "POST", headers: TRUSTED, body: { view: "fake:view", itemId: "a", expectedRevision: "hash-1", changes: { body: "新正文" } } }),
      ok,
    );
    expect(ok.statusCode).toBe(200);
    expect(json(ok)).toEqual({ ok: true, view: "fake:view", detail: { ...BODY, revision: "hash-2" } });
    expect(saved).toEqual([{ ...PROFILE, itemId: "a", expectedRevision: "hash-1", changes: { body: "新正文" } }]);

    // 空字符串不是修订号：放过去就等于「谁都盖得过谁」。
    const blank = fakeResponse();
    await handler(fakeRequest({ method: "POST", headers: TRUSTED, body: { view: "fake:view", itemId: "a", expectedRevision: "   ", changes: {} } }), blank);
    expect(blank.statusCode).toBe(400);
    expect(json(blank).error).toBe("expectedRevision 必须是整数或非空字符串");
  });

  it("passes an action's revision gate through, and refuses a malformed one", async () => {
    const ctx = await boot();
    ctx.provide("profileContext", PROFILE as never);
    const acted: unknown[] = [];
    suiteOf(ctx).registerDetail(
      fakeSource({
        async act(input) {
          acted.push(input);
          return BODY;
        },
      }),
    );
    const handler = routeOf(ctx);

    const ok = fakeResponse();
    await handler(
      fakeRequest({
        method: "POST",
        headers: TRUSTED,
        body: { view: "fake:view", op: "act", itemId: "a", actionId: "delete-team", args: { confirmTeamId: "a" }, expectedRevision: 3 },
      }),
      ok,
    );
    expect(ok.statusCode).toBe(200);
    expect(acted).toEqual([{ ...PROFILE, itemId: "a", actionId: "delete-team", args: { confirmTeamId: "a" }, expectedRevision: 3 }]);

    // 没带就是没栅：来源自己决定要不要要求它，入口不能凭空补一个。
    await handler(fakeRequest({ method: "POST", headers: TRUSTED, body: { view: "fake:view", op: "act", itemId: "a", actionId: "cancel-run", args: {} } }), fakeResponse());
    expect(acted[1]).toEqual({ ...PROFILE, itemId: "a", actionId: "cancel-run", args: {} });

    // 带了但不合法：和保存用同一条规则，不能悄悄当成「没带」。
    const bad = fakeResponse();
    await handler(
      fakeRequest({ method: "POST", headers: TRUSTED, body: { view: "fake:view", op: "act", itemId: "a", actionId: "cancel-run", args: {}, expectedRevision: " " } }),
      bad,
    );
    expect(bad.statusCode).toBe(400);
    expect(json(bad).error).toBe("expectedRevision 必须是整数或非空字符串");
  });

  it("runs a view-level action that has no item, and refuses one the view does not offer", async () => {
    const ctx = await boot();
    ctx.provide("profileContext", PROFILE as never);
    const acted: unknown[] = [];
    suiteOf(ctx).registerDetail(
      fakeSource({
        viewActions: [{ id: "new-team", label: "新建队伍", args: [{ key: "teamId", label: "队伍 id", value: null }] }],
        async actView(input) {
          acted.push(input);
        },
      }),
    );
    const handler = routeOf(ctx);

    const ok = fakeResponse();
    await handler(
      fakeRequest({ method: "POST", headers: TRUSTED, body: { view: "fake:view", op: "act", actionId: "new-team", args: { teamId: "demo" } } }),
      ok,
    );
    expect(ok.statusCode).toBe(200);
    // 视图级动作没有条目，也就没有详情可回：面板按 `scope` 知道该重读列表。
    expect(json(ok)).toEqual({ ok: true, view: "fake:view", scope: "view" });
    expect(acted).toEqual([{ ...PROFILE, actionId: "new-team", args: { teamId: "demo" } }]);

    suiteOf(ctx).registerDetail(fakeSource({ id: "fake:plain" }));
    const unsupported = fakeResponse();
    await handler(fakeRequest({ method: "POST", headers: TRUSTED, body: { view: "fake:plain", op: "act", actionId: "new-team" } }), unsupported);
    expect(unsupported.statusCode).toBe(400);
    expect(json(unsupported).error).toBe("这个视图不支持整体动作: fake:plain");
  });

  it("ships the view-level actions with the list so the panel can draw them up front", async () => {
    const ctx = await boot();
    ctx.provide("profileContext", PROFILE as never);
    suiteOf(ctx).registerDetail(fakeSource({ viewActions: [{ id: "new-team", label: "新建队伍" }] }));
    const handler = routeOf(ctx);

    const withActions = fakeResponse();
    await handler(fakeRequest({ url: "/void/api/detail?view=fake:view" }), withActions);
    expect(json(withActions).actions).toEqual([{ id: "new-team", label: "新建队伍" }]);

    // 没有视图级动作的视图不带这个字段：空数组会让面板画出一块什么都没有的区域。
    suiteOf(ctx).registerDetail(fakeSource({ id: "fake:plain" }));
    const withoutActions = fakeResponse();
    await handler(fakeRequest({ url: "/void/api/detail?view=fake:plain" }), withoutActions);
    expect(json(withoutActions).actions).toBeUndefined();
  });

  it("surfaces a source failure on read as a 500 with the real reason", async () => {
    const ctx = await boot();
    ctx.provide("profileContext", PROFILE as never);
    suiteOf(ctx).registerDetail(
      fakeSource({
        async detail() {
          throw new Error("军团没有数据根，业务视图没有可读的队伍与运行：需要配置 dataDir，或提供 profile（DSH_PROFILE）");
        },
      }),
    );
    const response = fakeResponse();
    await routeOf(ctx)(fakeRequest({ url: "/void/api/detail?view=fake:view&itemId=a" }), response);
    expect(response.statusCode).toBe(500);
    expect(json(response).error).toContain("军团没有数据根");
  });
});
