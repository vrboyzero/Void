# @void/void-dsh-control（灵榜控制面）

让 Codex、其他 AI 或 Agent 通过 **MCP Streamable HTTP** 向**已经运行**的
DeepSeek Harness Web profile 下达会话级任务。

插件运行在 DSH 进程内，直接访问当前 Web profile 的 Workspace、Session 与 Agent；
MCP 只是外部调用协议，不是一个独立的状态源。

- 目标 DSH 版本：`0.1.5-rc.2`（peerDependencies `^0.1.5-rc.2`）。
  实测承载 Web profile 的全局 CLI 是 `0.1.5-rc.1`，其内置子包为 `0.1.5-rc.2`。
- 插件名：`@void/void-dsh-control`，运行时名称：`void-dsh-control`。

## 1. 安装

### 1.1 从本仓库装配

```powershell
pwsh -File scripts/pack-lingbang.ps1
```

产出：

```text
dist/lingbang/
  package.json                      # dsh.bundle.patch -> cordis.patch.yml
  lib/                              # 编译后的插件
  cordis.patch.yml                  # bundle 层默认配置
  README.md
  void-void-dsh-control-0.1.0.tgz   # 安装载体
```

### 1.2 装进一个 profile

> **必须用 tarball，不要用目录路径。**

```powershell
dsh plugin --profile <profile> add "E:\project\star-sanctuary\Void\dist\lingbang\void-void-dsh-control-0.1.0.tgz"
```

原因（实测，非偏好）：dsh 的模块解析是「双锚点」的——profile 目录内的包沿 Node
父级向上查找，命中 `$DSH_HOME/profiles/node_modules` 里镜像的安装依赖闭包。
`dsh plugin add <目录>` 会装成 `link:`（符号链接），Node 按**真实路径**解析该包的
bare import，父级查找永远走不到 profile 的 `node_modules`，于是
`@deepseek-ai/cordis` 等 peer 解析失败，profile 启动直接报：

```text
ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/cordis'
  imported from ...\dist\lingbang\lib\index.js
```

用 tarball 安装时 pnpm 会把包解到 profile 自己的 `node_modules`，父级查找即可命中。
`dsh plugin add` 会识别 `package.json` 里的 `dsh.bundle.patch`，把 `cordis.patch.yml`
作为一个 bundle 层加入 profile。

> 重新打包后要**先 remove 再 add**：pnpm 按包名 + 版本复用已解析的依赖，直接
> `add` 同一个版本的 tarball 会返回 "Already up to date" 而保留旧代码。

```powershell
dsh plugin --profile <profile> remove "@void/void-dsh-control"
dsh plugin --profile <profile> add "<...>\void-void-dsh-control-0.1.0.tgz"
```

### 1.3 配置 token

```powershell
# 只在本机设置；不要写进 settings.yaml / cordis.patch.yml / 会话日志
$env:VOID_DSH_CONTROL_TOKEN = "<一段随机长字符串>"
```

变量未设置时插件会 warn，并且**所有请求返回 401**——不会退化成无认证端点。

### 1.4 客户端配置样例（Codex / 通用 MCP Client）

```json
{
  "mcpServers": {
    "dsh-control": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:3080/mcp/dsh-agent-control",
      "headers": {
        "Authorization": "Bearer ${VOID_DSH_CONTROL_TOKEN}"
      }
    }
  }
}
```

> 字段名以你实际使用的客户端文档为准；上例是概念配置。

## 2. 配置项

配置写在 profile 的 `cordis.patch.yml` 中，按 `id: void-dsh-control` 覆盖 bundle 层的行。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 设为 `false` 后不注册端点，回滚只需改这一行 |
| `path` | `/mcp/dsh-agent-control` | 挂到现有 WebServer 的精确路径 |
| `tokens[]` | `[{callerId: default, tokenEnv: VOID_DSH_CONTROL_TOKEN}]` | `tokenEnv` 是环境变量名，**不是** token 本身 |
| `allowAnonymous` | `false` | 仅用于本机 smoke；默认关闭 |
| `allowedRoots` | `[]` | 允许按绝对路径寻址的根目录；**留空即完全禁用路径寻址** |
| `allowedOperations` | 见 bundle 层 | token 未显式声明 `operations` 时使用的授权集合 |
| `ledger` | `storage` | `storage` 用 `dsh_agent_control` domain；`memory` 重启即丢 |
| `callerInstructions` | `''` | 返回给外部 Agent 的调用约束正文 |
| `requiredFields` | `[]` | 每次下单必须非空提供的 `metadata` 字段 |
| `requiredDocumentRules` | `[]` | 任务文档要求（`id` / `description` / `required` / `pathPattern`） |
| `forbiddenPatterns` | `[]` | 命中即拒绝的正则，例如 `'BEGIN PRIVATE KEY'` |
| `instructionsVersion` | `0` | 用户改动规则时递增；响应里会带回来 |
| `callback` | `{enabled: false}` | 可选回调 webhook，见 §3.2 |

### 2.1 用户设置层（热更新）

如果 profile 挂载了 `@deepseek-ai/dsh-settings`，插件会注册命名空间
`dsh-agent-control`，于是下面这些字段可以从 `$DSH_HOME/settings.yaml` 覆盖，
并且**不需要重启**：

```yaml
dsh-agent-control:
  callerInstructions: |
    下单前必须说明目标、验收标准和任务文档路径。
    文档引用使用工作区相对路径；不要发送密钥或完整环境变量。
  requiredFields:
    - objective
    - acceptanceCriteria
  requiredDocumentRules:
    - id: task-spec
      description: 必须提供任务规格文档
      required: true
      pathPattern: '^docs/.+\.(md|txt)$'
  forbiddenPatterns:
    - 'BEGIN PRIVATE KEY'
  instructionsVersion: 3
```

`dsh_control_info` 的响应，而不是 MCP tool description，才是规则的权威来源：
设置可以在 HMR 下变化，外部 Agent 每次开工前都应先读一次。

## 3. 工具

| 工具 | 需要的操作 | 说明 |
|---|---|---|
| `dsh_control_info` | 仅需认证 | 协议版本、能力、限额、**当前调用约束** |
| `dsh_dispatch_session_task` | `session.prompt` | 一次完成 Workspace 解析 + Session 创建/恢复/fork + 投递 |
| `dsh_list_workspaces` | `workspace.read` | 列出已登记 Workspace |
| `dsh_list_sessions` | `session.list` | 按 Workspace 或路径列出 Session |
| `dsh_send_message` | `session.prompt` | 向已有（含冷）Session 发一条消息 |
| `dsh_inject_context` | `session.inject` | 注入下一步模型上下文，**不唤醒**空闲 Agent |
| `dsh_get_task` | `task.read` | 查任务状态 + 有界事件页 |
| `dsh_wait_task` | `task.read` | 按 `afterCursor` 等待到指定状态 |
| `dsh_cancel_task` | `task.cancel` | 取消任务对应回合；不删 Session / Workspace / 文件 |

可选 Resource：`dsh://tasks/{taskId}/events`。

### 3.1 授权语义

操作授权是**向下传递**的，最小集合即可：

| 授予 | 同时获得 |
|---|---|
| `session.prompt` | `session.create` → `workspace.read` |
| `session.inject` / `session.steer` | `session.create` → `workspace.read` |
| `workspace.open` | `workspace.read` |
| `task.cancel` | `task.read` → `session.observe` |

只读 token 给 `workspace.read` + `session.list` 即可。

**条件权限**：`dsh_dispatch_session_task` 除了 `session.prompt`，在
`target.workspace.path`（按绝对路径寻址）时**还要求 `workspace.open`**——登记新项目
比给已登记项目下单是更大的能力。用 `workspaceId` 下单不需要它。

**路径引用规则**：文档引用里，**相对路径必须留在本工作区内**（含 `..` 段一律拒绝）；
要引用另一个 `allowedRoots` 下的文件，必须写**绝对路径**。

### 3.2 可选回调 webhook

给**不能一直保持 MCP 连接**的调用方用。默认关闭。

```yaml
# profile 的 cordis.patch.yml 里，按 id 覆盖 bundle 层
- id: void-dsh-control
  config:
    callback:
      enabled: true
      url: 'https://receiver.example/dsh-hook'
      secretEnv: VOID_DSH_CONTROL_CALLBACK_SECRET
      events: [completed, failed, cancelled]
      timeoutMs: 10000
      maxAttempts: 5
      allowedHosts: ['receiver.example']   # 可选；非空时强制校验 URL 主机
      includeAssistantSummary: false       # 默认不发送模型产出文本
```

```powershell
$env:VOID_DSH_CONTROL_CALLBACK_SECRET = "<HMAC 共享密钥>"
```

请求：

```http
POST /dsh-hook HTTP/1.1
content-type: application/json
x-dsh-control-delivery: task-abc:7
x-dsh-control-event: completed
x-dsh-control-timestamp: 1790000000
x-dsh-control-signature: sha256=<hex>

{"deliveryId":"task-abc:7","taskId":"task-abc","callerId":"codex","requestId":"r-1",
 "status":"completed","eventKind":"completed","time":"...","eventCursor":"7",
 "summary":"task completed: agent reached idle","workspaceId":"...","sessionId":"..."}
```

约定：

- **签名**：`HMAC-SHA256(secret, "<timestamp>.<body>")`，十六进制。接收方应校验签名
  并拒绝时间戳过旧的请求（签名覆盖时间戳，重放无法靠换时间戳绕过）。
- **幂等**：`deliveryId` = `<taskId>:<eventSeq>`，接收方按它去重。
- **重试**：失败按 `1s, 2s, 4s, …` 指数退避，上限 60s，最多 `maxAttempts` 次；
  每次尝试都写进 ledger 的 `callback_deliveries`，重启后不会重复通知已成功的投递。
- **负载范围**：只含任务摘要与游标。完整会话记录**永远不发送**；模型产出的
  `assistantSummary` 需要显式打开 `includeAssistantSummary`。
- **地址来源**：只来自用户配置，**不接受外部请求动态指定**回调地址。
- **失败不影响任务**：投递失败只记 ledger，不会把任务改成失败，也不会阻塞编排。
- 插件卸载时会先停止接受新请求，再 `drain()` 等投递收敛，最后关闭路由与 ledger。

## 4. 错误码

稳定、可诊断、不含凭据与内部堆栈：

```text
dsh-control/invalid-request              dsh-control/workspace-path-invalid
dsh-control/unauthorized                 dsh-control/workspace-not-allowed
dsh-control/forbidden-operation          dsh-control/workspace-not-found
dsh-control/policy-required-field        dsh-control/session-not-found
dsh-control/policy-document-missing      dsh-control/session-workspace-mismatch
dsh-control/policy-document-invalid      dsh-control/session-locked
dsh-control/policy-forbidden-content     dsh-control/task-not-found
dsh-control/limit-exceeded               dsh-control/host-unavailable
dsh-control/internal
```

## 5. 任务状态

```text
accepted → workspace_resolved → session_created | session_resumed
        → prompt_queued → running ⇄ assistant_message → idle → completed
任意非终态 → failed | cancelled
```

- `completed` 的条件：任务先被观察到 `running`，随后 Agent 回到 `idle`。
- `dsh_inject_context` 不唤醒 Agent，任务在 `prompt_queued → idle → completed` 立即收敛，
  响应里带 `injected: true, executed: false`。
- `eventCursor` 是任务事件序号；`dsh_wait_task(taskId, afterCursor)` 只返回其后的有序事件，
  断线后从游标继续即可，不依赖服务端主动推送。

## 6. 安全边界

1. 默认只跟随现有 WebServer 的绑定（loopback），插件自己不开监听、不改绑定。
2. token 只从环境变量读取；日志、配置、会话日志里都不出现 token 值。
3. token 比较走 SHA-256 摘要 + `timingSafeEqual`；失败只返回通用 401，不泄漏是否配置了 token。
4. 按 token 授予最小操作；只读、下单、转向、取消分开控制。
5. 路径一律 `realpath` 后再判 `allowedRoots`，`..` 穿越与符号链接逃逸同样被拒。
6. 限制 HTTP body、单条消息、文档引用数量/字节数、事件页大小与等待时长。
7. 所有请求带 `requestId`，按 `callerId + requestId` 幂等，重复请求不会重复投递。
8. 不开放 shell、任意命令、任意进程、动态插件安装、任意 Session 文件路径与 token 读取。
9. 外部消息一律经 DSH 现有 Session prompt / Agent inject 入口进入，确保写入事件日志。
10. 外部请求不能提升 Session 的 sandbox、approval、模型权限或工作区范围。
11. 拒绝内联 `.env`、`*.pem`、`.credentials.yaml` 等敏感文件（`mode: "reference"` 仍可用）。
12. 返回给外部 Agent 的错误稳定、可诊断，不含凭据、环境变量与内部堆栈。

## 7. 回滚

profile 的 `cordis.patch.yml` 是一个**顶层 YAML 数组**，回滚条目要写进数组里
（不是追加到 `[]` 后面）：

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- id: void-dsh-control
  config:
    enabled: false
```

1. 上面这一条，或直接删掉 `void-dsh-control` 这个 bundle（`dsh plugin remove`）。
2. 重启 Web profile，MCP 端点立即消失。
3. 不删除 Session 日志、Workspace 目录与 control ledger（保留用于审计）。
4. callback 默认关闭，回滚不需要删除任何环境变量。

不要用 `git reset`、批量删除或覆盖 `.dsh` 数据目录作为回滚手段。

### 7.1 回滚实测

在隔离 profile（`DSH_HOME=.tmp/lingbang-smoke`）上验证：

| 步骤 | 结果 |
|---|---|
| 装 tarball 后启动 | 端点存活；无 token / 错 token → 401；GET → 405 |
| MCP Client 端到端 smoke | 19 项断言全通过（工具目录、info、只读查询、各拒绝路径） |
| ledger 落盘 | `$DSH_HOME/storages/dsh_agent_control.json`，`version: 1`，5 张表 |
| 加 `enabled: false` 后重启 | 组合树显示 `config: {enabled: false}`；端点消失（回落到 SPA fallback 的 405）；profile 本身仍正常启动；ledger 文件保留 |

## 8. 开发

本包**不在** Void 主 pnpm workspace 内（原因见方案文档 §20.1：与其余包的
`0.1.0-rc.6` 依赖共存会让 pnpm 提升既有包的 peer 并破坏它们的测试）。
它自带 `pnpm-workspace.yaml` 与 `pnpm-lock.yaml`。

```powershell
cd packages/void-dsh-control
pnpm install
pnpm run typecheck   # src + tests 两套 tsconfig
pnpm test            # vitest，10 文件 / 204 例
pnpm run build       # tsc -> lib/
```

仓库根的 `pnpm -r build/test/typecheck` 不会覆盖本包。

### 8.1 真实 profile 端到端 smoke

```powershell
# 1. 装配（含 tarball）
pwsh -File scripts/pack-lingbang.ps1

# 2. 用隔离的 DSH_HOME 起一个临时 profile（不动正在使用的 web profile）
$env:DSH_HOME = "E:\project\star-sanctuary\Void\.tmp\lingbang-smoke"
dsh --profile lingbang --from-default-profile web --port 3199 --no-open   # 首次生成后 Ctrl-C
dsh plugin --profile lingbang add "E:\project\star-sanctuary\Void\dist\lingbang\void-void-dsh-control-0.1.0.tgz"

# 3. 启动并跑 smoke（19 项断言，退出码即结果）
$env:VOID_DSH_CONTROL_TOKEN = "<token>"
dsh --profile lingbang --port 3199 --no-open
node scripts/lingbang-profile-smoke.mjs --url http://127.0.0.1:3199/mcp/dsh-agent-control --token <token>
```

### 8.2 重新打包后的注意点

pnpm 按包名 + 版本复用已解析的依赖，直接 `add` 同一个版本的 tarball 会返回
"Already up to date" 并保留**旧代码**。重新打包后必须：

```powershell
dsh plugin --profile <profile> remove "@void/void-dsh-control"
dsh plugin --profile <profile> add "<...>.tgz"
```
