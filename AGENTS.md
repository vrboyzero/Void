# AGENTS.md — Void（虚空寄生套件）

项目级规则，作用于本仓库下的一切工作。补充 `~/.dsh/AGENTS.md`（全局规则）与
`自动化持续开发规则.md`（持续开发闭环）；冲突时以本文件为准。

**做插件相关的事之前，先读 [`README.md` 的「DSH 插件开发要点」](README.md#dsh-插件开发要点官方契约--实测)**
——那里有平台模块表、证据和每个结论的取得方式。本文件只放**动手时要照着做的规则**，和**查不出来的坑**。

---

## 1. 版本前提

**`dsh --version` 报的不是插件契约版本。** 它报的是 CLI 外壳（`0.2.0-rc.2`），而外壳的
dependencies 用的是脱字号范围，pnpm 实际装进来的运行时包**与外壳同版**（`0.2.0-rc.2`）。
契约由运行时包定，不由外壳定。查真正的版本：

```powershell
$d = "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh"
dsh --version                                                                   # 外壳，别拿它当契约
(Get-Content "$d\node_modules\@deepseek-ai\dsh-web-frontend\package.json" -Raw | ConvertFrom-Json).version  # 客户端契约 ← 最关心这个
(Get-Content "$d\node_modules\@deepseek-ai\dsh-settings\package.json"     -Raw | ConvertFrom-Json).version  # 宿主契约
(Get-Content "$d\node_modules\@deepseek-ai\cordis\package.json"           -Raw | ConvertFrom-Json).version  # 装的是 4.0.4
```

**`dsh-client-ui-primitives` / `dsh-client-ui-slots` / `dsh-client-store` 自 0.1.7 起随宿主
落到磁盘了**（0.1.5 时它们只活在前端 bundle 的冻结模块表里）。所以生成器默认**直接读本机已装的
那份**，不再按钉死的版本号去 npm 取——见 §4。仍然只在模块表里的只剩 `dsh-client-ui-dockkit`。

> **别把「版本号没变」当安全信号。** 0.1.6 → 0.1.7 平台模块表一项没动，插件却全白屏：变的是表内
> 模块的**具名导出**（图标从 `Icon<字形>14/16` 改名成 `Icon<字形>Regular/Medium`）。详见 §2.1。

仓库 devDependencies 里的 `@deepseek-ai/dsh-*@0.1.0-rc.6` 只用于构建测试，**不是部署对象**。
`参考项目/` 下有两份官方源码快照：**`deepseek-harness-dsh-v0.2.0-rc.2/`（与当前宿主同版）**
和 **`deepseek-harness-dsh-v0.1.7-rc.2/`**（上一版）。**两份都值得留**——查「宿主什么时候改的」
就差这一份，2026-10-03 核 `ShellExecutor` 的 `run` 就是靠两版对照定位的（见 §3）。
> 2026-10-03 核过：`参考项目/deepseek-harness-dsh-v0.2.0-rc.1/` 与 `参考项目/deepseek-harness-master/`
> **两个路径都不存在**（旧笔记里的写法已作废，别再照它找）。

**dsh 大版本升级后，第一件事查所有 peer 范围。** 0.2.0 起宿主逐包检查 `peerDependencies` 里的
`@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`，不满足的包**整包不加载**，只在 stderr 留一行
`dsh: skipping profile bundle`——界面上只看到「插件凭空消失」。

- **`peerDependenciesMeta.optional` 不豁免**：判定只看 `peerDependencies` 的键值。
- **只查 `@deepseek-ai/dsh*`**：`cordis`、`react`、`@void/*` 不看。
- 范围一律写 `>=0.1.x-rc.n <0.3.0-0`，**不要用 caret**——0.x 上的 `^` 等于 `<0.2.0`，正是这次四个包
  被跳过、插件「无法调用」的原因。`<0.3.0-0` 让 0.3 处强制重新验证。
- **要改就改全仓，别只改「正在用的那几个」。** 2026-09-29 那次只改了 5 个包，漏掉 `void-tools` /
  `void`（组合 bundle）/ `void-seam-demo`；两周后在 0.2.0-rc.2 上它们照样被整包跳过
  （`dsh: skipping profile bundle "@void/void-tools"`）。一条命令查全：
  `Select-String -Path packages/*/package.json -Pattern '"@deepseek-ai/dsh[^"]*": "\^'`
- 逃生门 `dsh plugin allow-version <包@版本> --profile <p> --dsh-version <精确版本> --accept-risk`，
  写进 `profiles/<p>/compatibility.json`，键是精确 `name@version`。**只用于临时验证，不留生产。**
- 不重启宿主也能查：用宿主自带的 semver 复刻 `plugin-compatibility.ts` 的判定，扫 profile 的
  `node_modules/@void/*/package.json`。详见 README §1.2。

**升级后插件不动，先怀疑门禁，再怀疑代码。** 0.2.0-rc.1 那次代码一行未改：平台模块表 9 项未变，
`dsh-client-ui-primitives` 只把 `Button` 从函数改成 `ForwardRefExoticComponent`、给 `DisclosureRow`
加了几个可选 prop。**rc.1 → rc.2 同样零改动**：声明重生成后差异只有 `DisclosureRow` 的注释，和
**`Input` 也从函数变成了 `ForwardRefExoticComponent`**——同一类变形。

> **它之所以不炸，是因为 `PRIMITIVE_GAPS` 的判据是 `hostExports[name] === undefined`，不是
> `typeof === 'function'`**（见 §2）。把它改成后者，这两次升级都会把整个设置面板打白。

宿主处于开发者预览，官方明说会有破坏兼容性的变更。**契约数字一律现查现核**：本地快照没有的
东西，不等于宿主不支持。反过来说——**快照里有的，也可能已经没了**：`installSection` 在 0.1.7
的安装包里存在、旧快照里还没写文档，到 0.2.0 就被整个删掉了。**已装的那一份才是契约。**

## 2. 插件契约

**平台模块表是版本相关的，且已经变过一次。** 客户端 bundle 只能 `require` 表内模块，表外直接
抛错。完整对照表与核查命令见 README；改插件前先核。

**模块能解析 ≠ 里面的具名导出还在。** 宿主改名一个导出，`import` 拿到的就是 `undefined`；
把它交给 React 渲染抛的是「element type is invalid」，而**被打掉的是整个 slot 条目**——用户看到
的是整块面板全白，不是少一个图标。0.1.7 的图标改名（`Icon<字形>14/16` → `Icon<字形>Regular/Medium`，
尺寸改为 `size` prop）就是这么炸的。

三道防线，缺一道都会再炸：**打包前** `pnpm run check:primitives`（已接进 `pack-all.ps1` 第 1 步）、
**提交前** `tests/primitives.spec.ts`、**运行期** `safeIcon()`。改任何宿主原语用法后，先跑
`pnpm run gen:primitives` 再跑 `pnpm run check:primitives`。**图标一律经 `safeIcon()` 在模块作用域
解析一次**，不要裸用；也不要把它改成 `typeof x === 'function'` 判据（宿主的 `DisclosureRow` 在
0.1.7 是 `MemoExoticComponent`，是对象不是函数，会被误杀成空白）。

**宿主提供的模块必须写进 `tsdown.config.ts` 的 `external`。** 漏一个的后果不是报错，而是
**静默 bundle 进一份副本**——同一个 React 两份实例，hooks 全线失效，症状离原因很远。

客户端 bundle 是 lazy-CJS factory（`window.__ModuleLoader__.load({id, factory})`），模块体副作用
只在 factory 调用时执行。官方明说外部包得自行复刻这个输出格式，所以手写 banner/footer 是必然。

`dsh.client.inject` 是**仅供参考**的包名依赖边（预检展示、HMR 差分）。激活顺序只由 cordis fiber
等待**服务**决定。

UI 组合只有一条路：`ctx.slots.register`。进一个未声明的 slot 是错误——用
`ctx.slots.inject(name, () => ctx.slots.register(...))`，它等服务声明、随声明塌陷回收、随调用方
fiber 一起走。**组件拿不到 `ctx`**，数据与回调全走 props。

**插件配置表单在 0.2.0 改由入口的 `Config` 派生，不再有 `installSection`。** 0.1.x 用的是
`ctx.settings.installSection(...)` 自声明命名空间——**那个 API 已被删除**。现在的规则：

- **表单只暴露 `Config` 里标了 `.volatile()` 的字段。** 一个都没有 → 这个入口**整个不进
  `describe()`**，面板能渲染却永远写不进去。启动项（`enabled`/`path`/`transport`/`ledger`）
  **不要**加 volatile：加了会被当成热改，不加则自动从表单消失（由面板只读区展示）。
- **命名空间 = 组合入口 id，不是插件名。** 必须与 `cordis.patch.yml` 里那条 `id:` 一致。
  两边各写一份字符串的漂移**表现就是「点保存没反应」**——抽到共享常量里，别写两遍。
- **volatile 字段解析出来是 `Volatile<T>` 引用**（`get()` 取当前值，无订阅；宿主就地更新）。
  变更通知走 `ctx.on('settings/document-updated', (ns, rev) => …)`，先按 `ns` 过滤。
- **`Config` 的 schema 注解写 `z<any, Config>`，不要写 `z<Config>`。** volatile 字段的输入面是
  裸形状、输出面是 `Volatile<T>`，单参形式要求两者相同，必然对不上。
- **跨字段校验没有写入钩子**，只能放在读取点。这是 0.2.0 的既成取舍：坏值先存下、用时才炸。
- **因此每个读配置的地方要么在有 try 的请求路径里，要么自己挂 `catch`。** fire-and-forget 地读
  （`void refresh()` 这种）一旦让拒绝逃逸，dsh 的 `installFailLoud` 会判成致命加载失败并
  `proc.exit(1)`——**用户在面板填错一个值就能让宿主退出**。漏一个就是一条这样的路径。
- **`MessageSourceMap` 要自己声明成员**（declaration merging，`kind` 用插件名）。0.2.0 删掉了通用的
  `'plugin'` 成员；不声明是编译期错误，不是运行时错误。

**面板侧的配套**：控件必须接收 `disabled`（设置视图缺失时要禁用），否则用户能改、草稿能攒、
横幅能出现，但 `save()` 因为 `view === undefined` 静默返回——**零请求、零报错**，极难排查。

**设置卡片是「暂存 + 保存」：输入只进草稿，用户点保存才写入。** 以草稿读取时的 revision 设栅；
保存失败保留草稿；字段不接受的草稿**阻塞保存**（`saveBlockers`）；值是否被接受由 Host 裁判。
实现在 `packages/void-entry/src/client/draft.ts`，测试直接喂它纯函数。

**草稿留在上层，控件保持无状态。** 控件再攒一层本地草稿 + 失焦提交，会让「改完立刻点保存」
提交改动前的值——这个 bug 犯过两次（列表编辑器、文本/数字控件）。

密钥值用 `role('secret')`：值不出现在响应里，控件初始为空、只报告是否已配置，值经 credentials
领域写入。现在没有 secret 字段（`tokens[].tokenEnv` 存的是变量名）。

## 3. 查不出来的坑

**`pnpm pack` 不编译。** 它把现成的 `lib/` 打进 tarball，所以漏了构建就是打出一个旧包——命令
成功、产物是旧的。打包前先构建。

**`void-dsh-control` 有独立构建链。** 它被 `pnpm-workspace.yaml` 排除（绕开 §4 的 peer 陷阱），
所以 `pack-all.ps1` 管不到它、`pnpm -r test` 也不含它的测试。改完它另跑
`scripts/pack-lingbang.ps1`。`pack-all.ps1` 末尾会比对时间戳——**看到 `[!]` 就说明你要打旧包**。

**`tsc` 不删孤儿产物。** 删了源文件，`lib/` 里那份照旧躺着（`tsc` 只写、不清理），而
`pnpm pack` 把整个 `lib/` 打进包——**等于把已删的实现一起发出去**，而且下次搜那个符号还会搜到
一份「活着的」旧代码。删源文件后按相对路径自查（别只比文件名、别漏子目录）：

```powershell
$p='void-soul'; $s="packages/$p/src"; $l="packages/$p/lib"
$src=Get-ChildItem $s -File -Filter *.ts -Recurse | ? Name -notlike '*.d.ts' |
  % { $_.FullName.Substring((Resolve-Path $s).Path.Length+1) -replace '\.ts$','' }
Get-ChildItem $l -File -Filter *.js -Recurse |
  % { $_.FullName.Substring((Resolve-Path $l).Path.Length+1) -replace '\.js$','' } |
  ? { $_ -notin $src }
```

> 2026-10-03 全仓扫过：`void-soul` / `void-memory` / `void-tools` **干净**；**`void-legion` 1 个**
> （`lib/authority-gate.js`，源文件已删、全仓 0 引用，2026-09-22 的旧产物）、**`void-entry` 19 个**
> （`lib/client.js` 与 `lib/types/client/*.js`，客户端改由 tsdown 出 `dist/` 之前的遗留）。
> 两个包都在正式 profile 里，**待处理**。

**重装要 `remove` → 删目录 → `add`，三步缺一不可。** 正式 profile 的 `pnpm-workspace.yaml` 是
`nodeLinker: hoisted`——包是**拷贝**进 `node_modules`，不是软链，也没有 `.pnpm` 虚拟存储。目录已存在
时 pnpm **不重写它，只报成功**；`@void/void-soul` 还被 `pnpm.overrides` 钉住、同时是 `void-memory` /
`void-legion` 的依赖，所以 `remove` 之后目录仍在、`add` 直接复用旧内容。

```powershell
dsh plugin --profile web remove "@void/<包名>"
# 把 node_modules\@void\<包名>\ 扔进回收站 —— 不删的话下面这步等于没做
dsh plugin --profile web add "<dist>\<tarball>"
```

2026-09-27 实测：只做 `remove`+`add`，**连报四次成功都没生效**（装进去 19365 B，tarball 是 20724 B）。
换新文件名也没用（`add` 改的根 specifier 被 `pnpm.overrides` 覆盖回旧路径）。lockfile 里的 `integrity`
与 tarball 的 sha512 逐字节相符，**不是 lockfile 陈旧**——别再往那个方向查。

装完**按内容核对**，不要看命令有没有报错：查文件大小，或 `Select-String -SimpleMatch` 找一个新符号。

**开关写用户层 `cordis.patch.yml`，不写 `cordis.yml`。** `prepareProfile` 每次启动把后者重置为
`[]`。用户层 patch 在栈最后、覆盖 bundle 送进来的 entry，而且**被 HMR 监视、免重启生效**——前提
是 profile 的 `patchReload === "live"`（`web` 是 `live`，`acp`/`headless`/`sdk` 是 `startup`）。
实测运行中写 `disabled: true`，2 秒内端点 404。

**别把「门面插件」塞进另一个门面 profile 的 bundles。** 包一旦被 dsh 当作 bundle，它就可能自带
一整套 profile 组合（`package.json` 的 `dsh.bundle.patch`）。实测：把 `@deepseek-harness-tui/dsh-tui`
（自称「dsh-base 之上的**交互式终端门面**」，patch 里写着 rows 会**按 id 覆盖 base 行**）加进 `web`
的 `dsh.profile.bundles`，`dsh web` 起来的就是 **TUI 而不是 web 服务**——**token 那一行永远不会打印**
（web app 压根没启动），终端也被 TUI 占住，人只会以为插件坏了。它的正确用法是**装进它自己的 profile**
（`dsh plugin --profile dsh-tui add …`；`dsh-tui` 与 `dsh --profile dsh-tui` 等价），两者互不干扰。

> 判断办法：看 `package.json` 有没有 `dsh.bundle`。**有 = 可能改门面，别随手塞进别人的 profile。**
> `void-soul` 这类是普通插件（只献服务、面板、提示词段），塞进 `web` 是对的。
>
> 顺带：这类 TUI 的逃生键是 **`Ctrl+C` 连按两下**（第一次取消当前任务，再按一次才强制退出，见它的
> `dsh-adapter/channel/input-actions.js` 注释）；README 不写这条。出不来就关掉终端窗口，或另开终端
> `Get-Process node | Where-Object { $_.CommandLine -like '*dsh-tui*' } | Stop-Process -Force`。

**包装宿主服务时，别用 `if (!service?.method) return;` 静默跳过。** 宿主改掉一个服务的方法名
**不会报错**——包装装不上，那道门禁就没了，而且一声不响。2026-10-03 实测：`void-soul` 的底层
shell 门禁包的是 `shell.run` / `shell.start`，而 `ShellExecutor`（快照 `v0.1.7-rc.2` 与 `v0.2.0-rc.2`
都一样）**只有 `resolve` + `execute`**——`run` 在 alpha.2 还有（当时的探针断言过 `typeof shell?.run
=== 'function'` 并通过），之后被宿主去掉，`plugin.ts` 里那句 `if (!shell?.run) return;` 于是把一道
**安全门禁变成了空操作**，直到查执行面才发现。

> **判据**：包装对象上方法不存在时，**要么抛、要么至少留一条日志**——静默 return 等于对外宣称
> 「门禁已装」而实际没有。
>
> **测试替身要照真实服务面的形状写。** 宿主自己的测试里 `run` / `start` 也只是文件内的局部辅助
> 函数（`async function run(x: { execute(spec)… }, spec)`），**不是服务方法**——照抄它就会写出一个
> 自带 `run` 的假服务，测试全绿而门禁从来没装上。这是「测试替身跟着一起错」最贵的一次。

**`pnpm -r test` 之外还要真机验证。** 测试替身是自己写的，会跟着一起错。

## 4. 依赖陷阱

`@deepseek-ai/dsh-client-ui-primitives@0.1.7-rc.1` 的 peer 是 `@deepseek-ai/cordis@~4.0.4`，而本
workspace 固定在 **4.0.1**。装进 `node_modules` 会让 pnpm 提升既有包的 peer，使 `void-tools` /
`void-legion` / `void-memory` 报 `does not provide an export named 'CallId' / 'isJsonValue'`。
宿主升级会抬这个 peer 范围，**每次升级重新确认，但结论一直是「不要装」**。

**它的类型靠按用法生成 ambient 声明，绝不装包。** `packages/void-entry/src/client/primitives.d.ts`
是生成物：改用法后跑 `pnpm run gen:primitives`，`pnpm run check:primitives` 校验。
生成器**默认读本机已装的宿主**（不再按钉死的版本号去 npm 取），`--check` 已接进 `pack-all.ps1`
第 1 步——宿主升级后忘了重跑，打包会失败。

## 5. 类型检查有三层

根 `tsconfig.base.json` 设了 `skipLibCheck: true`，ambient 声明里的悬空类型引用与非法修饰符
**全部静默通过**——已经因此漏过两个真缺陷（漏声明 `ButtonVariant`；生成出 `export declare function`，
在 `declare module` 里非法）。

`packages/void-entry` 的 `typecheck` 第三层 `tsconfig.client.strict.json` 只做一件事：
`skipLibCheck: false`。这是那两类错误的唯一防线。

## 6. 验证与安装

改插件后的真机验证装进**隔离 `DSH_HOME`**（`.tmp/void-entry-p1`，profile `entry`，端口 3699），
别拿日常 profile 做实验。装完看**终端有没有插件的报错横幅**，前端用真机操作验证（合成事件会被
React 的 value tracker 吃掉，需要时用真实键盘输入）。

**写探针脚本的三条**（`.tmp/live-signal/` 下那些 `*-live.mjs`）：

- **import `dsh/lib/profile-boot.js`（稳定转发），不要 import `profile-boot-<hash>.js`。** 宿主一升级
  那个哈希就变，老探针直接 `ERR_MODULE_NOT_FOUND`——2026-10-03 从 rc.1 升到 rc.2 时踩到过一次。
- **先看隔离 profile 里 `node_modules/@void/*` 是哪一种链接**（`Get-Item … | Select-Object LinkType`）。
  是 **junction 指向源码**就不需要重装，`pnpm --filter @void/<包> build` 之后直接生效；是 hoisted
  拷贝才要走 §3 的 `remove → 删目录 → add`。
- **探针必须幂等，而且不能破坏现场。** 角色选择是**档案级持久状态**（`agents/<id>/state.json`），
  上一轮跑剩的修订号会让下一次「切模组」当场撞 409，后面全部错位；每次显式写回一份干净状态。
  改写档案/模组文件前先备份，收尾比对哈希证明「一个字节都没动」。
- **别把「挂 `system-prompt/assemble` 瀑布记哈希」当成万能的观测面。** 2026-10-03 实测到它骗人一次：
  直接改盘上档案/模组正文之后，记录下来的三行内容停在一拍之前（行的时间戳恰好等于该轮发问的那一刻），
  而模型逐字引用出来的是新正文；**等 5 秒也没有迟到的行**，所以不是 `announce()` 不 await 造成的滞后，
  而是那个瀑布在这条路上根本没记到模型真正收到的那一份。
- **判据落到模型嘴里：让它把含特征串的行原样抄出来。** 这是唯一不会骗人的观测面——正文里塞一个它
  算不出来的串（比如围栏的 `<<VOID-FACET-BEGIN:sha256前16位>>`），它能一字不差抄出来，就证明确实进了
  提示词。问法要死：**「凡是出现 X 或 Y 的地方，把所在的整行逐字抄出来」**；问「某段落写了什么」会被
  它按自己的理解分段（实测同一个提示词，问「身份段落写了什么」它答「没有」，问「抄含 `E2E-EDIT-` 的行」
  它就正确抄出来了）。

**正式 profile 安装**：先留回滚点（`package.json` 与 `cordis.patch.yml` 各备一份），再
**`remove` → 删目录 → `add`**（见 §3，只做前两步会静默装不上）。**用户自己写在
`cordis.patch.yml` 里的内容保持原样**（那里有 `mcp-chrome-devtools`、`mcp-unity`）。
装完**按内容核对**，别信命令的成功输出。

## 7. 工作流

1. **每完成一个环节就回写进度**到对应方案文档（`docs/灵榜会话功能实现方案计划.md`、
   `虚空寄生实施方案计划.md`）——中途中断会丢进度。
2. 回写**带证据**：实测数据、命令输出、版本号、出处 URL。
3. 需要人工测试的环节先写进文档，开发完成后再交给开发人员。
4. 技术债按 `~/.dsh/AGENTS.md` §9 显式决策（`fix_now` / `defer` / `split_task` / `record_only`）。
5. **不确定就标注不确定**，附最小验证步骤。

## 8. 文件与提交

- 删除走回收站；操作盘符根目录需先确认路径解析正确。
- **`pnpm-lock.yaml` 是跟踪文件，依赖变化时随提交更新**（历史提交一直如此，pnpm workspace
  靠它复现安装）。
- 提交格式 `type: subject`，一次一件事，正文写清**为什么**和**怎么验证的**。
- 面向 agent 的文档用中文；代码标识符与注释按仓库既有风格。

## 9. 官方文档在哪

`参考项目/deepseek-harness-dsh-v0.2.0-rc.2/`（**与当前宿主同版**；查旧行为用同级的
`deepseek-harness-dsh-v0.1.7-rc.2/`）：

| 想知道 | 读 |
|---|---|
| 扩展点归属（新行为该挂哪） | `docs/architecture.md` 的「新行为的归属位置」表 |
| 加设置卡片 | **本地快照没有**（rc.5 之后才加）：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-settings-card.zh.md> |
| 扩展插件形态 | `docs/cookbook/extension-cookbook.md` |
| Web 客户端规范 | `packages/client/AGENTS.md` |
| 客户端模块系统 | `packages/client/modules/README.md` |
| 平台模块表 | `packages/client/web/src/platform.ts` |
