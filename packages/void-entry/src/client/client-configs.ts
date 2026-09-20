/**
 * MCP 客户端配置生成。
 *
 * 面板在这里比文档强的地方是**值是真的**：地址取自 `window.location.origin`（面板与
 * 端点同源），路径取自插件清单里的实际配置，变量名与授权范围取自当前 live settings。
 * 文档只能给一份硬编码端口的样例。
 *
 * 每种格式都注明出处与查证日期。**没有查证过的格式一律不生成**——生成一个「看起来
 * 能用、粘上去报错」的配置，比在文档里贴一份概念样例更糟。所以这里每个 recipe 都要
 * 带 `source` 字段，且必须是真读过的原始文档。
 *
 * @module @void/void-entry/client/client-configs
 */

/** 生成一份配置所需的上下文，全部来自实时值。 */
export interface ConnectContext {
  /** 端点完整 URL：`window.location.origin` + 清单里的路径。 */
  url: string;
  /** 该调用方的 token **环境变量名**；值本身永远不出现。 */
  tokenEnv: string;
  /** 调用方身份，用作配置里的 server 名。 */
  callerId: string;
}

/** 一种客户端的配置写法。 */
export interface ClientRecipe {
  id: string;
  label: string;
  /** 配置文件位置，直接显示给用户。 */
  location: string;
  language: "json" | "toml";
  /** 本插件推荐优先用它；界面上排前面并标注。 */
  recommended?: boolean;
  /** 出处：真读过的原始文档 URL。 */
  source: string;
  /** 查证日期，`YYYY-MM-DD`。 */
  verifiedAt: string;
  /** 这个客户端上容易配错的点；没有就省略。 */
  note?: string;
  /** 生成可粘贴的配置正文。 */
  render: (ctx: ConnectContext) => string;
}

/**
 * 把调用方身份转成配置里的 server 名。
 *
 * 各客户端对键名的字符集要求不同，统一收敛到 `[A-Za-z0-9_-]`：空格转连字符，其余
 * 非法字符去掉。空身份退化为 `dsh-control`，否则会生成一个非法键名。
 *
 * @param callerId - 调用方身份。
 * @returns 可用作配置键的名字。
 */
export function serverName(callerId: string): string {
  const cleaned = callerId.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9_-]/g, "");
  return cleaned === "" ? "dsh-control" : cleaned;
}

/**
 * Codex CLI：`~/.codex/config.toml` 的 `[mcp_servers.*]`，原生支持 Streamable HTTP。
 *
 * 这是**最贴合本插件模型**的一份：Codex 有专门的 `bearer_token_env_var`，暗号本身
 * 完全不必进配置文件。
 */
const codex: ClientRecipe = {
  id: "codex",
  label: "Codex CLI",
  location: "~/.codex/config.toml",
  language: "toml",
  recommended: true,
  source: "https://github.com/openai/codex/blob/main/docs/config.md",
  verifiedAt: "2026-09-20",
  note:
    "bearer_token_env_var 让暗号留在环境变量里——和本插件「token 只从环境变量读」的契约正好一致。",
  render: (ctx) =>
    [
      `[mcp_servers.${serverName(ctx.callerId)}]`,
      `url = ${JSON.stringify(ctx.url)}`,
      `bearer_token_env_var = ${JSON.stringify(ctx.tokenEnv)}`,
      "",
    ].join("\n"),
};

/**
 * Cursor：`.cursor/mcp.json`（项目级）或 `~/.cursor/mcp.json`（全局），两者合并。
 *
 * **远程 server 的官方示例不写 `type`**，只用 `url` + `headers`；写 `type` 反而可能
 * 被拒。`${env:NAME}` 的插值语法是官方文档化的，`headers` 明确在支持列表内。
 */
const cursor: ClientRecipe = {
  id: "cursor",
  label: "Cursor",
  location: ".cursor/mcp.json（项目级）或 ~/.cursor/mcp.json",
  language: "json",
  recommended: true,
  source: "https://cursor.com/docs/mcp",
  verifiedAt: "2026-09-20",
  note:
    "远程 server 不要写 type——官方示例没有这个字段。插值语法是 ${env:NAME}（带 env: 前缀），" +
    "读的是 Cursor 进程自己的环境，所以设完环境变量要重启 Cursor。远程 server 也不支持 envFile。",
  render: (ctx) =>
    JSON.stringify(
      {
        mcpServers: {
          [serverName(ctx.callerId)]: {
            url: ctx.url,
            headers: { Authorization: `Bearer \${env:${ctx.tokenEnv}}` },
          },
        },
      },
      null,
      2,
    ) + "\n",
};

/**
 * Claude Code：`.mcp.json`（项目级）或 `~/.claude.json`。
 *
 * 与 Cursor 相反，Claude Code **要求 `url` 条目必须带 `type`**，缺了会直接跳过该
 * server 并报 `MCP server "<name>" has a "url" but no "type"`。规范值是 `http`
 * （`streamable-http` 是别名）。
 */
const claudeCode: ClientRecipe = {
  id: "claude-code",
  label: "Claude Code",
  location: ".mcp.json（项目级）或 ~/.claude.json",
  language: "json",
  source: "https://docs.claude.com/en/docs/claude-code/mcp",
  verifiedAt: "2026-09-20",
  note:
    "和 Cursor 相反：这里 type 是必需的，缺了会被跳过并报错。取值用 http" +
    "（streamable-http 只是别名）。",
  render: (ctx) =>
    JSON.stringify(
      {
        mcpServers: {
          [serverName(ctx.callerId)]: {
            type: "http",
            url: ctx.url,
            headers: { Authorization: `Bearer \${${ctx.tokenEnv}}` },
          },
        },
      },
      null,
      2,
    ) + "\n",
};

/** Claude Desktop 的桥接变量名：整段 `Bearer <token>` 放这里，绕开 Windows 空格 bug。 */
function desktopAuthVar(tokenEnv: string): string {
  return `${tokenEnv}_AUTH`;
}

/**
 * Claude Desktop：`claude_desktop_config.json`，**必须经 `mcp-remote` 桥接**。
 *
 * 它的用户级配置文件从设计上只接 stdio server（官方配置参考原文：「Local stdio
 * servers added via the Developer settings. Remote servers come from the managed list
 * above or organization plugins.」），文件化的远程路线只有企业 MDM，而 MDM 要求 HTTPS、
 * 字段名叫 `transport`、且 `headers` 注明「No credentials here」。我们这条
 * `http://127.0.0.1` 带 bearer 的路线在用户配置里没有原生位置。
 *
 * Windows 上还有个已知问题（`mcp-remote` README 点名）：args 里的空格不转义。官方
 * workaround 是冒号后不留空格、把整段 `Bearer <token>` 放进变量值——所以这里用一个
 * 派生变量名，而不是复用 `tokenEnv`。
 */
const claudeDesktop: ClientRecipe = {
  id: "claude-desktop",
  label: "Claude Desktop",
  location: "%APPDATA%\\Claude\\claude_desktop_config.json",
  language: "json",
  source: "https://claude.com/docs/third-party/claude-desktop/configuration",
  verifiedAt: "2026-09-20",
  // 只说「为什么这条路线更差」。那个额外变量怎么设，由界面上的警告框专门讲——两处都讲
  // 会读起来像复读。
  note:
    "它的用户级配置文件只接 stdio server，远程路线必须经 mcp-remote 桥接、要联网拉包，" +
    "比前两种脆弱。能用 Codex / Cursor 就别用它。",
  render: (ctx) =>
    JSON.stringify(
      {
        mcpServers: {
          [serverName(ctx.callerId)]: {
            command: "npx",
            args: [
              "mcp-remote",
              ctx.url,
              "--transport",
              "http-only",
              "--header",
              `Authorization:\${${desktopAuthVar(ctx.tokenEnv)}}`,
            ],
          },
        },
      },
      null,
      2,
    ) + "\n",
};

/**
 * 兜底：没有单独列出的客户端。
 *
 * **刻意不写 `type`**。实测各家的字段名与取值并不统一（Cursor 不写、Claude Code 要
 * `type: "http"`、VS Code 同样用 `http`、Claude Desktop 叫 `transport`），一份「通用」
 * 片段不可能对所有客户端都成立。这里给最小可辨认的形状，并明确要求用户去核字段名。
 */
const generic: ClientRecipe = {
  id: "generic",
  label: "其他客户端",
  location: "按你的客户端文档",
  language: "json",
  source: "https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http",
  verifiedAt: "2026-09-20",
  note:
    "这只是最小形状。各客户端的字段名并不统一：Cursor 不写 type，Claude Code 与 VS Code " +
    "要 type: \"http\"，Claude Desktop 的字段叫 transport。粘之前务必对照你所用客户端的" +
    "文档核一遍。",
  render: (ctx) =>
    JSON.stringify(
      {
        mcpServers: {
          [serverName(ctx.callerId)]: {
            url: ctx.url,
            headers: { Authorization: `Bearer \${${ctx.tokenEnv}}` },
          },
        },
      },
      null,
      2,
    ) + "\n",
};
/** 按展示顺序排列的全部配方；`recommended` 的排在前面并标出来。 */
export const CLIENT_RECIPES: readonly ClientRecipe[] = [codex, cursor, claudeCode, claudeDesktop, generic];

/** 面板能自动补出的部分：地址与路径。 */
export interface EndpointParts {
  /** 清单里的端点路径。 */
  path: string;
}

/**
 * 拼出调用方该用的完整地址。
 *
 * 主机与端口取自浏览器当前位置而不是配置——面板与端点同源，所以这是**唯一**能自动
 * 得到正确端口的方式（端口由启动参数决定，插件配置里没有）。
 *
 * @param path - 清单里的端点路径。
 * @param origin - 站点 origin；默认取当前文档，测试可注入。
 * @returns 完整 URL。
 */
export function endpointUrl(path: string, origin?: string): string {
  const base =
    origin ?? (typeof window === "undefined" ? "http://127.0.0.1" : window.location.origin);
  // 去掉重复斜杠：路径以 / 开头，origin 不以 / 结尾。
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** 自检脚本默认读取的环境变量名；与它保持一致才不会生成多余参数。 */
const SMOKE_DEFAULT_TOKEN_ENV = "VOID_DSH_CONTROL_TOKEN";

/**
 * 生成自检命令。
 *
 * 这一条是**我们自己拥有**的，不依赖任何第三方格式，所以永远准确。
 *
 * 当调用方用的就是脚本默认读的那个变量时省略 `--token`——命令里连变量引用都不出现，
 * 也就没有「把暗号写进命令历史」的顾虑。换了变量名才需要显式传，且传的是
 * `$env:NAME` 这种**引用形式**，落在历史里的是变量名而不是值。
 *
 * @param url - 端点 URL。
 * @param tokenEnv - 该调用方的暗号变量名。
 * @returns 一行可直接粘贴运行的命令。
 */
export function smokeCommand(url: string, tokenEnv: string): string {
  const base = "node scripts\\lingbang-profile-smoke.mjs --url " + url;
  return tokenEnv === SMOKE_DEFAULT_TOKEN_ENV ? base : `${base} --token $env:${tokenEnv}`;
}
