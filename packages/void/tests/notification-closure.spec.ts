import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import * as VoidEntry from "@void/void-entry";
import * as VoidLegionService from "@void/void-legion/service";
import * as VoidLegionNotifications from "@void/void-legion/notification-source";
import * as VoidSoulPlugin from "@void/void-soul/plugin";
import { saveSessionBindings } from "@void/void-soul";
import { VOID_REQUEST_HEADER } from "@void/void-entry";
import type { VoidSuite } from "@void/void-entry";
import type { VoidTeam } from "@void/void-legion";

/**
 * 通知闭环（A13 / L9 的跨包验收）：军团跑完一次派活 → 终态落进数据根的通知文件 →
 * 入口面板通过 `/void/api/notifications` 读到 → 标记已读。
 *
 * 为什么非要跨包测：军团与入口各自单测都用了替身——军团对着假 suite，入口对着假来源。
 * 两边「形状对得上」这件事没有任何一个单测能证明，而形状错了只会表现为面板少画一条通知
 * （入口按契约拒收畸形条目），最难在真机上发现。这里用真军团服务 + 真入口 + 假 webServer
 * 把这段缝钉住；浏览器那一层（轮询、断线补读的提示）仍留给人工核对。
 */

/** 一个只在被 load 后才 provide webServer 的假宿主插件（与 void-entry 的测试同一做法）。 */
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
let dataDir: string | undefined;

// 跑测试的机器上可能真的设了 DSH_*（开发机就是日常 home）。这里一律清掉：
// 显式 dataDir 的用例本来就该用临时目录，内存模式的用例更不能因为环境变量
// 就把运行记录与通知写进日常档案里。
beforeEach(() => {
  delete process.env.DSH_HOME;
  delete process.env.DSH_PROFILE;
});

afterEach(async () => {
  await context?.fiber.dispose();
  context = undefined;
  if (dataDir !== undefined) {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    dataDir = undefined;
  }
});

/**
 * 真 Loader + 假模块表，把军团服务、入口、军团通知来源挂进同一个 Context。
 *
 * 数据根用显式 `dataDir`（临时目录）：**不碰日常 home**，同时又能验证通知真的落盘
 * ——内存模式下通知是关掉的，测不出闭环。
 */
async function boot(options: { persistent?: boolean; withSoul?: boolean } = {}): Promise<Context> {
  const persistent = options.persistent ?? true;
  dataDir = await mkdtemp(join(tmpdir(), "void-notification-closure-"));
  const ctx = new Context();
  await ctx.plugin(Loader);
  const modules = new Map<string, unknown>([
    ["fake-web-server", FakeWebServer],
    ["@void/void-legion/service", VoidLegionService],
    ["@void/void-entry", VoidEntry],
    ["@void/void-legion/notification-source", VoidLegionNotifications],
    ["@void/void-soul/plugin", VoidSoulPlugin],
  ]);
  ctx.loader.internal = {
    version: "v2",
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`);
      return modules.get(specifier);
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>;
  // 顺序加载：Include 的并发 fan-out 会丢嵌套 provider。
  await ctx.loader.create({ name: "fake-web-server" });
  await ctx.loader.create(
    persistent ? { name: "@void/void-legion/service", config: { dataDir } } : { name: "@void/void-legion/service" },
  );
  await ctx.loader.create({ name: "@void/void-entry" });
  await ctx.loader.create({ name: "@void/void-legion/notification-source" });
  if (options.withSoul === true) {
    // 预算压到 10 字，让 200 字的 SOUL 必定装不进去。
    await ctx.loader.create({ id: "void-soul", name: "@void/void-soul/plugin", config: { prompt: { maxCharacters: 10 } } });
  }
  await ctx.loader.await();
  return ctx;
}

function suiteOf(ctx: Context): VoidSuite {
  const suite = ctx.get("voidSuite") as VoidSuite;
  expect(suite).toBeDefined();
  return suite;
}

function teamOf(ctx: Context): VoidTeam {
  const team = ctx.get("voidTeam") as VoidTeam;
  expect(team).toBeDefined();
  return team;
}

function routeOf(ctx: Context, path: string): (req: unknown, res: unknown) => Promise<void> {
  const webServer = ctx.get("webServer") as unknown as {
    routes: Map<string, (req: unknown, res: unknown) => void | Promise<void>>;
  };
  const handler = webServer.routes.get(path);
  expect(handler).toBeDefined();
  // 路由注册用的是 `void this.handleNotifications(...)`（fire-and-forget），handler 立刻返回、
  // 处理还在微任务里跑。这里和 void-entry 自己的测试不同：真军团的来源要读盘（`notifications.json`），
  // 光转几圈事件循环等不到 fs 回来，所以按「响应写上了没有」等到上限为止。
  return async (req, res) => {
    await handler!(req, res);
    for (let i = 0; i < 200 && (res as FakeResponse).statusCode === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };
}

function fakeRequest(
  input: {
    method?: string;
    url?: string;
    headers?: Record<string, string | string[]>;
    body?: unknown;
  } = {},
): unknown {
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

interface FeedItem {
  id: string;
  title: string;
  summary?: string;
  at: string;
  level?: string;
  meta?: Record<string, string>;
  read?: boolean;
  source: string;
  sourceTitle: string;
}

const SAME_ORIGIN = { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" };
const TRUSTED = { ...SAME_ORIGIN, [VOID_REQUEST_HEADER]: "1", "content-type": "application/json; charset=utf-8" };

const TEAM = {
  id: "legion-demo",
  mode: "plan_execute_verify" as const,
  memberRoster: [
    { laneId: "lane_plan", role: "researcher" as const, authorityRelationToManager: "peer" as const },
    {
      laneId: "lane_code",
      role: "coder" as const,
      authorityRelationToManager: "subordinate" as const,
      dependsOn: ["lane_plan"],
    },
    {
      laneId: "lane_verify",
      role: "verifier" as const,
      authorityRelationToManager: "peer" as const,
      dependsOn: ["lane_code"],
    },
  ],
};

describe("notification closure (legion terminal state → entry panel → mark read)", () => {
  it("publishes one persistent notification per finished run and lets the panel read it back", async () => {
    context = await boot();
    const suite = suiteOf(context);
    const team = teamOf(context);
    // 来源确实注册进入口了——没有这一条，后面读到的空 feed 会被误当成「没有通知」。
    expect(suite.notificationSourceIds()).toEqual(["void-legion:runs"]);

    team.defineTeam(TEAM);
    const first = await team.dispatch("legion-demo", {
      task: "闭环冒烟",
      worker: async (task) => ({ laneId: task.laneId }),
    });
    const settled = await team.waitForRun(first.runId);
    expect(settled.status).toBe("completed");

    const notifications = routeOf(context, "/void/api/notifications");
    const listed = fakeResponse();
    await notifications(fakeRequest({ headers: SAME_ORIGIN }), listed);
    expect(listed.statusCode).toBe(200);
    const feed = json(listed);
    expect(feed.sources).toEqual([{ id: "void-legion:runs", title: "军团运行" }]);
    expect(feed.notes).toEqual([]);
    expect(feed.unread).toBe(1);
    const items = feed.items as FeedItem[];
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toBe(`${first.runId}#1`);
    expect(item.source).toBe("void-legion:runs");
    expect(item.title).toBe(`运行 ${first.runId} 已跑完`);
    expect(item.summary).toBe("完成 3/3，失败 0，未轮到 0");
    expect(item.level).toBe("info");
    expect(item.meta).toEqual({
      队伍: "legion-demo",
      运行: first.runId,
      结果: `legion/runs/${first.runId}.json`,
    });
    expect(item.read).toBe(false);

    // 通知真的在盘上，不是只活在这个进程里——宿主重启后照样补得回来（A13「持久通知可补读」）。
    const file = JSON.parse(await readFile(join(dataDir!, "legion", "notifications.json"), "utf8")) as {
      version: number;
      events: Array<{ eventId: string; status: string }>;
    };
    expect(file.version).toBe(1);
    expect(file.events.map((event) => event.eventId)).toEqual([`${first.runId}#1`]);
    expect(file.events[0]!.status).toBe("completed");

    // 标记已读：入口把请求转给来源，来源转给军团的仓库。
    const marked = fakeResponse();
    await notifications(
      fakeRequest({ method: "POST", headers: TRUSTED, body: { op: "read", source: "void-legion:runs", ids: [item.id] } }),
      marked,
    );
    expect(marked.statusCode).toBe(200);
    expect(json(marked)).toMatchObject({ ok: true, source: "void-legion:runs", requested: 1, marked: 1 });

    const reread = fakeResponse();
    await notifications(fakeRequest({ headers: SAME_ORIGIN }), reread);
    const after = json(reread);
    expect(after.unread).toBe(0);
    expect((after.items as FeedItem[])[0]!.read).toBe(true);

    // 第二次派活：只多一条，第一条不会被顶掉，也不会被重复记一遍（eventId 幂等）。
    const second = await team.dispatch("legion-demo", { worker: async () => undefined });
    await team.waitForRun(second.runId);
    const latest = fakeResponse();
    await notifications(fakeRequest({ headers: SAME_ORIGIN }), latest);
    const feed2 = json(latest);
    const items2 = feed2.items as FeedItem[];
    expect(items2.map((entry) => entry.id)).toEqual([`${second.runId}#1`, `${first.runId}#1`]);
    expect(feed2.unread).toBe(1);
    expect(items2[1]!.read).toBe(true);
  });

  it("keeps a readable note instead of failing when the legion side has no data root", async () => {
    // 无数据根＝内存模式：军团照常能派活，只是通知没地方落盘，面板要如实说明（L9 第五条）。
    context = await boot({ persistent: false });
    const suite = suiteOf(context);
    expect(suite.notificationSourceIds()).toEqual(["void-legion:runs"]);
    const team = teamOf(context);
    expect(team.dataRoot).toBeUndefined();

    team.defineTeam(TEAM);
    const run = await team.dispatch("legion-demo", { worker: async () => undefined });
    expect((await team.waitForRun(run.runId)).status).toBe("completed");

    const notifications = routeOf(context, "/void/api/notifications");
    const listed = fakeResponse();
    await notifications(fakeRequest({ headers: SAME_ORIGIN }), listed);
    const feed = json(listed);
    expect(feed.items).toEqual([]);
    expect(feed.unread).toBe(0);
    expect(feed.notes).toEqual([
      "军团这次没有数据根，终态通知没地方落盘（重启后什么都留不下）。本次进程里的运行记录仍然能在军团的任务视图里看到。",
    ]);
  });

  it("shows the empty-list note before any run has finished", async () => {
    context = await boot();
    const notifications = routeOf(context, "/void/api/notifications");
    const listed = fakeResponse();
    await notifications(fakeRequest({ headers: SAME_ORIGIN }), listed);
    const feed = json(listed);
    expect(feed.items).toEqual([]);
    expect(feed.unread).toBe(0);
    expect(feed.notes).toEqual([
      "还没有跑完的运行。队伍派活结束（完成、失败、取消或宿主重启结算）后，这里会留一条。",
    ]);
  });

  it("灵魂拒绝也走同一条路由：来源形状跨包对得上，面板才知道为什么没带灵魂", async () => {
    // 灵魂那侧读的是 DSH_HOME/DSH_PROFILE（插件运行期拿不到 profile 名），所以这里给一对临时值。
    const home = await mkdtemp(join(tmpdir(), "void-soul-closure-home-"));
    const previous = { home: process.env.DSH_HOME, profile: process.env.DSH_PROFILE };
    process.env.DSH_HOME = home;
    process.env.DSH_PROFILE = "web";
    try {
      const soulDir = join(home, "void-data", "web");
      await mkdir(join(soulDir, "runtime"), { recursive: true });
      await mkdir(join(soulDir, "agents", "小贝"), { recursive: true });
      await writeFile(
        join(soulDir, "agents", "小贝", "SOUL.md"),
        `---\nid: xiaobei\nname: 小贝\nsummary: 统筹\n---\n${"底".repeat(200)}\n`,
        "utf8",
      );
      await saveSessionBindings(soulDir, new Map([["s1", "xiaobei"]]));

      context = await boot({ withSoul: true });
      const suite = suiteOf(context);
      expect([...suite.notificationSourceIds()].sort()).toEqual(["void-legion:runs", "void-soul:refusals"]);

      // 真的派发一次 agent/created：灵魂那侧会去读档案、发现放不下、拒绝并留一条通知。
      context.emit("agent/created", { agent: { id: "s1", ctx: { systemPrompt: { section: () => () => undefined } } } });
      const notifications = routeOf(context, "/void/api/notifications");
      let items: FeedItem[] = [];
      let feed: Record<string, unknown> = {};
      for (let index = 0; index < 200 && items.length === 0; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        const listed = fakeResponse();
        await notifications(fakeRequest({ headers: SAME_ORIGIN }), listed);
        feed = json(listed);
        items = (feed.items ?? []) as FeedItem[];
      }
      expect(items).toHaveLength(1);
      const item = items[0]!;
      expect(item.source).toBe("void-soul:refusals");
      expect(item.sourceTitle).toBe("灵魂未生效");
      expect(item.title).toBe("档案 xiaobei 的说明书没装进模型");
      expect(item.level).toBe("danger");
      expect(item.meta).toEqual({ 会话: "s1", 档案: "xiaobei" });
      expect(String(item.summary)).toMatch(/超出本次上下文预算.*预算来自 configured/s);
      expect(feed.unread).toBe(1);
      expect((feed.notes as string[]).some((note) => /最近 50 条/.test(note))).toBe(true);

      // 标记已读也走同一条写路由：入口转给来源，来源转给进程内的拒绝记录。
      const marked = fakeResponse();
      await notifications(
        fakeRequest({ method: "POST", headers: TRUSTED, body: { op: "read", source: "void-soul:refusals", ids: [item.id] } }),
        marked,
      );
      expect(marked.statusCode).toBe(200);
      expect(json(marked)).toMatchObject({ ok: true, source: "void-soul:refusals", requested: 1, marked: 1 });
      const reread = fakeResponse();
      await notifications(fakeRequest({ headers: SAME_ORIGIN }), reread);
      expect(json(reread).unread).toBe(0);
    } finally {
      if (previous.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous.home;
      if (previous.profile === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = previous.profile;
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
