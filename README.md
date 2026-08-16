# Void MVP（首版）说明

> 阶段 3 Void MVP 的首版边界（完成标准 #8）。

## 首版包含

- `@void/void-memory`：`ctx.voidMemory` knowledge seam（FTS5 + sqlite-vec 检索/写入，最小闭环）。
- `@void/void-tools`：`ctx.voidToolContracts` 契约注册表 + `ctx.tools.guard` 角色策略映射。
- `@void/void-legion`：`ctx.voidTeam` 军团 seam（roster + 权威关系 + checkpoint）。
- `@void/void`：组合 bundle（三 seam 合到一个 profile 层）。
- `@void/void-channel-feishu`：渠道 seam（`ctx.voidChannels` 注册表 + mock Feishu 传输，receive→ingress→reply 形状）。
- 三 seam 纵向闭环（集成测试 `packages/void/tests/vertical-closure.spec.ts`）。

## 首版明确排除（未做 / 待后续）

- **真实 Feishu 集成**：`void-channel-feishu` 已有 mock 传输 seam；真实 Lark SDK + webhook + app 凭据未接入（外部依赖）。接入清单：① 依赖 `@larksuiteoapi/node-sdk`；② Feishu 应用 `app_id`/`app_secret` + 事件订阅 webhook URL；③ 实现 `VoidChannel`（webhook 收消息 → `onMessage` ingress → Lark SDK 回消息），源码参考 `belldandy-channels/src/feishu-http-transport.ts`（脱耦 BelldandyAgent 后复用传输形状）。
- **dream/摄取链路**：dream-* / external-memory-ingest 源码已随全量快照内嵌，但首版未暴露为 `ctx.voidMemory` seam / 工具，待后续接入。
- **军团执行引擎**：`void-legion` 的 `launch` 已实现"依赖序派发 + 可注入 worker + 失败传播"；接 `ctx.subagents`（真实子代理 spawn）待后续。
- **UI 深改**：壳 B（Tauri 2）属阶段 4；壳 A（dsh 薄 UI）属阶段 2/3/5 插件 client 半边，首版未做。

## 本地 profile 启动步骤（一条命令）

> `dsh plugin add <绝对路径>` 会**自动识别 `dsh.bundle` 并加进 profile 的 bundles**，无需手动改（早期文档里的"手动补 bundle"是误判，源自用了错误的相对路径）。

```powershell
# 方式一：用脚本（推荐）
.\scripts\install-profile.ps1 -Profile demo -DshHome "E:\project\star-sanctuary\Void\.dsh-demo"

# 方式二：手动逐条（等价）
$env:DSH_HOME = "E:\project\star-sanctuary\Void\.dsh-demo"
dsh plugin --profile demo add @deepseek-ai/dsh-headless@0.1.0-rc.6   # 显式 rc.6，勿用 latest
dsh plugin --profile demo add "E:\project\star-sanctuary\Void\packages\void-memory"
dsh plugin --profile demo add "E:\project\star-sanctuary\Void\packages\void-tools"
dsh plugin --profile demo add "E:\project\star-sanctuary\Void\packages\void-legion"
dsh plugin --profile demo add "E:\project\star-sanctuary\Void\packages\void-channel-feishu"

# 验证 + 跑任务
dsh --profile demo --dump-config     # 应看到 # == @void/* 各层
$env:DEEPSEEK_API_KEY = "..."
dsh --profile demo "任务"
```

> 注：本地开发直接装 4 个独立插件包即可（等价于组合 bundle `@void/void`）。组合 bundle 依赖这些包（`workspace:*`），本地 link 时内部依赖无法解析；其用途是"发布后作为单一入口"。

## 发行形态（打包 / 发布）

- **打包**：`.\scripts\pack-all.ps1` 把所有包 `pnpm pack` 到 `dist/`（`workspace:*` 会自动重写为版本号）。
- **本地 tarball 互装受限**：`pnpm add <多个 tarball>` 时，包之间的相互依赖仍会去 npm 解析（404）。故**正式发行需 `pnpm publish` 到 npm（或私有 registry）后 `dsh plugin add @void/void`**；tarball 只适用于无相互依赖的单包分发。

## 命名空间与数据目录（完成标准 #7）

- 环境变量统一 `VOID_*`（当前已用 `VOID_MEMORY_PATH`，其余随功能补齐）。
- 数据目录独立于 `DSH_HOME` / `~/.star_sanctuary`，默认 `:memory:`（测试）或 `VOID_MEMORY_PATH` 指定文件。

## 升级方式

- 依赖已发布 `@deepseek-ai/dsh-*@0.1.0-rc.6`（npm `next`）；`@deepseek-ai/cordis@4.0.1`（vendor 家族）。
- dsh 基座源码 `master@47f9438`（rc.5）仅作只读参考，与 npm rc.6 存在一版错位。

## 已知分叉

1. **全量快照已定案并按方案 B 内嵌**：Star 记忆快照位于 `packages/void-memory/src/star/`（101 文件 + protocol shim），已随 `@void/void-memory` 一起编译、运行；校验命令 `pnpm run verify:star-memory-snapshot`。`openai→ctx.llm` 补丁已实现 chat-completion 路径（`void-memory/src/llm.ts`），embedding 仍走 openai（dsh 无 embedding seam）。
2. **Include 并发装载竞态**：多 entry 经 `Promise.allSettled` 并发装载会丢 provider fiber；当前用顺序 `loader.create()` 规避，需在真实 `ctx.tools` 消费前确认是否够用。
3. **`dsh-headless` 的 `latest` 标签悬空**：`latest`=`0.0.1-rc.1` 依赖改名前的 `dsh-code-runtime-worker`（未发布）；需显式 `@0.1.0-rc.6`（`next`）安装。
4. **干净 dsh profile 需放行 `better-sqlite3` build**：dsh 转发的 pnpm 默认忽略 install scripts，`@void/void-memory` 安装后可能报 `Could not locate the bindings file`。`scripts/install-profile.ps1` 已自动在 profile 的 `pnpm-workspace.yaml` 写入 `onlyBuiltDependencies: [better-sqlite3]`；手动安装时按 `Void使用指南.md` 2.3 的 2b 步骤配置。
