import { afterEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import WebServer from "@deepseek-ai/dsh-host-webserver";
import * as Control from "../src/index.js";
import { createHostPorts } from "../src/hosts.js";
import type { HostPorts } from "../src/orchestrator.js";
import { bootControl, disposeContexts, ENDPOINT, findFiber, TOKEN_ENV, trackContext } from "./support/boot.js";

afterEach(disposeContexts);

describe("composition: Config schema rejects a transport that is not implemented", () => {
  // transport 曾经是死字段：声明了、面板也显示，但**没有任何代码读它**（路由直接构造
  // StreamableHTTPServerTransport）。自由字符串意味着 `transport: sse` 被静默接受、
  // 然后什么都不发生。改成常量后，配错在加载时就被拒绝。
  //
  // schema 的声明入参是解析后的 Config（每个字段都已填好），所以这里要传不完整对象就得
  // 显式放宽——本组用例验的是**运行时拒绝**，不是类型拒绝。
  const parseConfig = Control.Config as unknown as (value: Record<string, unknown>) => { transport: string };

  it("accepts the implemented transport and defaults to it", () => {
    expect(parseConfig({}).transport).toBe("streamable-http");
    expect(parseConfig({ transport: "streamable-http" }).transport).toBe("streamable-http");
  });

  it("refuses any other value instead of silently ignoring it", () => {
    expect(() => parseConfig({ transport: "sse" })).toThrow();
    expect(() => parseConfig({ transport: "" })).toThrow();
  });
});
describe("composition: plugin activation", () => {
  it("registers the MCP route, publishes the service and wires host events", async () => {
    const ctx = await bootControl();
    const webServer = ctx.get("webServer")!;
    const url = `http://127.0.0.1:${webServer.port}${ENDPOINT}`;

    expect(ctx.get("voidDshControl")).toBeDefined();
    expect(ctx.get("voidDshControl")!.endpointPath).toBe(ENDPOINT);

    // The endpoint answers, and refuses an unauthenticated request.
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(401);

    // A path outside the registered route is not claimed by the plugin.
    const other = await fetch(`http://127.0.0.1:${webServer.port}/nope`, { method: "POST" });
    expect(other.status).toBe(404);
  });

  it("subscribes to host lifecycle events globally", async () => {
    const ctx = await bootControl();
    const hooks = (ctx.events as unknown as { _hooks: Record<string, Array<{ global?: boolean }>> })._hooks;

    expect(hooks["session/event"]?.some((hook) => hook.global === true)).toBe(true);
    expect(hooks["agent/status"]?.some((hook) => hook.global === true)).toBe(true);
    expect(hooks["agent/error"]?.some((hook) => hook.global === true)).toBe(true);
  });

  it("stays inert when disabled", async () => {
    const ctx = await bootControl({ config: { enabled: false } });
    const webServer = ctx.get("webServer")!;
    expect(ctx.get("voidDshControl")).toBeUndefined();
    const response = await fetch(`http://127.0.0.1:${webServer.port}${ENDPOINT}`, { method: "POST" });
    expect(response.status).toBe(404);
  });

  it("removes the route and the service when the plugin is disposed", async () => {
    const ctx = await bootControl();
    const webServer = ctx.get("webServer")!;
    const url = `http://127.0.0.1:${webServer.port}${ENDPOINT}`;

    const fiber = findFiber(ctx, "void-dsh-control");
    expect(fiber).toBeDefined();
    await fiber!.dispose();

    expect(ctx.get("voidDshControl")).toBeUndefined();
    const response = await fetch(url, { method: "POST" });
    expect(response.status).toBe(404);
  });

  it("does not activate while a required service is missing", async () => {
    const ctx = await bootControl({ withControllers: false });
    // The fiber waits for its injections instead of registering a half-built,
    // unauthenticated endpoint.
    expect(ctx.get("voidDshControl")).toBeUndefined();
    const webServer = ctx.get("webServer")!;
    const response = await fetch(`http://127.0.0.1:${webServer.port}${ENDPOINT}`, { method: "POST" });
    expect(response.status).toBe(404);
  });

  it("warns instead of failing when the configured token variable is unset", async () => {
    delete process.env["VOID_DSH_CONTROL_MISSING_TOKEN"];
    const ctx = await bootControl({
      config: { tokens: [{ callerId: "spec", tokenEnv: "VOID_DSH_CONTROL_MISSING_TOKEN" }] },
    });
    const webServer = ctx.get("webServer")!;
    // The endpoint still exists, but authenticates nobody.
    const response = await fetch(`http://127.0.0.1:${webServer.port}${ENDPOINT}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer anything" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(401);
  });

  it("prints token remediation to stderr, where the operator is actually looking", async () => {
    delete process.env["VOID_DSH_CONTROL_MISSING_TOKEN"];
    // `ctx.logger` alone is invisible: no Node-side package registers a console
    // exporter, so a warning that only reaches the Web UI log panel leaves a
    // terminal operator with an unexplained 401. Pin the stderr channel.
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    try {
      await bootControl({
        config: { tokens: [{ callerId: "spec", tokenEnv: "VOID_DSH_CONTROL_MISSING_TOKEN" }] },
      });
    } finally {
      spy.mockRestore();
    }

    const output = written.join("");
    expect(output).toContain("VOID_DSH_CONTROL_MISSING_TOKEN");
    expect(output).toContain("401");
    expect(output).toContain("Get-Random");
    // Attribution matters: dsh prints other plugins' banners on the same stream.
    expect(output).toContain("[void-dsh-control]");
  });

  it("refuses to start with a storage ledger when no storage domain is mounted", async () => {
    const ctx = trackContext(new Context());
    await ctx.plugin(Loader);
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
    ctx.provide("sessionController", {});
    ctx.provide("workspaceController", {});

    await ctx.loader.create({ name: "@void/void-dsh-control", config: { path: ENDPOINT, ledger: "storage" } });
    await ctx.loader.await();

    // A configuration the plugin cannot honour must not degrade into an
    // unauthenticated endpoint.
    expect(ctx.get("voidDshControl")).toBeUndefined();
    const response = await fetch(`http://127.0.0.1:${ctx.get("webServer")!.port}${ENDPOINT}`, { method: "POST" });
    expect(response.status).toBe(404);
  });
});

describe("composition: configuration validation", () => {
  /**
   * Boot with a configuration the plugin cannot honour.
   *
   * Validation runs synchronously inside `apply`, before any async effect, so
   * Cordis fails plugin startup and the loader call itself rejects with the
   * plugin's own message — the "fails loud with a clear error" behaviour the
   * plan requires. No endpoint and no service are left behind.
   */
  async function bootFailure(config: Record<string, unknown>, pattern: RegExp): Promise<void> {
    await expect(bootControl({ config })).rejects.toThrowError(pattern);
  }

  it("rejects an unknown operation name with a clear error", async () => {
    await bootFailure({ allowedOperations: ["session.prompt", "not.an.operation"] }, /allowedOperations names an unknown operation/);
  });

  it("rejects an unknown token operation with a clear error", async () => {
    await bootFailure(
      { tokens: [{ callerId: "spec", tokenEnv: TOKEN_ENV, operations: ["nope"] }] },
      /tokens\[spec\]\.operations names an unknown operation/,
    );
  });

  it("rejects an invalid forbidden pattern with a clear error", async () => {
    await bootFailure({ forbiddenPatterns: ["("] }, /invalid forbiddenPatterns regular expression/);
  });

  it("applies the documented defaults", async () => {
    const ctx = await bootControl();
    const policy = ctx.get("voidDshControl")!.policy;
    expect(policy.instructionsVersion).toBe(0);
    expect(policy.requiredFields).toEqual([]);
    expect(policy.forbiddenPatterns).toEqual([]);
    expect(ctx.get("voidDshControl")!.guard.allowedRoots).toEqual([]);
  });
});

describe("composition: host port adapter", () => {
  it("exposes the controller surface through HostPorts", async () => {
    const ctx = await bootControl();
    const ports: HostPorts = createHostPorts(ctx);
    await expect(ports.listSessions()).resolves.toEqual([]);
    await expect(ports.listWorkspaces()).resolves.toEqual([]);
    await expect(ports.inspectSession("session-1")).resolves.toEqual({ exists: true, cwd: "E:/work/app" });
    await expect(ports.createSession({ workspaceId: "workspace-1" })).resolves.toEqual({ sessionId: "session-1" });
    await expect(ports.openWorkspace("E:/work/app")).resolves.toMatchObject({ workspaceId: "workspace-1" });
  });
});
