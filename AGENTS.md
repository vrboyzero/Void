# AGENTS.md — Void（虚空寄生套件）

项目级规则，作用于本仓库下的一切工作。补充 `~/.dsh/AGENTS.md`（全局规则）与
`自动化持续开发规则.md`（持续开发闭环）；冲突时以本文件为准。

**做插件相关的事之前，先读 [`README.md` 的「DSH 插件开发要点」](README.md#dsh-插件开发要点官方契约--实测)**
——那里有平台模块表、证据和每个结论的取得方式。本文件只放**动手时要照着做的规则**，和**查不出来的坑**。

---

## 1. 版本前提

**`dsh --version` 报的不是插件契约版本。** 它报的是 CLI 外壳（`0.1.5-rc.1`），而外壳的
dependencies 用的是脱字号范围 `^0.1.5-rc.1`，pnpm 实际装进来的运行时包**全都是 `0.1.5-rc.2`**。
契约由运行时包定，不由外壳定。查真正的版本：

```powershell
$d = "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh"
dsh --version                                                                   # 外壳，别拿它当契约
(Get-Content "$d\node_modules\@deepseek-ai\dsh-web-frontend\package.json" -Raw | ConvertFrom-Json).version  # 客户端契约 ← 最关心这个
(Get-Content "$d\node_modules\@deepseek-ai\dsh-settings\package.json"     -Raw | ConvertFrom-Json).version  # 宿主契约
(Get-Content "$d\node_modules\@deepseek-ai\cordis\package.json"           -Raw | ConvertFrom-Json).version  # 装的是 4.0.2
```

**`dsh-client-ui-primitives` 与 `dsh-client-ui-slots` 磁盘上不存在**——它们只活在前端 bundle 的
冻结模块表里，所以取不到本地副本，生成器只能用 `npm pack` 按版本号去 npm 取。

仓库 devDependencies 里的 `@deepseek-ai/dsh-*@0.1.0-rc.6` 只用于构建测试，**不是部署对象**。
`deepseek-harness-master/` 是官方源码快照 **0.1.0-rc.5**——**版本线又不同**。

宿主处于开发者预览，官方明说会有破坏兼容性的变更。**契约数字一律现查现核**：本地快照没有的
东西，不等于宿主不支持（`installSection` 就是这样——rc.2 安装包里已有，rc.5 快照里还没有讲它
的文档）。

## 2. 插件契约

**平台模块表是版本相关的，且已经变过一次。** 客户端 bundle 只能 `require` 表内模块，表外直接
抛错。完整对照表与核查命令见 README；改插件前先核。

**宿主提供的模块必须写进 `tsdown.config.ts` 的 `external`。** 漏一个的后果不是报错，而是
**静默 bundle 进一份副本**——同一个 React 两份实例，hooks 全线失效，症状离原因很远。

客户端 bundle 是 lazy-CJS factory（`window.__ModuleLoader__.load({id, factory})`），模块体副作用
只在 factory 调用时执行。官方明说外部包得自行复刻这个输出格式，所以手写 banner/footer 是必然。

`dsh.client.inject` 是**仅供参考**的包名依赖边（预检展示、HMR 差分）。激活顺序只由 cordis fiber
等待**服务**决定。

UI 组合只有一条路：`ctx.slots.register`。进一个未声明的 slot 是错误——用
`ctx.slots.inject(name, () => ctx.slots.register(...))`，它等服务声明、随声明塌陷回收、随调用方
fiber 一起走。**组件拿不到 `ctx`**，数据与回调全走 props。

**有 `cordis.yml` entry 的设置命名空间，用官方 `ctx.settings.installSection()`**，配
`ctx.inject(['settings'], ...)` 拿响应式 attach/detach。它内置 entry 作 base 层与 provider 缺失时
的回落。手搓 `register` + `ctx.get('settings')` 探测的差别在响应式：探测只在 apply 时做一次，
provider 后挂载就永远不被采纳。`onChange` 在 attach / detach / 提交时**都**触发，detach 那次对
快照类派生数据是必要的。

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

**重装必须 `remove` 再 `add`。** 同名同版本的 tarball 会被复用，只打印 "Already up to date"。

**开关写用户层 `cordis.patch.yml`，不写 `cordis.yml`。** `prepareProfile` 每次启动把后者重置为
`[]`。用户层 patch 在栈最后、覆盖 bundle 送进来的 entry，而且**被 HMR 监视、免重启生效**——前提
是 profile 的 `patchReload === "live"`（`web` 是 `live`，`acp`/`headless`/`sdk` 是 `startup`）。
实测运行中写 `disabled: true`，2 秒内端点 404。

**`pnpm -r test` 之外还要真机验证。** 测试替身是自己写的，会跟着一起错。

## 4. 依赖陷阱

`@deepseek-ai/dsh-client-ui-primitives@0.1.5-rc.2` 的 peer 是 `@deepseek-ai/cordis@^4.0.2`，而本
workspace 固定在 **4.0.1**。装进 `node_modules` 会让 pnpm 提升既有包的 peer，使 `void-tools` /
`void-legion` / `void-memory` 报 `does not provide an export named 'CallId' / 'isJsonValue'`。

**它的类型靠 `npm pack` 取、按用法生成 ambient 声明。** `packages/void-entry/src/client/primitives.d.ts`
是生成物：改用法后跑 `pnpm run gen:primitives`，`pnpm run check:primitives` 校验。

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

**正式 profile 安装**：先留回滚点（`package.json` 与 `cordis.patch.yml` 各备一份），再
`remove` → `add`。**用户自己写在 `cordis.patch.yml` 里的内容保持原样**（那里有
`mcp-chrome-devtools`、`mcp-unity`）。

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

`deepseek-harness-master/`，**注意版本线不同**（§1）：

| 想知道 | 读 |
|---|---|
| 扩展点归属（新行为该挂哪） | `docs/architecture.md` 的「新行为的归属位置」表 |
| 加设置卡片 | **本地快照没有**（rc.5 之后才加）：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-settings-card.zh.md> |
| 扩展插件形态 | `docs/cookbook/extension-cookbook.md` |
| Web 客户端规范 | `packages/client/AGENTS.md` |
| 客户端模块系统 | `packages/client/modules/README.md` |
| 平台模块表 | `packages/client/web/src/platform.ts` |
