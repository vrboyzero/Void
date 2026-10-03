import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import * as Control from "../src/index.js";
import { SETTINGS_NAMESPACE } from "../src/protocol.js";
import { bootControl, disposeContexts, ENDPOINT, ENTRY_ID, parsedConfig } from "./support/boot.js";
import { plainConfig, isVolatileField, writeSection } from "./support/fake-settings.js";

afterEach(disposeContexts);

const TOKEN_ENV = "VOID_DSH_CONTROL_SPEC_TOKEN";

/**
 * 设置表单里的字段，按声明顺序。
 *
 * 这十个在 `Config` 里标了 `.volatile()`：宿主把它们包成稳定引用，改完下一次读取就生效。
 * 另外四个（`enabled` / `transport` / `path` / `ledger`）决定插件是否加载、挂在哪、账本落在
 * 哪里，属于组合入口，**不进表单**——面板只读展示，所以下面同时钉住这两组的分界。
 */
const VOLATILE_FIELDS = [
  "tokens",
  "allowAnonymous",
  "allowedRoots",
  "allowedOperations",
  "callerInstructions",
  "requiredFields",
  "requiredDocumentRules",
  "forbiddenPatterns",
  "instructionsVersion",
  "callback",
];
const COMPOSITION_FIELDS = ["enabled", "transport", "path", "ledger"];

/** Spin the event loop until the predicate holds (or give up, letting the assertion fail). */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let tick = 0; tick < 200 && !predicate(); tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("settings: 命名空间与表单由宿主从入口的 Config 派生", () => {
  // **0.2.0 起没有「注册」这一步，所以这里没有注册可测。** 0.1.x 的插件调用
  // `ctx.settings.installSection(ns, schema, entry, { validate })` 自己声明命名空间，宿主在
  // 写入时跑 `validate`、在卸载时注销。0.2.0 删掉了那个 API：宿主**直接从入口的 `Config`
  // 派生表单**，命名空间 = 组合入口 id（`src/protocol.ts` 的 `SETTINGS_NAMESPACE`），跨字段
  // 校验也搬到了插件自己的读取点。旧版那两条用例——「provider 后挂载也被采纳」与「卸载后
  // 注销命名空间，重载不撞名」——描述的概念都已不存在，故删除；它们想守的两件事改由
  // 「命名空间等于入口 id」与「`settings/document-updated` 到达即读到新值」继续守着。

  it("表单里的字段恰好是那十个 volatile 字段", () => {
    // 宿主用 `volatileForm()` 挑出「最近的 volatile 祖先」构成表单（dsh-settings），
    // 所以对空对象解析一遍，带引用协议的就是表单要渲染的字段。
    const parsed = Control.Config({}) as unknown as Record<string, unknown>;
    const keys = Object.keys(parsed);
    const live = keys.filter((key) => isVolatileField(parsed[key]));
    expect(live).toEqual(VOLATILE_FIELDS);
    // 其余四个是组合入口的启动项：改一次要重启，所以不进表单，由面板的只读区展示。
    expect(keys.filter((key) => !live.includes(key))).toEqual(COMPOSITION_FIELDS);
  });

  it("callback 的九个字段一个不少", () => {
    const resolved = plainConfig(Control.Config({})) as Record<string, unknown>;
    expect(Object.keys(resolved.callback as Record<string, unknown>)).toEqual([
      "enabled",
      "url",
      "secretEnv",
      "events",
      "timeoutMs",
      "maxAttempts",
      "allowedHosts",
      "includeAssistantSummary",
      "includeLegionRuns",
    ]);
  });

  it("命名空间就是组合入口 id，也是包内 patch 写的那条 id", () => {
    // 面板拿这个字符串去设置视图里找自己的那份值；对不上就是「面板能渲染、点保存没反应」。
    // 宿主发事件时带的键是 `entry.options.id`（dsh-settings 的 `describe()`），所以
    // `cordis.patch.yml` 里那条 `id:` 必须与常量一致——这两处漂移过一次，代价是整块面板。
    const patch = readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8");
    expect(patch).toContain(`id: ${SETTINGS_NAMESPACE}`);
    // 测试夹具照 profile 的写法给入口同一条 id，所以 emit 用的命名空间与插件过滤的是同一个。
    expect(ENTRY_ID).toBe(SETTINGS_NAMESPACE);
  });

  it("没有任何设置服务时插件照常按入口配置工作", async () => {
    // 0.2.0 里插件根本不读 `ctx.settings`：宿主解析好的引用就是唯一的配置来源，
    // 所以「provider 没挂上怎么办」不再是需要回落的分支——这条用例钉住这个前提。
    const ctx = await bootControl();
    expect(ctx.get("settings")).toBeUndefined();
    const service = ctx.get("voidDshControl")!;
    expect(service.guard.allowedRoots).toEqual([]);
    expect(service.policy.callerInstructions).toBe("");
  });

  it("组合入口的取值就是运行初值，插件不再自己补第二份", async () => {
    const ctx = await bootControl({ config: { allowedOperations: ["session.list"], instructionsVersion: 7 } });
    // 宿主解析入口 `Config` 得到的对象就是交给 `apply` 的那份（Loader → `fiber.config`），
    // 面板看到的、运行时用的因此不可能各说各话。
    const resolved = plainConfig(parsedConfig(ctx)) as Record<string, unknown>;
    expect(resolved.allowedOperations).toEqual(["session.list"]);
    expect(resolved.instructionsVersion).toBe(7);
    expect(ctx.get("voidDshControl")!.policy.instructionsVersion).toBe(7);
    // 入口没写的字段由 schema 默认值补齐。
    expect(resolved.allowAnonymous).toBe(false);
    expect(resolved.tokens).toEqual([{ callerId: "spec", tokenEnv: TOKEN_ENV, operations: [] }]);
  });

  it("settings/document-updated 到达时，插件读到的是新值", async () => {
    const ctx = await bootControl();
    const service = ctx.get("voidDshControl")!;
    // 根目录快照只在收到事件后重算（`createConfigSource` 的 `watch` → `refreshRoots`）。
    expect(service.guard.allowedRoots).toEqual([]);

    const cwd = process.cwd();
    writeSection(ctx, parsedConfig(ctx), { allowedRoots: [cwd] });

    // 这条断言同时证明两件事：事件确实按 SETTINGS_NAMESPACE 到达了插件，且插件读到的是
    // 引用里**已经更新**后的值——事件先于读取、还是后于读取，在旧分层里是要靠人记的约定。
    await waitFor(() => service.guard.allowedRoots.length > 0);
    expect(service.guard.allowedRoots).toEqual([await realpath(cwd)]);
  });
});

describe("settings: 跨字段校验发生在读取点", () => {
  /**
   * 写入一个 schema 接受、跨字段规则拒绝的值。
   *
   * 0.2.0 的写入路径只有逐字段的 schema 校验，没有 `installSection` 时代的 `validate` 钩子，
   * 因此**坏值会先存进去**：写入点不再抛错，失败后移到下一次读取（下一个请求 / 下一次策略
   * 读取）。这是这一版模型的既成取舍，用例如实反映，不假装还能在写入时拒绝。
   *
   * 这里关掉事件通知，理由见 `WriteOptions`：插件的事件回调里那次读会 reject 且无人接管，
   * unhandled rejection 会让整个测试运行判失败。本组观察的是「写入被接受 → 下一次读取抛错」，
   * 通知路径由上一组的 `settings/document-updated` 用例与下一组覆盖。
   */
  async function writeAccepted(section: Record<string, unknown>) {
    const ctx = await bootControl();
    expect(() => writeSection(ctx, parsedConfig(ctx), section, { notify: false })).not.toThrow();
    return ctx;
  }

  /** The accessor that projects the section, and therefore the one that validates it. */
  const policyOf = (ctx: Awaited<ReturnType<typeof bootControl>>) => () => ctx.get("voidDshControl")!.policy;

  it("坏值经事件路径刷新时不掀翻宿主：降级保留上一次的快照", async () => {
    // 这条守的是 0.2.0 迁移里最容易踩的一颗雷。`source.watch` 是 fire-and-forget，而 0.2.0 的
    // 写入路径不做跨字段校验，所以「面板存下一个坏值」是**可达**的——两者一叠加，读取点的拒绝
    // 就会逃逸成 unhandledRejection，dsh 的 `installFailLoud` 把它判成致命加载失败并
    // `proc.exit(1)`：**一次误改配置足以把宿主整个干掉**。修法是刷新失败时降级（保留旧快照）
    // 并记一笔。所以这条**故意走通知路径**（不传 notify: false）。
    const ctx = await bootControl();
    const before = ctx.get("voidDshControl")!.guard.allowedRoots;

    writeSection(ctx, parsedConfig(ctx), { allowedRoots: ["not/absolute"] });
    // 拒绝在下一个微任务落地；给它一点时间，否则测不出逃逸。
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 没有 unhandled rejection（真有的话 vitest 判整个运行失败），且后台快照仍是上一次的好值。
    expect(ctx.get("voidDshControl")!.guard.allowedRoots).toEqual(before);
    // 降级的是「后台刷新」，不是失败本身：按需读取照旧如实报错。
    expect(policyOf(ctx)).toThrowError(/allowedRoots entries must be existing absolute directories/);
  });

  it("未知操作名：写进去了，下一次读取才抛", async () => {
    const ctx = await writeAccepted({ allowedOperations: ["session.prompt", "not.an.operation"] });
    // 「先存进去」不是推断：引用里确实带着那个坏值，失败只发生在读取点。
    expect((plainConfig(parsedConfig(ctx)) as Record<string, unknown>).allowedOperations).toEqual([
      "session.prompt",
      "not.an.operation",
    ]);
    expect(policyOf(ctx)).toThrowError(/allowedOperations names an unknown operation/);
  });

  it("token 上的未知操作名：下一次读取才抛", async () => {
    const ctx = await writeAccepted({
      tokens: [{ callerId: "spec", tokenEnv: TOKEN_ENV, operations: ["nope"] }],
    });
    expect(policyOf(ctx)).toThrowError(/tokens\[spec\]\.operations names an unknown operation/);
  });

  it("非法禁用正则：下一次读取才抛", async () => {
    const ctx = await writeAccepted({ forbiddenPatterns: ["("] });
    expect(policyOf(ctx)).toThrowError(/invalid forbiddenPatterns regular expression/);
  });

  it("不是「存在且为绝对路径」的根目录：下一次读取才抛", async () => {
    // 不存在的目录在激活时只会被跳过并留一行日志，看着像生效了、直到按路径寻址莫名其妙失败；
    // 现在错误发生在最近的一次读取上，仍然不是静默接受。
    const missing = await writeAccepted({ allowedRoots: ["C:/definitely/not/here"] });
    expect(policyOf(missing)).toThrowError(/allowedRoots entries must be existing absolute directories/);

    const relative = await writeAccepted({ allowedRoots: ["relative/path"] });
    expect(policyOf(relative)).toThrowError(/allowedRoots entries must be existing absolute directories/);
  });

  it("存在的绝对目录：写入与读取都通过，取回来还是它", async () => {
    const ctx = await writeAccepted({ allowedRoots: [process.cwd()] });
    expect(policyOf(ctx)).not.toThrow();
    expect((plainConfig(parsedConfig(ctx)) as Record<string, unknown>).allowedRoots).toEqual([process.cwd()]);
  });

  it("启用回调但地址不是绝对 URL：下一次读取才抛", async () => {
    // `resolveCallbackUrl` 里密钥的检查在 URL 之前，所以变量必须先设置，被验的才是 URL 规则。
    process.env["VOID_DSH_CONTROL_CALLBACK_SECRET"] = "spec-callback-secret";
    try {
      const ctx = await writeAccepted({ callback: { enabled: true, url: "not-a-url" } });
      expect(policyOf(ctx)).toThrowError(/callback\.url is not a valid absolute URL/);
    } finally {
      delete process.env["VOID_DSH_CONTROL_CALLBACK_SECRET"];
    }
  });
});

describe("settings: 活体生效", () => {
  // 0.2.0 的引用模型最要紧的两条验收：面板改完**不用重启**就生效。写入走
  // `writeSection`——它更新插件手里那些 `Volatile` 引用，正是宿主写入侧做的事。

  it("改权限后不重启即生效", async () => {
    const ctx = await bootControl({ config: { allowAnonymous: false } });
    const url = `http://127.0.0.1:${ctx.get("webServer")!.port}${ENDPOINT}`;
    const initialize = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    };

    // Before: no credential, anonymous refused.
    expect((await fetch(url, initialize)).status).toBe(401);

    writeSection(ctx, parsedConfig(ctx), { allowAnonymous: true });

    // After: the very same request gets past authentication, with no
    // re-registration and no restart — the authenticator reads the section per
    // request. The exact success code is the MCP layer's business (406 for a
    // missing Accept header), so the assertion is on the refusal itself.
    expect((await fetch(url, initialize)).status).not.toBe(401);
  });

  it("改 token 绑定后旧 token 立刻失效", async () => {
    const ctx = await bootControl();
    const url = `http://127.0.0.1:${ctx.get("webServer")!.port}${ENDPOINT}`;
    const call = (bearer: string) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });

    expect((await call("spec-token")).status).not.toBe(401);

    // Rebind the caller to a variable nobody set: the old token must stop
    // working immediately, because token values are re-read from the
    // environment rather than cached from activation.
    writeSection(ctx, parsedConfig(ctx), {
      tokens: [{ callerId: "spec", tokenEnv: "VOID_DSH_CONTROL_UNSET_TOKEN", operations: [] }],
    });
    expect((await call("spec-token")).status).toBe(401);
  });
});
