import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Authenticator } from "../src/auth.js";
import { MemoryControlLedger } from "../src/ledger.js";
import { createMcpHttpHandler } from "../src/mcp.js";
import { ControlOrchestrator } from "../src/orchestrator.js";
import { EMPTY_CALLER_POLICY, compilePolicy, type CallerPolicy } from "../src/policy.js";
import { LIMITS, type ControlOperation } from "../src/protocol.js";
import type { PathGuard } from "../src/workspace.js";
import { FakeHosts } from "./support/fake-hosts.js";

const ENDPOINT = "/mcp/dsh-agent-control";
const TOKEN_FULL = "token-full-access";
const TOKEN_READONLY = "token-read-only";
const TOKEN_PROMPT_ONLY = "token-prompt-only";

interface Harness {
  readonly url: string;
  readonly hosts: FakeHosts;
  readonly ledger: MemoryControlLedger;
  readonly orchestrator: ControlOrchestrator;
  close(): Promise<void>;
}

const harnesses: Harness[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close();
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function start(options: { policy?: CallerPolicy; guard?: PathGuard; tokens?: boolean } = {}): Promise<Harness> {
  const hosts = new FakeHosts();
  const ledger = new MemoryControlLedger();
  const policy = compilePolicy(options.policy ?? EMPTY_CALLER_POLICY);
  const guard = options.guard ?? { allowedRoots: [] };
  const orchestrator = new ControlOrchestrator({ ledger, hosts, policy: () => policy });

  const operations: ControlOperation[] = [
    "workspace.read",
    "workspace.open",
    "session.list",
    "session.create",
    "session.prompt",
    "session.inject",
    "session.steer",
    "session.observe",
    "task.read",
    "task.cancel",
  ];
  const authenticator = new Authenticator({
    tokens:
      options.tokens === false
        ? []
        : [
            { callerId: "full", token: TOKEN_FULL, operations },
            { callerId: "readonly", token: TOKEN_READONLY, operations: ["workspace.read", "session.list"] },
            // `session.prompt` expands to session.create → workspace.read, but deliberately
            // not to workspace.open, which is what §26.1-1 is about.
            { callerId: "promptonly", token: TOKEN_PROMPT_ONLY, operations: ["session.prompt", "task.read"] },
          ],
    allowAnonymous: false,
  });

  const handler = createMcpHttpHandler({
    authenticator,
    deps: {
      orchestrator,
      authenticator,
      hosts,
      policy: () => policy,
      guard: () => guard,
      identity: { name: "void-dsh-control", version: "0.1.0" },
    },
  });

  const server: Server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const harness: Harness = {
    url: `http://127.0.0.1:${port}${ENDPOINT}`,
    hosts,
    ledger,
    orchestrator,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  harnesses.push(harness);
  return harness;
}

/** Connect an MCP client with a bearer token. */
async function connect(url: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "lingbang-spec", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

/**
 * Parse the JSON payload a tool returned.
 *
 * The SDK's `callTool` result is a union that also covers the task-based result
 * shape, so the helper narrows structurally instead of trusting the union.
 */
function payload(result: unknown): Record<string, unknown> {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error("expected a tool result content array");
  const first = content[0] as { type?: string; text?: string } | undefined;
  if (first?.type !== "text" || typeof first.text !== "string") throw new Error("expected a text tool result");
  return JSON.parse(first.text) as Record<string, unknown>;
}

/** Error payload of a failed tool call. */
function errorPayload(result: unknown): { code: string; message: string; details: Record<string, unknown> } {
  const body = payload(result) as { error?: { code: string; message: string; details: Record<string, unknown> } };
  if (body.error === undefined) throw new Error(`expected an error payload, got ${JSON.stringify(body)}`);
  return body.error;
}

describe("mcp-http: transport and authentication", () => {
  it("rejects a request without a token", async () => {
    const harness = await start();
    const response = await fetch(harness.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("dsh-control/unauthorized");
    // The response must not disclose whether a token exists.
    expect(body.error.message).toBe("missing or invalid credentials");
  });

  it("rejects a wrong token", async () => {
    const harness = await start();
    const response = await fetch(harness.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer nope" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(401);
  });

  it("answers GET with 405", async () => {
    const harness = await start();
    const response = await fetch(harness.url, { method: "GET", headers: { authorization: `Bearer ${TOKEN_FULL}` } });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toContain("POST");
  });

  it("refuses a session-less non-initialize request", async () => {
    const harness = await start();
    const response = await fetch(harness.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN_FULL}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("dsh-control/invalid-request");
  });

  it("refuses a body over the configured limit", async () => {
    const harness = await start();
    const response = await fetch(harness.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN_FULL}` },
      body: "x".repeat(LIMITS.maxRequestBodyBytes + 1),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("dsh-control/limit-exceeded");
  });

  it("refuses an unknown session id", async () => {
    const harness = await start();
    const response = await fetch(harness.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN_FULL}`,
        "mcp-session-id": "00000000-0000-0000-0000-000000000000",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(404);
  });
});

describe("mcp-http: tool catalogue", () => {
  it("lists exactly the documented MVP tools", async () => {
    const harness = await start();
    const client = await connect(harness.url, TOKEN_FULL);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "dsh_cancel_task",
      "dsh_control_info",
      "dsh_dispatch_session_task",
      "dsh_get_task",
      "dsh_inject_context",
      "dsh_list_sessions",
      "dsh_list_workspaces",
      "dsh_send_message",
      "dsh_wait_task",
    ]);
    for (const tool of tools.tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description ?? "").not.toHaveLength(0);
    }
  });

  it("reports the live policy and limits from dsh_control_info", async () => {
    const harness = await start({
      policy: {
        ...EMPTY_CALLER_POLICY,
        callerInstructions: "先说明目标与验收标准。",
        requiredFields: ["objective"],
        instructionsVersion: 5,
      },
    });
    const client = await connect(harness.url, TOKEN_FULL);
    const body = payload(await client.callTool({ name: "dsh_control_info", arguments: {} }));
    expect(body["protocolVersion"]).toBe("1.0");
    expect(body["operations"]).toContain("session.prompt");
    expect((body["callerPolicy"] as Record<string, unknown>)["instructionsVersion"]).toBe(5);
    expect((body["callerPolicy"] as Record<string, unknown>)["callerInstructions"]).toBe("先说明目标与验收标准。");
    expect((body["limits"] as Record<string, unknown>)["maxWaitMs"]).toBe(LIMITS.maxWaitMs);
    expect((body["pathPolicy"] as Record<string, unknown>)["pathAddressingEnabled"]).toBe(false);
  });

  it("narrows the reported operations to the caller's grant", async () => {
    const harness = await start();
    const client = await connect(harness.url, TOKEN_READONLY);
    const body = payload(await client.callTool({ name: "dsh_control_info", arguments: {} }));
    expect(body["operations"]).toEqual(["session.list", "workspace.read"]);
  });
});

describe("mcp-http: path addressing needs workspace.open", () => {
  it("refuses a path target for a prompt-only caller", async () => {
    // §26.1-1: `dsh_dispatch_session_task` used to check only session.prompt, so
    // a prompt-only token could register a new workspace by absolute path.
    const root = await mkdtemp(join(tmpdir(), "void-dsh-mcp-"));
    tempRoots.push(root);
    const harness = await start({ guard: { allowedRoots: [root] } });
    const client = await connect(harness.url, TOKEN_PROMPT_ONLY);

    const result = await client.callTool({
      name: "dsh_dispatch_session_task",
      arguments: {
        requestId: "r1",
        target: { workspace: { path: root }, session: "new" },
        messages: [{ text: "x" }],
      },
    });

    expect(errorPayload(result).code).toBe("dsh-control/forbidden-operation");
    expect((errorPayload(result).details as Record<string, unknown>)["operation"]).toBe("workspace.open");
    // Nothing was registered and nothing was delivered.
    expect(harness.hosts.registeredPaths).toEqual([]);
    expect(harness.hosts.deliveries).toEqual([]);
  });

  it("still allows a registered workspace for the same caller", async () => {
    const root = await mkdtemp(join(tmpdir(), "void-dsh-mcp-"));
    tempRoots.push(root);
    const harness = await start({ guard: { allowedRoots: [root] } });
    const workspace = harness.hosts.seedWorkspace(root);
    const client = await connect(harness.url, TOKEN_PROMPT_ONLY);

    const result = await client.callTool({
      name: "dsh_dispatch_session_task",
      arguments: {
        requestId: "r1",
        target: { workspace: { workspaceId: workspace.workspaceId }, session: "new" },
        messages: [{ text: "x" }],
      },
    });

    expect(payload(result)["status"]).toBe("prompt_queued");
    expect(harness.hosts.deliveries).toHaveLength(1);
  });

  it("advertises the requirement in dsh_control_info", async () => {
    const harness = await start();
    const client = await connect(harness.url, TOKEN_PROMPT_ONLY);
    const body = payload(await client.callTool({ name: "dsh_control_info", arguments: {} }));
    const pathPolicy = body["pathPolicy"] as Record<string, unknown>;
    expect(pathPolicy["pathAddressingOperation"]).toBe("workspace.open");
    expect(pathPolicy["relativeDocumentRefsMustStayInsideWorkspace"]).toBe(true);
  });
});

describe("mcp-http: dispatch flow", () => {
  it("registers a workspace, creates a session and pages events by cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "void-dsh-mcp-"));
    tempRoots.push(root);
    const harness = await start({ guard: { allowedRoots: [root] } });
    harness.hosts.seedWorkspace(root);
    const client = await connect(harness.url, TOKEN_FULL);

    const dispatched = payload(
      await client.callTool({
        name: "dsh_dispatch_session_task",
        arguments: {
          requestId: "r1",
          target: { workspace: { path: root }, session: "new" },
          messages: [{ text: "请完成任务" }],
          metadata: { objective: "完成任务" },
        },
      }),
    ) as { taskId: string; sessionId: string; workspaceId: string; eventCursor: string; status: string };

    expect(dispatched.status).toBe("prompt_queued");
    expect(dispatched.taskId).toMatch(/^task-/);
    expect(harness.hosts.registeredPaths).toEqual([root]);
    expect(harness.hosts.deliveries).toHaveLength(1);

    const snapshot = payload(await client.callTool({ name: "dsh_get_task", arguments: { taskId: dispatched.taskId } })) as {
      task: { eventCursor: string };
      events: { seq: number }[];
    };
    expect(snapshot.events.map((event) => event.seq)).toEqual([0, 1, 2, 3]);

    const resumed = payload(
      await client.callTool({
        name: "dsh_get_task",
        arguments: { taskId: dispatched.taskId, afterCursor: snapshot.task.eventCursor },
      }),
    ) as { events: unknown[] };
    expect(resumed.events).toEqual([]);
  });

  it("replays an identical request instead of delivering twice (scenario D)", async () => {
    const root = await mkdtemp(join(tmpdir(), "void-dsh-mcp-"));
    tempRoots.push(root);
    const harness = await start({ guard: { allowedRoots: [root] } });
    const client = await connect(harness.url, TOKEN_FULL);
    const args = {
      requestId: "same",
      target: { workspace: { path: root }, session: "new" },
      messages: [{ text: "x" }],
    };

    const first = payload(await client.callTool({ name: "dsh_dispatch_session_task", arguments: args })) as { taskId: string };
    const second = payload(await client.callTool({ name: "dsh_dispatch_session_task", arguments: args })) as { taskId: string };

    expect(second.taskId).toBe(first.taskId);
    expect(harness.hosts.deliveries).toHaveLength(1);
  });

  it("continues an existing session and waits by cursor (scenario C + F)", async () => {
    const harness = await start();
    const workspace = harness.hosts.seedWorkspace("E:/work/app", ["session-1"]);
    harness.hosts.seedSession("session-1", "E:/work/app");
    const client = await connect(harness.url, TOKEN_FULL);

    const sent = payload(
      await client.callTool({
        name: "dsh_send_message",
        arguments: { requestId: "r1", sessionId: "session-1", message: { text: "继续" } },
      }),
    ) as { taskId: string; eventCursor: string };
    expect(harness.hosts.deliveries[0]).toMatchObject({ kind: "prompt", sessionId: "session-1", mode: "queue" });

    const pending = client.callTool({
      name: "dsh_wait_task",
      arguments: { taskId: sent.taskId, afterCursor: sent.eventCursor, until: "completed", timeoutMs: 5_000 },
    });
    // Drive the host-side lifecycle the plugin subscribes to.
    await harness.orchestrator.applySignal("session-1", { status: "running", summary: "turn started" });
    await harness.orchestrator.applySignal("session-1", { status: "idle", summary: "turn ended (stop)" });

    const waited = payload(await pending) as { task: { status: string }; events: { status: string }[] };
    expect(waited.task.status).toBe("completed");
    expect(waited.events.map((event) => event.status)).toEqual(["running", "idle", "completed"]);
    expect(workspace.sessionIds).toEqual(["session-1"]);
  });

  it("injects context without waking the agent and marks it unexecuted", async () => {
    const harness = await start();
    harness.hosts.seedWorkspace("E:/work/app", ["session-1"]);
    harness.hosts.seedSession("session-1", "E:/work/app");
    const client = await connect(harness.url, TOKEN_FULL);

    const body = payload(
      await client.callTool({
        name: "dsh_inject_context",
        arguments: { requestId: "r1", sessionId: "session-1", text: "背景" },
      }),
    ) as { injected: boolean; executed: boolean; status: string };

    expect(body.injected).toBe(true);
    expect(body.executed).toBe(false);
    expect(harness.hosts.deliveries).toEqual([{ kind: "inject", sessionId: "session-1", requestId: "r1", text: "背景" }]);
  });

  it("cancels through the host without deleting the session", async () => {
    const root = await mkdtemp(join(tmpdir(), "void-dsh-mcp-"));
    tempRoots.push(root);
    const harness = await start({ guard: { allowedRoots: [root] } });
    const client = await connect(harness.url, TOKEN_FULL);

    const dispatched = payload(
      await client.callTool({
        name: "dsh_dispatch_session_task",
        arguments: { requestId: "r1", target: { workspace: { path: root }, session: "new" }, messages: [{ text: "x" }] },
      }),
    ) as { taskId: string; sessionId: string };

    const cancelled = payload(await client.callTool({ name: "dsh_cancel_task", arguments: { taskId: dispatched.taskId } })) as {
      status: string;
    };
    expect(cancelled.status).toBe("cancelled");
    expect(harness.hosts.deliveries.some((entry) => entry.kind === "cancel")).toBe(true);
    expect(harness.hosts.sessions.has(dispatched.sessionId)).toBe(true);
  });

  it("lists workspaces and sessions", async () => {
    const harness = await start();
    const workspace = harness.hosts.seedWorkspace("E:/work/app", ["session-1"]);
    harness.hosts.seedSession("session-1", "E:/work/app");
    const client = await connect(harness.url, TOKEN_FULL);

    const workspaces = payload(await client.callTool({ name: "dsh_list_workspaces", arguments: {} })) as {
      items: { workspaceId: string; sessionCount: number }[];
    };
    expect(workspaces.items).toEqual([
      { workspaceId: workspace.workspaceId, path: "E:/work/app", title: "E:/work/app", sessionCount: 1, createdAt: expect.any(String), updatedAt: expect.any(String) },
    ]);

    const sessions = payload(
      await client.callTool({ name: "dsh_list_sessions", arguments: { workspaceId: workspace.workspaceId } }),
    ) as { items: { sessionId: string; resumable: boolean }[] };
    expect(sessions.items.map((item) => item.sessionId)).toEqual(["session-1"]);
    expect(sessions.items[0]!.resumable).toBe(true);
  });

  it("exposes the optional task-events resource", async () => {
    const root = await mkdtemp(join(tmpdir(), "void-dsh-mcp-"));
    tempRoots.push(root);
    const harness = await start({ guard: { allowedRoots: [root] } });
    const client = await connect(harness.url, TOKEN_FULL);
    const dispatched = payload(
      await client.callTool({
        name: "dsh_dispatch_session_task",
        arguments: { requestId: "r1", target: { workspace: { path: root }, session: "new" }, messages: [{ text: "x" }] },
      }),
    ) as { taskId: string };

    const resources = await client.listResources();
    expect(resources.resources).toEqual([]);
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((template) => template.uriTemplate)).toEqual(["dsh://tasks/{taskId}/events"]);

    const read = await client.readResource({ uri: `dsh://tasks/${dispatched.taskId}/events` });
    const first = read.contents[0];
    expect(first).toBeDefined();
    const body = JSON.parse(String((first as { text: string }).text)) as { task: { taskId: string }; events: unknown[] };
    expect(body.task.taskId).toBe(dispatched.taskId);
    expect(body.events).toHaveLength(4);
  });
});

describe("mcp-http: policy and security rejections", () => {
  it("rejects a dispatch missing a required field (scenario E)", async () => {
    const root = await mkdtemp(join(tmpdir(), "void-dsh-mcp-"));
    tempRoots.push(root);
    const harness = await start({
      guard: { allowedRoots: [root] },
      policy: { ...EMPTY_CALLER_POLICY, requiredFields: ["objective"], instructionsVersion: 1 },
    });
    const client = await connect(harness.url, TOKEN_FULL);

    const result = await client.callTool({
      name: "dsh_dispatch_session_task",
      arguments: { requestId: "r1", target: { workspace: { path: root }, session: "new" }, messages: [{ text: "x" }] },
    });

    expect(result.isError).toBe(true);
    const error = errorPayload(result);
    expect(error.code).toBe("dsh-control/policy-required-field");
    expect(error.details["missingFields"]).toEqual(["objective"]);
    // Nothing reached the host.
    expect(harness.hosts.deliveries).toEqual([]);
    expect(harness.hosts.registeredPaths).toEqual([]);
  });

  it("rejects a required document rule that is not satisfied", async () => {
    const root = await mkdtemp(join(tmpdir(), "void-dsh-mcp-"));
    tempRoots.push(root);
    const harness = await start({
      guard: { allowedRoots: [root] },
      policy: {
        ...EMPTY_CALLER_POLICY,
        requiredDocumentRules: [{ id: "spec", description: "需要任务规格", required: true, pathPattern: "^docs/.+\\.md$" }],
      },
    });
    const client = await connect(harness.url, TOKEN_FULL);

    const result = await client.callTool({
      name: "dsh_dispatch_session_task",
      arguments: { requestId: "r1", target: { workspace: { path: root }, session: "new" }, messages: [{ text: "x" }] },
    });
    expect(errorPayload(result).code).toBe("dsh-control/policy-document-missing");
    expect(harness.hosts.deliveries).toEqual([]);
  });

  it("rejects a workspace path outside every allowed root (scenario G)", async () => {
    const allowed = await mkdtemp(join(tmpdir(), "void-dsh-allowed-"));
    const outside = await mkdtemp(join(tmpdir(), "void-dsh-outside-"));
    tempRoots.push(allowed, outside);
    const harness = await start({ guard: { allowedRoots: [allowed] } });
    const client = await connect(harness.url, TOKEN_FULL);

    const result = await client.callTool({
      name: "dsh_dispatch_session_task",
      arguments: { requestId: "r1", target: { workspace: { path: outside }, session: "new" }, messages: [{ text: "x" }] },
    });
    expect(errorPayload(result).code).toBe("dsh-control/workspace-not-allowed");
    expect(harness.hosts.deliveries).toEqual([]);
  });

  it("refuses path addressing when no root is configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "void-dsh-mcp-"));
    tempRoots.push(root);
    const harness = await start({ guard: { allowedRoots: [] } });
    const client = await connect(harness.url, TOKEN_FULL);

    const result = await client.callTool({
      name: "dsh_dispatch_session_task",
      arguments: { requestId: "r1", target: { workspace: { path: root }, session: "new" }, messages: [{ text: "x" }] },
    });
    expect(errorPayload(result).code).toBe("dsh-control/workspace-not-allowed");
  });

  it("refuses an operation the caller's token does not grant", async () => {
    const harness = await start();
    const client = await connect(harness.url, TOKEN_READONLY);
    const result = await client.callTool({
      name: "dsh_dispatch_session_task",
      arguments: { requestId: "r1", target: { workspace: { workspaceId: "w1" }, session: "new" }, messages: [{ text: "x" }] },
    });
    expect(result.isError).toBe(true);
    expect(errorPayload(result).code).toBe("dsh-control/forbidden-operation");
  });

  it("refuses steer without the session.steer grant", async () => {
    const harness = await start();
    harness.hosts.seedWorkspace("E:/work/app", ["session-1"]);
    harness.hosts.seedSession("session-1", "E:/work/app");
    // `readonly` has no session.prompt at all, so the tool-level grant already
    // refuses; this asserts the message-mode check as well by granting prompt.
    const client = await connect(harness.url, TOKEN_FULL);
    await expect(
      client.callTool({
        name: "dsh_send_message",
        arguments: { requestId: "r1", sessionId: "session-1", message: { text: "x", mode: "steer" } },
      }),
    ).resolves.toBeTruthy();
    expect(harness.hosts.deliveries[0]).toMatchObject({ mode: "steer" });
  });

  it("rejects an invalid tool argument before touching the host", async () => {
    const harness = await start();
    const client = await connect(harness.url, TOKEN_FULL);
    const result = await client.callTool({
      name: "dsh_dispatch_session_task",
      arguments: { requestId: "r1", target: { workspace: {}, session: "new" }, messages: [{ text: "x" }] },
    });
    expect(result.isError).toBe(true);
    // The cross-field rule is enforced in the handler, not by a schema
    // refinement, so the caller gets a published code rather than an SDK-level
    // -32602 whose message varies by SDK version.
    expect(errorPayload(result).code).toBe("dsh-control/invalid-request");
    expect(harness.hosts.deliveries).toEqual([]);
  });

  it("rejects a workspace target that sets both addressing modes", async () => {
    const harness = await start();
    const client = await connect(harness.url, TOKEN_FULL);
    const result = await client.callTool({
      name: "dsh_dispatch_session_task",
      arguments: {
        requestId: "r1",
        target: { workspace: { workspaceId: "w1", path: "E:/work/app" }, session: "new" },
        messages: [{ text: "x" }],
      },
    });
    expect(errorPayload(result).code).toBe("dsh-control/invalid-request");
    expect(harness.hosts.deliveries).toEqual([]);
  });

  it("returns an unknown task as a stable error", async () => {
    const harness = await start();
    const client = await connect(harness.url, TOKEN_FULL);
    const result = await client.callTool({ name: "dsh_get_task", arguments: { taskId: "task-nope" } });
    expect(errorPayload(result).code).toBe("dsh-control/task-not-found");
  });
});
