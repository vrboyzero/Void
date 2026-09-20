import { describe, expect, it } from "vitest";
import {
  CLIENT_RECIPES,
  endpointUrl,
  serverName,
  smokeCommand,
} from "../src/client/client-configs.js";

describe("void-entry connect: endpoint url", () => {
  it("joins the live origin with the configured path", () => {
    // 端口只能从浏览器当前位置取——它由启动参数决定，插件配置里没有这个信息。
    expect(endpointUrl("/mcp/dsh-agent-control", "http://127.0.0.1:3080")).toBe(
      "http://127.0.0.1:3080/mcp/dsh-agent-control",
    );
  });

  it("does not double the slash when either side carries one", () => {
    expect(endpointUrl("mcp/x", "http://127.0.0.1:3080")).toBe("http://127.0.0.1:3080/mcp/x");
    expect(endpointUrl("/mcp/x", "http://127.0.0.1:3080/")).toBe("http://127.0.0.1:3080/mcp/x");
  });

  it("keeps a non-default port, because that is the whole point", () => {
    // 文档里那份样例硬编码了 3080；换端口就指错地方。
    expect(endpointUrl("/mcp/x", "http://127.0.0.1:3199")).toContain(":3199");
  });
});

describe("void-entry connect: server name", () => {
  it("keeps a name that is already usable", () => {
    expect(serverName("codex")).toBe("codex");
    expect(serverName("my-agent_2")).toBe("my-agent_2");
  });

  it("folds spaces and drops characters that break config keys", () => {
    expect(serverName("My Agent")).toBe("My-Agent");
    expect(serverName("a.b/c")).toBe("abc");
  });

  it("falls back rather than generating an empty key", () => {
    // 空身份会生成一个非法键名，比生成一个通用名更糟。
    expect(serverName("")).toBe("dsh-control");
    expect(serverName("   ")).toBe("dsh-control");
    expect(serverName("!!!")).toBe("dsh-control");
  });
});

describe("void-entry connect: smoke command", () => {
  it("omits --token when the caller uses the script's own default variable", () => {
    // 命令里连变量引用都不出现，就没有「暗号进命令历史」的顾虑。
    const command = smokeCommand("http://127.0.0.1:3080/mcp/x", "VOID_DSH_CONTROL_TOKEN");
    expect(command).not.toContain("--token");
    expect(command).toContain("--url http://127.0.0.1:3080/mcp/x");
  });

  it("passes a variable reference (not a value) for a custom variable", () => {
    const command = smokeCommand("http://127.0.0.1:3080/mcp/x", "CODEX_TOKEN");
    expect(command).toContain("--token $env:CODEX_TOKEN");
  });
});

describe("void-entry connect: recipes", () => {
  it("declares a source and a verification date for every recipe", () => {
    // 没查证过的格式不许生成——生成一个粘上去报错的配置比贴份概念样例更糟。
    for (const recipe of CLIENT_RECIPES) {
      expect(recipe.source).toMatch(/^https:\/\//);
      expect(recipe.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(recipe.location.length).toBeGreaterThan(0);
    }
  });

  it("never puts a token value in the generated text", () => {
    // 传入的是变量名；生成结果里只应出现名字，不应出现任何看起来像值的东西。
    const ctx = { url: "http://127.0.0.1:3080/mcp/x", tokenEnv: "CODEX_TOKEN", callerId: "codex" };
    for (const recipe of CLIENT_RECIPES) {
      const body = recipe.render(ctx);
      expect(body).toContain("CODEX_TOKEN");
      expect(body).not.toMatch(/Bearer\s+(?!\$\{)[A-Za-z0-9]{16,}/);
    }
  });

  it("renders each recipe in its declared language", () => {
    const ctx = { url: "http://127.0.0.1:3080/mcp/x", tokenEnv: "CODEX_TOKEN", callerId: "codex" };
    for (const recipe of CLIENT_RECIPES) {
      const body = recipe.render(ctx);
      if (recipe.language === "json") {
        expect(() => JSON.parse(body)).not.toThrow();
      } else {
        expect(body).toContain(`[mcp_servers.${serverName(ctx.callerId)}]`);
      }
      expect(body).toContain(ctx.url);
    }
  });
});

/**
 * 下面这组断言把**查证到的客户端差异**固定下来。它们是这个功能的核心价值：一份
 * 「通用片段」不可能对所有客户端成立，所以每份配方必须保持自己那一种写法。
 */
describe("void-entry connect: per-client shapes", () => {
  const ctx = { url: "http://127.0.0.1:3080/mcp/x", tokenEnv: "VOID_DSH_CONTROL_TOKEN", callerId: "codex" };
  const render = (id: string) => {
    const recipe = CLIENT_RECIPES.find((r) => r.id === id);
    expect(recipe, `missing recipe ${id}`).toBeDefined();
    return recipe!.render(ctx);
  };

  it("Codex uses bearer_token_env_var instead of a header", () => {
    const body = render("codex");
    expect(body).toContain('bearer_token_env_var = "VOID_DSH_CONTROL_TOKEN"');
    // 没有 header，也就没有地方能塞进暗号值。
    expect(body).not.toContain("Authorization");
  });

  it("Cursor omits type, because its official remote example has none", () => {
    const parsed = JSON.parse(render("cursor"));
    const server = parsed.mcpServers.codex;
    expect(server.type).toBeUndefined();
    expect(server.url).toBe(ctx.url);
    // 插值语法带 env: 前缀，写成 ${NAME} 是不生效的。
    expect(server.headers.Authorization).toBe("Bearer ${env:VOID_DSH_CONTROL_TOKEN}");
  });

  it("Claude Code requires type, with http as the canonical value", () => {
    // 与 Cursor 相反：缺 type 会被跳过并报错。
    const parsed = JSON.parse(render("claude-code"));
    expect(parsed.mcpServers.codex.type).toBe("http");
    expect(parsed.mcpServers.codex.headers.Authorization).toBe("Bearer ${VOID_DSH_CONTROL_TOKEN}");
  });

  it("Claude Desktop bridges through mcp-remote with the Windows-safe header form", () => {
    const parsed = JSON.parse(render("claude-desktop"));
    const server = parsed.mcpServers.codex;
    expect(server.command).toBe("npx");
    expect(server.args).toContain("mcp-remote");
    expect(server.args).toContain("--transport");
    expect(server.args).toContain("http-only");
    // 冒号后**没有空格**，整段 Bearer 放在变量里——这是 args 空格不转义的绕法。
    const header = server.args[server.args.indexOf("--header") + 1];
    expect(header).toBe("Authorization:${VOID_DSH_CONTROL_TOKEN_AUTH}");
    expect(header).not.toContain(" ");
  });

  it("the fallback recipe omits type rather than guessing one", () => {
    // 猜一个值等于生成一份在别的客户端上报错的配置。
    const parsed = JSON.parse(render("generic"));
    expect(parsed.mcpServers.codex.type).toBeUndefined();
  });

  it("marks the two客户端 that need no bridge as recommended", () => {
    const recommended = CLIENT_RECIPES.filter((r) => r.recommended === true).map((r) => r.id);
    expect(recommended).toEqual(["codex", "cursor"]);
  });
});