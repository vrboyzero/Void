import { Service, type Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";

declare module "@deepseek-ai/cordis" {
  interface Context {
    voidSuite: VoidSuite;
  }
}

export interface VoidSuitePlugin {
  id: string;
  name: string;
  description: string;
  /** 是否可独立开关（入口插件自身不可关）。 */
  toggleable: boolean;
}

/** Void 套装目录（静态元数据）。 */
const SUITE: VoidSuitePlugin[] = [
  { id: "void-memory", name: "记忆", description: "FTS5 + sqlite-vec 知识检索", toggleable: true },
  { id: "void-tools", name: "工具治理", description: "契约 + 角色策略", toggleable: true },
  { id: "void-legion", name: "军团", description: "花名册 + 权威 + 派活", toggleable: true },
  { id: "void-channel-feishu", name: "飞书渠道", description: "消息收发", toggleable: true },
  { id: "void-entry", name: "套装入口", description: "本入口", toggleable: false },
];

/**
 * 插件 → profile 里的 entry 行（cordis.patch.yml 的 id）。关一个插件 = 关它的
 * 全部 entry 行。耦合警示：新增插件/entry 时，先在这里登记映射。
 */
const ENTRY_IDS: Record<string, string[]> = {
  "void-memory": ["void-memory-sqlite", "void-memory-tool"],
  "void-tools": ["void-tools-contracts", "void-tools-policy"],
  "void-legion": ["void-legion"],
  "void-channel-feishu": ["void-channels"],
};

export class VoidSuite extends Service {
  static inject = ["loader"];

  constructor(ctx: Context) {
    super(ctx, "voidSuite");
    // 可选：web 组合里才有的 webServer，用于 host↔client 开关路由。
    const webServer = ctx.get("webServer") as WebServerLike | undefined;
    if (webServer) {
      webServer.register({ kind: "exact", path: "/void/api/status", handler: (req, res) => {
        void this.handleStatus(res);
      } });
      webServer.register({ kind: "exact", path: "/void/api/toggle", handler: (req, res) => {
        void this.handleToggle(req, res);
      } });
    }
  }

  list(): VoidSuitePlugin[] {
    return SUITE;
  }

  /** 当前插件是否启用（其全部 entry 都未 disabled 即启用）。 */
  isEnabled(pluginId: string): boolean {
    const entryIds = ENTRY_IDS[pluginId] ?? [];
    if (entryIds.length === 0) return true;
    for (const entry of this.ctx.loader.entries()) {
      if (entryIds.includes(entry.options.id) && entry.disabled) return false;
    }
    return true;
  }

  /**
   * 切换一个插件的启用状态：对其全部 entry 行设置/清除 `disabled`。
   * entry.update 会经 loader 持久化回 profile 的 cordis.patch.yml（HMR-safe）。
   */
  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    const entryIds = ENTRY_IDS[pluginId] ?? [];
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
    for (const plugin of SUITE) {
      if (!plugin.toggleable) continue;
      await this.setEnabled(plugin.id, enabled);
    }
  }

  private async handleStatus(res: JsonResponseLike): Promise<void> {
    const status = Object.fromEntries(SUITE.map((p) => [p.id, this.isEnabled(p.id)]));
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ plugins: SUITE.map((p) => ({ ...p, enabled: status[p.id] })) }));
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
      const plugin = SUITE.find((p) => p.id === pluginId);
      if (!plugin || !plugin.toggleable) {
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
