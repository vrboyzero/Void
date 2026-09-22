import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { evaluateRolePolicy, type ToolContract } from "../src/contract.js";
import {
  apply,
  canonicalLoopbackHost,
  localFetch,
  localFetchTargetKey,
  LOCAL_FETCH_TOOL_NAME,
  LocalFetchConfigError,
  LocalFetchRefusal,
  parseLocalFetchConfig,
  type LocalFetchConfig,
} from "../src/local-fetch.js";

interface SeenRequest {
  method: string | undefined;
  host: string | undefined;
  accept: string | undefined;
  url: string | undefined;
  body: string;
}

interface Harness {
  port: number;
  seen: SeenRequest[];
  close(): Promise<void>;
}

const open: Harness[] = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});

async function startServer(): Promise<Harness> {
  const seen: SeenRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        method: req.method,
        host: req.headers.host,
        accept: typeof req.headers.accept === "string" ? req.headers.accept : undefined,
        url: req.url,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      switch (path) {
        case "/ok":
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end("本机面板正常");
          return;
        case "/json":
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"state":"ok"}');
          return;
        case "/big":
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("x".repeat(5000));
          return;
        case "/slow":
          // 不回话，等超时。
          return;
        case "/png":
          res.writeHead(200, { "content-type": "image/png" });
          res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
          return;
        case "/boom":
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("炸了");
          return;
        case "/in":
          res.writeHead(302, { location: "/ok" });
          res.end();
          return;
        case "/loop":
          res.writeHead(302, { location: "/loop" });
          res.end();
          return;
        case "/out":
          res.writeHead(302, { location: `http://127.0.0.1:${redirectEscapePort}/ok` });
          res.end();
          return;
        default:
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("没有这个路径");
          return;
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const harness: Harness = {
    port: (server.address() as AddressInfo).port,
    seen,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
  open.push(harness);
  return harness;
}

/** 重定向逃逸用例要去的「别处」：一个同样在本机、但不在白名单里的端口。 */
let redirectEscapePort = 1;

interface RegisteredTool {
  name: string;
  description?: string;
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
}

function boot(config: LocalFetchConfig, registry?: ToolContract[]): { tool: RegisteredTool; logs: string[] } {
  const tools: RegisteredTool[] = [];
  const logs: string[] = [];
  const logger = {
    info: (message: string) => logs.push(`info ${message}`),
    warn: (message: string) => logs.push(`warn ${message}`),
    error: () => undefined,
    debug: () => undefined,
  };
  const ctx = {
    tools: {
      register: (tool: RegisteredTool) => {
        tools.push(tool);
        return () => undefined;
      },
    },
    logger: () => logger,
    get: (key: string) =>
      key === "voidToolContracts" && registry !== undefined
        ? { register: (contract: ToolContract) => { registry.push(contract); return () => undefined; } }
        : undefined,
  };
  apply(ctx as unknown as Context, config);
  const tool = tools[0];
  if (tool === undefined) throw new Error("工具没注册上");
  return { tool, logs };
}

async function call(url: string, config: LocalFetchConfig, extra: { maxBytes?: number; accept?: string } = {}): Promise<Record<string, unknown>> {
  const { tool } = boot(config);
  return (await tool.execute({ url, ...extra }, {})) as Record<string, unknown>;
}

async function refusalOf(url: string, config: LocalFetchConfig, extra: { maxBytes?: number } = {}): Promise<string> {
  try {
    await call(url, config, extra);
  } catch (error) {
    expect(error).toBeInstanceOf(LocalFetchRefusal);
    return (error as Error).message;
  }
  throw new Error("本该被拒，却放行了");
}

/** 直接给工具喂一个 exec（宿主就是这么把取消信号交给工具的执行体的）。 */
async function refusalWithExec(url: string, config: LocalFetchConfig, exec: unknown): Promise<string> {
  const { tool } = boot(config);
  try {
    await tool.execute({ url }, exec);
  } catch (error) {
    expect(error).toBeInstanceOf(LocalFetchRefusal);
    return (error as Error).message;
  }
  throw new Error("本该被拒，却放行了");
}

describe("本机抓取：主机规范化", () => {
  it("只认本机三种写法，其余一律不认", () => {
    expect(canonicalLoopbackHost("127.0.0.1")).toBe("127.0.0.1");
    expect(canonicalLoopbackHost("127.000.000.001")).toBe("127.0.0.1");
    expect(canonicalLoopbackHost("127.9.9.9")).toBe("127.9.9.9");
    expect(canonicalLoopbackHost("LOCALHOST")).toBe("127.0.0.1");
    expect(canonicalLoopbackHost("[::1]")).toBe("::1");
    expect(canonicalLoopbackHost("::1")).toBe("::1");
    expect(canonicalLoopbackHost("0.0.0.0")).toBeUndefined();
    expect(canonicalLoopbackHost("::")).toBeUndefined();
    expect(canonicalLoopbackHost("192.168.1.5")).toBeUndefined();
    expect(canonicalLoopbackHost("169.254.169.254")).toBeUndefined();
    expect(canonicalLoopbackHost("example.com")).toBeUndefined();
    expect(canonicalLoopbackHost("127.0.0.256")).toBeUndefined();
    expect(canonicalLoopbackHost(undefined)).toBeUndefined();
    expect(localFetchTargetKey("127.0.0.1", 3080)).toBe("127.0.0.1:3080");
    expect(localFetchTargetKey("::1", 3080)).toBe("[::1]:3080");
  });
});

describe("本机抓取：配置校验", () => {
  it("空白名单是合法的（fail-closed），上限有默认值", () => {
    const policy = parseLocalFetchConfig({});
    expect(policy.targets.size).toBe(0);
    expect(policy.maxBytes).toBe(256 * 1024);
    expect(policy.timeoutMs).toBe(5000);
    expect(policy.maxRedirects).toBe(3);
  });

  it("localhost 规范化成 127.0.0.1，重复条目去重", () => {
    const policy = parseLocalFetchConfig({
      allow: [
        { host: "localhost", port: 3080, note: "面板" },
        { host: "127.0.0.1", port: 3080 },
        { host: "::1", port: 3080 },
      ],
    });
    expect([...policy.targets.keys()]).toEqual(["127.0.0.1:3080", "[::1]:3080"]);
    expect(policy.targets.get("127.0.0.1:3080")?.note).toBe("面板");
  });

  it("写非本机地址、坏端口、越界上限都在装载时报错", () => {
    expect(() => parseLocalFetchConfig({ allow: [{ host: "192.168.1.5", port: 3080 }] })).toThrow(LocalFetchConfigError);
    expect(() => parseLocalFetchConfig({ allow: [{ host: "0.0.0.0", port: 3080 }] })).toThrow(/只能是本机地址/);
    expect(() => parseLocalFetchConfig({ allow: [{ host: "127.0.0.1", port: 0 }] })).toThrow(/端口必须在 1\.\.65535/);
    expect(() => parseLocalFetchConfig({ allow: [{ host: "127.0.0.1", port: 70000 }] })).toThrow(/端口必须在 1\.\.65535/);
    expect(() => parseLocalFetchConfig({ allow: [{ host: "127.0.0.1", port: "3080" as unknown as number }] })).toThrow(/端口必须在/);
    expect(() => parseLocalFetchConfig({ maxBytes: 0 })).toThrow(/maxBytes/);
    expect(() => parseLocalFetchConfig({ maxBytes: 9 * 1024 * 1024 })).toThrow(/maxBytes/);
    expect(() => parseLocalFetchConfig({ timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => parseLocalFetchConfig({ timeoutMs: 120_001 })).toThrow(/timeoutMs/);
    expect(() => parseLocalFetchConfig({ maxRedirects: 11 })).toThrow(/maxRedirects/);
    expect(() => parseLocalFetchConfig({ maxRedirects: -1 })).toThrow(/maxRedirects/);
    expect(parseLocalFetchConfig({ maxRedirects: 0 }).maxRedirects).toBe(0);
  });
});

describe("本机抓取：白名单与请求形状", () => {
  it("命中白名单就取回文本，并且只发 GET、Host 带端口", async () => {
    const panel = await startServer();
    const result = await call(`http://127.0.0.1:${panel.port}/ok`, { allow: [{ host: "127.0.0.1", port: panel.port }] });
    expect(result["status"]).toBe(200);
    expect(result["body"]).toBe("本机面板正常");
    expect(result["truncated"]).toBe(false);
    expect(result["bytes"]).toBe(Buffer.byteLength("本机面板正常"));
    expect(result["redirects"]).toEqual([]);
    expect(panel.seen).toHaveLength(1);
    expect(panel.seen[0]?.method).toBe("GET");
    expect(panel.seen[0]?.host).toBe(`127.0.0.1:${panel.port}`);
    expect(panel.seen[0]?.accept).toBe("*/*");
    expect(panel.seen[0]?.body).toBe("");
  });

  it("localhost 写法能命中 127.0.0.1 的白名单", async () => {
    const panel = await startServer();
    const result = await call(`http://localhost:${panel.port}/ok`, { allow: [{ host: "127.0.0.1", port: panel.port }] });
    expect(result["status"]).toBe(200);
  });

  it("同主机不同端口、别的回环地址、非本机地址都不放行", async () => {
    const panel = await startServer();
    const allow = [{ host: "127.0.0.1", port: panel.port }];
    expect(await refusalOf(`http://127.0.0.1:${panel.port + 1}/ok`, { allow })).toMatch(/不在白名单里/);
    expect(await refusalOf("http://127.0.0.2/ok", { allow })).toMatch(/不在白名单里/);
    expect(await refusalOf("http://example.com/ok", { allow })).toMatch(/只去本机地址/);
    expect(await refusalOf("http://169.254.169.254/latest/meta-data/", { allow })).toMatch(/只去本机地址/);
    expect(await refusalOf(`https://127.0.0.1:${panel.port}/ok`, { allow })).toMatch(/只支持 http/);
    expect(await refusalOf(`http://user:pass@127.0.0.1:${panel.port}/ok`, { allow })).toMatch(/用户名密码/);
    expect(await refusalOf(`http://127.0.0.1:${panel.port}/ok`, { allow: [] })).toMatch(/没有配白名单/);
    expect(await refusalOf("这不是地址", { allow })).toMatch(/看不懂这个地址/);
    expect(panel.seen).toHaveLength(0);
  });
});

describe("本机抓取：重定向、限量与超时", () => {
  it("白名单内的重定向会跟，并记下经过的地址", async () => {
    const panel = await startServer();
    const result = await call(`http://127.0.0.1:${panel.port}/in`, { allow: [{ host: "127.0.0.1", port: panel.port }] });
    expect(result["status"]).toBe(200);
    expect(result["body"]).toBe("本机面板正常");
    expect(result["redirects"]).toEqual([`http://127.0.0.1:${panel.port}/in`]);
  });

  it("重定向到白名单外（换端口）当场停手", async () => {
    const escape = await startServer();
    const panel = await startServer();
    redirectEscapePort = escape.port;
    const message = await refusalOf(`http://127.0.0.1:${panel.port}/out`, { allow: [{ host: "127.0.0.1", port: panel.port }] });
    expect(message).toMatch(/重定向走到了白名单外/);
    expect(escape.seen).toHaveLength(0);
  });

  it("重定向打转时按预算停手，maxRedirects=0 表示一次都不跟", async () => {
    const panel = await startServer();
    const allow = [{ host: "127.0.0.1", port: panel.port }];
    expect(await refusalOf(`http://127.0.0.1:${panel.port}/loop`, { allow })).toMatch(/跟了 3 次还没到/);
    expect(await refusalOf(`http://127.0.0.1:${panel.port}/in`, { allow, maxRedirects: 0 })).toMatch(/跟了 0 次还没到/);
  });

  it("超过字节上限就截断，且单次只能把上限调小", async () => {
    const panel = await startServer();
    const allow = [{ host: "127.0.0.1", port: panel.port }];
    const cut = await call(`http://127.0.0.1:${panel.port}/big`, { allow, maxBytes: 100 });
    expect(cut["bytes"]).toBe(100);
    expect(cut["truncated"]).toBe(true);
    expect((cut["body"] as string).length).toBe(100);

    const capped = await call(`http://127.0.0.1:${panel.port}/big`, { allow, maxBytes: 50 }, { maxBytes: 5000 });
    expect(capped["bytes"]).toBe(50);
    expect(capped["truncated"]).toBe(true);
  });

  it("二进制正文不装进上下文，只回一句说明", async () => {
    const panel = await startServer();
    const result = await call(`http://127.0.0.1:${panel.port}/png`, { allow: [{ host: "127.0.0.1", port: panel.port }] });
    expect(result["binary"]).toBe(true);
    expect(result["body"]).toBeUndefined();
    expect(result["note"]).toMatch(/image\/png/);
  });

  it("非 2xx 也如实回话（不抛错），超时与连不上则拒绝", async () => {
    const panel = await startServer();
    const allow = [{ host: "127.0.0.1", port: panel.port }];
    const boom = await call(`http://127.0.0.1:${panel.port}/boom`, { allow });
    expect(boom["status"]).toBe(500);
    expect(boom["body"]).toBe("炸了");

    expect(await refusalOf(`http://127.0.0.1:${panel.port}/slow`, { allow, timeoutMs: 300 })).toMatch(/超时/);

    const dead = await startServer();
    const deadPort = dead.port;
    await dead.close();
    open.pop();
    expect(await refusalOf(`http://127.0.0.1:${deadPort}/ok`, { allow: [{ host: "127.0.0.1", port: deadPort }] })).toMatch(/连不上/);
  }, 10_000);
});

describe("本机抓取：取消信号（上层停手时要当场落定）", () => {
  it("exec.signal 一到就断，并写明「被取消」而不是「超时」", async () => {
    const panel = await startServer();
    const allow = [{ host: "127.0.0.1", port: panel.port }];
    const controller = new AbortController();
    const started = Date.now();
    const pending = refusalWithExec(
      `http://127.0.0.1:${panel.port}/slow`,
      { allow, timeoutMs: 30_000 },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);
    const message = await pending;
    expect(message).toMatch(/被取消/);
    expect(message).not.toMatch(/超时/);
    // 上限是 30 秒；真断了才会在一瞬间回来。
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it("信号在调用前就断了：直接说被取消", async () => {
    const panel = await startServer();
    const controller = new AbortController();
    controller.abort();
    const message = await refusalWithExec(
      `http://127.0.0.1:${panel.port}/slow`,
      { allow: [{ host: "127.0.0.1", port: panel.port }], timeoutMs: 30_000 },
      { signal: controller.signal },
    );
    expect(message).toMatch(/被取消/);
  }, 10_000);

  it("自己那条超时仍然写「超时」，和取消分得清", async () => {
    const panel = await startServer();
    const message = await refusalOf(`http://127.0.0.1:${panel.port}/slow`, {
      allow: [{ host: "127.0.0.1", port: panel.port }],
      timeoutMs: 300,
    });
    expect(message).toMatch(/超时（300ms）/);
    expect(message).not.toMatch(/被取消/);
  }, 10_000);
});

describe("本机抓取：插件装载", () => {
  it("注册工具与契约，并把放行/拒绝写进日志", async () => {
    const panel = await startServer();
    const registry: ToolContract[] = [];
    const { tool, logs } = boot({ allow: [{ host: "127.0.0.1", port: panel.port }] }, registry);
    expect(tool.name).toBe(LOCAL_FETCH_TOOL_NAME);
    expect(tool.description).toMatch(/白名单/);
    expect(registry).toHaveLength(1);
    expect(registry[0]).toMatchObject({ name: LOCAL_FETCH_TOOL_NAME, family: "network-read", isReadOnly: true, riskLevel: "low" });

    const allowed = evaluateRolePolicy(registry[0]!, { role: "researcher", allowedToolFamilies: ["workspace-read", "network-read"], maxToolRiskLevel: "medium" });
    expect(allowed.allowed).toBe(true);
    const denied = evaluateRolePolicy(registry[0]!, { role: "researcher", allowedToolFamilies: ["workspace-read"], maxToolRiskLevel: "medium" });
    expect(denied.allowed).toBe(false);

    await tool.execute({ url: `http://127.0.0.1:${panel.port}/ok` }, { agent: { id: "session-1" } });
    expect(logs.some((line) => line.startsWith("info 本机抓取") && line.includes("会话=session-1"))).toBe(true);
    await expect(tool.execute({ url: "http://127.0.0.1:1/ok" }, {})).rejects.toThrow(LocalFetchRefusal);
    expect(logs.some((line) => line.startsWith("warn 本机抓取被拒"))).toBe(true);
  });

  it("配置写错时装载即失败", () => {
    expect(() => boot({ allow: [{ host: "10.0.0.5", port: 3080 }] })).toThrow(LocalFetchConfigError);
  });

  it("没有契约注册表时照样注册工具（不依赖它）", async () => {
    const panel = await startServer();
    const { tool } = boot({ allow: [{ host: "127.0.0.1", port: panel.port }] });
    await expect(tool.execute({ url: `http://127.0.0.1:${panel.port}/ok` }, {})).resolves.toMatchObject({ status: 200 });
  });
});
