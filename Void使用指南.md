# Void 使用指南

> Void 是一套寄生在 DeepSeek Harness（dsh）之上的树外插件组，把 Star 的差异化能力（记忆 / 工具治理 / 军团 / 渠道）以 dsh seam 的方式接入。本文档说明：如何安装对接插件、每个功能模块怎么用。
>
> 关联文档：[虚空寄生实施方案计划.md](./虚空寄生实施方案计划.md)（方案与进度）、[SOURCES.md](./SOURCES.md)（来源清单）、[README.md](./README.md)（首版边界与分叉）。

---

## 一、Void 是什么

一句话：**Void 不是独立产品，而是挂在 dsh 上的一组插件（bundle）。**

```
你（WebChat / 飞书）
        │  dsh SDK / JSON-RPC
        v
  dsh 宿主（agent-loop / session / tools / subagent）
        │  装载 Void bundle
        v
  Void 插件组
   ├─ void-memory      记忆知识层（FTS5 + sqlite-vec 检索）
   ├─ void-tools       工具治理（契约 + 角色策略）
   ├─ void-legion      军团（花名册 + 权威关系 + 派活）
   ├─ void-channel-*   渠道（飞书等）
   └─ void             组合 bundle（把上面几层合到一层）
```

Void 遵守 dsh 的契约：不替换 agent-loop、不双写 session，记忆作为其上的 knowledge 层；团队/军团作为公开的 `ctx.voidTeam` seam（不降级为 subagent 黑盒）。

### 仓库里有什么

| 包 | 作用 |
|---|---|
| `@void/void-memory` | `ctx.voidMemory` 记忆 seam + `memory_search` 工具 |
| `@void/void-tools` | `ctx.voidToolContracts` 契约注册表 + `ctx.tools.guard` 角色策略 |
| `@void/void-legion` | `ctx.voidTeam` 军团 seam（roster + 权威 + 派活 + checkpoint） |
| `@void/void-channel-feishu` | `ctx.voidChannels` 渠道注册表 + mock 飞书传输 |
| `@void/void` | 组合 bundle（memory + tools + legion 合到一个 profile 层） |
| `@void/void-seam-demo` | 阶段 1 的最小 seam 模板（Service Definition + Provider + Consumer） |
| `@void/void-memory` 内嵌 `src/star/` | Star 记忆的全量源码快照（方案 B 合并后随插件包分发） |

---

## 二、安装与对接（插件如何装进 dsh）

### 2.1 前置条件

- **Node**：`^22.19.0` 或 `>=24.0.0`
- **pnpm**：Void 工作区用 `10.23.0`（`package.json` 的 `packageManager` 已声明）
- **dsh CLI**：`@deepseek-ai/dsh`（全局或 `npx` 均可）

### 2.2 拉依赖 / 构建 / 测试（Void 仓库内）

```powershell
cd E:\project\star-sanctuary\Void
pnpm install      # 安装所有 workspace 依赖（含 native）
pnpm build        # tsc 编译所有包
pnpm test         # 跑全部测试（当前 29 个，全绿）
```

> ⚠️ **native 依赖**：`better-sqlite3` 需要运行 build script 下载/编译二进制。仓库根 `package.json` 已配 `pnpm.onlyBuiltDependencies: ["better-sqlite3"]`；若安装后仍报 `Could not locate the bindings file`，手动执行：
> ```powershell
> cd node_modules\.pnpm\better-sqlite3@*\node_modules\better-sqlite3
> .\node_modules\.bin\prebuild-install.cmd
> ```

### 2.3 把 Void 插件装进一个 dsh profile（本地开发方式）

> 关键坑：`dsh plugin add <本地路径>` **只把包加为 `link:` 依赖，不会自动写进 `dsh.profile.bundles`**（发行形态固化前的手动步骤）。

```powershell
# 1. 隔离数据目录（避免污染 ~/.dsh）
$env:DSH_HOME = "E:\project\star-sanctuary\Void\.dsh-demo"

# 2. 装 dsh headless（务必显式 rc.6，勿用 latest，见 FAQ）
dsh plugin --profile demo add @deepseek-ai/dsh-headless@0.1.0-rc.6

# 2b. 允许 better-sqlite3 的 install script（干净 profile 必须；否则 native binding 缺失）
$profileDir = Join-Path $env:DSH_HOME "profiles\demo"
$workspaceYaml = Join-Path $profileDir "pnpm-workspace.yaml"
if ((Get-Content -Raw $workspaceYaml) -notmatch 'onlyBuiltDependencies') {
  Add-Content -Path $workspaceYaml -Value "`nonlyBuiltDependencies:`n  - better-sqlite3`n"
}

# 3. 逐个 link Void 包（绝对路径，bundle 自动识别）
$base = "E:\project\star-sanctuary\Void\packages"
dsh plugin --profile demo add "$base\void-memory"
dsh plugin --profile demo add "$base\void-tools"
dsh plugin --profile demo add "$base\void-legion"
dsh plugin --profile demo add "$base\void-channel-feishu"

# 4. 验证组合（应看到 "# == @void/*" 各层）
dsh --profile demo --dump-config

# 5. 跑完整任务
$env:DEEPSEEK_API_KEY = "你的 key"
dsh --profile demo "你的任务"
```

> 也可用脚本：`.\scripts\install-profile.ps1 -Profile demo -DshHome "...\.dsh-demo"`

验证成功的标志：`--dump-config` 输出里出现 `# == @void/*` 各层，且任务里模型能调用 `memory_search` 工具。

### 2.4 发行方式

- **打包**：`.\scripts\pack-all.ps1` 把所有包 `pnpm pack` 到 `dist/`（`workspace:*` 会自动重写为版本号），打包前会清理上一轮 tarball。
- **干净 profile smoke**：`.\scripts\smoke-clean-profile.ps1 -ApiKey "你的key"` 会用全新 `DSH_HOME` 安装 `dsh-headless` + `distoid-void-memory-0.1.0.tgz`，放行 `better-sqlite3` build，打印 dump-config，并让模型真实调用一次 `memory_search`；完整输出在 `%TEMP%\dsh-void-smoke.log`。
- **正式发行**：`pnpm publish` 到 npm（或私有 registry）后，`dsh plugin add @void/void`（组合 bundle 作为单一入口，其 `@void/void-*` 依赖从 registry 解析）。
- **已知限制**：本地 tarball 互装时，包之间的相互依赖仍去 npm 解析（404），故 tarball 只适合无相互依赖的单包分发。

---

## 三、功能模块使用指南

### 3.1 记忆（void-memory）

**能力**：把内容写入知识层（FTS5 全文 + sqlite-vec 向量），按关键词或向量检索。底层是 Star `belldandy-memory` 的全量快照，内嵌于本包 `src/star/`（快照校验：`pnpm run verify:star-memory-snapshot`）。

**数据目录**：环境变量 `VOID_MEMORY_PATH` 指定 SQLite 文件；缺省 `:memory:`（测试用）。

**代码层 API（`ctx.voidMemory`）**：

```ts
// 写入一条（可选带 embedding 向量），返回字符串 id
const id = ctx.voidMemory.store("要记住的内容", new Float32Array([...]));

// 关键词检索（FTS5）
const hits = ctx.voidMemory.search("关键词", 5);

// 向量检索（sqlite-vec KNN）
const hits2 = ctx.voidMemory.searchByVector(new Float32Array([...]), 5);

// 摄取整篇文档（按空行切块后逐块存储），返回块数
const n = ctx.voidMemory.ingest("第一段\n\n第二段\n\n第三段");
```

**模型层工具**：`memory_search`（参数 `query` + 可选 `k`）——模型可直接调用它查记忆。

### 3.2 工具治理（void-tools）

**能力**：给工具挂"契约"（家族 / 风险等级 / 只读 / 需授权），并用角色策略（`ctx.tools.guard`）在工具执行前拦截越权调用。

**代码层 API（`ctx.voidToolContracts`）**：

```ts
// 注册一个工具契约（HMR-safe，返回 disposer）
ctx.voidToolContracts.register({
  name: "void_exec",
  family: "command-exec",   // network-read / workspace-read / workspace-write / patch / command-exec / ...
  isReadOnly: false,
  needsPermission: true,
  riskLevel: "high",        // low / medium / high / critical
});

// 查询契约
const contract = ctx.voidToolContracts.get("void_exec");
```

**角色策略**（`void-tools-policy` 插件，通过 `ctx.tools.guard` 落地）：当某个工具的执行不符合 `allowedToolFamilies` 或超过 `maxToolRiskLevel` 时，guard 返回拒绝原因 → 工具被拒。策略在 profile 的 cordis.patch.yml 里配：

```yaml
- id: void-tools-policy
  name: "@void/void-tools/policy"
  config:
    contracts:
      - name: void_exec
        family: command-exec
        isReadOnly: false
        needsPermission: true
        riskLevel: high
    rolePolicy:
      role: researcher
      allowedToolFamilies: [workspace-read]
      maxToolRiskLevel: medium
```

### 3.3 军团（void-legion）

**能力**：用 `ctx.voidTeam` 公开团队拓扑（花名册 + 权威关系 + 依赖），按依赖顺序派活（launch）并记录 checkpoint。

**代码层 API（`ctx.voidTeam`）**：

```ts
// 定义团队（拓扑是唯一真源），返回 disposer
ctx.voidTeam.defineTeam({
  id: "legion-demo",
  mode: "plan_execute_verify",
  memberRoster: [
    { laneId: "lane_plan",      role: "researcher", authorityRelationToManager: "peer" },
    { laneId: "lane_plan_doc",  role: "default",    authorityRelationToManager: "peer",       dependsOn: ["lane_plan"] },
    { laneId: "lane_code",      role: "coder",      authorityRelationToManager: "subordinate", dependsOn: ["lane_plan_doc"] },
    { laneId: "lane_verify",    role: "verifier",   authorityRelationToManager: "peer",       dependsOn: ["lane_code"] },
    { laneId: "lane_progress",  role: "default",    authorityRelationToManager: "subordinate", dependsOn: ["lane_plan_doc", "lane_code", "lane_verify"] },
  ],
});

// 查看团队（花名册 + 权威图）
const team = ctx.voidTeam.observe("legion-demo");

// 按 dependsOn 拓扑排序派活，逐 lane 记录 checkpoint
const { order } = ctx.voidTeam.launch("legion-demo");

// 记录/读取 checkpoint（机器可读的进度心跳）
ctx.voidTeam.checkpoint("legion-demo", "lane_code", "completed");
ctx.voidTeam.getCheckpoint("legion-demo", "lane_code"); // "completed"
```

> 说明：`launch` 目前是"拓扑排序 + 逐 lane checkpoint"的最小派活；真正的子智能体执行（Star 的 orchestrator/launch-spec）留待后续。

### 3.4 渠道（void-channel-feishu）

**能力**：渠道注册表 `ctx.voidChannels` + 一个 mock 飞书传输（receive → ingress → reply），证明"收消息 → 路由 → 回消息"的 seam 形状。

**代码层 API（`ctx.voidChannels`）**：

```ts
// 注册一个渠道（实现 VoidChannel 接口），返回 disposer
ctx.voidChannels.register(myChannel);

// 按名查渠道 / 列所有渠道
ctx.voidChannels.get("feishu");
ctx.voidChannels.list();
```

**真实飞书**：接入需三样（飞书开放平台创建应用可得）：`app_id` / `app_secret` / 事件订阅 `webhook` URL；再用 Lark SDK（`@larksuiteoapi/node-sdk`）实现 `VoidChannel`（webhook 收 → `onMessage` ingress → Lark SDK 回）。当前只有 mock 传输，真实接入待凭据。

### 3.5 组合 bundle（void）

`@void/void` 的 `cordis.patch.yml` 把 memory / tools / legion 三层合到一个 profile 层——这是 profile 里要引用的"组合层"（即 2.3 里手动加进 `dsh.profile.bundles` 的 `@void/void`）。

---

## 四、纵向闭环（端到端）

验证过的完整链路（`dsh --profile demo` + `DEEPSEEK_API_KEY`）：

```
用户发任务
  → dsh agent-loop 领走
  → 模型调用 memory_search 工具（void-memory 注册）
  → ctx.voidMemory.search → MemoryStore(FTS5 + sqlite-vec)
  → 返回结果给模型
```

示例（实际跑通）：

```powershell
$env:DEEPSEEK_API_KEY = "..."
dsh --profile demo "请调用 memory_search 工具搜索 'hello'，然后报告结果。"
# 输出：模型成功调用 memory_search，返回 []（空记忆库）
```

---

## 五、常见问题（FAQ）

### Q1：`dsh plugin add @deepseek-ai/dsh-headless` 报 `dsh-code-runtime-worker` 找不到

**原因**：不带版本号默认装 `latest` 标签 = `0.0.1-rc.1`（旧版），它依赖改名前的 `dsh-code-runtime-worker`（未发布）。

**解决**：显式指定版本 `@0.1.0-rc.6`（`next`）。

### Q2：`dsh plugin add <本地路径>` 后 `--dump-config` 看不到 Void 层

**原因**：本地 `dsh plugin add` 只把包加为依赖，不写进 `dsh.profile.bundles`。

**解决**：手动把 `@void/void` 追加进 profile 的 `dsh.profile.bundles`（见 2.3 第 4 步）。

### Q3：手动编辑 profile 的 package.json 后 `--dump-config` 报 `Unexpected token ''`

**原因**：用 `Set-Content -Encoding UTF8` 写了带 BOM 的文件。

**解决**：用无 BOM 的 UTF-8 写回（`[System.IO.File]::WriteAllText(path, json, (New-Object System.Text.UTF8Encoding($false)))`）。

### Q4：模型说 `memory_search` 工具不存在

**原因**：Void provider 用"函数插件 + 嵌套 `ctx.plugin(Service)`"会撞 dsh 的 Include 并发装载竞态，导致服务没提供、工具没注册。

**解决**：provider 一律 `export default <Service类>`（直接挂载），本仓库已修复。

### Q5：向量维度变了会怎样

`MemoryStore` 检测到维度不一致会**重建 vec0 表**（并 `console.warn`），不抛错、不残留脏数据。旧的 keyword 内容仍可检索。

### Q6：`dsh-code-runtime-worker` 是"缺包"吗

不是。是 npm `latest` 标签指向旧版、引用了改名前的包名。源码与 `next`（rc.6）都用 `dsh-code-runtime-worker-thread`（已发布）。显式 rc.6 即可，无需等官方补发。

---

## 六、环境变量与命名空间

| 变量 | 用途 | 说明 |
|---|---|---|
| `VOID_MEMORY_PATH` | 记忆 SQLite 文件路径 | 缺省 `:memory:`；独立于 `DSH_HOME` / `~/.star_sanctuary` |
| `DEEPSEEK_API_KEY` | 跑 headless 任务的模型 key | 仅运行时传入，勿写入仓库 |
| `DSH_HOME` | dsh 数据目录 | 本地开发建议隔离（见 2.3） |

其余 Star 语义的 `BELLDANDY_*` 变量（如 `BELLDANDY_STATE_DIR`）在快照里暂保留原样，迁移到 `VOID_*` 属后续补丁。
