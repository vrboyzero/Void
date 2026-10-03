# Void —— 寄生在 dsh 上的虚空插件集

> 把「灵魂（人格底线 + 模组）」「人格记忆（按 Agent 隔离的 Markdown 记忆仓）」「军团（真实子代理派活）」
> 做成 dsh 插件，并合到一个 Web 界面入口里。
>
> 计划与进度：[`docs/灵魂记忆与军团.md`](docs/灵魂记忆与军团.md)｜安装与使用：[`Void使用指南.md`](Void使用指南.md)｜
> 方案总纲：[`虚空寄生实施方案计划.md`](虚空寄生实施方案计划.md)｜来源清单：[`SOURCES.md`](SOURCES.md)

## 现在包含什么

| 包 | 作用 |
|---|---|
| `@void/void-soul` | 灵魂：`ctx.voidAuthority` 权威档案 + `ctx.voidSoul` 灵魂档案与模组库；装进模型前的预算与变量预检，装不下时在通知栏留一条（`void-soul:refusals`）；首次见面引导（档案 front matter 的 `firstMeeting` + `state.json` 的完成位，面板可标完成/重来） |
| `@void/void-memory` | 人格记忆：`memory_*` 6 个工具 + `ctx.voidMemoryLibrary` 面板视图；另含旧知识层 `/sqlite`（内嵌 Star 快照） |
| `@void/void-tools` | 工具治理：`ctx.voidToolContracts` 契约注册表 + `ctx.tools.guard` 角色策略 |
| `@void/void-legion` | 军团：队伍、真实子代理执行、运行记录、终态通知（`launch_legion` / `legion_run` / `legion_cancel`）；逐 lane 把成员自己的 SOUL + 当前角色装进子代理 persona（取不到就整次拒绝派活） |
| `@void/void-entry` | 界面入口：设置卡片 + `/void/api/*` 路由 + 业务视图注册表 + 详情渲染器 + 通知栏 |
| `@void/void-channel-feishu` | 渠道：`ctx.voidChannels` 注册表 + mock 飞书传输（receive→ingress→reply 形状）；**发消息侧**另有真实实现 `RealFeishuChannel`（`./real-feishu`，Lark SDK 已是依赖，缺凭据 fail-closed） |
| `@void/void` | 组合 bundle = entry + soul + memory + tools + legion 五包的**并集**（16 条 entry） |
| `@void/void-seam-demo` | 阶段 1 的最小 seam 模板（新插件照着抄） |
| `@void/void-dsh-control` | 灵榜控制面：MCP Streamable HTTP，让外部 AI 指挥**正在运行的** DSH Web profile。**独立 workspace + tarball 安装**，见下 |

五个业务包共用一套数据根：`<DSH_HOME>/void-data/<DSH_PROFILE>/`——**`DSH_PROFILE` 必须显式给**
（`dsh --profile X` 不会替你设），只给 `DSH_HOME` 时插件照样加载、业务视图回 `404 无法确定档案位置`。
完整说明见 [`Void使用指南.md`](Void使用指南.md) 2.6。

## 还没做（诚实清单）

- **真实飞书的收消息侧**：发消息侧（`RealFeishuChannel`，飞书官方 SDK 主动发到指定 chat）已实现；**webhook 事件订阅 + 回调路由**这另一半未做，默认 bundle 装的仍是 mock 传输。
- **dream / external-memory-ingest**：源码随全量快照内嵌在 `packages/void-memory/src/star/`，但没暴露成 seam / 工具。
- **壳 B（Tauri 2）**：属阶段 4，未开始；dsh 自带的 Web 壳（壳 A）已由 `void-entry` 接管。
- **人工核对**：真机上的界面与交互核对由开发者按 [`docs/灵魂记忆与军团.md`](docs/灵魂记忆与军团.md) 19.3 的清单做，插件侧只保证测试与接口。

## 本地 profile 启动步骤（一条命令）

> `dsh plugin add <绝对路径>` 会**自动识别 `dsh.bundle.patch` 并加进 profile 的 `dsh.profile.bundles`**，无需手动改。

```powershell
# 方式一：用脚本（推荐；装 soul/memory/tools/legion/entry/feishu 六个包）
.\scripts\install-profile.ps1 -Profile web -DshHome "E:\project\star-sanctuary\Void\.tmp\soul-profile"

# 方式二：手动逐条（等价）
$env:DSH_HOME = "E:\project\star-sanctuary\Void\.tmp\soul-profile"
dsh plugin --profile web add @deepseek-ai/dsh-headless@0.1.0-rc.6   # 显式 rc.6，勿用 latest
foreach ($p in "void-soul","void-memory","void-tools","void-legion","void-entry","void-channel-feishu") {
  dsh plugin --profile web add "E:\project\star-sanctuary\Void\packages\$p"
}

# 验证 + 启动（DSH_PROFILE 必须一起给，否则业务视图回 404）
dsh --profile web --dump-config | Select-String "void-"   # 五包共 16 条 entry
$env:DSH_PROFILE = "web"
dsh web --no-open --port 3699
```

> 本地开发装独立包即可（与组合 bundle 等价）；组合包 `@void/void` 依赖 `@void/void-*`，本地 link 时内部依赖解析不了，其用途是"发布后作为单一入口"。隔离 profile 的安装 / 备份 / 回滚 / 卸载见 [`Void使用指南.md`](Void使用指南.md) 2.6。

## 发行形态（打包 / 发布）

- **打包**：`pwsh -File scripts/pack-all.ps1` 把六个包（soul / memory / tools / legion / entry / feishu）与组合包 `@void/void` 一起 `pnpm pack` 到 `dist/`（`workspace:*` 自动重写为版本号），旧 tarball 归档到 `dist/.trash/pack-<时间戳>`。
- **`pnpm pack` 不编译**：它只打现成的 `lib/`，所以脚本里先 `pnpm -r build`；漏了构建就会打上一次的代码（命令成功、产物是旧的）。
- **本地 tarball 互装受限**：`pnpm add <多个 tarball>` 时包之间的相互依赖仍会去 registry 解析（404）。正式发行需 `pnpm publish` 到 npm（或私有 registry）后 `dsh plugin add @void/void`；在隔离 profile 里逐包装 tarball 是可行的（见使用指南 2.6）。
- 控制面单独打包：`pwsh -File scripts/pack-lingbang.ps1`。

## `@void/void-dsh-control`（灵榜控制面）单独说明

这个包**与上面这些包形态不同**，不要用同一套步骤：

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

**军团投递（P6g）**：控制面新增可选的回调消费者——军团每次运行进入终态（完成 / 失败 / 取消）时，把
一条 `legion/run-terminal` 事件按和任务回调同一套传输发出去（签名、超时、允许域、指数退避、稳定
`deliveryId` = 军团的 `eventId`）。开关是设置卡片里的 `callback.includeLegionRuns`（默认关），
`callback.enabled` 与 `callback.url` 仍然是总开关。网络侧**只能是「至少一次」**，接收端必须按
`eventId` 去重；控制面挂载前军团照常运行，挂载后会自动补投未确认的事件。

## 命名空间与数据目录

- 环境变量统一 `VOID_*`（已用 `VOID_MEMORY_PATH`、`VOID_FEISHU_APP_ID` / `VOID_FEISHU_APP_SECRET`、`VOID_DSH_CONTROL_TOKEN` / `VOID_DSH_CONTROL_CALLBACK_SECRET`）。
- **灵魂 / 人格记忆 / 军团的数据根是 `<DSH_HOME>/void-data/<DSH_PROFILE>/`**（按 profile 隔离，不在模型工作区内）：
  `agents/<agentId>/SOUL.md`、`agents/<agentId>/MEMORY.md` + `memory/*.md` + `memory.sqlite`、
  `agents/facets/*.md`（共享模组库）、`legion/teams/*.json`、`legion/runs/`、`legion/notifications.json`。
  显式给绝对 `dataDir` 可覆盖；**没配数据根不会让插件加载失败**——服务照常挂载，用到数据时才报错
  （`灵魂档案没有数据根…` / `人格记忆没有数据根…` / `军团没有数据根…`），**配错**（相对路径、越界档案名）则当场抛。
- **链接一律看穿**：数据根内的每次读写先做字符串比、再做一次 realpath 比（`void-soul/src/path-guard.ts` + `void-memory/src/paths.ts`）。
  `agents/<agentId>`、`agents/facets`、记忆的 `memory/`、`MEMORY.md`、`memory.sqlite` 被换成指向数据根外的链接时抛
  `路径经链接后越界: …` / `记忆路径经链接后越界: …`，列目录遇到链接直接拒绝（Windows 上 junction 的 `isDirectory()` 是 false，
  静默跳过会让人以为数据丢了）。数据根**自己**落在链接下（把 `.dsh` 挪到别的盘）是正常部署，照常放行。
- **`facets` 是保留目录名**（大小写不敏感：Windows 上 `agents/Facets` 就是 `agents/facets`）：它归共享模组库，
  不能同时当某份档案的目录。判定只有一处——`void-soul/src/profile.ts` 的 `FACET_DIRECTORY_NAME` / `isFacetDirectoryName()`，
  注册扫描、模组库路径拼接与人格记忆的档案 id 校验都用它；人格记忆里 `facets` 既不能当档案 id，
  也不会被列成一份「档案」（否则记忆文件会写进模组库、面板上凭空多一份档案）。
- 旧知识层（`/sqlite`，内嵌 Star 快照）仍用 `VOID_MEMORY_PATH`（缺省 `:memory:`），**与上面的数据根无关**。

## 升级方式

- 五个业务包依赖已发布 `@deepseek-ai/dsh-*@0.1.0-rc.6`（npm `next`）；`@deepseek-ai/cordis@4.0.1`（vendor 家族）。
- 控制面 `void-dsh-control` 走另一条版本线（宿主契约 `0.1.5-rc.2`），单独 workspace、单独打包，根 `pnpm -r` 不覆盖它。
- dsh 基座源码 `master@47f9438`（rc.5）仅作只读参考，与 npm rc.6 存在一版错位。

## DSH 插件开发要点（官方契约 + 实测）

本节写给**要改这些插件的人**。完整规则见 [`AGENTS.md`](AGENTS.md)；这里讲清楚「为什么」。

### 版本前提：`dsh --version` 不够用

先澄清一个容易踩的点——**`dsh --version` 报的不是插件契约版本**：

```powershell
$d = "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh"
dsh --version                                                                   # 0.1.7-rc.1 ← 只是 CLI 外壳
(Get-Content "$d\node_modules\@deepseek-ai\dsh-web-frontend\package.json" -Raw | ConvertFrom-Json).version  # 0.1.7-rc.1 ← 客户端契约
(Get-Content "$d\node_modules\@deepseek-ai\dsh-settings\package.json"     -Raw | ConvertFrom-Json).version  # 0.1.7-rc.1 ← 宿主契约
(Get-Content "$d\node_modules\@deepseek-ai\cordis\package.json"           -Raw | ConvertFrom-Json).version  # 4.0.4
```

外壳的 dependencies 是脱字号范围，pnpm 解析后装进来的运行时包**与外壳同版**（0.1.7-rc.1）。
**契约由运行时包定，不由外壳定**——所以写插件时以第二、三行的输出为准。

**0.1.7 起 `dsh-client-ui-primitives` / `dsh-client-ui-slots` / `dsh-client-store` 随宿主落到磁盘了**
（0.1.5 时它们只活在前端 bundle 的冻结模块表里，取不到本地副本）。类型生成脚本因此改成**默认读本机
已装的那份**，不再按钉死的版本号去 npm 取——见第 9 节。仍然只在模块表里的只剩 `dsh-client-ui-dockkit`。

还有两个**不同版本线**的东西别混进来：仓库 `devDependencies` 钉的 `@deepseek-ai/dsh-*@0.1.0-rc.6`
只用于构建与测试；`deepseek-harness-master/` 是官方源码快照 `0.1.0-rc.5`。

宿主处于**开发者预览**，官方 README 明写「**未来将出现破坏兼容性的变更**」。所以本节的每个
数字都标了取得方式——**照抄会漂移**。

### 1. 平台模块表：唯一能拿到的宿主模块，而且跨版本会变

客户端 bundle 跑在浏览器的冻结模块表里，只能 `require` 表内的 specifier。0.1.7-rc.1 的表是这 9 项
（与 0.1.7-rc.2 源码里的 `PLATFORM_MODULES` 逐字一致）：

`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、
`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、
`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`

**表没变不等于表里的东西没变。** 0.1.6 → 0.1.7 这张表一项没动，插件却全白屏了——变的是表内模块的
**具名导出**（下一节）。

要核表本身，直接读运行中的页面，比搜 bundle 准：

```js
window.__dshSidebarModuleSystem__.seed   // Map，键就是表里的 specifier
```

官方源码快照（`deepseek-harness-master/`，**0.1.0-rc.5**）里的 `PLATFORM_MODULES` 也有一份清单，
但**不能直接当作我们的契约**——版本线不同。

表外的模块在浏览器里 `require` 会直接抛错，所以用它之前先核。

### 1.1 具名导出会在版本间改名：图标那一课（0.1.7 真机白屏）

0.1.7 把产品图标从 `Icon<字形><尺寸>` 改名成 `Icon<字形>Regular` / `Icon<字形>Medium`，
尺寸从名字里挪到 `size` prop：

```ts
// 0.1.0-rc.5 及更早
import { IconQuestionOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
// 0.1.7+
import { IconQuestionOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
```

旧名字在 0.1.7 的导出表里**不存在**，读出来是 `undefined`。把它交给 React 渲染抛的是
「element type is invalid」，而**被打掉的是整个 `settings.section` 条目**——用户看到的是设置面板
全白，不是少一个图标，很容易往编排/权限方向去查。本次改到的 6 个：`IconCordisPluginOutline`、
`IconQuestionOutline`、`IconSearchOutline`、`IconPlusOutline`、`IconSettingsOutline`、`IconTrashOutline`。

**结论：模块能解析 ≠ 里面的名字还在。** 三道防线，缺一道都会再炸：

| 时机 | 机制 | 在哪 |
|---|---|---|
| 打包前 | `gen-primitives-types.mjs --check` 拿宿主同版导出表核对源码用到的名字 | `scripts/pack-all.ps1` 第 1 步 |
| 提交前 | `tests/primitives.spec.ts` 断言「源码 import 的名字 ⊆ 生成的声明」 | `pnpm -r test` |
| 运行期 | `safeIcon()` 把缺失的图标换成空组件，坏一个图标不至于打掉整个面板 | `src/client/primitives-probe.ts` |

### 1.2 0.2.0 的 peer 门禁：插件会被**整包跳过**（2026-09-29 真机）

dsh 0.2.0 起，启动时逐包检查 `peerDependencies` 里 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的范围
（源码 `packages/boot/app-boot/src/plugin-compatibility.ts`）：

```ts
if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue;   // 只查 dsh 自家包
const requirement = ['workspace:^','workspace:~','workspace:*'].includes(range) ? runtimeVersion : range;
if (!semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })) peers[name] = range;
```

不满足的包**不加载**，只在 stderr 留一行：

```
dsh: skipping profile bundle "@void/void-entry": Error: Plugin @void/void-entry@0.1.0 is
incompatible with dsh 0.2.0-rc.1: peerDependencies {"@deepseek-ai/dsh-client-ui-slots":"^0.1.0-rc.6"}.
```

用户在界面上看到的是「插件凭空消失」，那行终端输出很容易被后面的日志刷掉。

**我们踩的坑**：所有 peer 都写成 `^0.1.x-rc.n`。caret 在 0.x 上等于 `>=0.1.x-rc.n <0.2.0`，
**0.2.0-rc.1 直接被拒**，四个包全部没加载。改 `>=0.1.0-rc.6 <0.3.0-0` 后干净启动。

三条容易踩的细节：

- **`peerDependenciesMeta.optional` 不豁免。** `void-entry` 的 `dsh-client-ui-slots` 标了
  `optional: true`，照样被拒——判定只看 `peerDependencies` 的键值。
- **只查 `@deepseek-ai/dsh*`。** `@deepseek-ai/cordis`、`react`、`@void/*` 一律不看，写多松都行。
- 逃生门 `dsh plugin allow-version <包@版本> --profile <p> --dsh-version <精确版本> --accept-risk`，
  写进 `profiles/<p>/compatibility.json`，键是**精确的 name@version**（换版本即失效）。只用于临时
  验证，别留在生产。

**结论：dsh 大版本升级后，第一件事是查所有 peer 范围。** 现用形式 `>=0.1.0-rc.6 <0.3.0-0`
——覆盖已验过的版本线，在 0.3 处强制重新验证。

**不重启宿主也能查**：拿宿主自带的 semver 复刻上面那段判定，扫 profile 的
`node_modules/@void/*/package.json`。

**关键事实：我们的插件代码在 0.2.0 上一行都没改。** 平台模块表 9 项未变，`dsh-client-ui-primitives`
只多了 `Button` 从函数变 `ForwardRefExoticComponent`、`DisclosureRow` 增了几个可选 prop——都不是
破坏性变化。宿主端点、客户端面板、设置页、写路径全部实测通过。**升级挂掉时先怀疑门禁，再怀疑代码。**

### 1.3 settings 服务在 0.2.0 被换掉了：`installSection` 没了（2026-10-01 真机）

0.2.0 把 `ctx.settings` 换成了 **`SettingsForms`**，插件注册设置命名空间的整套做法随之作废。

| | 0.1.x | 0.2.0 |
|---|---|---|
| 注册方式 | `ctx.settings.installSection(ctx, ns, schema, entry, hooks)` | **API 被删除**（源码快照与装好的 `dsh-settings` 里都 0 命中） |
| 表单来源 | 插件传进去的 schema | **从入口的 `Config` 派生**（`describe()` 键就是 `entry.options.id`） |
| 命名空间 | 插件自定义的名字 | **组合入口 id** |
| 准入条件 | — | `volatileForm(schema)` 必须非空——**`Config` 里至少要有一个 `.volatile()` 字段** |
| 取值 | hooks 的 `setSource` 回调 | `Config` 里 volatile 字段解析成 **`Volatile<T>` 引用**，`get()` 取当前值 |
| 变更通知 | hooks 的 `onChange` | `ctx.on('settings/document-updated', (ns, revision) => …)` |
| 跨字段校验 | hooks 的 `validate`，**写入时**拒绝 | **没有钩子**——只能挪到读取点，坏值先存下、用时才炸 |

**症状长得极具误导性**：面板照常渲染、勾选框照常能点、草稿照常攒、横幅照常显示「有未保存的改动」，
**但点保存零请求、零报错、横幅不消失**。因为 `void-entry` 的 `save()` 第一句是
`if (draft === undefined || view === undefined) return`——命名空间不在 `describe()` 里，
`view` 恒为 `undefined`，于是静默返回。（另一条 `ops.length === 0` 会走 `discard()` 把横幅**清掉**，
横幅还在就说明不是它——这是个好用的二分。）

**当时全仓库只有灵榜用 `installSection`**，所以爆炸半径就它一个。查同类问题：

```powershell
Select-String -Path packages\*\src\*.ts -Pattern 'installSection|\.settings\.'
```

三条容易踩的细节：

- **`.volatile()` 只加在可热改字段上。** 启动项（`enabled` / `path` / `transport` / `ledger`）不加——
  加了会被当成热改，而不加就自动不出现在表单里（正好是想要的效果，由面板的只读区展示）。
- **带 volatile 的 schema 不能写 `z<Config>` 注解。** `z<T>` 展开是 `Schema<T, T, 'plain'>`，
  要求输入面与输出面都是 `T`；而 volatile 字段的输入面是裸形状、输出面是 `Volatile<T>`，必然对不上。
  写 `z<any, Config>`（放开输入、钉住输出）。宿主自家的 `web-search-deepseek` 等同样不写单参形式。
- **`MessageSourceMap` 也要自己声明。** 0.2.0 删掉了通用的 `'plugin'` 成员，各插件用 declaration
  merging 声明自己的 `kind`（`plan-mode` / `tool-goal` / `hooks-codex` 都是这个写法）。
  不声明不是运行时错误，而是编译期「不在联合类型里」。

**顺带修掉一个「能改不能存」的结构性坑**：`FieldControl` 给 `operations` / `tokens` 两个控件
**没传 `disabled`**，所以设置视图缺失时它们照样收输入。现在补上了；`save()` 的静默 `return`
也改成会明确报「宿主没有这个设置命名空间」。

#### 校验后移带来的第二颗雷：一次误改配置能让宿主退出

「跨字段校验从写入时挪到读取时」不是没有代价的，**代价就是下面这条，改的时候必须一起处理**。

插件里凡是 **fire-and-forget 地读配置**的地方（灵榜是 `source.watch(() => { void refreshRoots(); })`），
都会在坏值写入后变成 **unhandledRejection**——而 dsh 的 `dsh-app-boot` 里 `installFailLoud` 把
`unhandledRejection` 判成 `fatal load failure` 并 **`proc.exit(1)`**。也就是说：用户在面板里把
`allowedOperations` 写错一个操作名 / 写个坏正则 / 填个不存在的目录 / 填错回调 URL，
**dsh 进程直接就没了**。

实测（撤掉修复跑单测）：断言全过，但 vitest 仍报 `Unhandled Rejection` + `Errors 1 error`，
**退出码 1**——拒绝逃逸本身就是失败，哪怕业务断言是对的。

修法是给这类调用一律挂 `catch`，**降级成「放弃这次后台刷新 + 大声记一笔」**：
`roots` 因此保留上一次的好值，而按需读取（请求路径）仍照旧如实报错。请求路径本身是安全的——
`mcp.ts` 的 handler 外层有 `try`，`ControlError` 会变成 **400 + 错误详情**，不重抛、不崩。

**结论：在 0.2.0 上，任何读配置的地方要么在有 try 的请求路径里，要么自己挂 catch。**
漏一个 fire-and-forget 就是一条「改错配置 → 宿主退出」的路径。

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

#### 7.1 ⚠️ patch 的 `config` 是**整体替换**，不是深合并

这条极易踩，后果是**静默丢配置**。

patch 的语义在 `dsh-app-boot/lib/index.js` 的 `applyEntryPatches()` 里——源码注释称它为
「THE patch semantics of this include」：

```js
for (const [key, value] of Object.entries(overrides)) {
  if (key === "id") continue;
  target[key] = value;      // 顶层键直接赋值，没有递归合并
}
```

`config` 是顶层键，所以**整个 config 对象被替换**，而不是逐字段覆盖。只写一个字段，其余字段
全部回到 schema 默认值——包括你没打算动的那些。

实测（`void-dsh-control`）：往 profile 的 `cordis.patch.yml` 只写

```yaml
- id: void-dsh-control
  config:
    allowedRoots:
      - E:\project\star-sanctuary\Void
```

结果 `tokens` 被一并抹掉（回到 `[]`），端点仍然在，但**所有请求 401**。补全 `tokens` 后立即恢复。

**正确写法**：改任何一个字段，都要把**其余关键项一并写全**。最省事的做法是从包内的
`cordis.patch.yml` 复制整段 `config` 再改你要改的那一行。

> 参考实现见 `packages/void-dsh-control/cordis.patch.yml`——它就是一份可直接抄的完整 config。

### 8. 构建链有个坑：`pnpm pack` 不编译

它只把现成的 `lib/` 打进 tarball。漏了构建，打出来的是**上一次**的代码——命令成功、产物是旧
的，静默失败。

更隐蔽的是 `void-dsh-control`：它被 `pnpm-workspace.yaml` 排除（为绕开下面那条 peer 陷阱），
所以 **`pack-all.ps1` 管不到它**，必须另跑 `pack-lingbang.ps1`；`pnpm -r test` 也不含它的测试。
`pack-all.ps1` 末尾会比对时间戳并提示——看到 `[!]` 就说明你正要打出一个旧包。

### 9. 一条会咬人的依赖陷阱

`@deepseek-ai/dsh-client-ui-primitives@0.1.7-rc.1` 的 peerDependencies 是
`@deepseek-ai/cordis@~4.0.4`，而本 workspace 固定在 **4.0.1**。把它装进 `node_modules` 会让
pnpm 提升既有包的 peer，使 `void-tools` / `void-legion` / `void-memory` 报
`does not provide an export named 'CallId' / 'isJsonValue'`。
（宿主升级会抬这个 peer 范围，所以每次升级都要重新确认——但**结论一直是「不要装」**。）

**所以它的类型靠生成 ambient 声明，绝不装包。** 生成脚本是
`scripts/gen-primitives-types.mjs`（`pnpm run gen:primitives` / `check:primitives`）：

- **输入是用法**：扫描 `src/client/**` 里从该模块 import 的名字，只生成这些。新用一个原语而忘了
  重新生成，`--check` 会立刻失败；不会出现「声明里有但代码不用」或反过来的情况。
- **默认读本机已装的宿主**（`$DSH_HOST_PRIMITIVES_DIR` 可覆盖），读不到才按脚本里的
  `HOST_VERSION` 去 npm 取。0.1.7 起该包随宿主落到磁盘，**所以这条路径离线可用，也不用再记得
  改常量**——0.1.5 → 0.1.7 那次就是漏在「常量没改、声明没跟上」，运行期才炸成白屏。
- `--check` 已接进 `pack-all.ps1` 第 1 步：宿主升级后忘了重跑，**打包会失败**，而不是打出一个
  白屏的包。

配套的**运行期兜底**在 `src/client/primitives-probe.ts`：`PRIMITIVE_GAPS` 列出缺失的名字供
`apply()` 告警，`safeIcon()` 把改名后变成 `undefined` 的图标换成空组件。注意 `safeIcon` 只把
「名字取不到」判为缺失——不要改成 `typeof x === 'function'`，宿主的 `DisclosureRow` 在 0.1.7 是
`MemoExoticComponent`（对象，不是函数），那个判据会把它误杀成空白。

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
