/**
 * 远程只读诊断：凭据只从 --token-env 指定的进程环境变量读，不输出 header 或响应正文。
 * node scripts/lingbang-remote-smoke.mjs --url https://host.tailnet.ts.net/mcp/dsh-agent-control --token-env LINGBANG_OFFICE_TOKEN
 * 可选 --task-id ID --after-cursor CURSOR：验证已知任务的断线续读，不派发新任务。
 */
import { createRequire } from 'node:module';
const require = createRequire(new URL('../packages/void-dsh-control/package.json', import.meta.url));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const args = new Map();
const known = new Set(['--url', '--token-env', '--task-id', '--after-cursor']);
for (let i = 2; i < process.argv.length; i += 2) {
  if (!known.has(process.argv[i]) || !process.argv[i + 1]) throw new Error('参数只接受 --url、--token-env、--task-id、--after-cursor 的名称/值对');
  args.set(process.argv[i], process.argv[i + 1]);
}
const url = new URL(args.get('--url'));
if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) throw new Error('端点必须是无凭据和查询参数的 HTTP(S) URL');
if (url.protocol !== 'https:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw new Error('远程端点必须使用 HTTPS');
const tokenEnv = args.get('--token-env') ?? 'LINGBANG_OFFICE_TOKEN';
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) throw new Error('非法环境变量名');
const token = process.env[tokenEnv]?.trim();
if (!token) throw new Error(`当前进程缺少 ${tokenEnv}`);

function check(condition, message) { if (!condition) throw new Error(message); console.log(`PASS ${message}`); }
function payload(result) {
  if (result.isError) throw new Error('工具拒绝请求：请检查 caller 操作授权、workspaceIds 和 taskId 所属目标');
  return JSON.parse(result.content[0].text);
}
async function status(headers) {
  const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(10_000) });
  await response.body?.cancel();
  return response.status;
}
try {
  check(await status({}) === 401, '缺失 token 返回 401');
  check(await status({ Authorization: 'Bearer invalid-smoke-token' }) === 401, '错误 token 返回 401');
  check(await status({ Origin: 'https://untrusted.invalid' }) === 403, '陌生 Origin 返回 403');
  check(await status({ Authorization: `Bearer ${token}` }) === 405, '有效 token 通过鉴权（GET 不提供推送流）');
  for (let attempt = 0; attempt < 2; attempt++) {
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    const client = new Client({ name: 'lingbang-remote-smoke', version: '1' });
    try {
      await client.connect(transport, { timeout: 15_000 });
      check((await client.listTools()).tools.some(tool => tool.name === 'dsh_get_task'), `连接 ${attempt + 1} 工具发现`);
      const info = payload(await client.callTool({ name: 'dsh_control_info', arguments: {} }));
      check(Array.isArray(info.workspaceScope?.workspaceIds), `连接 ${attempt + 1} 工作区范围可见`);
      console.log(`operations=${info.operations.join(',')} workspaceCount=${info.workspaceScope.workspaceIds.length}`);
      if (args.has('--task-id')) {
        const result = payload(await client.callTool({ name: 'dsh_get_task', arguments: {
          taskId: args.get('--task-id'), ...(args.has('--after-cursor') ? { afterCursor: args.get('--after-cursor') } : {}),
        } }));
        console.log(`taskStatus=${result.task.status} eventCursor=${result.task.eventCursor} eventCount=${result.events.length}`);
      }
    } finally { await client.close(); }
  }
} catch {
  console.error('FAIL 远程诊断未通过；检查目标在线、Serve 路径、tailnet grants/ACL、凭据与授权。未派发任务。');
  process.exitCode = 1;
}
