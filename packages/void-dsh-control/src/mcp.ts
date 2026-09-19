/**
 * MCP surface for the Lingbang control plane (plan §6, §12).
 *
 * The endpoint is Streamable HTTP in **stateless** mode: one `McpServer` and one
 * transport are created per HTTP request and bound to the caller identity that
 * request authenticated as. That keeps caller identity out of global state and
 * makes a dropped connection cost nothing.
 *
 * Every tool follows the same order, which is also the security order:
 * authenticate → authorize operation → validate shape → enforce user policy →
 * touch the host. A request that fails any earlier step never reaches the
 * session log.
 *
 * @module @void/void-dsh-control/mcp
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  CONTROL_PROTOCOL_VERSION,
  ControlError,
  LIMITS,
  cancelTaskInputSchema,
  cancelTaskInputShape,
  dispatchInputSchema,
  dispatchInputShape,
  documentRefSchema,
  getTaskInputSchema,
  getTaskInputShape,
  injectContextInputSchema,
  injectContextInputShape,
  listSessionsInputSchema,
  listSessionsInputShape,
  listWorkspacesInputSchema,
  listWorkspacesInputShape,
  sendMessageInputSchema,
  sendMessageInputShape,
  waitTaskInputSchema,
  waitTaskInputShape,
  type MessageMode,
} from "./protocol.js";
import type { Authenticator, CallerIdentity } from "./auth.js";
import { checkPolicy, describePolicy, throwOnViolations, type CompiledCallerPolicy } from "./policy.js";
import { renderDocumentRefs, resolveDocumentRefs, type DocumentRefInput } from "./document-refs.js";
import { assertAllowedDirectory, type PathGuard } from "./workspace.js";
import { TOOL_CONDITIONAL_OPERATIONS, TOOL_OPERATIONS, type ControlOrchestrator, type HostPorts, type PreparedMessage } from "./orchestrator.js";

/** Plugin identity reported to MCP clients. */
export interface PluginIdentity {
  readonly name: string;
  readonly version: string;
}

/** Everything the MCP tools need from the composition. */
export interface ControlToolDeps {
  readonly orchestrator: ControlOrchestrator;
  readonly authenticator: Authenticator;
  readonly hosts: HostPorts;
  /** Live policy accessor; settings can change under HMR. */
  readonly policy: () => CompiledCallerPolicy;
  /** Live path guard accessor. */
  readonly guard: () => PathGuard;
  readonly identity: PluginIdentity;
}

/** One MCP tool result. */
interface ToolResult {
  /** MCP result envelopes carry free-form metadata beside `content`. */
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/**
 * Render a successful tool result as JSON text.
 *
 * @param payload - JSON-safe payload.
 * @returns The MCP tool result.
 */
function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Render a failure as a stable, caller-safe MCP tool error.
 *
 * The payload always carries a `code` from the published vocabulary; host
 * errors are summarized rather than forwarded so no stack, path or credential
 * reaches the caller (plan §11 requirement 12).
 *
 * @param error - Failure raised while handling the tool call.
 * @returns The MCP tool error result.
 */
function fail(error: unknown): ToolResult {
  const payload =
    error instanceof ControlError
      ? error.toPayload()
      : { code: "dsh-control/internal" as const, message: "control plane failed to complete the request", details: {} };
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: payload }, null, 2) }], isError: true };
}

/**
 * Wrap a tool body so no failure escapes as an unstructured MCP protocol error.
 *
 * @param body - Tool implementation.
 * @returns A tool callback returning a structured result.
 */
function guarded(body: () => Promise<ToolResult>): () => Promise<ToolResult> {
  return async () => {
    try {
      return await body();
    } catch (error) {
      return fail(error);
    }
  };
}

/**
 * Build the `dsh_control_info` payload.
 *
 * This response, not the MCP tool description, is the authoritative statement of
 * the user's current rules (plan §6.1, §9.1).
 *
 * @param deps - Tool dependencies.
 * @param identity - Authenticated caller.
 * @returns The info payload.
 */
function infoPayload(deps: ControlToolDeps, identity: CallerIdentity): Record<string, unknown> {
  const policy = deps.policy();
  const guard = deps.guard();
  return {
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    plugin: deps.identity,
    operations: [...identity.operations].sort(),
    targets: {
      workspace: ["workspaceId", "path (absolute, inside allowedRoots; requires the workspace.open grant)"],
      session: ["new", "existing sessionId", "forkFrom + optional atSeq"],
    },
    limits: LIMITS,
    pathPolicy: {
      allowedRootCount: guard.allowedRoots.length,
      pathAddressingEnabled: guard.allowedRoots.length > 0,
      // Stated here so a caller discovers the requirement from the authoritative
      // policy response rather than from a rejected dispatch (plan §6.1).
      pathAddressingOperation: "workspace.open",
      relativeDocumentRefsMustStayInsideWorkspace: true,
    },
    callerPolicy: describePolicy(policy),
    notes: [
      "callerPolicy is live: re-read this tool after the user changes settings.",
      "metadata is audit-only; anything the DSH agent must see belongs in messages[].text.",
      "wait.until controls only this MCP response, never the agent's running policy.",
      "inject does not wake an idle agent; the task reports prompt_queued and stops.",
      "A relative documentRef must stay inside the workspace; address another allowed root with an absolute path.",
    ],
  };
}

/**
 * Resolve the real workspace root for a dispatch target.
 *
 * @param deps - Tool dependencies.
 * @param target - Workspace target from the request.
 * @returns The canonical workspace path.
 * @throws ControlError when the target does not name exactly one addressing mode.
 */
async function resolveWorkspaceRoot(
  deps: ControlToolDeps,
  target: { workspaceId?: string; path?: string },
): Promise<string> {
  // The cross-field rule lives here rather than in a schema refinement so the
  // caller always receives a published `dsh-control/invalid-request` code.
  if (target.path !== undefined && target.workspaceId !== undefined) {
    throw new ControlError("dsh-control/invalid-request", "workspace target must set exactly one of workspaceId or path");
  }
  if (target.path !== undefined) {
    return await assertAllowedDirectory(target.path, deps.guard());
  }
  if (target.workspaceId !== undefined) {
    const workspace = await deps.hosts.getWorkspace(target.workspaceId);
    if (workspace === undefined) {
      throw new ControlError("dsh-control/workspace-not-found", "workspace is not registered", {
        workspaceId: target.workspaceId,
      });
    }
    return workspace.path;
  }
  throw new ControlError("dsh-control/invalid-request", "workspace target must name a workspaceId or a path");
}

/**
 * Prepare the messages of a dispatch request: resolve document references,
 * render them into the model-facing text, and enforce the user policy.
 *
 * @param deps - Tool dependencies.
 * @param input - Parsed dispatch input.
 * @returns Prepared messages plus the workspace-relative paths that were used.
 */
async function prepareDispatch(
  deps: ControlToolDeps,
  input: z.infer<typeof dispatchInputSchema>,
): Promise<{ messages: PreparedMessage[]; documentPaths: string[] }> {
  const workspaceRoot = await resolveWorkspaceRoot(deps, input.target.workspace);
  const guard = deps.guard();
  const messages: PreparedMessage[] = [];
  const documentPaths: string[] = [];

  for (const message of input.messages) {
    const refs = await resolveDocumentRefs(message.documentRefs as readonly DocumentRefInput[], workspaceRoot, guard);
    for (const ref of refs) documentPaths.push(ref.relativePath);
    messages.push({ text: `${message.text}${renderDocumentRefs(refs)}`, mode: message.mode });
  }

  throwOnViolations(
    checkPolicy(deps.policy(), {
      metadata: input.metadata,
      documentPaths,
      texts: messages.map((message) => message.text),
    }),
  );

  return { messages, documentPaths };
}

/**
 * Build an MCP server whose tools act as one authenticated caller.
 *
 * @param deps - Tool dependencies.
 * @param identity - Caller the HTTP request authenticated as.
 * @returns A configured, not-yet-connected MCP server.
 */
export function createControlMcpServer(deps: ControlToolDeps, identity: CallerIdentity): McpServer {
  const server = new McpServer(
    { name: deps.identity.name, version: deps.identity.version },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        "Lingbang control plane for a running DeepSeek Harness Web profile. Call dsh_control_info before your first dispatch: it returns the user's live caller policy, which this description cannot express.",
    },
  );

  const authorize = (tool: keyof typeof TOOL_OPERATIONS): void => {
    const operation = TOOL_OPERATIONS[tool];
    // Tools absent from the table (only `dsh_control_info`) need authentication
    // but no grant: the caller policy must be readable by every caller.
    if (operation === undefined) return;
    deps.authenticator.require(identity, operation);
  };

  server.registerTool(
    "dsh_control_info",
    {
      title: "Read control-plane info",
      description: "Return protocol version, capabilities, limits and the user's live caller policy. Read this before dispatching.",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        authorize("dsh_control_info");
        return ok(infoPayload(deps, identity));
      })(),
  );

  server.registerTool(
    "dsh_dispatch_session_task",
    {
      title: "Dispatch a session task",
      description:
        "Atomically resolve a workspace, create/resume/fork a session and deliver messages, in one idempotent call. `requestId` is required and scoped to your caller identity. Addressing a workspace by absolute path requires the workspace.open grant.",
      inputSchema: dispatchInputShape,
    },
    async (args) =>
      guarded(async () => {
        authorize("dsh_dispatch_session_task");
        const input = dispatchInputSchema.parse(args);
        assertConditionalOperations(identity, "dsh_dispatch_session_task", input.target.workspace.path !== undefined);
        assertMessageModes(identity, input.messages.map((message) => message.mode));
        const prepared = await prepareDispatch(deps, input);
        const result = await deps.orchestrator.dispatch(identity, {
          requestId: input.requestId,
          workspace: input.target.workspace,
          session: toSessionCommand(input.target.session),
          messages: prepared.messages,
          wait: input.wait ?? { until: "accepted", timeoutMs: 0 },
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        });
        return ok(result);
      })(),
  );

  server.registerTool(
    "dsh_list_workspaces",
    {
      title: "List workspaces",
      description: "List registered workspaces, optionally filtered by absolute path prefix. Never returns credentials or environment values.",
      inputSchema: listWorkspacesInputShape,
    },
    async (args) =>
      guarded(async () => {
        authorize("dsh_list_workspaces");
        const input = listWorkspacesInputSchema.parse(args);
        const items = await deps.orchestrator.listWorkspaces(input.pathPrefix);
        return ok({ items });
      })(),
  );

  server.registerTool(
    "dsh_list_sessions",
    {
      title: "List sessions",
      description: "List sessions filtered by workspace id or absolute path, with running state and resumability.",
      inputSchema: listSessionsInputShape,
    },
    async (args) =>
      guarded(async () => {
        authorize("dsh_list_sessions");
        const input = listSessionsInputSchema.parse(args);
        const items = await deps.orchestrator.listSessions({
          ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
          ...(input.path === undefined ? {} : { path: input.path }),
        });
        return ok({ items });
      })(),
  );

  server.registerTool(
    "dsh_send_message",
    {
      title: "Send a message to a session",
      description: "Deliver one message to an existing (possibly cold) session. Default mode is queue; steer requires the session.steer grant.",
      inputSchema: sendMessageInputShape,
    },
    async (args) =>
      guarded(async () => {
        authorize("dsh_send_message");
        const input = sendMessageInputSchema.parse(args);
        assertMessageModes(identity, [input.message.mode]);
        const inspection = await deps.hosts.inspectSession(input.sessionId);
        if (!inspection.exists) {
          throw new ControlError("dsh-control/session-not-found", "session does not exist and is not resumable", {
            sessionId: input.sessionId,
          });
        }
        const root = inspection.cwd ?? process.cwd();
        const refs = await resolveDocumentRefs(input.message.documentRefs as readonly DocumentRefInput[], root, deps.guard());
        const text = `${input.message.text}${renderDocumentRefs(refs)}`;
        throwOnViolations(
          checkPolicy(deps.policy(), {
            metadata: input.metadata,
            documentPaths: refs.map((ref) => ref.relativePath),
            texts: [text],
          }),
        );
        const task = await deps.orchestrator.sendMessage(identity, {
          requestId: input.requestId,
          sessionId: input.sessionId,
          message: { text, mode: input.message.mode },
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        });
        return ok(task);
      })(),
  );

  server.registerTool(
    "dsh_inject_context",
    {
      title: "Inject context into a session",
      description:
        "Inject model-facing context for the next step WITHOUT waking an idle agent. The response is marked injected-but-not-executed.",
      inputSchema: injectContextInputShape,
    },
    async (args) =>
      guarded(async () => {
        authorize("dsh_inject_context");
        const input = injectContextInputSchema.parse(args);
        const inspection = await deps.hosts.inspectSession(input.sessionId);
        if (!inspection.exists) {
          throw new ControlError("dsh-control/session-not-found", "session does not exist and is not resumable", {
            sessionId: input.sessionId,
          });
        }
        const root = inspection.cwd ?? process.cwd();
        const refs = await resolveDocumentRefs(input.documentRefs, root, deps.guard());
        const text = `${input.text}${renderDocumentRefs(refs)}`;
        throwOnViolations(
          checkPolicy(deps.policy(), {
            documentPaths: refs.map((ref) => ref.relativePath),
            texts: [text],
          }),
        );
        const task = await deps.orchestrator.injectContext(identity, {
          requestId: input.requestId,
          sessionId: input.sessionId,
          text,
        });
        return ok({ ...task, injected: true, executed: false });
      })(),
  );

  server.registerTool(
    "dsh_get_task",
    {
      title: "Get task status",
      description: "Read a control task's status, bounded event page and assistant summary. Use afterCursor to page forward.",
      inputSchema: getTaskInputShape,
    },
    async (args) =>
      guarded(async () => {
        authorize("dsh_get_task");
        const input = getTaskInputSchema.parse(args);
        const snapshot = deps.orchestrator.getTask(identity, {
          taskId: input.taskId,
          ...(input.afterCursor === undefined ? {} : { afterCursor: input.afterCursor }),
          limit: input.limit,
        });
        return ok(snapshot);
      })(),
  );

  server.registerTool(
    "dsh_wait_task",
    {
      title: "Wait for task events",
      description: "Long-poll a task until it reaches `until` (or the timeout), returning only events after afterCursor.",
      inputSchema: waitTaskInputShape,
    },
    async (args) =>
      guarded(async () => {
        authorize("dsh_wait_task");
        const input = waitTaskInputSchema.parse(args);
        const snapshot = await deps.orchestrator.waitTask(identity, {
          taskId: input.taskId,
          ...(input.afterCursor === undefined ? {} : { afterCursor: input.afterCursor }),
          until: input.until,
          timeoutMs: input.timeoutMs,
          limit: input.limit,
        });
        return ok(snapshot);
      })(),
  );

  server.registerTool(
    "dsh_cancel_task",
    {
      title: "Cancel a task",
      description: "Cancel the active turn of a task's session. Never deletes the session, workspace or project files.",
      inputSchema: cancelTaskInputShape,
    },
    async (args) =>
      guarded(async () => {
        authorize("dsh_cancel_task");
        const input = cancelTaskInputSchema.parse(args);
        const task = await deps.orchestrator.cancelTask(identity, { taskId: input.taskId });
        return ok(task);
      })(),
  );

  // Optional resource surface for clients that read resources instead of
  // polling tools (plan §9.2). It reuses the same bounded event projection.
  server.registerResource(
    "task-events",
    new ResourceTemplate("dsh://tasks/{taskId}/events", { list: undefined }),
    { title: "Control task events", description: "Bounded event page for one control task.", mimeType: "application/json" },
    async (uri: URL, variables) => {
      const raw = variables["taskId"];
      const taskId = Array.isArray(raw) ? raw[0] : raw;
      if (taskId === undefined) {
        throw new ControlError("dsh-control/invalid-request", "taskId is required in the resource URI");
      }
      const snapshot = deps.orchestrator.getTask(identity, { taskId, limit: LIMITS.maxEventPageSize });
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(snapshot, null, 2) }],
      };
    },
  );

  return server;
}

/**
 * Enforce the conditional operation requirements of one tool call.
 *
 * A tool can need a second capability for a particular input shape. The most
 * important case is path-based workspace addressing: registering a workspace is
 * `workspace.open`, which is a strictly larger capability than prompting one
 * that is already registered, so a prompt-only token must not be able to reach
 * it through `dsh_dispatch_session_task` (plan §7.1, §11 requirement 4).
 *
 * @param identity - Authenticated caller.
 * @param tool - Tool being invoked.
 * @param applies - Whether the input shape triggers the extra requirement.
 */
function assertConditionalOperations(identity: CallerIdentity, tool: string, applies: boolean): void {
  if (!applies) return;
  for (const requirement of TOOL_CONDITIONAL_OPERATIONS[tool] ?? []) {
    if (!identity.operations.has(requirement.operation)) {
      throw new ControlError("dsh-control/forbidden-operation", "caller is not permitted to use this input shape", {
        operation: requirement.operation,
        when: requirement.when,
      });
    }
  }
}

/**
 * Reject a message mode the caller is not granted.
 *
 * `queue` needs `session.prompt` (already checked by the tool); `steer` needs
 * `session.steer`; `inject` needs `session.inject` (plan §11 requirement 4).
 *
 * @param identity - Authenticated caller.
 * @param modes - Modes requested by the message list.
 */
function assertMessageModes(identity: CallerIdentity, modes: readonly MessageMode[]): void {
  for (const mode of modes) {
    if (mode === "steer") {
      if (!identity.operations.has("session.steer")) {
        throw new ControlError("dsh-control/forbidden-operation", "caller is not permitted to steer a session", {
          operation: "session.steer",
        });
      }
      continue;
    }
    if (mode === "inject" && !identity.operations.has("session.inject")) {
      throw new ControlError("dsh-control/forbidden-operation", "caller is not permitted to inject context", {
        operation: "session.inject",
      });
    }
  }
}

/**
 * Narrow the wire session target into an orchestrator command.
 *
 * @param target - Parsed session target.
 * @returns The orchestrator's discriminated form.
 */
function toSessionCommand(
  target: z.infer<typeof dispatchInputSchema>["target"]["session"],
): { kind: "new" } | { kind: "existing"; sessionId: string } | { kind: "fork"; sessionId: string; atSeq?: number } {
  if (target === "new") return { kind: "new" };
  if ("sessionId" in target) return { kind: "existing", sessionId: target.sessionId };
  return target.atSeq === undefined
    ? { kind: "fork", sessionId: target.forkFrom }
    : { kind: "fork", sessionId: target.forkFrom, atSeq: target.atSeq };
}

/** Inputs of {@link createMcpHttpHandler}. */
export interface McpHttpHandlerOptions {
  readonly deps: ControlToolDeps;
  readonly authenticator: Authenticator;
}

/**
 * One live MCP transport session.
 *
 * Sessions are bound to the caller that created them: a leaked session id is
 * useless without a token that authenticates as the same caller.
 */
interface McpSession {
  readonly callerId: string;
  readonly server: McpServer;
  readonly transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

/** Maximum concurrent MCP sessions served by one control plane. */
const MAX_MCP_SESSIONS = 64;

/** Idle sessions older than this are closed and forgotten. */
const MCP_SESSION_IDLE_MS = 5 * 60_000;

/**
 * Create the HTTP handler registered on `ctx.webServer`.
 *
 * Responsibilities, in order: authenticate the bearer token, enforce the body
 * size bound, dispatch by verb, then hand the request to the MCP transport that
 * owns the session. A request carrying no session id must be an `initialize`;
 * every other request must name a session created by the same caller.
 *
 * @param options - Handler dependencies.
 * @returns A node:http handler owning the full response lifecycle.
 */
export function createMcpHttpHandler(options: McpHttpHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { deps, authenticator } = options;
  const sessions = new Map<string, McpSession>();

  const closeSession = (sessionId: string): void => {
    const session = sessions.get(sessionId);
    if (session === undefined) return;
    sessions.delete(sessionId);
    void session.transport.close();
    void session.server.close();
  };

  const reapIdleSessions = (now: number): void => {
    for (const [sessionId, session] of sessions) {
      if (now - session.lastSeen > MCP_SESSION_IDLE_MS) closeSession(sessionId);
    }
    // A hard cap keeps a caller that never disconnects from growing the table
    // without bound; the oldest session goes first.
    while (sessions.size >= MAX_MCP_SESSIONS) {
      const oldest = [...sessions.entries()].sort((left, right) => left[1].lastSeen - right[1].lastSeen)[0];
      if (oldest === undefined) break;
      closeSession(oldest[0]);
    }
  };

  return async (req, res) => {
    try {
      const identity = authenticator.authenticate(req.headers.authorization);
      const sessionId = headerValue(req.headers["mcp-session-id"]);
      const now = Date.now();
      reapIdleSessions(now);

      if (req.method === "DELETE") {
        if (sessionId === undefined || sessions.get(sessionId)?.callerId !== identity.callerId) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: { code: "dsh-control/task-not-found", message: "unknown MCP session" } }));
          return;
        }
        closeSession(sessionId);
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }

      if (req.method !== "POST") {
        // Streamable HTTP GET is the server-push channel; this control plane has
        // none, and 405 is the documented answer.
        res.writeHead(405, { "content-type": "application/json", allow: "POST, DELETE" });
        res.end(JSON.stringify({ ok: false, error: { code: "dsh-control/invalid-request", message: "only POST and DELETE are supported" } }));
        return;
      }

      const body = await readJsonBody(req, LIMITS.maxRequestBodyBytes);

      if (sessionId !== undefined) {
        const session = sessions.get(sessionId);
        if (session === undefined || session.callerId !== identity.callerId) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: { code: "dsh-control/task-not-found", message: "unknown MCP session" } }));
          return;
        }
        session.lastSeen = now;
        await session.transport.handleRequest(req, res, body);
        return;
      }

      if (!isInitializeRequest(body)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: { code: "dsh-control/invalid-request", message: "no MCP session id: send initialize first" },
          }),
        );
        return;
      }

      const server = createControlMcpServer(deps, identity);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (created) => {
          sessions.set(created, { callerId: identity.callerId, server, transport, lastSeen: Date.now() });
        },
      });
      transport.onclose = () => {
        const created = transport.sessionId;
        if (created !== undefined) sessions.delete(created);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const payload =
        error instanceof ControlError
          ? { ok: false, error: error.toPayload() }
          : { ok: false, error: { code: "dsh-control/internal", message: "control plane failed to handle the request" } };
      res.writeHead(error instanceof ControlError && error.code === "dsh-control/unauthorized" ? 401 : 400, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify(payload));
    }
  };
}

/**
 * Read one header value as a single string.
 *
 * @param value - Raw header value from node:http.
 * @returns The value, or `undefined` when absent.
 */
function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first.length === 0 ? undefined : first;
}

/**
 * Whether a parsed body is an MCP `initialize` request.
 *
 * @param body - Parsed JSON request body.
 * @returns True when the request opens a new MCP session.
 */
export function isInitializeRequest(body: unknown): boolean {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined;
  return record?.["method"] === "initialize";
}

/**
 * Read and parse a bounded JSON request body.
 *
 * The bound is enforced while reading, so an oversized body is rejected before
 * it is buffered in full.
 *
 * @param req - Incoming request.
 * @param limitBytes - Maximum accepted body size.
 * @returns The parsed JSON value, or `undefined` for an empty body.
 * @throws ControlError `dsh-control/limit-exceeded` or `dsh-control/invalid-request`.
 */
export async function readJsonBody(req: IncomingMessage, limitBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.byteLength;
    if (total > limitBytes) {
      throw new ControlError("dsh-control/limit-exceeded", "request body exceeds the configured limit", {
        limit: limitBytes,
      });
    }
    chunks.push(buffer);
  }
  if (total === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ControlError("dsh-control/invalid-request", "request body is not valid JSON");
  }
}

export { documentRefSchema };
