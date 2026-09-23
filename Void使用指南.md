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
   ├─ void-soul       灵魂（SOUL 底线 + 模组库 + 权威档案，派活身份从这来）
   ├─ void-memory      人格记忆（Markdown 记忆仓 + memory.sqlite 索引，FTS5 + sqlite-vec 检索）
   ├─ void-tools       工具治理（契约 + 角色策略）
   ├─ void-legion      军团（花名册 + 权威关系 + 派活 + 终态通知）
   ├─ void-entry       界面入口（设置卡片 + 业务视图 + 详情渲染器 + 通知栏）
   ├─ void-channel-*   渠道（飞书等）
   └─ void             组合 bundle（把上面各层合到一层，内容与逐个装包等价）
```

Void 遵守 dsh 的契约：不替换 agent-loop、不双写 session，记忆作为其上的 knowledge 层；团队/军团作为公开的 `ctx.voidTeam` seam（不降级为 subagent 黑盒）。

### 仓库里有什么

| 包 | 作用 |
|---|---|
| `@void/void-soul` | `ctx.voidAuthority` 权威档案 + `ctx.voidSoul` 灵魂档案与模组库（面板用） |
| `@void/void-memory` | 人格记忆：`memory_search`/`memory_read`/`memory_write` 等 6 个工具 + `ctx.voidMemoryLibrary` 面板视图（`/provider` 那套）；另含旧知识层 `/sqlite` 的 `ctx.voidMemory` |
| `@void/void-tools` | `ctx.voidToolContracts` 契约注册表 + `ctx.tools.guard` 角色策略 |
| `@void/void-legion` | `ctx.voidTeam` 军团 seam（roster + 权威 + 派活 + checkpoint + 终态通知） |
| `@void/void-entry` | 界面入口：设置卡片、`/void/api/*` 路由、业务视图注册表、详情渲染器与通知栏 |
| `@void/void-channel-feishu` | `ctx.voidChannels` 渠道注册表 + mock 飞书传输；发消息侧另有真实实现 `RealFeishuChannel`（`./real-feishu`，Lark SDK 已是依赖） |
| `@void/void` | 组合 bundle（entry + soul + memory + tools + legion 合到一个 profile 层；与逐个装包由 `packages/void/tests/bundle-parity.spec.ts` 逐条比对） |
| `@void/void-seam-demo` | 阶段 1 的最小 seam 模板（Service Definition + Provider + Consumer） |
| `@void/void-dsh-control` | 灵榜控制面：MCP Streamable HTTP 端点，让外部 AI（Codex 等）指挥**正在运行的** DSH Web profile。**独立 workspace + tarball 安装，见 2.5** |
| `@void/void-memory` 内嵌 `src/star/` | Star 记忆的全量源码快照（方案 B 合并后随插件包分发；**人格记忆不用它**，见 3.1） |

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
pnpm test         # 跑全部测试（当前 862 个，全绿；不含独立 workspace 的 void-dsh-control，它自带 15 文件 / 302 例）
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
dsh plugin --profile demo add "$base\void-soul"
dsh plugin --profile demo add "$base\void-memory"
dsh plugin --profile demo add "$base\void-tools"
dsh plugin --profile demo add "$base\void-legion"
dsh plugin --profile demo add "$base\void-entry"
dsh plugin --profile demo add "$base\void-channel-feishu"

# 4. 验证组合（应看到 "# == @void/*" 各层）
dsh --profile demo --dump-config

# 5. 跑完整任务
$env:DEEPSEEK_API_KEY = "你的 key"
dsh --profile demo "你的任务"
```

> **档案名从哪来**：`dsh --profile demo` 只决定读哪个 profile 目录，**它不设置 `DSH_PROFILE`**；但插件现在能从宿主给的档案目录（`ctx.baseUrl` = `<DSH_HOME>/profiles/demo/`）自己认出档案名，所以**通常不必再手工设 `DSH_PROFILE`**。数据根是 `<DSH_HOME>/void-data/<档案名>`；认不出的场合（插件不在根树、档案目录不是 `<home>/profiles/<名字>` 这个形状）才需要显式给：
>
> ```powershell
> $env:DSH_HOME = "E:\project\star-sanctuary\Void\.dsh-demo"
> $env:DSH_PROFILE = "demo"          # 可选：给了就压过宿主给的档案目录
> ```
>
> 优先级：显式 `dataDir` 配置 > 宿主的 `profileContext` > `DSH_HOME`+`DSH_PROFILE` > 宿主档案目录（`ctx.baseUrl`）。三条来源一个都没有时插件**照样加载**（不会掀掉整棵插件树），业务视图回
> `404 无法确定档案位置：需要 profileContext、宿主给的档案目录（ctx.baseUrl），或 DSH_HOME + DSH_PROFILE`——这是设计，不是故障。详见 2.6 与 `docs/灵魂记忆与军团.md` 的 13.1。

> 也可用脚本：`.\scripts\install-profile.ps1 -Profile demo -DshHome "...\.dsh-demo"`

验证成功的标志：`--dump-config` 输出里出现 `# == @void/*` 各层，且任务里模型能调用 `memory_search` 工具。

### 2.4 发行方式

- **打包**：`.\scripts\pack-all.ps1` 把所有包 `pnpm pack` 到 `dist/`（`workspace:*` 会自动重写为版本号），打包前会清理上一轮 tarball。
- **干净 profile smoke**：`.\scripts\smoke-clean-profile.ps1 -ApiKey "你的key"` 会用全新 `DSH_HOME` 安装 `dsh-headless` + `distoid-void-memory-0.1.0.tgz`，放行 `better-sqlite3` build，打印 dump-config，并让模型真实调用一次 `memory_search`；完整输出在 `%TEMP%\dsh-void-smoke.log`。
- **正式发行**：`pnpm publish` 到 npm（或私有 registry）后，`dsh plugin add @void/void`（组合 bundle 作为单一入口，其 `@void/void-*` 依赖从 registry 解析）。
- **已知限制**：本地 tarball 互装时，包之间的相互依赖仍去 npm 解析（404），故 tarball 只适合无相互依赖的单包分发。

### 2.5 灵榜控制面（void-dsh-control）单独安装

这个包**与 2.3 的其余 Void 包形态不同**：它是**独立 workspace**（根 `pnpm-workspace.yaml` 显式排除），
面向 dsh `0.1.5-rc.2`，并且**必须用 tarball 安装**。

```powershell
# 1. 构建 + 装配 + 打包（独立脚本，不是 pack-all.ps1）
pwsh -File scripts\pack-lingbang.ps1

# 2. 装进 profile —— 必须用 .tgz，不能用目录路径
dsh plugin --profile <profile> add "E:\project\star-sanctuary\Void\dist\lingbang\void-void-dsh-control-0.1.0.tgz"

# 3. 设 token（仓库规范：环境变量统一 VOID_*）
$env:VOID_DSH_CONTROL_TOKEN = "<长随机串>"

# 4. 构建 / 测试（根 pnpm -r 不覆盖该包）
pnpm --dir packages\void-dsh-control run typecheck
pnpm --dir packages\void-dsh-control test
```

**两个必须知道的坑**：

1. `dsh plugin add <目录>` 只装成 `link:`，Node 按真实路径解析 bare import 时够不到 profile 的
   `node_modules`，启动会报 `Cannot find package '@deepseek-ai/cordis'`。**用 `.tgz`。**
2. 重新打包后要**先 remove 再 add**，否则 pnpm 按包名 + 版本复用旧解析，打印
   `Already up to date` 并继续跑旧代码。

**为什么不并入主 workspace**：把 rc.2 与 rc.6 放进同一个 workspace，pnpm 会把既有包自动安装的
peer 提升到 rc.2，`void-tools` / `void-legion` / `void-memory` 的测试会直接报
`does not provide an export named 'CallId' / 'isJsonValue'`。

完整说明见 `packages/void-dsh-control/README.md`；面向普通用户的安装、配置与操作指南见
`docs/灵榜会话功能实现方案计划.md` 第 25 节。

### 2.6 隔离 profile 操作指南（安装 tarball / 备份 / 回滚 / 卸载）

> 面向「在**不碰日常 `~/.dsh`** 的前提下，把 Void 装进一个一次性 profile」的场景。
> 2026-09-22 在 `Void\.tmp\soul-profile` 上按本节完整跑通过一遍。

**0. 隔离**：整节都用 `DSH_HOME` 指向仓库内的一个目录（例如 `Void\.tmp\soul-profile`）。
档案名（数据根的下一级）现在**不必手工设**——宿主会把档案目录 `<DSH_HOME>\profiles\<名字>\` 交给根树插件，插件据此认出档案名；想固定成别的名字时再给：

```powershell
$env:DSH_HOME    = "E:\project\star-sanctuary\Void\.tmp\soul-profile"
$env:DSH_PROFILE = "web"        # 可选；给了就压过宿主给的档案目录
```

`dsh --profile web` 只决定读哪个 profile 目录，**不会设置 `DSH_PROFILE`**；插件的数据根是
`<DSH_HOME>/void-data/<档案名>`，档案名按「显式 `dataDir` > `profileContext` > `DSH_HOME`+`DSH_PROFILE` > 宿主档案目录（`ctx.baseUrl`）」的顺序认（见 13.1）。

> **每条命令都要重设一遍**：每个 shell 都是新进程，不继承上一条命令的环境变量。漏掉 `DSH_HOME` 时
> `dsh plugin` 会照默认 home 走，把新 profile 建到日常 `~/.dsh\profiles\<名字>` 里——隔离就破了。

**1. 备份（装之前先做，回滚就靠它）**：

```powershell
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$bk = "E:\project\star-sanctuary\Void\.tmp\p7-backup\$stamp"
New-Item -ItemType Directory -Force -Path $bk | Out-Null
Copy-Item "$env:DSH_HOME\profiles\web\package.json"     $bk
Copy-Item "$env:DSH_HOME\profiles\web\cordis.patch.yml" $bk
```

`profiles/<档案名>/` 里真正决定「装了什么」的只有两份文件：`package.json`（依赖 + `dsh.profile.bundles`）
与 `cordis.patch.yml`（entry 级覆盖）。`node_modules/` 与 lockfile 都能重建，不必备份。

**2. 安装**：用 **tarball**，不要用目录（目录只装成 `link:`，peer 解析会失败）：

```powershell
pwsh -File scripts\pack-all.ps1        # 先构建再打包，产物在 dist\
dsh plugin --profile web add "E:\project\star-sanctuary\Void\dist\void-void-soul-0.1.0.tgz"
dsh plugin --profile web add "E:\project\star-sanctuary\Void\dist\void-void-memory-0.1.0.tgz"
# …按需继续装 tools / legion / entry
```

想一次装齐就用组合包 `void-void-0.1.0.tgz`（内容 = 五包并集，见 3.6）；它的 `@void/void-*`
依赖要从 registry 解析，本地还没发布时请逐个装单包。

**必须给绝对路径**：`dsh plugin` 把相对路径按 profile 目录解析，写 `dist\xxx.tgz` 会在
`profiles\<名字>\dist\xxx.tgz` 上找，报 `ENOENT`。

**重打包之后要清一次账**：pnpm 把 `file:` 依赖按 lockfile 记账，路径没变就认为「已是最新」，
再 `dsh plugin add` 同一个路径不会换文件（实测：tarball 换成旧包再 `add`，装的还是原来那份）。
改了源码重新 `pack-all.ps1` 之后，先删掉 profile 里的 `pnpm-lock.yaml` 与 `node_modules/`
（或干脆重建 profile）再装。

**装 `void-memory` / `void-legion` 之前，先在 profile 的 `package.json` 里加两条 `pnpm` 配置**
（2026-09-22 实测，缺了会装不上或装上了也不能用）：

```json
{
  "pnpm": {
    "overrides": { "@void/void-soul": "file:E:/project/star-sanctuary/Void/dist/void-void-soul-0.1.0.tgz" },
    "onlyBuiltDependencies": ["better-sqlite3"]
  }
}
```

- `overrides`：这两个包把 `@void/void-soul` 声明成普通版本依赖（`0.1.0`），本地没发布时 pnpm 会去
  registry 找，报 `No authorization header was set for the request.` / 404。用 `overrides` 把它指到
  同一个 tarball 即可；`@void/void-soul` 没发布前这是本机安装的唯一办法。
- `onlyBuiltDependencies`：pnpm 10 默认不跑依赖的构建脚本，`better-sqlite3` 的原生模块不会编译，
  装完 `require('better-sqlite3')` 报 `Could not locate the bindings file`，人格记忆一检索就崩。
  加上之后安装会现场编译一次（约十几秒，需要本机有 MSVC 工具链）。

**3. 验证**：

```powershell
dsh --profile web --dump-config | Select-String "id: void"   # 五包共 16 条 entry 全部命中
dsh web --no-open --port 3699                                # 打开打印出来的带 token 的地址
```

`GET /void/api/panels` 应返回五个业务视图（人格记忆 / 灵魂档案 / 模组库 / 军团队伍 / 军团运行）
与两个通知来源 `void-legion:runs`、`void-soul:refusals`；`GET /void/api/detail?view=void-soul:profiles` 应列得出真档案。
若这里回 `404 无法确定档案位置：需要 profileContext、宿主给的档案目录（ctx.baseUrl），或 DSH_HOME + DSH_PROFILE`，
说明三条来源一个都没给（正常用 `dsh --profile X` 起的时候宿主会给档案目录，所以一般见不到这条）——
**界面本身仍然打得开**，这是「没配」与「配错」分开处理的结果。

全新的 profile 第一次打开时数据根还不存在，**五个视图都应该是 200 + 空列表**：灵魂档案 / 模组库回空表，
人格记忆带回一句「数据根里还没有任何档案的记忆……」的提示。这是 2026-09-22 修掉的缺陷（空数据根曾让两个
灵魂视图回 500），现在「还没建目录」与「一份都没有」是同一种情况：不报错，也不替你建目录。

**`dsh web` 只服务默认 profile**（默认就是 `web`）：`dsh web` 不收 `--profile`，它按默认 profile 组合 bundle，而 Void 的数据根按档案名走（`DSH_PROFILE` 或宿主给的档案目录）。2026-09-22 实测：`DSH_HOME` 指向隔离 home、`DSH_PROFILE=soulmem`（只装了 entry + soul + memory 的 profile）时，界面仍然列得出军团队伍与军团运行（那是默认 profile 的插件），但数据根确实是全新的 `void-data/soulmem`——五个视图都 200 + 空列表，而且**没有替你建目录**。所以「非默认 profile 的插件组合」只能在 CLI 层验（`dsh --profile <名字> --dump-config`），界面层要在默认 profile 上看。

**4. 回滚**：把备份的两份文件拷回去，再触发一次依赖解析：

```powershell
Copy-Item "$bk\package.json"     "$env:DSH_HOME\profiles\web\" -Force
Copy-Item "$bk\cordis.patch.yml" "$env:DSH_HOME\profiles\web\" -Force
dsh plugin --profile web add @deepseek-ai/dsh-headless@0.1.0-rc.6   # 把依赖拉回备份状态
dsh --profile web --dump-config
```

**数据不动**：`void-data/<档案名>/` 下的档案、记忆、队伍与运行记录**不受安装/卸载影响**，
回滚不会丢数据，卸载也不会替你删。

**5. 卸载**：

```powershell
dsh plugin --profile web remove "@void/void-legion"
dsh plugin --profile web remove "@void/void-tools"
# …逐个 remove；装了组合包则是 remove "@void/void"
```

卸载后核对残留（2026-09-22 在一个一次性 profile 上实测）：`pnpm-lock.yaml` 会跟着收缩（`@void/` 与
被拉进来的传递依赖条目都清零）、`--dump-config` 里 `void-*` 的命中数回到 0、`dependencies` 与
`dsh.profile.bundles` 里不再有 `@void/*`。**会留下的只有两样**：

- `node_modules/` 下的**空作用域目录**（例如 `node_modules/@void/`，以及被 `void-channel-feishu` 的
  Lark SDK 带进来的 `@larksuiteoapi/`）——里面没有任何包；留着无害，想彻底干净就删掉整个 `node_modules/` 让 pnpm 重装。
- `cordis.patch.yml` 里**手写的**、针对 Void entry 的覆盖（例如 `void-memory-provider: {profile: web}`、
  `void-soul: {entryPolicy: …}`）不会自动消失，要手工删掉，否则下次启动会因为 patch 指向不存在的 entry 而报错。

> ⚠️ 删数据目录请走系统回收站，不要 `Remove-Item -Recurse` 直接抹；也**不要**把 junction 当普通目录删
> （2026-09-09 的事故就是这么来的）。

---

## 三、功能模块使用指南

### 3.1 记忆（void-memory）

这个包里其实有**两套记忆**，装的时候别混：

| | 人格记忆（主力，P3–P6 落地） | 旧知识层（历史 MVP，兼容保留） |
|---|---|---|
| 装的 entry | `@void/void-memory/provider`＋`/tool`＋`/memory-service`＋`/detail-view` | `@void/void-memory/sqlite` |
| 数据落在哪 | `<DSH_HOME>/void-data/<DSH_PROFILE>/agents/<agentId>/`：`MEMORY.md`（长期）＋`memory/*.md`（日记条目）＋`memory.sqlite`（索引） | 单个 SQLite 文件（`VOID_MEMORY_PATH`，缺省 `:memory:`），内容是内嵌的 Star 快照 |
| 隔离 | 按 Agent 身份分家，A 的记忆 B 看不到 | 不隔离 |
| 检索 | `memory.sqlite` 的 FTS5 索引（关键词） | Star `belldandy-memory`：FTS5＋sqlite-vec 向量 |

**模型层工具**（6 个，只认调用者本人的记忆）：

| 工具 | 干什么 |
|---|---|
| `memory_search` | 关键词检索本人记忆，返回 entryId / 来源 / 修订 / 片段 |
| `memory_read` / `memory_list` | 读单条 / 分页列出「记了些什么」 |
| `memory_write` | 写长期记忆（`MEMORY.md`）或新建日记条目 |
| `memory_update` | 按 entryId 或长期文档 id 修改；必须带 `expectedRevision`（防并发覆盖） |
| `memory_retract` | 撤回错误记忆：正文清空、原件挪进 `retracted/`，立即不再被检索 |

**写入前的密钥检查**：`memory_write` / `memory_update` 落盘前会先扫一遍正文，命中十类高置信度密钥形态（私钥块、`sk-…`、GitHub token/PAT、AWS `AKIA…`、Slack `xox…`、Google `AIza…`、JWT、`Bearer …`、`api_key = …` 这类赋值）就直接拒绝，返回
`Error: 记忆正文含疑似敏感内容（openai-key），已拒绝写入`——**只报类型、不回显原文**，正文、`MEMORY.md`、`memory.sqlite` 与 `-wal`/`-shm`、`retracted/` 里都不留痕（2026-09-23 真机实测，见《灵魂记忆与军团》19.3 第 3 条）。这是**形态匹配**，不是「秘密扫描器」：没被这十类覆盖的口令认不出来，别把密钥交给它保管。

**记忆落在磁盘上**：条目与长期文字都是 `<数据根>` 下的普通 Markdown 文件，换一个会话、甚至换一个宿主进程重启之后再 `memory_search`，照样查得到（2026-09-23 真机实测：写与查分别在新旧两个宿主进程里跑，检索分数一致、正文逐字读回）。

**记忆不进提示词**：除了 SOUL（说明书）本身，记忆正文**不会被自动塞进上下文**——模型必须自己调 `memory_search` / `memory_read` 才能看到内容。这条不是口头约定：`packages/void/tests/prompt-closure.spec.ts` 用真 Loader + 真 SystemPrompt 服务 + 真灵魂/记忆插件，把哨兵同时写进 `SOUL.md` 与 `MEMORY.md`，断言进提示词的只有说明书与本次模组这两条通道，记忆哨兵一个字节都不在（也不在工具描述里）。

**面板**：`void-memory:memory` 业务视图（走详情渲染器）列出每个 Agent 的长期记忆与条目，可打开正文、编辑、撤回。

**数据根**：`<DSH_HOME>/void-data/<档案名>/agents/<agentId>/`——`DSH_HOME` 的缺省是 `~/.dsh`，档案名按「显式 `dataDir` > `profileContext` > `DSH_HOME`+`DSH_PROFILE` > 宿主档案目录（`ctx.baseUrl`，`dsh --profile X` 会给）」认；
三条都没有时插件照常加载，用到数据才报 `人格记忆没有数据根，无法读写记忆：…`（见 2.6）。

**`<agentId>` 是档案 id，不是 SOUL 所在目录名**：档案目录可以叫 `小贝`（id 是 `xiaobei`），记忆仍然落在
`agents/xiaobei/`；把 `MEMORY.md` 放进 `agents/小贝/` 记忆面板列不出来——`MemoryLibrary.listAgents()` 只收能过
档案 id 校验（`[A-Za-z0-9][A-Za-z0-9_-]{0,63}`）的目录名，中文目录名一律跳过，面板会显示成
「数据根里还没有任何档案的记忆」。记忆一律按 id 找，跟 SOUL 放在哪个目录无关。

**路径边界**：记忆的每一次读写都先看一遍真实位置——档案根、长期文字、条目、撤回区、日记目录与每个条目文件、
以及 `memory.sqlite` 句柄路径（`provider.ts` / `memory-library.ts` 里是同步打开的，所以走同步版守卫）。
把 `memory/`、`MEMORY.md` 或 `memory.sqlite` 换成指向数据根外的链接后，读写会抛
`记忆路径经链接后越界: …`，根外那个目录里不会多出任何文件；列目录遇到链接直接拒绝，不静默跳过。
数据根**自己**落在链接下（把 `.dsh` 挪到别的盘）是正常部署，照常放行。

**共用模组库那层不是档案**：`agents/facets` 归灵魂的模组库，人格记忆把它当保留名——`facets`（以及 Windows 上等价的
`Facets`）既不能当档案 id，也不会出现在记忆面板的档案列表里；绑定到这个名字的会话写不出 `MEMORY.md`，
`facets/xxx` 这种条目 id 也解析不了。判定与灵魂侧共用同一处
（`void-soul/src/profile.ts` 的 `FACET_DIRECTORY_NAME` / `isFacetDirectoryName()`），大小写不敏感。

**旧知识层的代码层 API（`ctx.voidMemory`）**（只有装了 `/sqlite` 才有）：

```ts
const id = ctx.voidMemory.store("要记住的内容", new Float32Array([...])); // 可选带向量
const hits = ctx.voidMemory.search("关键词", 5);                          // FTS5
const hits2 = ctx.voidMemory.searchByVector(new Float32Array([...]), 5);  // sqlite-vec KNN
const n = ctx.voidMemory.ingest("第一段\n\n第二段\n\n第三段");             // 按空行切块
```

快照校验：`pnpm run verify:star-memory-snapshot`。

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
      allowedToolFamilies:
        - workspace-read
        # 本机抓取（local_fetch）属于 network-read；白名单为空时它照样谁都不放行。
        - network-read
      maxToolRiskLevel: medium
```

**本机抓取（`local_fetch`）**：模型想读本机的面板/接口（比如 `http://127.0.0.1:3080/`）时走这个工具，不走宿主的 `web_fetch`（宿主硬拒非公网地址，没有开关）。它的规矩是**白名单 + 端口限制，默认全关**：

```yaml
- id: void-tools-local-fetch
  name: "@void/void-tools/local-fetch"
  config:
    allow:
      - host: 127.0.0.1     # 只认 127.x.x.x / ::1 / localhost
        port: 3080
        note: 面板（写给人看）
    maxBytes: 262144        # 可选，1..8388608
    timeoutMs: 5000         # 可选，1..120000
    maxRedirects: 3         # 可选，0..10
```

- 只发 GET、不带 body；只走 `http://`（本机地址没有证书可言）；地址里带用户名密码一律拒。
- 空白名单（默认）＝谁都不放行，且**不在装载期报错**——装得上、用不了，报错发生在模型真去抓的时候。
- 每一次重定向都重新过白名单，跳到白名单外就停手；超过 `maxRedirects` 也停手。
- 超字节上限就截断并标 `truncated: true`；非 2xx 如实回话（不当异常）；图片这类非文本响应只回一句「正文没有装进上下文」，不带二进制。
- **上层停手就当场断开**：工具接的是调用方给的取消信号（`exec.signal`）——军团在面板上点取消、会话被中断时，正在跑的那次抓取会立刻断开，文案是 `本机抓取被取消（上层停手了）：<url>`；只有它自己那条 `timeoutMs` 到期才写 `本机抓取超时（Nms）：<url>`（两者分得清，不混成一句含糊的「超时或已取消」）。
- 拒绝文案会原样进模型的上下文（比如 `本机抓取只允许白名单里的地址，127.0.0.1:3081 不在白名单里`），所以模型能自己看懂为什么被拒。
- 每次调用都写日志：成功是 `本机抓取 <url> → <status>（N 字节[，已截断]） 会话=<id>`，被拒是 `本机抓取被拒：<原因> 会话=<id>`。
- 想临时开口子就在 profile 的 patch 里用同一个 id 覆盖（同 id 会整块替换 `config`），不必改包。
- 真机核对过（2026-09-23，隔离 profile + 真模型）：模型自己调了两次 `local_fetch`——白名单里的 `127.0.0.1:3777` 读回 200、页面口令原样进了回答；白名单外的 `127.0.0.1:3778` 回 `Error: 本机抓取只允许白名单里的地址，127.0.0.1:3778 不在白名单里`，模型拿不到内容，只把拒绝原文转述了出来。
- 取消也真机量过（2026-09-23，同一个"睡 100 秒才回话"的慢面板）：**没接 `exec.signal` 之前**，在军团面板上点「停全队」只把还没派发的任务取消掉，正在跑的那次抓取照样睡满 100 秒（比点击多跑 58.3 秒，运行才结算）；**接上之后**同样点一次，点击那一毫秒慢面板就收到连接断开、子代理当场落定 `cancelled`，运行记 `run_cancelled`——比自然结束早 24 秒。

### 3.3 灵魂（void-soul）

**能力**：给每个 Agent 一份 `SOUL.md`（人格底线）＋一层可切换的模组（角色），并回答「这次派活的是谁」。

**两个 seam**：

| seam | 作用 |
|---|---|
| `ctx.voidAuthority` | 权威档案：`forSession(sessionId)` 按会话解析派活者身份，`personaFor(agentId)` 按档案 id 取那个成员的身份文本（军团逐 lane 注入 persona 用；**不看会话绑定**，取不出来就抛，绝不退回派活者的身份） |
| `ctx.voidSoul` | 灵魂档案与模组库：列档案、读改模组正文、切换当前模组（面板用） |

**数据**：`<数据根>/agents/<agentId>/SOUL.md`；共享模组库 `<数据根>/agents/facets/*.md`（所有 Agent 共用这一层）。`facets` 是**保留目录名**（大小写不敏感：Windows 上 `Facets` 就是 `facets`），不能同时当某份档案的目录——判定在 `profile.ts` 的 `FACET_DIRECTORY_NAME` / `isFacetDirectoryName()`，注册扫描、目录拼接与人格记忆的档案 id 校验都用它。`agents/` 下的**链接（含 Windows 的 junction）一律拒绝**并报出指向哪里——`readdir` 会把 junction 报成「不是目录」，旧写法「非目录就跳过」会让那份档案凭空消失；普通文件（如 `agents/README.md`）跳过不报错。模组库也一样：`agents/facets` 整层被换成链接、或库里某个 `*.md` 是指向库外的链接，读取时抛 `路径经链接后越界`；模组库还没建出来时按空库处理（不报错也不建目录）。

**面板**：`void-soul:profiles`（灵魂档案卡片：显示名 / 头像 / **底线正文**可编辑，正文带留痕与回滚，另有绑定会话、首次见面、**停用 / 启用这份档案**（可逆，只改 `state.json` 里一个布尔值）与**删除这份档案**（危险动作，走回收站，记忆与聊天记录都不动）等动作）与 `void-soul:facets`（模组库：编辑 Markdown 正文、为当前 Agent 指派或清除模组）。

**边界**：`SOUL.md` 只有人类侧（面板）能改，模型侧没有写权限——「底线改不动」是结构上的，不靠约定。人类改**底线正文**有专门的入口（见 3.7 的「底线正文的人类编辑入口」），而 front matter（`id` / `owner` / `authority`）仍然不可改：`id` 一改，记忆根与派活身份就全对不上了。数据根没配好时插件照样加载，用到才报错（`灵魂档案没有数据根，无法读写档案与模组：…`）。

**能填的变量**：只有三个，`{{provider}}`、`{{model}}`、`{{cwd}}`——插值是宿主做的（`dsh-system-prompt` 每次组装提示词时一次性严格替换，替换进去的内容不会再被扫描），本插件只认这三个名字，别的会报 `未知说明书变量`。取值口径也跟着宿主：`provider`/`model` 来自 Agent 的 `AgentOptions`，`cwd` 来自会话头。**所以有个坑**：如果 provider/model 是通过 `agent/request` 瀑布给的（不是 `AgentOptions`），宿主的提示词变量就取不到值，写 `{{provider}}` 会让整个 Agent 起不来——本插件在装载前会先拦下来并报清楚原因（给这个 Agent 设上，或把变量删掉）。front matter（id／主人／权限）不参与插值。

**装进模型的预算**（`SOUL.md` 保存不设上限，装进模型前才量）：默认上限 10 万字符；能读到模型上下文窗口时（宿主首次请求之后）再收紧到 `窗口 × 0.5`。放不下就**拒绝发送**并报出实际字数、预算与补救方向（缩短 SOUL／换更短的模组／换窗口更大的模型），不会截断内容。想自己定上限：

```yaml
- id: void-soul
  config:
    prompt:
      maxCharacters: 20000   # 硬上限；窗口更小则取窗口
```

注意 `dsh --patch` 的补丁项给同一个 `id` 写 `config:` 是**整体替换**而不是深合并：上面这段会顶掉该条目原有的 `entryPolicy` 等配置，要写就把它们一起写全。

**装不进去时会告诉你**：拒绝除了进宿主日志（按 `void-soul` 查，那是留档处），还会进面板的**通知栏**——来源 `void-soul:refusals`，标题「灵魂未生效」，一条写清会话 id、档案名（能反查到时）与拒绝原因，点掉即标已读。它**只在本次进程里留最近 50 条**，宿主重启后清空，历史请去日志查（拒绝是当场发生的事，重启后那次会话已经不在了，所以不落盘）。会话本来就没绑档案的**不会**进这个列表——那不是「装不下」，是没给它派灵魂。

**它真的进了模型吗（段的顺序与「补段」）**：三段在宿主的系统提示里分别叫 `void:soul`（顺序 1）、`void:facet`（2）、`void:first-meeting`（3），宿主的身份节是 -1000、派活身份前缀是 0，所以它们紧跟在「你是谁」之后。宿主在 `agent/created` 上**不等待**监听器（`announce()` 不 await），而本插件要读盘才拿得到正文，所以极早发出的第一条请求理论上可能赶在落定之前；插件为此挂在宿主的 `system-prompt/assemble` 瀑布上**补段与换正文**——先让宿主编好，再把这次缺的段插到 `deployment:persona-prefix` 之后（本插件自己的段这一轮不该装就摘掉、名单外别人的段一律不动、挂载失败不连累这次装配），**并且每一轮都重读磁盘把段正文换成最新的那一份**（2026-09-23 起：段文本不再在 `agent/created` 那一刻定死，改完模组或底线正文，同一个会话的下一轮就用新版；真机实测同会话第二问的提示词从 1862 字变成 1896 字）。要自己核对：会话日志里第一条 `system/message` 事件就是最终提示词。2026-09-22 在隔离 profile 上用真实凭据实测：延迟 0 与 300ms 两种时机灵魂段与模组段都在（1896 字），写了 `firstMeeting` 的档案是 1924 字、标成已完成后回到 1896 字。

**首次见面引导**：在 `SOUL.md` 的 front matter 里加一行 `firstMeeting:`，这个档案的会话第一次进模型时，这行文字会跟着说明书一起装进提示词（`void:first-meeting` 段，排在底线与模组之后）；`state.json` 里记着「做完没有」，标过完成就不再装。（2026-09-23 真机核对过整条开关：面板点「重来一遍」后，同一会话下一轮就把这段装回去了——7067 → 7094 字，模型当场问「我该怎么称呼你？」与「现在要不要改底线？」；点「标记『引导已完成』」后另起新会话不再装这段，全程 `SOUL.md` 一个字节没变。）

```yaml
---
id: xiaobei
name: 小贝
summary: 主人的贴身助手
firstMeeting: 先自我介绍，再问主人怎么称呼。
---
```

- 只有**一行**：front matter 解析器只认「顶层单行标量 + 缩进的 `authority:` 块」两层，多行引导写不进去（要写长内容就放进底线正文）。
- 没写 `firstMeeting` 的档案不做自我介绍，面板上那条动作会被拒（`这份档案没有写首次见面引导，不用标完成: xiaobei`）。
- 在面板的「灵魂档案」详情里点**「标记『引导已完成』」**或**「让引导再来一遍」**：只改 `state.json`（`firstMeetingDone`），**档案正文一个字节都不动**——引导文字是人写的，这个入口没有改它的路径。状态不进 `selectionRevision`：换角色不该重做自我介绍。
- 它也算进**装进模型的预算**：超预算时整份拒绝（不装一半），拒绝信息里单独列出引导的字数。

### 3.4 军团（void-legion）

**能力**：把一支队伍真的派出去干活——每条 lane 变成一个 dsh 子智能体，按依赖顺序执行；进度、产出、取消与终态通知都能从工具和面板看到。

**模型层工具**（4 个）：

| 工具 | 作用 |
|---|---|
| `launch_legion` | 派活：`{ teamId, task?, plan? }`。`plan` 是可选的手工计划 JSON（`{"goal":…,"tasks":[{laneId,title,brief,dependsOn,stage,modelRef}]}`），非法计划在派发前就被拒。**计划只写「这一步干什么」**——没写的身份与调度字段都从队伍那条 lane 继承（见下面「队伍从哪来、计划管什么」）。立即返回 `runId`，运行在后台继续 |
| `legion_run` | 读运行进度和小产出；超过 256 KiB 的产出返回 `outputRef.bytes` 与预览（`{ runId, wait? }`；`wait: true` 阻塞到终态，仍可取消） |
| `legion_output` | 分片读大产出的原始 UTF-8 JSON：`{ runId, laneId, offset, length? }`，每次最多 16 KiB；按 `nextOffset` 继续，依次 base64 解码并拼接还原完整内容 |
| `legion_cancel` | 取消整个 run（也可只取消某条 lane） |

`legion_run`、`legion_output`、`legion_cancel` 每次都重核调用会话的绑定、发起身份与本次冻结名单的指挥权；无发起身份的旧运行记录在模型工具层拒绝读取/取消，面板和服务层的历史记录不删。子代理先绑定自己的档案再进首轮；绑定失败不会借用父身份。

**队伍从哪来**：两个来源，**先内存、后磁盘**——`ctx.voidTeam.defineTeam(...)` 注册在内存里的，以及**保存在磁盘上的**（`<数据根>/legion/teams/<teamId>.json`，也就是**面板里建的那些**）。`launch_legion` 只给 `teamId` 就够了，面板建的队伍照样派得动。（2026-09-23 之前工具层只认内存那一份，面板建的队伍会回「队伍不存在: X」——已修，现在派发前会先 `observe`、再 `loadTeam` 落磁盘。）面板上改的**人数上限 / 并发上限**也是当场落到磁盘上的：点一次保存，两个数各推一格修订，**宿主重启后仍是新值**；把上限改到比名单人数还少会被拒（「队伍人数超出上限: 3 > 2（按档案去重后计数，含指挥者与临时成员；改上限或减人后再派）」），拿改前的修订再保存也会被拒（「队伍配置已被其他保存更新（期望修订 X，实际 Y），请重读后再改」），这两种拒绝都不会碰磁盘。（2026-09-23 真机核对：面板把 8→5、4→2 保存后，换一个进程重启宿主，面板读回仍是「3/5 人 · 修订 7」，磁盘原文逐字未变；再绕过宿主把文件换回改前那一份，面板**当场**读回旧值——面板显示的是磁盘上的真值，不是进程里的快照。）

**队伍管谁来做、计划管这次做什么**：`plan` 只负责「这次跑哪几条 lane、每一步干什么」；**谁来做**由队伍决定——计划里没写 `agentId`/`role`/`writes`/`stage`/`modelRef` 时，按 `laneId` 从队伍那条 lane 继承（身份就是这么来的；少了它，权限检查会直接拒「派活目标缺少档案 id: lane_front」）。计划**可以只跑队伍的一部分 lane**：继承来的跨 lane 引用（`dependsOn`/`reportsTo`/`mayDirect`/`handoffTo`）若指向这次不跑的 lane，会被丢掉——那条 lane 不在名单里，「依赖它」「向它汇报」都无从谈起（否则会被拒「成员 lane_front 的汇报对象不在名单里: lane_plan」）；计划**自己**写的引用不丢，那是计划内部的矛盾，派发前会报出来（如「任务计划的 X 依赖不在名单里: Y」）。

**门禁开着的时候**：`launch_legion`/`legion_run`/`legion_output`/`legion_cancel` 在入口策略里都算**管理入口**（名字不在只读名单里就落兜底），`entryPolicy.enabled: true` 时会被拒（「工具 launch_legion 属于管理入口，未开放给 Agent，已拒绝」）。要派活及读取大产出，须在 `entryPolicy.allowed` 里显式写上需要的名字——见 3.3 与 Q8。

**代码层 API（`ctx.voidTeam`）**：

```ts
// 队伍文档（面板里也能建/改；保存带 expectedRevision，防止并发覆盖）
const teams = await ctx.voidTeam.listTeams();
const team = await ctx.voidTeam.loadTeam("legion-demo");
await ctx.voidTeam.saveTeam(document, { expectedRevision: team?.revision });

// 派活：立刻拿到 RunRecord，任务在后台跑。
// worker 是必填的真实执行体：模型走 launch_legion 时由工具自己建（`createScheduledWorker`）；
// 代码层自己派就得自己建，漏给会被拒（「派活缺少执行体」）。逐 lane 身份也要自己填
// （见下面「逐子代理身份」），不然子代理就是无名的。
const worker = createScheduledWorker(ctx, parentAgent, {});
const run = await ctx.voidTeam.dispatch("legion-demo", { task: "把 X 做完", worker });

// 看进度 / 等结果 / 取消
await ctx.voidTeam.runProgress(run.runId);
await ctx.voidTeam.waitForRun(run.runId);
await ctx.voidTeam.cancelLane(run.runId, "lane_code");
await ctx.voidTeam.cancelRun(run.runId);

// 终态通知（断线重连后可补读）
await ctx.voidTeam.notifications?.list();
```

**逐子代理身份**：派活时每个 lane 的子代理都会拿到**它自己那份**身份——按 lane 的 `agentId` 现读磁盘，取「底线 + 当前角色」两段（模组正文接在底线后面），装进宿主的 `persona` 段（`deployment:persona-prefix`，遮蔽继承来的那份）。**不会拿派活会话的身份顶替**：`SoulAuthority.personaFor(agentId)` 只按档案 id 取，不看会话绑定。取不到就整次拒绝派活——缺档案报「没有这份档案，取不出派活身份: X」、底线与角色都空报「档案 X 没有底线正文，取不出派活身份」，而且**在任何运行记录与子代理之前**就拒（连 run 都不建）。身份走和父会话同一份预算检查（`prompt.maxCharacters`），但**变量只查名字、不预检取值**（子代理的 provider/model 由宿主在它自己组装那一刻决定）；**首次见面引导不进子代理身份**（那是跟主人见面用的）。副作用一条：军团现在每次都带身份，所以 provider 必须声明 `persona` 能力，没声明的会被直接拒绝派活（「子代理 provider "X" 不支持逐子代理身份注入，拒绝派活」）。（2026-09-23 真机核对过：两条 lane 的子会话提示词里各只有自己的名号（`ajia` / `ayi`），父会话里只有父的（`xiaobei`），产出开头正是「阿甲在此」「阿乙在此」；同一个会话不绑档案时调 `launch_legion` 收到「派活缺少权威档案：会话 … 没有绑定灵魂档案」，运行记录一个都没多。）

**调度语义**：`schedule` 三选一——`parallel`（无依赖的同时跑）、`sequential`（严格按拓扑，一次一条）、`staged`（阶段内并发、阶段间串行）；`memberLimit` 与 `maxConcurrentTasks` 可在面板改；同一队伍的写锁在 run 之间共享。**「无依赖」不等于「真并行」**：计划里没写 `writes` 的任务**按写任务处理**，同一工作区（默认 `default`）的写任务会被写锁串起来，只读任务请显式写 `writes: false`。（2026-09-23 两个方向都真机核对过：三条 lane 都不写 `writes` 时，`lane_side` 的 `startedAt` 正好等于 `lane_front` 的 `endedAt`、本机慢页面服务的两次请求隔了 31 秒；三条都写 `writes: false` 后，两条互不依赖的 lane 的 `startedAt` 只差 1 毫秒、两次请求只差 1.2 秒。）

**数据**：队伍 `<数据根>/legion/teams/<teamId>.json`、运行记录 `<数据根>/legion/runs/`、终态通知 `<数据根>/legion/notifications.json`。**军团可以没有数据根**：内存能力照常，派活与留档才报错。

**面板**：`void-legion:teams`（队伍：可编辑成员表、新建队伍、看组织图）与 `void-legion:runs`（运行与成员产出）；跑完的 run 会在通知栏留一条，浏览器断线重连后能补读。运行详情里的**进度**逐条写实——「在跑：lane_front（ajia），开始 …，子会话 …」「还没轮到：lane_check（ayi）」「已结算 1/2，在跑 1，还没轮到 0」「最近活动 …」，**不编造完成百分比**；run 还在跑的时候面板**每 3 秒自己重读一次**（跑完就停），任务表里「子会话」那一格是**能点的按钮**，点下去切到宿主的原生子会话、连它的聊天记录一起读出来（跨启动打开上一次跑完的 run 也照样能点）。（2026-09-23 真机核对过：真模型派一个慢运行，进度从「在跑 1 / 还没轮到 1」一路走到「全部干完：2/2」，两次点格子都真切过去并读出了记录。）

**停用的成员在面板上看得见（2026-09-23 起）**：成员被停用之后不用等到派活失败才发现——队伍列表的摘要尾巴多一句「 · N 个成员已停用」，队伍详情在「成员名单」与「运行记录」之间多出一节「停用的成员」，逐条点名 `已停用：lane_front 的 ajia —— 派活会被拒（在灵魂档案面板上「启用这份档案」就恢复，记忆与聊天记录一个字节都没动）`；读不出来的档案单列一行并注明「这一处不算「没停用」」，末尾一句说清名单一个字节都不动。**停用不是把人从名单里去掉**：那张可编辑的成员表一个字节都不动（也不往里加列——整份回写会把算出来的列当成字段写进队伍文件），派活之前才整队拦住：有几个成员取不出身份就一次列几个（`整队不派：N 个成员取不出派活身份——lane … 的派活身份取不出来（<agentId>）：档案已停用，拒绝派活: …`），一个 run 都不会产生。军团自己再读一遍 `agents/*/state.json` 才知道谁被停用，全程只读。（2026-09-23 真机核对：停用「阿甲（ajia）」后列表摘要变 `parallel_subtasks · 并行 · 3/8 人 · 1 个成员已停用`，真模型调 `launch_legion` 拿到 `Error: 整队不派：1 个成员取不出派活身份——lane lane_front 的派活身份取不出来（ajia）：档案已停用，拒绝派活: ajia（在面板上「启用这份档案」就恢复，记忆与聊天记录一个字节都没动）`，`legion/runs/` 一个文件都没多；点「启用这份档案」后标记消失，同一条两条 lane 的计划再派一次正常跑完。）

### 3.5 渠道（void-channel-feishu）

**能力**：渠道注册表 `ctx.voidChannels` + 一个 mock 飞书传输（receive → ingress → reply），证明"收消息 → 路由 → 回消息"的 seam 形状。

**代码层 API（`ctx.voidChannels`）**：

```ts
// 注册一个渠道（实现 VoidChannel 接口），返回 disposer
ctx.voidChannels.register(myChannel);

// 按名查渠道 / 列所有渠道
ctx.voidChannels.get("feishu");
ctx.voidChannels.list();
```

**真实飞书**：分两半，**发消息侧已实现**、**收消息侧未做**。

- 发消息侧：`RealFeishuChannel`（从 `@void/void-channel-feishu/real-feishu` 导入）用飞书官方 SDK 主动发消息到指定 chat；凭据从 `VOID_FEISHU_APP_ID` / `VOID_FEISHU_APP_SECRET` 或 config 读，**缺凭据直接抛错**（fail-closed，不静默降级成 mock），绝不硬编码 / 回显 / 落库。SDK（`@larksuiteoapi/node-sdk`）已是本包依赖，不需要额外安装。
- 收消息侧：webhook 事件订阅 + 回调路由还没做，默认 bundle 装的仍是 mock 传输（`service` entry）。要收消息还得在飞书开放平台配事件订阅回调地址，并给 Void 加一条 webhook 路由。
- 凭据自检：把凭据放进 `Void/.env.local`，跑 `node scripts/verify-feishu-token.mjs`——只换 `tenant_access_token` 验凭据与连通性，**不发任何消息**，也不回显 secret。

### 3.6 组合 bundle（void）

`@void/void` 的 `cordis.patch.yml` 是 **entry + soul + memory + tools + legion 五包 bundle 的并集**，共 16 条 entry
（entry 1 条、soul 4 条、memory 4 条、tools 2 条、legion 5 条）。它只做「把五包合到一层」，不额外提供业务能力。

> **为什么要有 parity 测试**：组合包和「逐个装包」必须是同一套运行形态，少一条 entry 就会出现
> 「用组合包装的人看不到某个视图」。`packages/void/tests/bundle-parity.spec.ts` 会把组合层与五个包
> 逐条比对（条目集合、id 不重复、每条 `name` 与整块 `config`、相对顺序、依赖覆盖），改任何一边忘了
> 同步另一边都会红。

装组合包还是逐个装单包**效果等价**；但组合包依赖 `@void/void-*` 从 registry 解析，本地还没发布时只能用单包（见 2.4）。

### 3.7 界面入口（void-entry）

`@void/void-entry` 是所有面板功能的落点：设置卡片、HTTP 路由、业务视图注册表、详情渲染器与通知栏。
它自己不懂业务——**视图是各业务包注册进来的**：

| 视图 id | 标题 | 归属 |
|---|---|---|
| `void-soul:profiles` | 灵魂档案 | void-soul |
| `void-soul:facets` | 模组库 | void-soul |
| `void-memory:memory` | 人格记忆 | void-memory |
| `void-legion:teams` | 军团队伍 | void-legion |
| `void-legion:runs` | 军团运行 | void-legion |

**面板里的状态一律说中文**（2026-09-23 定案）：队伍详情的「最近的运行」状态列、运行列表的摘要、运行详情的「状态」字段与任务表的状态列，写的都是中文说法——「在跑 / 已跑完 / 有任务失败 / 已取消 / 被宿主重启中断」「还没轮到 / 已完成 / 失败 / 被上游堵住」。运行详情那一格的下面留着一行小字写着磁盘上的原始值（形如 `磁盘上的原始值：interrupted。`），**原始枚举一个都没丢**：`legion_run` 工具返回与 `<数据根>/legion/runs/<runId>.json` 里仍然是 `running`/`blocked` 这些原值，事件流水那一段也照旧写原始 `kind`（它是诊断流水，后面常跟一句中文说明）。状态值是磁盘上的外部输入，面板遇到不认识的值**照原样显示**，不写「未知」也不留空。（2026-09-23 真机核对：在一份真档案上，运行详情的状态格读出来就是「被宿主重启中断」，下面那行小字写着 `磁盘上的原始值：interrupted。`，同一页任务表的状态列也是中文；磁盘上的 JSON 一个字节没动。）

**面板里的只读区**：顶部每个档案一行「<显示名>的当前角色」，内容是两行只读信息——「已保存：…」与「本次生效：…」（没有进行中的请求时后者写「本次生效：还没有请求」），只带一个「清空已保存角色」按钮，这一区里**没有任何输入控件**。面板里唯一的输入框是插件列表的「搜索插件…」；可编辑字段（显示名 / 头像 / **底线正文** / 会话绑定 / 新建档案 / 模组正文 / 记忆正文）都在各业务视图的详情里，属于允许人类维护的范围；**主人与上下级权限不开放编辑**。

**这两行到底在说什么**（2026-09-23 真机定案）：第一行是**磁盘上已保存的**（选中的模组、名字与摘要；没有选择就写「无模组」），第二行是**这个会话最近一次请求真正装进模型的**那一版。两行不一样时第一行会点明原因和去处——选择刚换过写「，等下一次请求生效」，模组正文刚改过写「，模组正文已改，待下一次请求生效」，底线正文刚改过写「，底线正文已改，待下一次请求生效」，同时第二行后缀「（还是改前那份）」。**改完正文不用重开会话**：下一次请求（同一个会话的下一轮也算）就会用新正文装配——真机上改完正文后同会话第二问的提示词从 1862 字变成 1896 字。第二行只活在本次进程里，宿主重启后没有请求记录，它会照实说「还没有请求」。

**底线正文的人类编辑入口**（2026-09-22 定案）：灵魂档案详情里「底线正文」是一个多行编辑框，旁边还有一个「改动原因」文本框和「回滚底线正文」动作——**改底线不必再去开 IDE**。它和别的字段走的是两条路：

- 写之前先把旧版整份留痕到 `agents/<目录>/history/SOUL-<旧修订>.md`，再往同目录的 `history/soul-log.jsonl` 追加一行（谁改的、什么时候、换掉哪一版、新修订、多少字节、原因）；**回滚本身也留痕**，所以改坏了能滚回去，滚回去之后还能再滚回来。
- 表单是整张提交的，所以**正文逐字没变就不写盘**——不然每次改显示名都会多出一条空留痕；正文真变了，显示名/头像会用**写完之后的新修订**保存。
- 正文为空会被拒（「底线正文不能为空：没有底线的档案取不出派活身份，要清空就先删档案」）；超出插件默认上限（100 000 字符）在写盘前就被拒；留痕日志坏行会明确报错，不会假装「没有历史」。
- 改的只是正文：front matter（`id`/`name`/`owner`/`authority`）一个字节都不动，`id` 与记忆根不变。**模型仍然没有写底线正文的工具**——这条入口只给人用。

**删档案入口**（2026-09-23，落的是 2026-09-22 定案「删档案不删记忆、不删聊天记录」）：档案详情最后是一个危险动作「删除这份档案」，点了不会立刻删——要**再敲一遍档案 id**，还可以写一句备注（会一起记进留痕）。确认之后：

- **搬，不是抹**：档案目录里的 `SOUL.md`、`state.json` 与 `history/` 逐样搬进数据根的 `trash/<时间戳>-<目录名>/`（同一卷上直接 `rename`；跨卷直接拒绝，绝不退化成「复制再删」）；搬空之后目录才被删掉，所以**目录名与档案 id 相同时也不会顺手把记忆搬走**。
- **一个字节都不动的**：记忆目录 `agents/<档案 id>/`（`MEMORY.md`、`memory/`、`memory.sqlite`、`retracted/`，连 sqlite 的字节都算）、DSH 的 `sessions/`（聊天记录）、以及 `runtime/session-bindings.json` 里的绑定。绑定留着，重新建一份同 id 的档案就把那些会话接回来；没接回来之前那些会话取不到身份，会拒绝进模型。
- **留痕**：每删一笔往 `trash/deletions.jsonl` 追加一行 JSON——档案 id、显示名、目录名、从哪搬到哪、留在原地的是什么、删除时间、备注。
- **回执三节**：删了什么 / 什么没动（会报出还绑着几个会话，这就是引用检查）/ 怎么捞回来（把 `trash/<…>/` 里那几样搬回 `agents/<目录>/`，就是原来那份档案，内容与修订都不变）。

这条只管一份**档案**，和「Agent 整体删除」不是一回事（后者仍只做停用 + 引用检查 + 预览回收范围，不做一键递归）。真机核对（隔离 profile 上删一份探针档案）：记忆三份 sha256 与聊天记录 110 个文件**逐字节不变**、绑定文件与删前逐字节相同、回收站恰好一份且含那三样、清单里不再有它，**回收站那份副本也不会被当成一份档案列出来**。

**停用 / 启用一份档案**（2026-09-23，落的是上面那句「Agent 整体删除只做停用 + 引用检查 + 预览回收范围」里的**停用**那半条）：档案详情末尾还有一对动作——当前是启用状态时显示「停用这份档案」，停用之后就变成「启用这份档案」（同一位置二选一，**可逆，不是危险动作**，和上面那条删除要一眼分得开）。停用**只改一个布尔值**：

- **写盘只碰一处**：`agents/<目录名>/state.json` 里的 `suspended` 变成 `true`（老状态文件没有这个字段就是「启用」；值写坏了会报 `停用状态损坏`，不会当成启用混过去）。底线正文、正文留痕、记忆、聊天记录、会话绑定**一个字节都不动**——它不是删除，也不预演删除。
- **效果是下一轮装配就把灵魂段摘掉**：绑定的会话照常能聊，但进模型时不再装底线与角色（走的是「这一轮什么也不装」那条路，**不是沿用上一份**，所以提示词里当场干净），拒绝理由进通知栏「灵魂未生效」——`档案已停用，拒绝进入模型: <档案 id>（在面板上「启用这份档案」就恢复，记忆与聊天记录一个字节都没动）`，同一条原因只报一次；**军团也不会拿它派活**（取派活身份时同样拒绝）。
- **引用检查**：详情里那一节报出还绑着几个会话（连会话 id）、军团里哪支队伍的哪条 lane 引用了它、组织图里**别人**把它写成上级/下级的那些档案（它自己写的上下级在「主人与权限」那一节）。读不了的队伍文件单独报出来——`读不了的队伍文件：legion/teams/broken.json（不是能读的 JSON：…）——这一处不算「没有引用」`，不会因为读不动就当成你没有引用。
- **回收范围预览**：哪些会搬进回收站（`SOUL.md` / `state.json` / `history/`，以及目录名与档案 id 不同名时的档案目录本身）、哪些一个字节不动（记忆、`sessions/`、会话绑定、队伍引用），最后一行写明「这是预览」。目录名与档案 id **同名**时预览只列三样、目录留着——因为记忆就住在那一层。
- **留痕**：每按一次往 `runtime/suspensions.jsonl` 追加一行 JSON（档案 id、显示名、目录名、**停还是启**、时间、备注），面板上能看到最近几次；留痕坏了会点名第几行，不会假装「没有历史」。
- **回执四节**：改了什么 / 什么没动 / 引用 / 回收范围。启用不写原因也放行；启用之后**同一个会话**的下一轮就把底线装回来。

真机核对（隔离 profile 上停/启一份探针档案，40 条断言全绿）：停用前那一轮系统提示 7090 字含底线标记句，停用后同一个会话的下一轮 7047 字、没有底线标记句（会话没被搞崩，真模型照常答话），启用后回到 7090 字；全程 `SOUL.md` 的 sha256 不变、记忆三份与聊天记录 112 个文件逐字节不变、绑定文件逐字节不变、留痕两笔 `true,false` 字段齐全、列表上标着「已停用」。

**HTTP 路由**（读走 `assertSameOrigin`、写走 `assertTrustedMutation`；缺 `Origin` 的本地进程请求放行）：

| 路由 | 作用 |
|---|---|
| `GET /void/api/status`、`POST /void/api/toggle` | 入口总开关 |
| `GET /void/api/panels` | 设置面板 + 业务视图清单 + 通知来源 |
| `GET /void/api/detail?view=<id>&itemId=&q=` | 业务视图的列表 / 单条 |
| `POST /void/api/detail` | 保存或执行视图动作（`op: "save"` 或 `"act"`） |
| `GET`、`POST /void/api/notifications` | 通知栏读取与标记已读 |
| `GET /void/api/facet-versions`、`POST /void/api/facet-selection` | 模组版本与切换 |

**插件开关与依赖**：入口按包切换该包的全部 entry。记忆以灵魂为前置，军团以灵魂和记忆为前置；开军团时缺任一前置会返回 409，关灵魂或记忆时若下游仍在运行，也返回 409 并提示先关哪个插件，**不会暗中连带关闭**。整套开关一次请求交给 Host，关闭顺序为军团→记忆→灵魂，开启顺序相反；未安装所需前置时整套开启会在改动前拒绝。直接编辑 profile patch 不经过这个开关门禁，维护者须自行保证依赖组合一致。开关仅在**本次 dsh 进程**有效，重启不会继承；长期禁用需在用户层 `cordis.patch.yml` 对相应的每条 entry 用 `disabled: true` 覆盖（见 README「开关持久化」），不要改每次启动被重置的根 `cordis.yml`。

**回到 dsh 原 Agent**：只关闭灵魂和记忆**不够**，军团、工具治理、灵榜控制面、渠道等 Void 插件可能仍在影响工具和服务。先结束或取消进行中的军团运行，再用整套开关关闭所有可切换的 Void 插件，并**新开会话**核对系统提示与工具列表；旧会话的聊天历史和落盘记忆不会被开关删除，灵魂段又是登记在旧 Agent 作用域里，停用插件也不能保证旧 Agent 下一轮不再携带它。这样只是接近原生 Agent 的运行行为：不可关闭的 `void-entry` 面板仍装着，且本次开关不持久。需要严格的原生 dsh 环境时，使用未安装 Void 的独立 profile，而不是声称仅关闭两项即完全恢复。以上是源码静态边界，alpha.2 真机开关、进行中运行与旧会话的联动仍需在隔离 profile 验证。

**通知栏**：在状态条下方；浏览器重连或标签页回到前台时会补读断线期间的通知（军团终态就是靠它补的）。当前有两个来源：`void-legion:runs`（军团跑完的终态，落盘、重启后还在）与 `void-soul:refusals`（灵魂没装进模型的原因，只在进程内留最近 50 条、重启即清）。

补读有四条触发路径：页面刚打开、浏览器从断网恢复（`online` 事件）、标签页回到前台（`visibilitychange`）、以及每 15 秒一次的轮询兜底。2026-09-23 真机实测：断网期间跑完并取消的那次运行，恢复网络后 `online` 事件当场就发起读取、**8 毫秒**后未读数就从「没有未读」变成「1 条未读」——不是等下一次轮询；整页刷新后已读/未读照样保持（读状态落在 `<数据根>/legion/notifications.json` 的 `readAt` 上，不是浏览器本地）。

---

## 四、纵向闭环（端到端）

验证过的完整链路（**旧知识层那套**：`dsh --profile demo` + `DEEPSEEK_API_KEY`）：

```
用户发任务
  → dsh agent-loop 领走
  → 模型调用 memory_search 工具
  → ctx.voidMemory.search → MemoryStore(FTS5 + sqlite-vec)（内嵌的 Star 快照）
  → 返回结果给模型
```

> 人格记忆（`/provider` 那套）的链路形状一样，只是落点不同：工具 → `MemoryLibrary` → 该 Agent 的
> `MEMORY.md` / `memory/*.md`，检索走 `memory.sqlite` 的 FTS5（**没有向量**），并且需要数据根
> （`DSH_HOME` + `DSH_PROFILE`，见 2.6）。

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

### Q7：模型说「本机抓取没有配白名单」或「…不在白名单里」

**原因**：`local_fetch` 默认**空白名单＝谁都不放行**（fail-closed），装载期故意不报错；宿主自带的 `web_fetch` 对回环/内网地址是硬拒绝，也没有开关。

**解决**：在 profile 的 `cordis.patch.yml` 里用**同一个 id**（`void-tools-local-fetch`）覆盖，写 `config.allow: [{ host: 127.0.0.1, port: 3080 }]`（同 id 会整块替换 `config`，所以 `maxBytes`/`timeoutMs`/`maxRedirects` 要一起写全，见 3.2）。白名单按「允许模型看这个页面」来写，不要按「这台机器上有什么」来写——写进去的服务，模型就能读它吐出来的任何东西。

### Q8：模型说「工具 launch_legion 属于管理入口，未开放给 Agent，已拒绝」

**原因**：开了入口门禁（`entryPolicy.enabled: true`）之后，凡是不在只读名单里的工具都按「管理入口」拒——军团工具（`launch_legion`/`legion_run`/`legion_output`/`legion_cancel`）正是管理面：派活会真的拉起子智能体、真的花 token，所以默认不让任何档案随手做。

**解决**：给 `void-soul` 那条补 `entryPolicy.allowed`（**同 id 是整块替换 `config`**，`isolation` 等要一起写全）：

```yaml
- id: void-soul
  config:
    entryPolicy:
      enabled: true
      isolation: { readIsolated: false, writeIsolated: true }
      allowed: [memory_write, memory_update, memory_retract, launch_legion, legion_run, legion_output, legion_cancel]
```

`allowed` 是**整个 profile 一份**的名单，不按档案分开——写进去，所有档案都能派活。不想开这个口子就保持拒绝：门禁的默认姿态是「宁可不让 Agent 自己拉队伍」。

**顺带认一下别的症状**（都不是配置问题，2026-09-23 真机派活撞出来的，已修）：`队伍不存在: alpha` 是工具层以前只认内存里的队伍（面板建的队伍在磁盘上）；`cannot get property "subagents" without inject` 是军团取子代理 seam 的方式不对；`派活目标缺少档案 id: lane_front` 与 `成员 lane_front 的汇报对象不在名单里: lane_plan` 是手工计划与队伍名单合并的规则问题（见 3.4）。

### Q9：模型说「工具 write 属于写入入口，需要读隔离执行环境，本机没有，已拒绝」

**原因**：这是入口门禁的**设计行为，不是故障**。门禁把工具按读 / 写 / 执行 / 宿主私人数据 / 管理五类判定，本机（Windows）拿不到读隔离执行环境，所以**写与执行一律拒**，只读工具照常放行。工具**不会从名单里消失**：模型看得见、真调了才拿得到这句中文原因——这是刻意的，静默消失会让模型反复重试一个看不见的工具，静默放行又等于门禁不存在。2026-09-23 真机实测（一个装了门禁的隔离 profile，真模型 + 真凭据）：同一轮里 37 个工具都声明给了模型，`write` 回 `Error: 工具 write 属于写入入口，需要读隔离执行环境，本机没有，已拒绝`，命令行工具（**Windows 上叫 `pwsh`**）回 `Error: 工具 pwsh 属于原始执行入口，需要读隔离执行环境，本机没有，已拒绝`——两条都是正常的工具结果（`isError: true`），不是抛异常也不是卡住；同一份名单里的 `read`/`glob`/`grep` 一个都没被拒。**要注意**：落兜底的「管理入口」还包括 `subagent`/`workflow`/`create_goal`/`update_goal`/`send_message`/`job_kill`/`exit_plan_mode` 这些，开了门禁它们也一起被拒（派活因此只走 `launch_legion`）。

**解决**：想让 Agent 能写文件 / 跑命令，只有三条路：① 换一个真正带读隔离的执行环境（Linux landlock 或 AppContainer 路线），再把 `entryPolicy.isolation.readIsolated` 打开，写与执行会在隔离内放行；② 把工具名写进 `entryPolicy.allowed`（同 id 整块替换 `config`，见 Q8）——但 `allowed` 是**整个 profile 一份**，写进去所有档案都放行，**等于放弃这道门禁**，只在完全信得过的隔离 profile 里这么干；③ 干脆不开门禁（`entryPolicy.enabled` 默认就是 `false`）。日常开发用的 profile 建议就用第 ③ 条：需要「Agent 不许碰本机」时才把门禁打开。**2026-09-23 补（走第 ① 条时的坑，已修）**：以前工具门禁会放行，但底层 shell 服务仍按默认的「没有读隔离」拒掉原始命令（`原始命令缺少读隔离，已拒绝执行`），于是模型看得见命令行工具、却一条命令也跑不起来；现在两道门禁共用同一份判定（`Void/packages/void-soul/src/execution-policy.ts` 的 `isExecutionAllowed`，`allowUnisolated` 也一样两处同时生效），声明了隔离就两层一起放行。顺带记住本机还有**第三层**：隔离声明打开之后命令还会过一次宿主沙箱，本机（Windows）没有可用的沙箱后端（`SetNamedSecurityInfoW failed (Win32 5)`），所以真机上仍跑不起来——那是宿主那一层，不是 Void 这道门禁；这一层的结论要等一台 Linux 机器才能验（见《灵魂记忆与军团》人工清单第 4 条）。

### Q10：模型说「记忆条目正文 不是有效的 UTF-8 文本」或「… 太大，拒绝读入」

**原因**：这是**刻意的 fail-closed，不是故障**。Void 读的每一份正文（档案 `SOUL.md`、模组文件、`MEMORY.md`、日记条目、底线留痕日志）都先按字节做一次 UTF-8 校验再解码：Node 的 `readFile(…, "utf8")` 遇到非法字节**不报错**，只把坏字节换成 `U+FFFD`，于是坏文件会以乱码进模型与面板，没人知道是文件坏了——所以改成先判 `isUtf8`：坏字节与超过 8 MiB（每份正文）都直接拒绝，并给一句带路径、字节数、出错字符位置的中文原因（坏字节那句末尾是「请把文件另存为 UTF-8 再试。」，超限那句是「… 太大，拒绝读入: <路径>（N 字节，上限 M 字节）。」）。拒绝只针对**这一次读**：原文件一个字节都不动，也不会截断。

**解决**：按提示把那份文件用编辑器「另存为 UTF-8」再试即可——**同一个会话的下一轮就会自愈**（每轮装配会重试一次；同一条原因只报一次，文件改动导致原因变了会再报一条，不必换会话或重启宿主）。坏掉的 `SOUL.md` 会让**整份档案**加载失败：该档案的会话装不上灵魂段，通知栏留一条「档案 X 的说明书没装进模型」；坏掉的日记条目在 `memory_list` 里显示成「记忆条目损坏: <条目 id>（…）」，其余条目照常可读。2026-09-23 真机核对过（隔离 profile + 真模型 + 真凭据，11 条断言全绿）：坏条目 / 坏长期记忆 / 坏 `SOUL.md` / 9 MiB 的 `MEMORY.md` 四种都拿到了可读拒绝，四个文件的字节数一个没变；把坏 `SOUL.md` 另存成 UTF-8 之后，**同一个会话**的系统提示从 1827 字回到 1896 字、灵魂段回来。

---

## 六、环境变量与命名空间

| 变量 | 用途 | 说明 |
|---|---|---|
| `VOID_MEMORY_PATH` | **旧知识层**（`/sqlite` 那套）的 SQLite 文件路径 | 缺省 `:memory:`；**人格记忆不用它**——人格记忆的数据根见 `DSH_HOME`＋`DSH_PROFILE` |
| `VOID_FEISHU_APP_ID` / `VOID_FEISHU_APP_SECRET` | 真实飞书渠道凭据 | 缺凭据 fail-closed 抛错，绝不硬编码/回显/落库 |
| `VOID_DSH_CONTROL_TOKEN` | 灵榜控制面机器 token | 只从环境变量读；未设置时所有请求 401 |
| `VOID_DSH_CONTROL_CALLBACK_SECRET` | 灵榜回调 webhook 的 HMAC 共享密钥 | 仅在 `callback.enabled: true` 时需要 |
| `DEEPSEEK_API_KEY` | 跑 headless 任务的模型 key | 仅运行时传入，勿写入仓库 |
| `DSH_HOME` | dsh 数据目录 | 本地开发务必隔离到仓库内，别指向日常 `~/.dsh`（见 2.3 / 2.6） |
| `DSH_PROFILE` | **档案名**（可选的显式覆盖） | 数据根 = `<DSH_HOME>/void-data/<档案名>`；**跑 Web/headless 时通常不必给**——宿主会把档案目录 `<DSH_HOME>/profiles/<名字>/` 交给插件，插件据此认出档案名；显式给了就压过它。三条来源都没有时才回 `404 无法确定档案位置…`（见 2.6 / 13.1） |

其余 Star 语义的 `BELLDANDY_*` 变量（如 `BELLDANDY_STATE_DIR`）在快照里暂保留原样，迁移到 `VOID_*` 属后续补丁。

**灵榜回调 webhook 的验收口径**（2026-09-23 真机核对过：真接收器 ＋ 真密钥，27 个请求全部验签通过）：军团每次终态（跑完 / 有任务失败 / 被取消）都会向 `callback.url` 发一个 POST，四个头分别是 `x-dsh-control-delivery`（等于军团那条通知的 `eventId`，形如 `<runId>#1`，**接收方按它去重**）、`x-dsh-control-event`（`completed` / `failed` / `cancelled`）、`x-dsh-control-timestamp`（Unix 秒）、`x-dsh-control-signature`；签名 = `sha256=` 拼上 `HMAC-SHA256(密钥, "<timestamp>.<原始请求体>")` 的十六进制——**必须拿原始 body 算，先反序列化再拼字符串就对不上了**。接收端回 2xx 才算收到；非 2xx 会按 1s / 2s / 4s… 退避重试到 `callback.maxAttempts`（默认 5，探针里设成 3 实测三次全 500 就收手），累计次数与 `deliveredAt` 都记在 `<数据根>/legion/notifications.json` 的 `delivery` 字段里，所以**重启后会补投没确认过的事件、已经确认过的绝不重投**（真机实测：端点先回 500 时终态后 5 毫秒就首发、只记账；改成 200 重启补投 9/9；再重启零重投）。地址必须落在 `callback.allowedHosts` 里（写 `host:port`，只认 http/https）；打不通或一直回 500 **只影响投递账，不影响军团运行本身**（那次真机运行照常 `completed 2/2`）。body 里只有 `deliveryId`、`eventId`、`runId`、`teamId`、`status`、`finishedAt`、`counts`、`resultRef`——**没有成员产出、没有 SOUL 正文、没有会话记录**。
