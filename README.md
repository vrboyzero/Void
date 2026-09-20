# Void MVP（首版）说明

> 阶段 3 Void MVP 的首版边界（完成标准 #8）。

## 首版包含

- `@void/void-memory`：`ctx.voidMemory` knowledge seam（FTS5 + sqlite-vec 检索/写入，最小闭环）。
- `@void/void-tools`：`ctx.voidToolContracts` 契约注册表 + `ctx.tools.guard` 角色策略映射。
- `@void/void-legion`：`ctx.voidTeam` 军团 seam（roster + 权威关系 + checkpoint）。
- `@void/void`：组合 bundle（三 seam 合到一个 profile 层）。
- `@void/void-channel-feishu`：渠道 seam（`ctx.voidChannels` 注册表 + mock Feishu 传输，receive→ingress→reply 形状）。
- `@void/void-dsh-control`：灵榜控制面（MCP Streamable HTTP，让外部 AI 指挥正在运行的 DSH Web profile）。**独立 workspace + tarball 安装，见下节。**
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

## `@void/void-dsh-control`（灵榜控制面）单独说明

这个包**与上面 5 个包形态不同**，不要用同一套步骤：

| 维度 | 其余 Void 包 | `void-dsh-control` |
|---|---|---|
| workspace | 主 workspace 成员 | **独立 workspace**（根 `pnpm-workspace.yaml` 显式排除，见下） |
| 目标 dsh 版本 | `0.1.0-rc.6` | **`0.1.5-rc.2`**（面向当前全局 dsh CLI） |
| 安装方式 | `dsh plugin add <目录>` | **必须 `dsh plugin add <tarball>`** |
| 打包脚本 | `scripts/pack-all.ps1` | **`scripts/pack-lingbang.ps1`** |
| 构建/测试 | 根 `pnpm -r build/test` 覆盖 | 根 `pnpm -r` **不覆盖**，要 `pnpm --dir packages/void-dsh-control ...` |

**为什么独立 workspace**：把 rc.2 与 rc.6 放进同一个 workspace 后，pnpm 会把既有包自动安装的 peer 提升到 rc.2，`void-tools` / `void-legion` / `void-memory` 的测试会直接报 `does not provide an export named 'CallId' / 'isJsonValue'`。

**为什么必须用 tarball**：`dsh plugin add <目录>` 只装成 `link:`；Node 按真实路径解析该包的 bare import，父级查找到不了 profile 的 `node_modules`，peer 解析失败、profile 启动报 `Cannot find package '@deepseek-ai/cordis'`。

```powershell
# 构建 + 装配 + 打包
pwsh -File scripts/pack-lingbang.ps1

# 装进 profile（必须用 .tgz）
dsh plugin --profile <profile> add "E:\project\star-sanctuary\Void\dist\lingbang\void-void-dsh-control-0.1.0.tgz"

# 重新打包后必须先删再装（否则 pnpm 复用旧解析，打印 "Already up to date"）
dsh plugin --profile <profile> remove "@void/void-dsh-control"
```

完整说明见 `packages/void-dsh-control/README.md`，以及
`docs/灵榜会话功能实现方案计划.md` 第 25 节（普通用户版安装、配置与操作指南）。

## 命名空间与数据目录（完成标准 #7）

- 环境变量统一 `VOID_*`（当前已用 `VOID_MEMORY_PATH`、`VOID_FEISHU_APP_ID` / `VOID_FEISHU_APP_SECRET`、`VOID_DSH_CONTROL_TOKEN` / `VOID_DSH_CONTROL_CALLBACK_SECRET`）。
- 数据目录独立于 `DSH_HOME` / `~/.star_sanctuary`，默认 `:memory:`（测试）或 `VOID_MEMORY_PATH` 指定文件。

## 升级方式

- 依赖已发布 `@deepseek-ai/dsh-*@0.1.0-rc.6`（npm `next`）；`@deepseek-ai/cordis@4.0.1`（vendor 家族）。
- dsh 基座源码 `master@47f9438`（rc.5）仅作只读参考，与 npm rc.6 存在一版错位。

## DSH 插件开发要点（官方契约 + 实测）

本节写给**要改这些插件的人**。完整规则见 [`AGENTS.md`](AGENTS.md)；这里讲清楚「为什么」。

### 版本前提

我们部署时面对的是**全局 CLI** `@deepseek-ai/dsh@0.1.5-rc.1`，其运行时对应 `0.1.5-rc.2`
的插件契约。仓库 `devDependencies` 里钉的 `0.1.0-rc.6` 只用于构建与测试，**两者不是一回事**。

宿主处于**开发者预览**，官方 README 明写「**未来将出现破坏兼容性的变更**」。所以本节的每个
数字都标了取得方式——**照抄会漂移**。

### 1. 平台模块表：唯一能拿到的宿主模块，而且跨版本会变

客户端 bundle 跑在浏览器的冻结模块表里，只能 `require` 表内的 specifier。这张表**变过**：

| specifier | rc.2（我们在跑） | rc.5（本地官方源码） |
|---|---|---|
| `react` / `react/jsx-runtime` / `react-dom` / `react-dom/client` | ✅ | ✅ |
| `@deepseek-ai/cordis` | ✅ | ✅ |
| `@deepseek-ai/dsh-client-ui-slots` | ✅ | ✅ |
| `@deepseek-ai/dsh-client-ui-primitives` | ✅ | ✅ |
| `@deepseek-ai/dsh-client-store` | ✅ | **已移除** |
| `@deepseek-ai/dsh-client-ui-dockkit` | ✅ | **已移除** |
| `@deepseek-ai/dsh-client-web-react` | ❌ | **新增** |
| `@deepseek-ai/dsh-client-ui-attachment` | ❌ | **新增** |
| `@deepseek-ai/dsh-client-schema-form` | ❌ | **新增** |

官方源码快照（`deepseek-harness-master/`，**0.1.0-rc.5**）里的 `PLATFORM_MODULES` 有一份清单，
但**不能直接当作我们的契约**——版本线不同。要核 rc.2，直接搜前端 bundle（命令见
`AGENTS.md` §4.1）。

表外的模块在浏览器里 `require` 会直接抛错，所以用它之前先核。

### 2. 宿主提供的模块必须外部化

`tsdown.config.ts` 的 `external` 漏一个，打包器就会去磁盘找它。找不到报错还算好；
**更糟的是打进去一份副本**——同一个 React 出现两份实例，hooks 全线失效，而且症状离原因很远。

### 3. 客户端 bundle 必须是 lazy-CJS factory

宿主用 `window.__ModuleLoader__.load({ id, factory })` 注册，模块体的副作用（含 CSS 注入）
**只在 factory 被调用时执行**。官方明说「没有已发布的预设暴露该包，因此本仓库之外的包得
**自行复刻**同样的输出格式」——所以手写 banner/footer 是必然，不是将就。

### 4. 设置命名空间：用官方的 `installSection`，别手搓

有 `cordis.yml` entry 的消费方，官方要求用 `ctx.settings.installSection()`。它内置两件事：
entry 作 base 层、provider 不在时回落 entry。

我们最初手搓了等价物（`ctx.settings.register` + 一个 `ctx.get('settings')` 探测）。差别在
**响应式**：探测只在 apply 时做一次，provider 后于插件挂载就**永远不被采纳**；换成
`ctx.inject(['settings'], ...)` + `installSection` 之后，attach 和 detach 都认。

顺带一个隐蔽点：`installSection` 的 `onChange` 在 **attach / detach / 提交**时都会触发。
detach 那次对快照类派生数据是**必要**的——要把权限交回组合入口，而不是留着用户层的最后值。

### 5. 设置卡片是「暂存 + 保存」，不是「即时写回」

官方 `ui-settings-plugins` 的规则：页面暂存输入，**只有用户保存时才写入**；以草稿读取时的
revision 设栅；保存失败保留草稿；**字段不接受的草稿阻塞保存**而不是丢弃；值是否被接受，
**唯一的裁判是 Host**。

这不是风格偏好，是**结构性问题**。我们最初是即时写回，于是任何输入都必须立刻变成一次写回，
每个控件都得各自想办法避免半成品值上线——「每敲一个字就提交」「空行被服务端拒」「改完立刻
保存提交的是旧值」都是同一个根因的不同表现。补上草稿层（`void-entry/src/client/draft.ts`）
之后，输入根本不碰写回，那一整类问题消失了。

**推论：控件不得自己攒本地草稿 + 失焦提交。** 草稿在上层，控件再攒一层就会让「改完立刻点
保存」提交改动前的值。这个 bug 我们犯了两次。

### 6. 密钥字段有专门机制

给字段标 `role('secret')`：值不出现在任何响应里，控件初始为空、只报告是否已配置，值经
credentials 领域写入而非 settings 分节。

我们目前**没有**任何 secret 字段——`tokens[].tokenEnv` 存的是**环境变量名**，不是值。将来要存
暗号值时用这个机制。

### 7. 开关持久化：写用户层 patch，别写 `cordis.yml`

`prepareProfile` **每次启动都把 `cordis.yml` 重置为 `[]`**，所以 loader 树的写回无法持久。
要持久化就写 profile 的 `cordis.patch.yml`——它在 patch 栈最后，覆盖 bundle 送进来的 entry。

而且它**免重启生效**：`dsh-app-boot` 的 `watchUserPatches` 会监视用户层 patch，变更时事务性
重新应用。前提是 profile 的 `patchReload === "live"`——`web` 模板是 `live`，`acp`/`headless`/`sdk`
是 `startup`。实测：运行中写 `disabled: true`，**2 秒内端点 404**。

### 8. 构建链有个坑：`pnpm pack` 不编译

它只把现成的 `lib/` 打进 tarball。漏了构建，打出来的是**上一次**的代码——命令成功、产物是旧
的，静默失败。

更隐蔽的是 `void-dsh-control`：它被 `pnpm-workspace.yaml` 排除（为绕开下面那条 peer 陷阱），
所以 **`pack-all.ps1` 管不到它**，必须另跑 `pack-lingbang.ps1`；`pnpm -r test` 也不含它的测试。
`pack-all.ps1` 末尾会比对时间戳并提示——看到 `[!]` 就说明你正要打出一个旧包。

### 9. 一条会咬人的依赖陷阱

`@deepseek-ai/dsh-client-ui-primitives@0.1.5-rc.2` 的 peerDependencies 是
`@deepseek-ai/cordis@^4.0.2`，而本 workspace 固定在 **4.0.1**。把它装进 `node_modules` 会让
pnpm 提升既有包的 peer，使 `void-tools` / `void-legion` / `void-memory` 报
`does not provide an export named 'CallId' / 'isJsonValue'`。

**所以它的类型靠 `npm pack` 取、生成 ambient 声明，绝不装包。** 生成脚本是
`scripts/gen-primitives-types.mjs`（`pnpm run gen:primitives` / `check:primitives`），输入是
「客户端实际 import 了什么」，所以它不会和用法脱节。

### 10. `skipLibCheck: true` 会吞掉 `.d.ts` 里的一切错误

根 `tsconfig.base.json` 设了它，于是 ambient 声明里的悬空类型引用、非法修饰符**全部静默通过**。
我们因此漏过两个真缺陷：手抄的声明漏了 `ButtonVariant`（而 `Button` 的签名就引用了它），生成器
产出过在 `declare module` 里非法的 `export declare function`。

所以 `packages/void-entry` 的 `typecheck` 有**三层**，最后一层
`tsconfig.client.strict.json` 只做一件事：`skipLibCheck: false`。**别删它**，删了这两类错误
会重新隐形。

### 11. Host 没有 MCP **server** 注册点

官方包里只有 `dsh-mcp-client`（DSH 作为客户端消费外部 MCP）。`webhookRuntime` 是入站 webhook
（GitHub 那类），不是 MCP。所以灵榜控制面经 `ctx.webServer.register()` 挂路由是**唯一且正确**
的做法，不是权宜之计。

### 延伸阅读

`deepseek-harness-master/` 是官方源码快照（**注意版本线与我们不同**）：

| 想知道 | 读 |
|---|---|
| 扩展点归属（新行为该挂哪） | `docs/architecture.md` 的「新行为的归属位置」表 |
| 加设置卡片 | **本地快照没有这份**（rc.5 之后才加）：[GitHub master](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-settings-card.zh.md) |
| 扩展插件形态 | `docs/cookbook/extension-cookbook.md` |
| Web 客户端规范 | `packages/client/AGENTS.md` |
| 客户端模块系统（lazy-CJS、解析顺序） | `packages/client/modules/README.md` |

## 已知分叉

1. **全量快照已定案并按方案 B 内嵌**：Star 记忆快照位于 `packages/void-memory/src/star/`（101 文件 + protocol shim），已随 `@void/void-memory` 一起编译、运行；校验命令 `pnpm run verify:star-memory-snapshot`。`openai→ctx.llm` 补丁已实现 chat-completion 路径（`void-memory/src/llm.ts`），embedding 仍走 openai（dsh 无 embedding seam）。
2. **Include 并发装载竞态**：多 entry 经 `Promise.allSettled` 并发装载会丢 provider fiber；当前用顺序 `loader.create()` 规避，需在真实 `ctx.tools` 消费前确认是否够用。
3. **`dsh-headless` 的 `latest` 标签悬空**：`latest`=`0.0.1-rc.1` 依赖改名前的 `dsh-code-runtime-worker`（未发布）；需显式 `@0.1.0-rc.6`（`next`）安装。
4. **干净 dsh profile 需放行 `better-sqlite3` build**：dsh 转发的 pnpm 默认忽略 install scripts，`@void/void-memory` 安装后可能报 `Could not locate the bindings file`。`scripts/install-profile.ps1` 已自动在 profile 的 `pnpm-workspace.yaml` 写入 `onlyBuiltDependencies: [better-sqlite3]`；手动安装时按 `Void使用指南.md` 2.3 的 2b 步骤配置。
