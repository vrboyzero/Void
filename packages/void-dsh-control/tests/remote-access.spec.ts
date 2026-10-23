import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Authenticator, type TokenGrant, type CallerIdentity } from "../src/auth.js";
import { MemoryControlLedger } from "../src/ledger.js";
import { createMcpHttpHandler } from "../src/mcp.js";
import { ControlOrchestrator } from "../src/orchestrator.js";
import { compilePolicy, EMPTY_CALLER_POLICY } from "../src/policy.js";
import { CONTROL_OPERATIONS, expandOperations } from "../src/protocol.js";
import { validateOrigins } from "../src/origin.js";
import { FakeHosts } from "./support/fake-hosts.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

function build() {
  const hosts = new FakeHosts();
  const allowed = hosts.seedWorkspace(process.cwd(), ["allowed-session"]);
  const other = hosts.seedWorkspace(`${process.cwd()}/other`, ["other-session"]);
  hosts.seedSession("allowed-session", allowed.path);
  hosts.seedSession("other-session", other.path);
  const ledger = new MemoryControlLedger();
  const policy = () => compilePolicy(EMPTY_CALLER_POLICY);
  const orchestrator = new ControlOrchestrator({ hosts, ledger, policy });
  const identity: CallerIdentity & { workspaceIds: string[] } = {
    callerId: "remote", operations: expandOperations(CONTROL_OPERATIONS), workspaceIds: [allowed.workspaceId],
  };
  return { hosts, allowed, other, ledger, policy, orchestrator, identity };
}

function command(workspaceId: string, session: { kind: "new" } | { kind: "existing" | "fork"; sessionId: string } = { kind: "new" }) {
  return { requestId: "remote-request", workspace: { workspaceId }, session,
    messages: [{ text: "hello", mode: "queue" as const }], wait: { until: "accepted" as const, timeoutMs: 0 } };
}

describe("§30 caller workspace boundaries", () => {
  it("rejects an ungranted workspace before querying or changing the target host", async () => {
    const { hosts, other, orchestrator, identity, ledger } = build();
    const get = vi.spyOn(hosts, "getWorkspace");
    await expect(orchestrator.dispatch(identity, command(other.workspaceId))).rejects.toMatchObject({ code: "dsh-control/workspace-not-allowed" });
    expect(get).not.toHaveBeenCalled();
    expect(hosts.deliveries).toEqual([]);
    expect(ledger.listTasks()).toEqual([]);
  });

  it.each(["existing", "fork"] as const)("rejects an ungranted %s session before inspecting it", async (kind) => {
    const { hosts, allowed, orchestrator, identity } = build();
    const inspect = vi.spyOn(hosts, "inspectSession");
    await expect(orchestrator.dispatch(identity, command(allowed.workspaceId, { kind, sessionId: "other-session" })))
      .rejects.toMatchObject({ code: "dsh-control/workspace-not-allowed" });
    expect(inspect).not.toHaveBeenCalled();
    expect(hosts.deliveries).toEqual([]);
  });

  it.each(["sendMessage", "injectContext"] as const)("rejects %s to an ungranted session before inspection", async (method) => {
    const { hosts, orchestrator, identity } = build();
    const inspect = vi.spyOn(hosts, "inspectSession");
    const input = { requestId: "denied", sessionId: "other-session", text: "hi", message: { text: "hi", mode: "queue" as const } };
    await expect(orchestrator[method](identity, input)).rejects.toMatchObject({ code: "dsh-control/workspace-not-allowed" });
    expect(inspect).not.toHaveBeenCalled();
    expect(hosts.deliveries).toEqual([]);
  });

  it("rechecks scope before replaying, reading or cancelling a formerly allowed task", async () => {
    const { hosts, allowed, orchestrator, identity } = build();
    const task = await orchestrator.dispatch(identity, command(allowed.workspaceId));
    const denied = { ...identity, workspaceIds: [] };
    await expect(orchestrator.dispatch(denied, command(allowed.workspaceId))).rejects.toMatchObject({ code: "dsh-control/workspace-not-allowed" });
    expect(() => orchestrator.getTask(denied, { taskId: task.taskId, limit: 20 })).toThrow();
    await expect(orchestrator.cancelTask(denied, { taskId: task.taskId })).rejects.toThrow();
    expect(hosts.deliveries.filter(item => item.kind === "cancel")).toEqual([]);
    expect(hosts.promptCount).toBe(1);
  });
});

async function start(allowedOrigins: readonly string[] = []) {
  const fixture = build();
  let grants: (TokenGrant & { workspaceIds: string[] })[] = [{
    callerId: "remote", token: "test-secret", operations: [...CONTROL_OPERATIONS], workspaceIds: [fixture.allowed.workspaceId],
  }];
  const authenticator = new Authenticator(() => ({ tokens: grants, allowAnonymous: false }));
  const handler = createMcpHttpHandler({ authenticator, allowedOrigins: () => allowedOrigins, deps: { ...fixture, authenticator,
    guard: () => ({ allowedRoots: [dirname(process.cwd())] }), identity: { name: "remote-spec", version: "1" } } });
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  closers.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/dsh-agent-control`);
  const connect = async () => {
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: "Bearer test-secret" } } });
    const client = new Client({ name: "remote-client", version: "1" });
    await client.connect(transport);
    closers.push(() => client.close());
    return client;
  };
  return { ...fixture, url, connect, setGrants: (value: typeof grants) => { grants = value; } };
}

function body(result: Awaited<ReturnType<Client["callTool"]>>) {
  return JSON.parse((result.content as { text: string }[])[0]!.text);
}

describe("§30 remote HTTP boundary and reconnect", () => {
  it("rejects wildcard Origin grants", () => {
    expect(() => validateOrigins(["https://*.example"])).toThrow();
  });

  it("permits explicitly listed Origins while still requiring credentials", async () => {
    const { url } = await start(["https://console.example"]);
    const result = await fetch(url, { method: "POST", headers: { Origin: "https://console.example" }, body: "not json" });
    expect(result.status).toBe(401);
  });

  it("denies tokens without a workspace grant by default", async () => {
    const identity = new Authenticator({ tokens: [{ callerId: "legacy", token: "value", operations: ["session.prompt"] }], allowAnonymous: false })
      .authenticate("Bearer value");
    expect(identity.workspaceIds).toEqual([]);
  });

  it.each(["https://evil.example", "null", "http://127.0.0.1", "https://evil.example, https://other.example"])("rejects Origin %s before authentication or body processing", async origin => {
    const { url } = await start();
    const result = await fetch(url, { method: "POST", headers: { Origin: origin }, body: "not json" });
    expect(result.status).toBe(403);
  });

  it("enumerates only granted workspaces and sessions", async () => {
    const f = await start();
    const client = await f.connect();
    const workspaces = body(await client.callTool({ name: "dsh_list_workspaces", arguments: {} }));
    expect(workspaces.items.map((item: { workspaceId: string }) => item.workspaceId)).toEqual([f.allowed.workspaceId]);
    const sessions = body(await client.callTool({ name: "dsh_list_sessions", arguments: {} }));
    expect(sessions.items.map((item: { sessionId: string }) => item.sessionId)).toEqual(["allowed-session"]);
  });

  it("uses current grants on an already initialized MCP session", async () => {
    const f = await start();
    const client = await f.connect();
    f.setGrants([{ callerId: "remote", token: "test-secret", operations: ["workspace.read"], workspaceIds: [] }]);
    const result = await client.callTool({ name: "dsh_send_message", arguments: { requestId: "revoked", sessionId: "allowed-session", message: { text: "hi" } } });
    expect(body(result).error.code).toBe("dsh-control/forbidden-operation");
    expect(body(await client.callTool({ name: "dsh_list_workspaces", arguments: {} })).items).toEqual([]);
    expect(f.hosts.promptCount).toBe(0);
  });

  it("does not allow global allowedRoots to widen a scoped document reference", async () => {
    const f = await start();
    const client = await f.connect();
    const result = await client.callTool({ name: "dsh_send_message", arguments: {
      requestId: "outside-document", sessionId: "allowed-session", message: { text: "hi", documentRefs: [
        { path: join(dirname(process.cwd()), "void-entry", "package.json"), mode: "inline" },
      ] },
    } });
    expect(body(result).error.code).toBe("dsh-control/workspace-not-allowed");
    expect(f.hosts.promptCount).toBe(0);
  });

  it("rejects a different caller's task outside the granted workspace", async () => {
    const f = await start();
    const task = await f.orchestrator.dispatch({ callerId: "other", operations: expandOperations(CONTROL_OPERATIONS) }, command(f.other.workspaceId));
    const client = await f.connect();
    const result = await client.callTool({ name: "dsh_get_task", arguments: { taskId: task.taskId } });
    expect(body(result).error.code).toBe("dsh-control/workspace-not-allowed");
  });

  it("revokes an existing MCP session when its token is removed", async () => {
    const f = await start();
    const client = await f.connect();
    f.setGrants([]);
    await expect(client.listTools()).rejects.toMatchObject({ code: 401 });
    expect(f.hosts.promptCount).toBe(0);
  });

  it("recovers a task across new transports with the same requestId and cursor", async () => {
    const f = await start();
    const input = { requestId: "retry", target: { workspace: { workspaceId: f.allowed.workspaceId }, session: "new" }, messages: [{ text: "hello" }] };
    const first = await f.connect();
    const accepted = body(await first.callTool({ name: "dsh_dispatch_session_task", arguments: input }));
    await first.close();
    const second = await f.connect();
    expect(body(await second.callTool({ name: "dsh_dispatch_session_task", arguments: input })).taskId).toBe(accepted.taskId);
    await f.orchestrator.applySignal(accepted.sessionId, { status: "running", summary: "running" });
    await f.orchestrator.applySignal(accepted.sessionId, { status: "idle", summary: "done" });
    const recovered = body(await second.callTool({ name: "dsh_get_task", arguments: { taskId: accepted.taskId, afterCursor: accepted.eventCursor } }));
    expect(recovered.task.status).toBe("completed");
    expect(f.hosts.promptCount).toBe(1);
    expect(recovered.events.length).toBeGreaterThan(0);
  });
});
