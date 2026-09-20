import { Service, type Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";

declare module "@deepseek-ai/cordis" {
  interface Context {
    voidSuite: VoidSuite;
  }
}

/** Void 包的 npm scope：目录只收录这个前缀下的已登记包。 */
const VOID_SCOPE = "@void/";

/** 入口包自身：目录里列出但不可关闭。 */
const SELF_PACKAGE = "@void/void-entry";

/**
 * 展示元数据。目录的**成员**不来自这里——成员由 profile 里实际登记的
 * `@void/*` entry 决定（见 {@link VoidSuite.discover}）。这张表只补人类可读的
 * 名字与一句话说明；表里没有的包退化为「去掉 scope 的包名 + 空说明」，因此
 * 新插件装上就能出现在目录里，不必先改这张表。
 *
 * 数组顺序即目录展示顺序；表外的包排在后面，按包名字典序。
 */
const CATALOG: ReadonlyArray<{ package: string; name: string; description: string }> = [
  {
    package: "@void/void-dsh-control",
    name: "灵榜控制面",
    description: "让 Codex 等外部 AI 通过 MCP 指挥正在运行的 DSH",
  },
  { package: "@void/void-memory", name: "记忆", description: "FTS5 + sqlite-vec 知识检索" },
  { package: "@void/void-tools", name: "工具治理", description: "契约 + 角色策略" },
  { package: "@void/void-legion", name: "军团", description: "花名册 + 权威 + 派活" },
  { package: "@void/void-channel-feishu", name: "飞书渠道", description: "消息收发" },
  { package: SELF_PACKAGE, name: "虚空入口", description: "本入口（不可关闭）" },
];

const CATALOG_INDEX = new Map(CATALOG.map((entry, index) => [entry.package, index]));

/**
 * 把一个模块说明符归一化成包名。
 *
 * entry 的 `name` 可能是**子路径**（`@void/void-memory/sqlite`），一个包会有多条
 * entry 行；目录要按包聚合，所以先砍掉子路径。scope 外的说明符返回 undefined。
 */
function packageOf(specifier: string): string | undefined {
  if (!specifier.startsWith(VOID_SCOPE)) return undefined;
  const rest = specifier.slice(VOID_SCOPE.length);
  const slash = rest.indexOf("/");
  return VOID_SCOPE + (slash === -1 ? rest : rest.slice(0, slash));
}

/** 目录里的一项 = profile 里实际登记的一个 `@void/*` 包。 */
export interface VoidSuitePlugin {
  /** 包名，同时作为开关 API 的稳定 id。 */
  id: string;
  /** 人类可读的名字（缺省退化为去掉 scope 的包名）。 */
  name: string;
  description: string;
  /** 入口自身不可关。 */
  toggleable: boolean;
  /** 该包的全部 entry 行都未 disabled 时为 true。 */
  enabled: boolean;
}

/** 一个已登记包及其 entry 行 id（关一个插件 = 关它的全部 entry 行）。 */
interface DiscoveredPlugin {
  package: string;
  entryIds: string[];
  enabled: boolean;
}

export class VoidSuite extends Service {
  static inject = ["loader"];

  constructor(ctx: Context) {
    super(ctx, "voidSuite");
    // 可选：web 组合里才有的 webServer，用于 host↔client 目录与开关路由。
    //
    // **不能在构造函数里直接 `ctx.get("webServer")` 探测**：本服务的 inject 只声明
    // loader，fiber 会早于 webServer 的提供者激活，那一刻探测结果是 undefined，路由
    // 就永远注册不上（实测：`/void/api/status` 返回 404，而 inject 里声明了 webServer
    // 的 void-dsh-control 同一 profile 下 401 = 路由正常）。改用 `ctx.inject` 等它
    // 出现；headless 组合里没有 webServer，回调就一直不执行，正好不需要路由。
    ctx.inject(["webServer"], (webCtx) => {
      const webServer = webCtx.get("webServer") as WebServerLike | undefined;
      if (!webServer) return;
      webCtx.effect(
        () =>
          webServer.register({
            kind: "exact",
            path: "/void/api/status",
            handler: (_req, res) => {
              void this.handleStatus(res);
            },
          }),
        "void-entry: /void/api/status",
      );
      webCtx.effect(
        () =>
          webServer.register({
            kind: "exact",
            path: "/void/api/toggle",
            handler: (req, res) => {
              void this.handleToggle(req, res);
            },
          }),
        "void-entry: /void/api/toggle",
      );
    });
  }

  /**
   * 扫描 loader 里已登记的 `@void/*` entry，按包聚合出目录。
   *
   * 用 loader 而不是读 profile 的 `package.json`：entry 树是**当前真正装载**的
   * 内容，能自动带上「装了但被 disabled」的包（目录要显示为关），也不会因为
   * profile 清单与 entry 树不同步而虚报。代价是纯声明式、没有任何 entry 的包
   * 不会出现——那本来也点不动。
   */
  private discover(): DiscoveredPlugin[] {
    const groups = new Map<string, { entryIds: string[]; enabled: boolean }>();
    for (const entry of this.ctx.loader.entries()) {
      const name = entry.options.name;
      if (typeof name !== "string") continue;
      const packageName = packageOf(name);
      if (packageName === undefined) continue;
      const group = groups.get(packageName) ?? { entryIds: [], enabled: true };
      group.entryIds.push(entry.options.id);
      if (entry.disabled) group.enabled = false;
      groups.set(packageName, group);
    }

    return [...groups.entries()]
      .map(([packageName, group]) => ({ package: packageName, ...group }))
      .sort((a, b) => {
        const ai = CATALOG_INDEX.get(a.package) ?? Number.MAX_SAFE_INTEGER;
        const bi = CATALOG_INDEX.get(b.package) ?? Number.MAX_SAFE_INTEGER;
        if (ai !== bi) return ai - bi;
        return a.package.localeCompare(b.package);
      });
  }

  /** 目录：profile 里实际登记的全部 Void 插件。 */
  list(): VoidSuitePlugin[] {
    return this.discover().map((plugin) => {
      const meta = CATALOG.find((entry) => entry.package === plugin.package);
      return {
        id: plugin.package,
        name: meta?.name ?? plugin.package.slice(VOID_SCOPE.length),
        description: meta?.description ?? "",
        toggleable: plugin.package !== SELF_PACKAGE,
        enabled: plugin.enabled,
      };
    });
  }

  /** 当前插件是否启用（其全部 entry 都未 disabled 即启用）。 */
  isEnabled(pluginId: string): boolean {
    const found = this.discover().find((plugin) => plugin.package === pluginId);
    // 目录里没有的包不算「启用」：它根本没被登记，开关没有意义。
    return found?.enabled ?? false;
  }

  listEntryIds(pluginId: string): string[] {
    return this.discover().find((plugin) => plugin.package === pluginId)?.entryIds ?? [];
  }

  /**
   * 切换一个插件的启用状态：对其全部 entry 行设置/清除 `disabled`。
   *
   * ⚠️ **只在本次运行期间有效，重启 dsh 会恢复。** 这是 dsh 的有意设计，不是本插件的
   * 疏漏：profile 的根配置 `cordis.yml` **每次启动都被强制重写成空数组**，因为整个
   * 组合是 patch 层，loader 的 tree write-back 会把 compose 出来的行烘进根文件，下次
   * 启动就会把每个 bundle 的 insert 重复一遍（见 dsh `profile-boot` 的
   * `prepareProfile`）。所以 `entry.update()` / `loader.write()` 都落不了盘。
   *
   * 要永久关闭，得写 profile 的用户层 `cordis.patch.yml`（形如
   * `- id: void-dsh-control` + `disabled: true`）；本插件尚未实现，见方案文档
   * 「开关的持久化边界」。UI 上已如实标注为「本次运行期间」。
   */
  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    const entryIds = this.listEntryIds(pluginId);
    const updates: Array<Promise<void>> = [];
    for (const entry of this.ctx.loader.entries()) {
      if (entryIds.includes(entry.options.id)) {
        updates.push(entry.update({ disabled: enabled ? undefined : true }));
      }
    }
    await Promise.all(updates);
  }

  /** 一键开关整套（除入口自身）。 */
  async setAllEnabled(enabled: boolean): Promise<void> {
    for (const plugin of this.list()) {
      if (!plugin.toggleable) continue;
      await this.setEnabled(plugin.id, enabled);
    }
  }

  private async handleStatus(res: JsonResponseLike): Promise<void> {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ plugins: this.list() }));
  }

  private async handleToggle(req: JsonRequestLike, res: JsonResponseLike): Promise<void> {
    try {
      const body = await readJsonBody(req);
      const { pluginId, enabled } = body as { pluginId?: string; enabled?: boolean };
      if (typeof pluginId !== "string" || typeof enabled !== "boolean") {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: "pluginId + enabled are required" }));
        return;
      }
      const plugin = this.list().find((p) => p.id === pluginId);
      if (!plugin) {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: `plugin "${pluginId}" is not installed in this profile` }));
        return;
      }
      if (!plugin.toggleable) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: `plugin "${pluginId}" is not toggleable` }));
        return;
      }
      await this.setEnabled(pluginId, enabled);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  }
}

/** 结构化 restate（host 半是 node 侧，webServer 只在 web 组合里存在）。 */
interface WebServerLike {
  register(route: { kind: "exact" | "prefix"; path: string; handler: (req: JsonRequestLike, res: JsonResponseLike) => void | Promise<void> }): () => void;
}

interface JsonRequestLike {
  [Symbol.asyncIterator](): AsyncIterator<string | Uint8Array>;
}

interface JsonResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

async function readJsonBody(req: JsonRequestLike): Promise<unknown> {
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

export default VoidSuite;
