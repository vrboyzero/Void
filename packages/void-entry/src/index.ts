import path from "node:path";
import { fileURLToPath } from "node:url";
import { Service, type Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import {
  assertSameOrigin,
  assertTrustedMutation,
  VoidRequestRejected,
  type VoidDetailSource,
  type VoidRequestLike,
} from "./detail.js";
import {
  assertNotificationItems,
  sortNotifications,
  type VoidNotificationItem,
  type VoidNotificationSource,
} from "./notifications.js";

// 业务视图契约是入口的公开面：插件按它实现，面板按它渲染。
export {
  VOID_REQUEST_HEADER,
  VoidRequestRejected,
  type VoidDetailAction,
  type VoidDetailBody,
  type VoidDetailField,
  type VoidDetailItem,
  type VoidDetailSection,
  type VoidDetailSource,
  type VoidRequestLike,
} from "./detail.js";

// 通知契约同样是公开面（§16.2 L9 第五条）：来源落盘、入口聚合、面板补读。
export {
  assertNotificationItems,
  sortNotifications,
  type VoidNotification,
  type VoidNotificationItem,
  type VoidNotificationLevel,
  type VoidNotificationList,
  type VoidNotificationPayload,
  type VoidNotificationSource,
} from "./notifications.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    voidSuite: VoidSuite;
  }
}

/** Void 包的 npm scope：目录只收录这个前缀下的已登记包。 */
const VOID_SCOPE = "@void/";

/** 入口包自身：目录里列出但不可关闭。 */
const SELF_PACKAGE = "@void/void-entry";

const SOUL_PACKAGE = "@void/void-soul";
const MEMORY_PACKAGE = "@void/void-memory";
const LEGION_PACKAGE = "@void/void-legion";
const PREREQUISITES: Readonly<Record<string, readonly string[]>> = {
  [MEMORY_PACKAGE]: [SOUL_PACKAGE],
  [LEGION_PACKAGE]: [SOUL_PACKAGE, MEMORY_PACKAGE],
};
const DEPENDENCY_ORDER: Readonly<Record<string, number>> = {
  [SOUL_PACKAGE]: 1,
  [MEMORY_PACKAGE]: 2,
  [LEGION_PACKAGE]: 3,
};

class ToggleConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToggleConflict";
  }
}

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
  { package: SOUL_PACKAGE, name: "灵魂", description: "档案身份与系统提示词" },
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
  active: boolean;
}

/**
 * 一个配置字段的展示提示。
 *
 * 字段的**存在与类型**来自 settings namespace 的 schema（面板自己解析），这里只补
 * schema 表达不了的三件事：中文标签、用哪个控件渲染、以及帮助文字。
 */
export interface VoidPanelField {
  /** 从 namespace 根出发的路径，例如 `["callback", "url"]`。 */
  path: string[];
  /** 中文标签；缺省退化为路径末段。 */
  label?: string;
  /**
   * 控件提示。面板不认识的值退化为按 schema 类型推断，因此新增控件类型不会让
   * 旧面板渲染失败。
   */
  widget?: "switch" | "text" | "number" | "list" | "operations" | "rules" | "tokens" | "patterns" | "choices";
  /** `choices` 控件的候选项；其他控件忽略。 */
  options?: Array<{ value: string; label: string }>;
  /** 一句话说明，显示在控件下方。 */
  help?: string;
  /** 危险的开关，需要二次确认（如允许匿名调用）。 */
  danger?: boolean;
  /**
   * 只读字段：值来自组合入口（`cordis.patch.yml`）而不是设置命名空间，因此面板
   * 只展示、不提供编辑，并在旁边给出改法。
   *
   * 这类字段**不在 schema 里**，面板必须靠这个标记区分「可写，只是当前值来自
   * base」与「根本改不了」——否则会渲染出一个写了不生效的控件，那是最糟的面板
   * bug，因为它看起来像是成功了。
   */
  readOnly?: boolean;
}

/** 面板里的一组配置。分组顺序即展示顺序。 */
export interface VoidPanelGroup {
  id: string;
  title: string;
  /** 未展开时的摘要；缺省由面板按字段值生成。 */
  summary?: string;
  fields: VoidPanelField[];
  /**
   * 分组末尾的**展示区块**（不是可配置字段）。
   *
   * `connect` 让面板渲染 MCP 接入信息与可复制的客户端配置；数据取自
   * {@link VoidPanelManifest.connect} 与当前命名空间的值。渲染逻辑归面板——各客户端
   * 的配置格式是通用 MCP 知识，不是某个插件独有的。
   */
  block?: "connect";
}

/**
 * 一个插件贡献给「虚空（Void）」面板的配置清单。
 *
 * 由插件**自己**通过 `ctx.voidSuite.registerPanel()` 注册，而不是在入口里维护一张
 * 大表：字段标签、控件选择和业务词汇表都是插件自己的知识，放这边才不会两边各写
 * 一份、日久失同步。入口只负责按 schema 渲染。
 */
export interface VoidPanelManifest {
  /** 设置命名空间，面板据此取 schema 与当前值。 */
  namespace: string;
  groups: VoidPanelGroup[];
  /**
   * 业务操作词汇表：值 → 中文解释 + 它会自动带上的前置项。
   *
   * `operations` 控件用它渲染勾选矩阵，并把「你没勾但实际生效了」的前置项标出来。
   * 前置关系由插件给出（它就是运行时 `expandOperations` 的实现方），面板不重算。
   */
  operations?: Array<{ value: string; label: string; prerequisite?: boolean }>;
  /**
   * MCP 接入信息：面板据此生成可复制的客户端配置。
   *
   * **不含主机与端口**，因为面板自己就能补上——面板跑在浏览器里、与端点同源，
   * `window.location.origin` 就是调用方该用的地址。让插件去猜端口反而会猜错：端口由
   * 启动参数 `--port` 决定，插件配置里没有这个信息。路径必须由插件给，因为它是组合
   * 入口定的。
   */
  connect?: {
    /** 端点路径，如 `/mcp/dsh-agent-control`。 */
    path: string;
    /** 传输方式，用于生成的配置里标注；目前只有 `streamable-http`。 */
    transport?: string;
  };
}

interface RegisteredPanel {
  package: string;
  manifest: VoidPanelManifest;
}

/** 宿主放档案的目录名：档案目录一律是 `<DSH_HOME>/profiles/<档案名>/`。 */
export const PROFILE_DIRECTORY_NAME = "profiles";

/** 档案名规则：只认字面量，不猜、不归一化（与 `void-soul` 的数据根规则同一份口径）。 */
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** 档案名是否合法。 */
export function isProfileName(name: string): boolean {
  return PROFILE_NAME_PATTERN.test(name);
}

/**
 * 从宿主给插件的 `baseUrl` 认档案位置。
 *
 * cordis 把根配置的 include 根锚在**档案目录**上（`dsh/lib/profile-boot-*.js`：
 * 「the Loader needs a real include root to anchor `baseUrl` at the profile directory」），
 * 所以根树插件的 `ctx.baseUrl` 就是 `<DSH_HOME>/profiles/<档案名>/`。这是插件在运行期
 * 唯一能拿到的「我是哪个档案」的宿主事实——宿主从不设 `DSH_PROFILE`（2026-09-22 真机核对）。
 *
 * 形状对不上就返回 `undefined`：**绝不猜一个默认档案**去读写别人的数据。
 */
export function profileLocationFromBaseUrl(baseUrl: string | undefined): ProfileLocation | undefined {
  const raw = baseUrl?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  let directory: string;
  try {
    directory = raw.startsWith("file:") ? fileURLToPath(raw) : raw;
  } catch {
    return undefined;
  }
  if (!path.isAbsolute(directory)) return undefined;
  const resolved = path.resolve(directory);
  const parent = path.dirname(resolved);
  if (path.basename(parent) !== PROFILE_DIRECTORY_NAME) return undefined;
  const name = path.basename(resolved);
  if (!isProfileName(name)) return undefined;
  const home = path.dirname(parent);
  return path.isAbsolute(home) ? { home, name } : undefined;
}

/**
 * 档案位置从哪儿来，按可信度排：目标宿主的 `profileContext` > 显式环境变量
 * （`DSH_HOME` + `DSH_PROFILE`）> 宿主给的档案目录（`ctx.baseUrl`）。
 *
 * 前两条是「有人明确说了」，第三条是「宿主就是这么起的」：装包的人少设一个环境变量时，
 * 第三条仍然认得出正在跑的是哪个档案，不必让整棵插件树带着空数据根活着。
 */
export function resolveProfileLocation(
  webCtx: { get(name: string): unknown; baseUrl?: string | undefined },
  env: NodeJS.ProcessEnv = process.env,
): ProfileLocation | undefined {
  const profile = webCtx.get("profileContext") as { home?: unknown; name?: unknown } | undefined;
  if (profile && typeof profile.home === "string" && typeof profile.name === "string") return { home: profile.home, name: profile.name };
  const home = env.DSH_HOME?.trim();
  const name = env.DSH_PROFILE?.trim();
  if (home && name && path.isAbsolute(home)) return { home, name };
  return profileLocationFromBaseUrl(webCtx.baseUrl);
}

export interface ProfileLocation {
  home: string;
  name: string;
}

export interface FacetVersionSource {
  load(input: ProfileLocation): Promise<ReadonlyArray<{ id: string; title: string; lines: readonly string[] }>>;
  save?(input: ProfileLocation & { agentId: string; facetId: string | null; expectedRevision: number }): Promise<unknown>;
}

export class VoidSuite extends Service {
  static inject = ["loader"];

  private toggleQueue: Promise<void> = Promise.resolve();

  /** 各插件贡献的面板清单，按包名索引。 */
  private readonly panels = new Map<string, VoidPanelManifest>();
  /** 各插件贡献的业务详情视图，按视图 id 索引。 */
  private readonly details = new Map<string, VoidDetailSource>();
  /** 各插件贡献的通知来源，按来源 id 索引（§16.2 L9 第五条的补读入口）。 */
  private readonly notices = new Map<string, VoidNotificationSource>();
  private facetVersions: FacetVersionSource | undefined;

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
      webCtx.effect(
        () =>
          webServer.register({
            kind: "exact",
            path: "/void/api/panels",
            handler: (_req, res) => {
              void this.handlePanels(res);
            },
          }),
        "void-entry: /void/api/panels",
      );
      webCtx.effect(
        () =>
          webServer.register({
            kind: "exact",
            path: "/void/api/facet-versions",
            handler: (_req, res) => {
              void this.handleFacetVersions(webCtx, res);
            },
          }),
        "void-entry: /void/api/facet-versions",
      );
      webCtx.effect(
        () =>
          webServer.register({
            kind: "exact",
            path: "/void/api/facet-selection",
            handler: (req, res) => {
              void this.handleFacetSelection(webCtx, req, res);
            },
          }),
        "void-entry: /void/api/facet-selection",
      );
      webCtx.effect(
        () =>
          webServer.register({
            kind: "exact",
            path: "/void/api/detail",
            handler: (req, res) => {
              void this.handleDetail(webCtx, req, res);
            },
          }),
        "void-entry: /void/api/detail",
      );
      // 通知：GET 补读（断线重连后第一件事），POST 只做「标记已读」。
      webCtx.effect(
        () =>
          webServer.register({
            kind: "exact",
            path: "/void/api/notifications",
            handler: (req, res) => {
              void this.handleNotifications(req, res);
            },
          }),
        "void-entry: /void/api/notifications",
      );
    });
  }

  /** 由灵魂插件登记只读来源。未登记时查询返回空列表，不猜测数据根。 */
  registerFacetVersions(source: FacetVersionSource): () => void {
    this.facetVersions = source;
    return () => {
      if (this.facetVersions === source) this.facetVersions = undefined;
    };
  }

  /**
   * 登记一个业务详情视图。
   *
   * 视图 id 重复直接抛：两个插件抢同一个 id 意味着其中一个**静默**不生效，而面板上
   * 看起来一切正常——这种错必须在装载时就炸出来，而不是等用户发现数据不对。
   *
   * @param source - 视图实现（列表/详情/可选保存与动作）。
   * @returns 注销函数。
   */
  registerDetail(source: VoidDetailSource): () => void {
    const existing = this.details.get(source.id);
    if (existing !== undefined && existing !== source) throw new Error(`业务视图 id 重复: ${source.id}`);
    this.details.set(source.id, source);
    return () => {
      // 只在仍是我们登记的那一份时删除，避免误删后来者的覆盖。
      if (this.details.get(source.id) === source) this.details.delete(source.id);
    };
  }

  /** 已登记的业务视图 id（按登记顺序）。 */
  detailViewIds(): string[] {
    return [...this.details.keys()];
  }

  /**
   * 已登记业务视图的目录项。
   *
   * 面板需要知道**有哪些视图**才谈得上打开它们，而视图 id 只有这里知道；所以随
   * `/void/api/panels` 一起给出去，客户端不必硬编码任何业务 id（§16.1 的通用渲染器）。
   */
  detailManifests(): Array<{ id: string; title: string }> {
    return [...this.details.values()].map((source) => ({ id: source.id, title: source.title }));
  }

  /**
   * 登记一个通知来源。
   *
   * 和业务视图同样的规矩：**id 重复直接抛**。两个来源抢同一个 id 时，「标记已读」会
   * 送到错的那一个，而面板上看起来一切正常。
   *
   * @param source - 来源实现（`list` 必给，`markRead` 可选）。
   * @returns 注销函数。
   */
  registerNotificationSource(source: VoidNotificationSource): () => void {
    const existing = this.notices.get(source.id);
    if (existing !== undefined && existing !== source) throw new Error(`通知来源 id 重复: ${source.id}`);
    this.notices.set(source.id, source);
    return () => {
      if (this.notices.get(source.id) === source) this.notices.delete(source.id);
    };
  }

  /** 已登记的通知来源 id（按登记顺序）。 */
  notificationSourceIds(): string[] {
    return [...this.notices.keys()];
  }

  /** 已登记通知来源的目录项（随 `/void/api/panels` 给面板）。 */
  notificationManifests(): Array<{ id: string; title: string }> {
    return [...this.notices.values()].map((source) => ({ id: source.id, title: source.title }));
  }

  /**
   * 登记一个插件的面板清单。
   *
   * 由插件在自己的 `ctx.inject(["voidSuite"], ...)` 里调用，因此不装在某个
   * profile 里的插件不会留下任何痕迹；disposer 随 fiber 卸载回收。
   *
   * @param packageName - 贡献方包名，须与目录里的 id 一致。
   * @param manifest - 分组、字段提示与业务词汇表。
   * @returns 注销函数。
   */
  registerPanel(packageName: string, manifest: VoidPanelManifest): () => void {
    this.panels.set(packageName, manifest);
    return () => {
      // 只在仍是我们登记的那一份时删除，避免误删后来者的覆盖。
      if (this.panels.get(packageName) === manifest) this.panels.delete(packageName);
    };
  }

  /** 已登记的面板清单，按包名索引。 */
  panelManifests(): Record<string, VoidPanelManifest> {
    return Object.fromEntries(this.panels);
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
    const groups = new Map<string, { entryIds: string[]; enabled: boolean; active: boolean }>();
    for (const entry of this.ctx.loader.entries()) {
      const name = entry.options.name;
      if (typeof name !== "string") continue;
      const packageName = packageOf(name);
      if (packageName === undefined) continue;
      const group = groups.get(packageName) ?? { entryIds: [], enabled: true, active: false };
      group.entryIds.push(entry.options.id);
      if (entry.disabled) group.enabled = false;
      else group.active = true;
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
  setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    return this.queueToggle(() => this.setEnabledNow(pluginId, enabled));
  }

  /** 一键开关整套（除入口自身）。 */
  setAllEnabled(enabled: boolean): Promise<void> {
    return this.queueToggle(async () => {
      const installed = this.discover().filter((plugin) => plugin.package !== SELF_PACKAGE);
      if (enabled) {
        for (const plugin of installed) {
          for (const prerequisite of PREREQUISITES[plugin.package] ?? []) {
            if (!installed.some((item) => item.package === prerequisite)) {
              throw new ToggleConflict(`无法开启整套：${this.pluginName(plugin.package)}缺少已安装的${this.pluginName(prerequisite)}插件`);
            }
          }
        }
      }
      installed.sort((left, right) =>
        (DEPENDENCY_ORDER[left.package] ?? 0) - (DEPENDENCY_ORDER[right.package] ?? 0));
      if (!enabled) installed.reverse();
      for (const plugin of installed) await this.setEnabledNow(plugin.package, enabled);
    });
  }

  private pluginName(pluginId: string): string {
    return CATALOG.find((item) => item.package === pluginId)?.name ?? pluginId;
  }

  private queueToggle(operation: () => Promise<void>): Promise<void> {
    const pending = this.toggleQueue.then(operation);
    this.toggleQueue = pending.catch(() => undefined);
    return pending;
  }

  private async setEnabledNow(pluginId: string, enabled: boolean): Promise<void> {
    const installed = this.discover();
    const target = installed.find((plugin) => plugin.package === pluginId);
    if (!target || pluginId === SELF_PACKAGE) throw new ToggleConflict(`插件 ${pluginId} 不可切换`);
    if (enabled) {
      const missing = (PREREQUISITES[pluginId] ?? [])
        .filter((prerequisite) => !installed.find((plugin) => plugin.package === prerequisite)?.enabled);
      if (missing.length > 0) {
        throw new ToggleConflict(`请先开启${missing.map((id) => this.pluginName(id)).join("、")}，再开启${this.pluginName(pluginId)}`);
      }
    } else {
      const blockers = installed.filter((plugin) => plugin.active &&
        (PREREQUISITES[plugin.package] ?? []).includes(pluginId));
      if (blockers.length > 0) {
        throw new ToggleConflict(`请先关闭${blockers.map((plugin) => this.pluginName(plugin.package)).join("、")}，再关闭${this.pluginName(pluginId)}`);
      }
    }
    const entries = [...this.ctx.loader.entries()].filter((entry) => target.entryIds.includes(entry.options.id));
    const attempted: Array<{ entry: (typeof entries)[number]; disabled: (typeof entries)[number]["options"]["disabled"] }> = [];
    try {
      for (const entry of entries) {
        attempted.push({ entry, disabled: entry.options.disabled });
        await entry.update({ disabled: enabled ? undefined : true });
      }
      await this.ctx.loader.await();
      const current = this.discover().find((plugin) => plugin.package === pluginId);
      if (enabled ? !current?.enabled : current?.active) {
        throw new ToggleConflict(`${this.pluginName(pluginId)}仍被上层配置禁用或未能完整切换，请检查 profile 配置`);
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const { entry, disabled } of attempted.reverse()) {
        try {
          await entry.update({ disabled });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      await this.ctx.loader.await();
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], `${this.pluginName(pluginId)}切换失败且回滚未完成，请重读插件状态`);
      }
      throw error;
    }
  }

  private async handleStatus(res: JsonResponseLike): Promise<void> {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ plugins: this.list() }));
  }

  private async handleFacetVersions(webCtx: Context, res: JsonResponseLike): Promise<void> {
    const profile = resolveProfileLocation(webCtx);
    if (!profile || !this.facetVersions) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ versions: [] }));
      return;
    }
    const versions = await this.facetVersions.load({ home: profile.home, name: profile.name });
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ versions }));
  }

  private async handleFacetSelection(webCtx: Context, req: JsonRequestLike, res: JsonResponseLike): Promise<void> {
    try {
      assertTrustedMutation(req);
    } catch (error) {
      rejectRequest(res, error);
      return;
    }
    const profile = resolveProfileLocation(webCtx);
    if (!profile || !this.facetVersions?.save) {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: "facet selection is unavailable" }));
      return;
    }
    const body = await readJsonBody(req) as { agentId?: unknown; facetId?: unknown; expectedRevision?: unknown };
    if (typeof body.agentId !== "string" || (body.facetId !== null && typeof body.facetId !== "string") || typeof body.expectedRevision !== "number") {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "agentId, facetId, expectedRevision are required" }));
      return;
    }
    try {
      const saved = await this.facetVersions.save({ ...profile, agentId: body.agentId, facetId: body.facetId, expectedRevision: body.expectedRevision });
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, saved }));
    } catch (error) {
      res.statusCode = 409;
      res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  }

  private async handlePanels(res: JsonResponseLike): Promise<void> {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        panels: this.panelManifests(),
        details: this.detailManifests(),
        notifications: this.notificationManifests(),
      }),
    );
  }

  private async handleToggle(req: JsonRequestLike, res: JsonResponseLike): Promise<void> {
    try {
      assertTrustedMutation(req);
      const body = await readJsonBody(req);
      const { pluginId, enabled } = body as { pluginId?: string; enabled?: boolean };
      if (typeof pluginId !== "string" || typeof enabled !== "boolean") {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: "pluginId + enabled are required" }));
        return;
      }
      if (pluginId === "*") {
        await this.setAllEnabled(enabled);
        sendJson(res, 200, { ok: true, plugins: this.list() });
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
      sendJson(res, 200, { ok: true, plugins: this.list() });
    } catch (error) {
      if (error instanceof ToggleConflict) {
        sendJson(res, 409, { ok: false, error: error.message });
      } else {
        rejectRequest(res, error);
      }
    }
  }

  /**
   * 业务详情的读写：`GET` 读（列表或单条），`POST` 写（`op: "save" | "act"`）。
   *
   * 读也核对同源。跨站页面读不到响应（我们没有 CORS 头），但 DNS rebinding 下
   * 「同源」可以是假的，多一道核对不亏。
   */
  private async handleDetail(webCtx: Context, req: JsonRequestLike, res: JsonResponseLike): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    if (method === "GET") {
      await this.handleDetailRead(webCtx, req, res);
      return;
    }
    if (method === "POST") {
      await this.handleDetailWrite(webCtx, req, res);
      return;
    }
    sendJson(res, 405, { ok: false, error: `不支持的方法: ${method}` });
  }

  private async handleDetailRead(webCtx: Context, req: JsonRequestLike, res: JsonResponseLike): Promise<void> {
    try {
      assertSameOrigin(req);
    } catch (error) {
      rejectRequest(res, error);
      return;
    }
    const view = readQuery(req.url, "view");
    if (view === undefined) {
      sendJson(res, 400, { ok: false, error: "缺少业务视图 id（?view=）" });
      return;
    }
    const source = this.details.get(view);
    if (source === undefined) {
      sendJson(res, 404, { ok: false, error: `没有这个业务视图: ${view}` });
      return;
    }
    const profile = resolveProfileLocation(webCtx);
    if (!profile) {
      // 不返回空列表：那看起来像「没有数据」，而真实原因是位置没解析出来。
      sendJson(res, 404, { ok: false, error: "无法确定档案位置：需要 profileContext、宿主给的档案目录（ctx.baseUrl），或 DSH_HOME + DSH_PROFILE" });
      return;
    }
    const itemId = readQuery(req.url, "itemId");
    const query = readQuery(req.url, "q");
    try {
      if (itemId === undefined) {
        // 视图级动作随列表一起给：面板要在列表上方就能画出「新建」这类按钮，
        // 不必先点开某一条才知道能做什么。检索声明同理——搜索框也要在列表上方。
        const actions = source.viewActions ?? [];
        const listed = await source.list({
          home: profile.home,
          name: profile.name,
          ...(query === undefined ? {} : { query }),
        });
        // 只返回数组的视图照旧能用；带 `note` 的（截断、读不出来的档案）原样透传，
        // 由面板显示在列表上方——列表被截断这件事必须说出来。
        // 这里不用 `Array.isArray`：它只收窄到 `any[]`，而只读数组不是 `any[]`，
        // 联合类型两边都留着，反而取不出 `items`。有 `items` 字段的就是列表结果。
        const items = "items" in listed ? listed.items : listed;
        const note = "items" in listed ? listed.note : undefined;
        sendJson(res, 200, {
          view,
          title: source.title,
          items,
          ...(query === undefined ? {} : { query }),
          ...(note === undefined ? {} : { note }),
          ...(actions.length === 0 ? {} : { actions }),
          ...(source.search === undefined ? {} : { search: source.search }),
        });
        return;
      }
      const detail = await source.detail({ home: profile.home, name: profile.name, itemId });
      sendJson(res, 200, { view, title: source.title, detail });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * 通知：`GET` 补读（重连后第一件事），`POST` 只做「标记已读」。
   *
   * 读也核对同源：通知里带的是本机运行状态与结果路径，和业务视图同一条理由，
   * 不该让跨站页面读走。
   */
  private async handleNotifications(req: JsonRequestLike, res: JsonResponseLike): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    if (method === "GET") {
      await this.handleNotificationsRead(req, res);
      return;
    }
    if (method === "POST") {
      await this.handleNotificationsWrite(req, res);
      return;
    }
    sendJson(res, 405, { ok: false, error: `不支持的方法: ${method}` });
  }

  /**
   * 补读：把所有来源的条目合成一栏。
   *
   * **一个来源坏掉不能拖垮整栏**：读不出来的来源降级成一条 note，其余照常显示——面板
   * 少一栏通知和少一次运行的记录，后者严重得多。而「一个来源都没登记」与「来源都在、
   * 只是没有通知」在响应里分得开（`sources` 为空 vs `items` 为空），面板才好说人话。
   */
  private async handleNotificationsRead(req: JsonRequestLike, res: JsonResponseLike): Promise<void> {
    try {
      assertSameOrigin(req);
    } catch (error) {
      rejectRequest(res, error);
      return;
    }
    const items: VoidNotificationItem[] = [];
    const notes: string[] = [];
    for (const source of this.notices.values()) {
      try {
        const listed = await source.list();
        // 同 handleDetailRead：只读数组不是 `any[]`，`Array.isArray` 收窄不了联合类型，
        // 所以按「有没有 items 字段」分支。
        const entries = "items" in listed ? listed.items : listed;
        const note = "items" in listed ? listed.note : undefined;
        for (const item of assertNotificationItems(source.id, entries)) {
          items.push({ ...item, source: source.id, sourceTitle: source.title });
        }
        if (note !== undefined) notes.push(note);
      } catch (error) {
        notes.push(
          `通知来源 ${source.title}（${source.id}）读不出来：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const sorted = sortNotifications(items);
    sendJson(res, 200, {
      items: sorted,
      unread: sorted.filter((item) => item.read !== true).length,
      sources: this.notificationManifests(),
      notes,
    });
  }

  /**
   * 标记已读：通知栏**唯一的写操作**。
   *
   * 入口不替来源改事实（通知内容只有产生它的插件知道对不对），只转发「人看过了」这一件事。
   */
  private async handleNotificationsWrite(req: JsonRequestLike, res: JsonResponseLike): Promise<void> {
    try {
      assertTrustedMutation(req);
      const body = (await readJsonBody(req)) as { op?: unknown; source?: unknown; ids?: unknown };
      const op = typeof body.op === "string" ? body.op : "read";
      if (op !== "read") {
        sendJson(res, 400, { ok: false, error: `不认识的 op: ${op}（只认 read）` });
        return;
      }
      const source = typeof body.source === "string" && body.source !== "" ? body.source : undefined;
      if (source === undefined) {
        sendJson(res, 400, { ok: false, error: "source 是必填（通知来源 id）" });
        return;
      }
      const target = this.notices.get(source);
      if (target === undefined) {
        sendJson(res, 404, { ok: false, error: `没有这个通知来源: ${source}` });
        return;
      }
      if (target.markRead === undefined) {
        sendJson(res, 400, { ok: false, error: `这个通知来源不支持标记已读: ${source}` });
        return;
      }
      const ids = Array.isArray(body.ids)
        ? body.ids.filter((id): id is string => typeof id === "string" && id !== "")
        : [];
      if (ids.length === 0) {
        sendJson(res, 400, { ok: false, error: "ids 是必填（要标记已读的通知 id）" });
        return;
      }
      const marked = await target.markRead(ids);
      sendJson(res, 200, {
        ok: true,
        source,
        requested: ids.length,
        ...(typeof marked === "number" ? { marked } : {}),
      });
    } catch (error) {
      rejectRequest(res, error);
    }
  }

  private async handleDetailWrite(webCtx: Context, req: JsonRequestLike, res: JsonResponseLike): Promise<void> {
    try {
      assertTrustedMutation(req);
    } catch (error) {
      rejectRequest(res, error);
      return;
    }
    const profile = resolveProfileLocation(webCtx);
    if (!profile) {
      sendJson(res, 404, { ok: false, error: "无法确定档案位置：需要 profileContext、宿主给的档案目录（ctx.baseUrl），或 DSH_HOME + DSH_PROFILE" });
      return;
    }
    const body = (await readJsonBody(req)) as {
      view?: unknown;
      op?: unknown;
      itemId?: unknown;
      expectedRevision?: unknown;
      changes?: unknown;
      actionId?: unknown;
      args?: unknown;
    };
    const view = typeof body.view === "string" ? body.view : undefined;
    if (view === undefined) {
      sendJson(res, 400, { ok: false, error: "view 是必填" });
      return;
    }
    const source = this.details.get(view);
    if (source === undefined) {
      sendJson(res, 404, { ok: false, error: `没有这个业务视图: ${view}` });
      return;
    }
    const itemId = typeof body.itemId === "string" && body.itemId.trim() !== "" ? body.itemId : undefined;
    const op = body.op ?? "save";
    // 视图级动作没有条目：只有 `act` 允许不给 itemId（走 actView）。其余操作都得指名条目，
    // 否则「保存」会变成一次不知道改谁的操作。
    if (itemId === undefined && op !== "act") {
      sendJson(res, 400, { ok: false, error: "itemId 是必填" });
      return;
    }
    const home = profile.home;
    const name = profile.name;
    // 来源抛出的错误一律回 409：面板对「冲突」与「校验失败」的处理是同一件事——
    // 保留草稿、把原因显示出来。真实原因在 error 里，没有被抹掉。
    try {
      if (op === "save") {
        if (itemId === undefined) {
          sendJson(res, 400, { ok: false, error: "itemId 是必填" });
          return;
        }
        if (source.save === undefined) {
          sendJson(res, 400, { ok: false, error: `这个视图不支持保存: ${view}` });
          return;
        }
        const revision = body.expectedRevision;
        const revisionOk =
          (typeof revision === "number" && Number.isInteger(revision)) ||
          (typeof revision === "string" && revision.trim() !== "");
        if (!revisionOk) {
          sendJson(res, 400, { ok: false, error: "expectedRevision 必须是整数或非空字符串" });
          return;
        }
        if (body.changes === null || typeof body.changes !== "object" || Array.isArray(body.changes)) {
          sendJson(res, 400, { ok: false, error: "changes 必须是对象" });
          return;
        }
        const detail = await source.save({
          home,
          name,
          itemId,
          expectedRevision: revision as number | string,
          changes: body.changes as Record<string, unknown>,
        });
        sendJson(res, 200, { ok: true, view, detail });
        return;
      }
      if (op === "act") {
        if (typeof body.actionId !== "string" || body.actionId.trim() === "") {
          sendJson(res, 400, { ok: false, error: "actionId 是必填" });
          return;
        }
        const args = body.args === undefined ? {} : body.args;
        if (args === null || typeof args !== "object" || Array.isArray(args)) {
          sendJson(res, 400, { ok: false, error: "args 必须是对象" });
          return;
        }
        if (itemId === undefined) {
          if (source.actView === undefined) {
            sendJson(res, 400, { ok: false, error: `这个视图不支持整体动作: ${view}` });
            return;
          }
          await source.actView({ home, name, actionId: body.actionId, args: args as Record<string, unknown> });
          // 不回详情：视图级动作没有「当前条目」，面板随后重读列表。
          sendJson(res, 200, { ok: true, view, scope: "view" });
          return;
        }
        if (source.act === undefined) {
          sendJson(res, 400, { ok: false, error: `这个视图不支持动作: ${view}` });
          return;
        }
        // 动作也可以带修订栅（删除、取消这类破坏性动作）：带了就必须合法，没带就是没栅。
        // 面板对同一份数据用同一条规则，来源不必自己再判一次类型。
        const actRevision = body.expectedRevision;
        const actRevisionOk =
          actRevision === undefined ||
          (typeof actRevision === "number" && Number.isInteger(actRevision)) ||
          (typeof actRevision === "string" && actRevision.trim() !== "");
        if (!actRevisionOk) {
          sendJson(res, 400, { ok: false, error: "expectedRevision 必须是整数或非空字符串" });
          return;
        }
        const detail = await source.act({
          home,
          name,
          itemId,
          actionId: body.actionId,
          args: args as Record<string, unknown>,
          ...(actRevision === undefined ? {} : { expectedRevision: actRevision as number | string }),
        });
        sendJson(res, 200, { ok: true, view, detail });
        return;
      }
      sendJson(res, 400, { ok: false, error: `不认识的 op: ${String(op)}（只认 save / act）` });
    } catch (error) {
      sendJson(res, 409, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** 结构化 restate（host 半是 node 侧，webServer 只在 web 组合里存在）。 */
interface WebServerLike {
  register(route: { kind: "exact" | "prefix"; path: string; handler: (req: JsonRequestLike, res: JsonResponseLike) => void | Promise<void> }): () => void;
}

interface JsonRequestLike extends VoidRequestLike {
  [Symbol.asyncIterator](): AsyncIterator<string | Uint8Array>;
}

interface JsonResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

function sendJson(res: JsonResponseLike, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

/** 门禁拒绝回它自己的状态码（403），其余按 500——不是所有错误都是「用户请求不对」。 */
function rejectRequest(res: JsonResponseLike, error: unknown): void {
  const statusCode = error instanceof VoidRequestRejected ? error.statusCode : 500;
  sendJson(res, statusCode, { ok: false, error: error instanceof Error ? error.message : String(error) });
}

/** 取查询参数；空串按「没给」处理，免得 `?view=` 变成一次查空 id 的调用。 */
function readQuery(url: string | undefined, key: string): string | undefined {
  if (url === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url, "http://void.local");
  } catch {
    return undefined;
  }
  const value = parsed.searchParams.get(key)?.trim();
  return value === undefined || value === "" ? undefined : value;
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
