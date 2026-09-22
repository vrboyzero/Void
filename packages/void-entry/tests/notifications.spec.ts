import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import * as VoidEntry from "../src/index.js";
import { VOID_REQUEST_HEADER } from "../src/detail.js";
import type { VoidNotificationSource, VoidSuite } from "../src/index.js";

/** 一个只在被 load 后才 provide webServer 的假宿主插件（与 detail.spec.ts 同一做法）。 */
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

let context: Context | undefined;

beforeEach(() => {
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

function routeOf(ctx: Context, path: string): (req: unknown, res: unknown) => Promise<void> {
  const webServer = ctx.get("webServer") as unknown as {
    routes: Map<string, (req: unknown, res: unknown) => void | Promise<void>>;
  };
  const handler = webServer.routes.get(path);
  expect(handler).toBeDefined();
  // 路由注册用的是 `void this.handleNotifications(...)`（fire-and-forget），handler 立刻返回、
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
    url: input.url ?? "/void/api/notifications",
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

function fakeSource(overrides: Partial<VoidNotificationSource> = {}): VoidNotificationSource {
  const source: VoidNotificationSource = {
    id: "fake:notes",
    title: "假通知",
    async list() {
      return { items: [] };
    },
    ...overrides,
  };
  return source;
}

describe("void-entry notification sources", () => {
  it("registers sources and lists their ids", async () => {
    const ctx = await boot();
    const suite = suiteOf(ctx);
    suite.registerNotificationSource(fakeSource());
    expect(suite.notificationSourceIds()).toEqual(["fake:notes"]);
    expect(suite.notificationManifests()).toEqual([{ id: "fake:notes", title: "假通知" }]);
  });

  it("refuses a duplicate source id instead of silently replacing it", async () => {
    const ctx = await boot();
    const suite = suiteOf(ctx);
    suite.registerNotificationSource(fakeSource());
    expect(() => suite.registerNotificationSource(fakeSource({ title: "另一个" }))).toThrow("通知来源 id 重复: fake:notes");
    // 原来那份还在，标题没被换掉。
    expect(suite.notificationManifests()).toEqual([{ id: "fake:notes", title: "假通知" }]);
  });

  it("unregisters on dispose, and a stale disposer does not remove the new one", async () => {
    const ctx = await boot();
    const suite = suiteOf(ctx);
    const dispose = suite.registerNotificationSource(fakeSource());
    dispose();
    expect(suite.notificationSourceIds()).toEqual([]);

    suite.registerNotificationSource(fakeSource({ title: "新的" }));
    // 旧插件卸载得晚，不该把新插件刚注册的那份删掉。
    dispose();
    expect(suite.notificationManifests()).toEqual([{ id: "fake:notes", title: "新的" }]);
  });

  it("announces the source catalog on /void/api/panels", async () => {
    const ctx = await boot();
    suiteOf(ctx).registerNotificationSource(fakeSource());
    const response = fakeResponse();
    await routeOf(ctx, "/void/api/panels")(fakeRequest({ url: "/void/api/panels" }), response);

    expect(json(response).notifications).toEqual([{ id: "fake:notes", title: "假通知" }]);
  });
});

describe("void-entry notification route", () => {
  it("returns an empty feed when nothing registered a source", async () => {
    const ctx = await boot();
    const response = fakeResponse();
    await routeOf(ctx, "/void/api/notifications")(fakeRequest(), response);

    expect(response.statusCode).toBe(200);
    expect(json(response)).toEqual({ items: [], unread: 0, sources: [], notes: [] });
  });

  it("merges sources, unread first, and stamps each item with its source", async () => {
    const ctx = await boot();
    const suite = suiteOf(ctx);
    suite.registerNotificationSource(
      fakeSource({
        id: "void-legion:runs",
        title: "军团运行",
        async list() {
          return {
            items: [
              { id: "a1", title: "甲", at: "2026-09-22T08:00:00.000Z" },
              { id: "a2", title: "乙", at: "2026-09-22T09:00:00.000Z", read: true },
            ],
          };
        },
      }),
    );
    suite.registerNotificationSource(
      fakeSource({
        id: "void-memory:notes",
        title: "记忆提醒",
        async list() {
          return { items: [{ id: "b1", title: "丙", at: "2026-09-22T07:00:00.000Z", read: true }] };
        },
      }),
    );

    const response = fakeResponse();
    await routeOf(ctx, "/void/api/notifications")(fakeRequest(), response);
    const payload = json(response) as { items: Array<Record<string, unknown>>; unread: number; sources: unknown[] };

    // 未读的在最前，其余按时间倒序——人先看到「还没处理的」，再看到刚过去的。
    expect(payload.items.map((item) => item.id)).toEqual(["a1", "a2", "b1"]);
    expect(payload.unread).toBe(1);
    expect(payload.items[0]).toMatchObject({ source: "void-legion:runs", sourceTitle: "军团运行" });
    // 来源没写 `read` 就算没读过——入口不替它编一个「已读」。
    expect(payload.items[0]!.read).not.toBe(true);
    expect(payload.items[1]!.read).toBe(true);
    expect(payload.sources).toEqual([
      { id: "void-legion:runs", title: "军团运行" },
      { id: "void-memory:notes", title: "记忆提醒" },
    ]);
  });

  it("keeps a broken source from taking down the whole feed", async () => {
    const ctx = await boot();
    const suite = suiteOf(ctx);
    suite.registerNotificationSource(
      fakeSource({
        id: "broken:one",
        title: "坏来源",
        async list() {
          throw new Error("索引打不开");
        },
      }),
    );
    suite.registerNotificationSource(
      fakeSource({
        id: "ok:one",
        title: "好来源",
        async list() {
          return { items: [{ id: "x", title: "还在", at: "2026-09-22T08:00:00.000Z" }] };
        },
      }),
    );

    const response = fakeResponse();
    await routeOf(ctx, "/void/api/notifications")(fakeRequest(), response);
    const payload = json(response) as { items: Array<{ id: string }>; notes: string[] };

    expect(response.statusCode).toBe(200);
    expect(payload.items.map((item) => item.id)).toEqual(["x"]);
    expect(payload.notes).toEqual(["通知来源 坏来源（broken:one）读不出来：索引打不开"]);
  });

  it("turns a malformed item into a note naming the source and the position", async () => {
    const ctx = await boot();
    suiteOf(ctx).registerNotificationSource(
      fakeSource({
        id: "sloppy:one",
        title: "马虎来源",
        async list() {
          return { items: [{ id: "ok", title: "好的", at: "2026-09-22T08:00:00.000Z" }, { id: "bad", title: "缺时间" } as never] };
        },
      }),
    );

    const response = fakeResponse();
    await routeOf(ctx, "/void/api/notifications")(fakeRequest(), response);
    const payload = json(response) as { items: unknown[]; notes: string[] };

    // 整份来源都不要：半份通知比没有通知更让人误判。
    expect(payload.items).toEqual([]);
    expect(payload.notes).toEqual(["通知来源 马虎来源（sloppy:one）读不出来：通知来源 sloppy:one 的第 2 条缺少 at"]);
  });

  it("rejects a cross-site read with 403", async () => {
    const ctx = await boot();
    const response = fakeResponse();
    await routeOf(ctx, "/void/api/notifications")(
      fakeRequest({ headers: { host: "127.0.0.1:3080", origin: "http://evil.test" } }),
      response,
    );
    expect(response.statusCode).toBe(403);
    expect(json(response).error).toBe("跨站请求被拒绝：Origin evil.test 与 Host 127.0.0.1:3080 不一致");
  });

  it("marks items read and reports how many really changed", async () => {
    const ctx = await boot();
    const seen: Array<{ ids: readonly string[] }> = [];
    suiteOf(ctx).registerNotificationSource(
      fakeSource({
        async markRead(ids) {
          seen.push({ ids });
          return 1;
        },
      }),
    );

    const response = fakeResponse();
    await routeOf(ctx, "/void/api/notifications")(
      fakeRequest({ method: "POST", headers: TRUSTED, body: { op: "read", source: "fake:notes", ids: ["a#1", "a#2"] } }),
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(json(response)).toEqual({ ok: true, source: "fake:notes", requested: 2, marked: 1 });
    expect(seen).toEqual([{ ids: ["a#1", "a#2"] }]);
  });

  it("omits `marked` when the source cannot count", async () => {
    const ctx = await boot();
    suiteOf(ctx).registerNotificationSource(fakeSource({ async markRead() {} }));
    const response = fakeResponse();
    await routeOf(ctx, "/void/api/notifications")(
      fakeRequest({ method: "POST", headers: TRUSTED, body: { source: "fake:notes", ids: ["a#1"] } }),
      response,
    );

    expect(json(response)).toEqual({ ok: true, source: "fake:notes", requested: 1 });
  });

  it("requires the same-origin marker and a JSON content type", async () => {
    const ctx = await boot();
    suiteOf(ctx).registerNotificationSource(fakeSource({ async markRead() {} }));
    const response = fakeResponse();
    await routeOf(ctx, "/void/api/notifications")(
      fakeRequest({ method: "POST", headers: SAME_ORIGIN, body: { source: "fake:notes", ids: ["a#1"] } }),
      response,
    );
    expect(response.statusCode).toBe(403);
    expect(json(response).error).toBe("缺少同源标记（x-void-request），拒绝改动");
  });

  it("names every rejected field instead of silently ignoring it", async () => {
    const ctx = await boot();
    const suite = suiteOf(ctx);
    suite.registerNotificationSource(fakeSource({ id: "no-read", title: "只读来源" }));
    suite.registerNotificationSource(fakeSource({ id: "can-read", title: "可标来源", async markRead() { return 0; } }));
    const route = routeOf(ctx, "/void/api/notifications");

    const unknownOp = fakeResponse();
    await route(fakeRequest({ method: "POST", headers: TRUSTED, body: { op: "clear", source: "can-read", ids: ["x"] } }), unknownOp);
    expect(unknownOp.statusCode).toBe(400);
    expect(json(unknownOp).error).toBe("不认识的 op: clear（只认 read）");

    const noSource = fakeResponse();
    await route(fakeRequest({ method: "POST", headers: TRUSTED, body: { ids: ["x"] } }), noSource);
    expect(noSource.statusCode).toBe(400);
    expect(json(noSource).error).toBe("source 是必填（通知来源 id）");

    const unknownSource = fakeResponse();
    await route(fakeRequest({ method: "POST", headers: TRUSTED, body: { source: "nope", ids: ["x"] } }), unknownSource);
    expect(unknownSource.statusCode).toBe(404);
    expect(json(unknownSource).error).toBe("没有这个通知来源: nope");

    const noMarkRead = fakeResponse();
    await route(fakeRequest({ method: "POST", headers: TRUSTED, body: { source: "no-read", ids: ["x"] } }), noMarkRead);
    expect(noMarkRead.statusCode).toBe(400);
    expect(json(noMarkRead).error).toBe("这个通知来源不支持标记已读: no-read");

    const noIds = fakeResponse();
    await route(fakeRequest({ method: "POST", headers: TRUSTED, body: { source: "can-read", ids: [] } }), noIds);
    expect(noIds.statusCode).toBe(400);
    expect(json(noIds).error).toBe("ids 是必填（要标记已读的通知 id）");
  });

  it("rejects other methods with 405", async () => {
    const ctx = await boot();
    const response = fakeResponse();
    await routeOf(ctx, "/void/api/notifications")(fakeRequest({ method: "PUT" }), response);
    expect(response.statusCode).toBe(405);
    expect(json(response).error).toBe("不支持的方法: PUT");
  });

  it("propagates a source error on the write path as 500, not a silent ok", async () => {
    const ctx = await boot();
    suiteOf(ctx).registerNotificationSource(
      fakeSource({
        async markRead() {
          throw new Error("通知文件损坏");
        },
      }),
    );
    const response = fakeResponse();
    await routeOf(ctx, "/void/api/notifications")(
      fakeRequest({ method: "POST", headers: TRUSTED, body: { source: "fake:notes", ids: ["a#1"] } }),
      response,
    );
    expect(response.statusCode).toBe(500);
    expect(json(response).error).toBe("通知文件损坏");
  });
});
