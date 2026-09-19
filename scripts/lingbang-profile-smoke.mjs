/**
 * 对**真实运行的 DSH profile** 做一次端到端 smoke：
 * initialize → tools/list → dsh_control_info → dsh_list_workspaces → dsh_list_sessions
 * → 各种拒绝路径。
 *
 * 用法：
 *   node scripts/lingbang-profile-smoke.mjs --url http://127.0.0.1:3199/mcp/dsh-agent-control --token <token>
 *
 * 退出码 0 表示全部通过；非 0 表示有断言失败（失败项会打印出来）。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const url = args.get("--url");
const token = args.get("--token") ?? process.env.VOID_DSH_CONTROL_TOKEN ?? "";
if (url === undefined) {
  console.error("missing --url");
  process.exit(2);
}

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail === undefined ? "" : ` :: ${detail}`}`);
    failures.push(name);
  }
}

function payload(result) {
  const content = result?.content;
  if (!Array.isArray(content) || content[0]?.type !== "text") throw new Error("expected a text tool result");
  return JSON.parse(content[0].text);
}

/**
 * Call a tool, tolerating the two rejection shapes an MCP server may use:
 * a tool result with `isError`, or a JSON-RPC protocol error thrown by the SDK
 * (schema-level rejection). Both mean "the request was refused".
 */
async function callToolSafe(client, name, args) {
  try {
    const result = await client.callTool({ name, arguments: args });
    return { refused: result.isError === true, body: payload(result), protocolError: undefined };
  } catch (error) {
    return { refused: true, body: undefined, protocolError: error instanceof Error ? error.message : String(error) };
  }
}

/** Error code from either rejection shape. */
function refusalCode(outcome) {
  return outcome.body?.error?.code ?? outcome.protocolError;
}

async function raw(body, headers) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.text() };
}

console.log("== lingbang 真实 profile smoke ==");
console.log(`endpoint: ${url}`);

console.log("\n[1] 认证拒绝");
{
  const anonymous = await raw({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, {});
  check("无 token → 401", anonymous.status === 401, `status=${anonymous.status}`);
  const wrong = await raw({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { authorization: "Bearer wrong" });
  check("错 token → 401", wrong.status === 401, `status=${wrong.status}`);
  const get = await fetch(url, { method: "GET", headers: { authorization: `Bearer ${token}` } });
  check("GET → 405", get.status === 405, `status=${get.status}`);
}

console.log("\n[2] MCP 握手与工具目录");
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: "lingbang-profile-smoke", version: "0.0.0" });
await client.connect(transport);
check("initialize 成功", true);

const tools = await client.listTools();
const names = tools.tools.map((tool) => tool.name).sort();
check("9 个工具", names.length === 9, names.join(","));
check(
  "工具名匹配",
  names.join(",") ===
    [
      "dsh_cancel_task",
      "dsh_control_info",
      "dsh_dispatch_session_task",
      "dsh_get_task",
      "dsh_inject_context",
      "dsh_list_sessions",
      "dsh_list_workspaces",
      "dsh_send_message",
      "dsh_wait_task",
    ].join(","),
  names.join(","),
);

console.log("\n[3] dsh_control_info");
const info = payload(await client.callTool({ name: "dsh_control_info", arguments: {} }));
check("协议版本", info.protocolVersion === "1.0", String(info.protocolVersion));
check("返回调用方权限", Array.isArray(info.operations) && info.operations.length > 0, JSON.stringify(info.operations));
check("返回限额", typeof info.limits?.maxWaitMs === "number");
check("返回调用约束", typeof info.callerPolicy === "object" && info.callerPolicy !== null);
check("路径策略可见", typeof info.pathPolicy?.pathAddressingEnabled === "boolean");
// §26.1-1: a caller must be able to discover the extra grant from the
// authoritative policy response instead of from a rejected dispatch.
check("路径寻址所需权限已声明", info.pathPolicy?.pathAddressingOperation === "workspace.open");
check("相对引用规则已声明", info.pathPolicy?.relativeDocumentRefsMustStayInsideWorkspace === true);

console.log("\n[4] 宿主只读查询（真实 workspaceController / sessionController）");
const workspaces = payload(await client.callTool({ name: "dsh_list_workspaces", arguments: {} }));
check("workspaces 返回 items 数组", Array.isArray(workspaces.items), JSON.stringify(workspaces).slice(0, 200));
const sessions = payload(await client.callTool({ name: "dsh_list_sessions", arguments: {} }));
check("sessions 返回 items 数组", Array.isArray(sessions.items), JSON.stringify(sessions).slice(0, 200));

console.log("\n[5] 拒绝路径");
{
  const outside = await callToolSafe(client, "dsh_dispatch_session_task", {
    requestId: "smoke-outside",
    target: { workspace: { path: "C:\\Windows" }, session: "new" },
    messages: [{ text: "x" }],
  });
  check(
    "allowedRoots 为空时拒绝路径寻址",
    refusalCode(outside) === "dsh-control/workspace-not-allowed",
    String(refusalCode(outside)),
  );

  const invalid = await callToolSafe(client, "dsh_dispatch_session_task", {
    requestId: "smoke-invalid",
    target: { workspace: {}, session: "new" },
    messages: [{ text: "x" }],
  });
  check("非法 target 被拒", invalid.refused === true, JSON.stringify(invalid.body ?? invalid.protocolError).slice(0, 200));
  check(
    "非法 target 返回稳定错误码",
    refusalCode(invalid) === "dsh-control/invalid-request",
    String(refusalCode(invalid)),
  );

  const both = await callToolSafe(client, "dsh_dispatch_session_task", {
    requestId: "smoke-both",
    target: { workspace: { workspaceId: "w", path: "C:\\Windows" }, session: "new" },
    messages: [{ text: "x" }],
  });
  check("两种寻址同时给出被拒", refusalCode(both) === "dsh-control/invalid-request", String(refusalCode(both)));

  const unknownTask = await callToolSafe(client, "dsh_get_task", { taskId: "task-nope" });
  check("未知任务 → task-not-found", refusalCode(unknownTask) === "dsh-control/task-not-found", String(refusalCode(unknownTask)));
}

console.log("\n[6] ledger（真实 storageDomain）");
{
  // 未知 workspaceId 会走到真实 workspaceController 查询，然后稳定失败。
  const failed = await callToolSafe(client, "dsh_dispatch_session_task", {
    requestId: "smoke-missing-ws",
    target: { workspace: { workspaceId: "workspace-does-not-exist" }, session: "new" },
    messages: [{ text: "x" }],
  });
  check(
    "未知 workspaceId → workspace-not-found",
    refusalCode(failed) === "dsh-control/workspace-not-found",
    String(refusalCode(failed)),
  );

  const unknownSession = await callToolSafe(client, "dsh_send_message", {
    requestId: "smoke-missing-session",
    sessionId: "session-does-not-exist",
    message: { text: "x" },
  });
  check(
    "未知 sessionId → session-not-found",
    refusalCode(unknownSession) === "dsh-control/session-not-found",
    String(refusalCode(unknownSession)),
  );
}

await client.close();

console.log("");
if (failures.length === 0) {
  console.log("全部通过。");
  process.exit(0);
}
console.log(`失败 ${failures.length} 项：${failures.join(", ")}`);
process.exit(1);
