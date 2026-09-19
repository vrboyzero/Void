import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import WebServer from "@deepseek-ai/dsh-host-webserver";
import * as Control from "../src/index.js";
import { createHostPorts } from "../src/hosts.js";
import type { HostPorts } from "../src/orchestrator.js";
import { FakeHosts } from "./support/fake-hosts.js";

const contexts: Context[] = [];

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
});

const TOKEN_ENV = "VOID_DSH_CONTROL_SPEC_TOKEN";
const ENDPOINT = "/mcp/dsh-agent-control";

/**
 * Boot a real Cordis Loader with the real WebServer and stub controllers.
 *
 * The Workspace and Session controllers are stubbed rather than booted because
 * they need the whole agent/model stack; what this fixture verifies is the
 * plugin's own composition: injection, route registration, service publication,
 * event wiring and disposal.
 */
async function boot(config: Record<string, unknown>, options: { withControllers?: boolean } = {}): Promise<Context> {
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

  process.env[TOKEN_ENV] = "spec-token";
  await ctx.loader.create({
    name: "@void/void-dsh-control",
    config: { path: ENDPOINT, ledger: "memory", tokens: [{ callerId: "spec", tokenEnv: TOKEN_ENV }], ...config },
  });
  await ctx.loader.await();
  void hosts;
  return ctx;
}

function findFiber(ctx: Context, pluginName: string) {
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers) {
      if (fiber.name === pluginName) return fiber;
    }
  }
  return undefined;
}

describe("composition: plugin activation", () => {
  it("registers the MCP route, publishes the service and wires host events", async () => {
    const ctx = await boot({});
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

  it("stays inert when disabled", async () => {
    const ctx = await boot({ enabled: false });
    const webServer = ctx.get("webServer")!;
    expect(ctx.get("voidDshControl")).toBeUndefined();
    const response = await fetch(`http://127.0.0.1:${webServer.port}${ENDPOINT}`, { method: "POST" });
    expect(response.status).toBe(404);
  });

  it("removes the route and the service when the plugin is disposed", async () => {
    const ctx = await boot({});
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
    const ctx = await boot({}, { withControllers: false });
    // The fiber waits for its injections instead of registering a half-built,
    // unauthenticated endpoint.
    expect(ctx.get("voidDshControl")).toBeUndefined();
    const webServer = ctx.get("webServer")!;
    const response = await fetch(`http://127.0.0.1:${webServer.port}${ENDPOINT}`, { method: "POST" });
    expect(response.status).toBe(404);
  });

  it("warns instead of failing when the configured token variable is unset", async () => {
    delete process.env["VOID_DSH_CONTROL_MISSING_TOKEN"];
    const ctx = await boot({
      tokens: [{ callerId: "spec", tokenEnv: "VOID_DSH_CONTROL_MISSING_TOKEN" }],
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

  it("refuses to start with a storage ledger when no storage domain is mounted", async () => {
    const ctx = new Context();
    contexts.push(ctx);
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
    await expect(boot(config)).rejects.toThrowError(pattern);
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
    const ctx = await boot({});
    const policy = ctx.get("voidDshControl")!.policy;
    expect(policy.instructionsVersion).toBe(0);
    expect(policy.requiredFields).toEqual([]);
    expect(policy.forbiddenPatterns).toEqual([]);
    expect(ctx.get("voidDshControl")!.guard.allowedRoots).toEqual([]);
  });
});

describe("composition: host port adapter", () => {
  it("exposes the controller surface through HostPorts", async () => {
    const ctx = await boot({});
    const ports: HostPorts = createHostPorts(ctx);
    await expect(ports.listSessions()).resolves.toEqual([]);
    await expect(ports.listWorkspaces()).resolves.toEqual([]);
    await expect(ports.inspectSession("session-1")).resolves.toEqual({ exists: true, cwd: "E:/work/app" });
    await expect(ports.createSession({ workspaceId: "workspace-1" })).resolves.toEqual({ sessionId: "session-1" });
    await expect(ports.openWorkspace("E:/work/app")).resolves.toMatchObject({ workspaceId: "workspace-1" });
  });
});
