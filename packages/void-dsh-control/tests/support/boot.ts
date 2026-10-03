import { Context } from "@deepseek-ai/cordis";
import Loader, { type EntryOptions } from "@deepseek-ai/cordis-plugin-loader";
import WebServer from "@deepseek-ai/dsh-host-webserver";
import * as Control from "../../src/index.js";
import { SETTINGS_NAMESPACE } from "../../src/protocol.js";
import { FakeHosts } from "./fake-hosts.js";

export const TOKEN_ENV = "VOID_DSH_CONTROL_SPEC_TOKEN";
export const ENDPOINT = "/mcp/dsh-agent-control";
/** 组合入口 id；dsh 0.2.0 用它当设置命名空间（见 `src/protocol.ts` 的 SETTINGS_NAMESPACE）。 */
export const ENTRY_ID = SETTINGS_NAMESPACE;

const contexts: Context[] = [];

/**
 * Register a context for disposal by {@link disposeContexts}.
 *
 * For a test that must build its own bootstrap rather than use
 * {@link bootControl} — the storage-ledger startup failure, for instance, which
 * needs a Loader with no storage domain mounted.
 *
 * @param ctx - Context to dispose after the test.
 * @returns The same context, for chaining.
 */
export function trackContext(ctx: Context): Context {
  contexts.push(ctx);
  return ctx;
}

/** Dispose every context booted by {@link bootControl}; call from `afterEach`. */
export async function disposeContexts(): Promise<void> {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
}

export interface BootOptions {
  withControllers?: boolean;
  /** Entry configuration merged over the fixture defaults. */
  config?: Record<string, unknown>;
}

/**
 * Boot a real Cordis Loader with the real WebServer and stub controllers.
 *
 * The Workspace and Session controllers are stubbed rather than booted because
 * they need the whole agent/model stack; what this fixture verifies is the
 * plugin's own composition: injection, route registration, service publication,
 * event wiring and disposal.
 *
 * @param options - Fixture switches.
 * @returns The booted context, with the plugin active.
 */
export async function bootControl(options: BootOptions = {}): Promise<Context> {
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(Loader);

  const hosts = new FakeHosts();
  const controllers = {
    sessionController: {
      async list() {
        return { items: [] };
      },
      async inspect() {
        return { meta: { cwd: "E:/work/app" }, inheritedEventCount: 0, events: [] };
      },
      async create() {
        return { sessionId: "session-1" };
      },
      async fork() {
        return { sessionId: "session-2" };
      },
      async prompt() {
        return { accepted: true };
      },
      async resolveAgent() {
        return { error: { code: "session/not-found" } };
      },
      cancel() {
        return { accepted: true };
      },
    },
    workspaceController: {
      async create(request: { path: string }) {
        return { workspace: { workspaceId: "workspace-1", path: request.path, title: request.path, sessionIds: [], createdAt: "t", updatedAt: "t" }, created: true };
      },
      async *follow(signal: AbortSignal) {
        void signal;
        yield { type: "baseline", value: { items: [], archivedSessionIds: [] } };
      },
    },
  };

  const modules = new Map<string, unknown>([
    ["@deepseek-ai/dsh-host-webserver", WebServer],
    ["@void/void-dsh-control", Control],
  ]);
  ctx.loader.internal = {
    version: "v2",
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`);
      return modules.get(specifier);
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>;

  await ctx.loader.create({ name: "@deepseek-ai/dsh-host-webserver", config: { host: "127.0.0.1", port: 0 } });
  await ctx.loader.await();

  if (options.withControllers !== false) {
    ctx.provide("sessionController", controllers.sessionController);
    ctx.provide("workspaceController", controllers.workspaceController);
  }

  // 组合入口的 `id` 必须与 dsh 用的设置命名空间一致：宿主发
  // `settings/document-updated` 时带的就是 `entry.options.id`（dsh-settings 的
  // `describe()`），插件按 `SETTINGS_NAMESPACE` 过滤。这里照 profile 的
  // `cordis.patch.yml` 写同一条 id，否则「面板改完不生效」在测试里根本复现不出来。
  //
  // `EntryTree.create()` 的类型是 `Omit<EntryOptions, 'id'>`，但 `ensureId()` 只在 id
  // 缺失时才随机生成——profile 从 YAML 读进来的那批 entry 正是带 id 调进来的。
  process.env[TOKEN_ENV] = "spec-token";
  const controlEntry: EntryOptions = {
    id: ENTRY_ID,
    name: "@void/void-dsh-control",
    config: { path: ENDPOINT, ledger: "memory", tokens: [{ callerId: "spec", tokenEnv: TOKEN_ENV }], ...options.config },
  };
  await ctx.loader.create(controlEntry);
  await ctx.loader.await();
  void hosts;
  return ctx;
}

/**
 * Find the fiber one plugin was loaded into.
 *
 * @param ctx - Booted context.
 * @param pluginName - Loader entry name.
 * @returns The fiber, or `undefined`.
 */
export function findFiber(ctx: Context, pluginName: string) {
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers) {
      if (fiber.name === pluginName) return fiber;
    }
  }
  return undefined;
}

/**
 * The parsed configuration the running plugin actually holds.
 *
 * dsh 0.2.0 resolves the entry's `Config` through the real schema and hands the
 * result to `apply`; its `Volatile` fields are the very references the settings
 * panel writes to. A test that wants to simulate a panel write needs this
 * object — {@link writeSection} updates these references in place.
 *
 * @param ctx - Context booted by {@link bootControl}.
 * @returns The parsed plugin configuration.
 * @throws Error when the control plane is not loaded on this context.
 */
export function parsedConfig(ctx: Context): Control.Config {
  const fiber = findFiber(ctx, "void-dsh-control");
  if (fiber === undefined) throw new Error("the control plane is not loaded on this context");
  return fiber.config as Control.Config;
}
