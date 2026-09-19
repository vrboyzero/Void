# DSH 工作区指令字节预算（系统提示词上限）——机制与改造手册

> 适用版本：`@deepseek-ai/dsh` **0.1.5-rc.2**（Windows 本机安装与 WSL 侧同为该版本，出厂预设逐字节一致）
> 机器真源：各 agent preset 的 `agent.cordis.yml` 里 `@deepseek-ai/dsh-agent-instructions` 那一行的 `maxBytes`
> 本文件 = 机制说明 + 现状台账 + 以后做同类改造的操作步骤

---

## 1. 一句话结论

初始系统提示词里**"工作区指令"（`AGENTS.md` / `CLAUDE.md`）的注入体积**由 agent preset 的 `agent-instructions.maxBytes` 控制，出厂值 **65,536 字节（64 KiB）**，超出部分会被截断或整文件丢弃——这就是"重要的 AGENTS.md 被跳过"的根因。

本机已把三个**带指令加载**的模式各做了一个 **131,072 字节（128 KiB）** 的副本预设（与 WSL 的 `standard-128k` 做法一致）。

---

## 2. 现状台账（2026-09-17 实测）

| 预设 id | 显示名 | trust | `maxBytes` | 是否挂载 `agent-instructions` |
| --- | --- | --- | ---: | --- |
| `standard` | 标准模式 | system | 65,536 | 是 |
| `ptc` | PTC 模式 | system | 65,536 | 是 |
| `cordis` | 创造模式 | system | 65,536 | 是 |
| `minimal` | 极简模式 | system | —（未声明） | **否** |
| `standard-128k` | 标准模式（大指令预算） | user | **131,072** | 是 |
| `ptc-128k` | PTC 模式（大指令预算） | user | **131,072** | 是 |
| `cordis-128k` | 创造模式（大指令预算） | user | **131,072** | 是 |
| `pwsh-gitbash` | PowerShell + Git Bash（大指令预算） | user | **131,072** | 是 |
| `win-minimal-pwsh` | Windows 极简模式 | user | —（未声明） | **否** |

两条容易踩的推论：

- **极简模式根本没有"上限"问题，因为它压根不做指令注入**——`minimal` / `win-minimal-pwsh` 的 composition 里没有 `agent-instructions` 行，所以这两个模式下 `AGENTS.md` **完全不会加载**。这不是被截断，是没这一步。
- 预算**写在每个 preset 自己身上**，不是全局设置；`settings.yaml` 里没有这个开关。

关于 `pwsh-gitbash`：它是**用户自建**预设（不是出厂文件），所以**在原地把 `maxBytes` 从 65,536 提到 131,072**，而没有另做 `pwsh-gitbash-128k` 副本——自建预设若做副本，以后改主体时副本会静默分叉（详见 §5 步骤 2 的取舍规则）。

---

## 3. 机制（两个旋钮别搞混）

`@deepseek-ai/dsh-agent-instructions` 的配置里有两个字节数，作用完全不同：

| 配置项 | 默认 | 管什么 | 超了会怎样 |
| --- | ---: | --- | --- |
| `maxBytes` | **每个 preset 必填**，出厂 65,536 | **一次渲染批次**的 UTF-8 字节上限 | 截断并插入提示语（见下） |
| `maxSourceBytes` | 1,048,576（1 MiB） | **单个**指令文件的读取上限 | 该文件被**整个忽略**（*larger files are ignored*） |

**「1M 模式」这个说法容易混**：1 MiB 是 `maxSourceBytes`（单文件），不是预算；WSL 那个叫 `standard-128k` 的预设，实际值也是 131,072（128 KiB），不是 1M。

### 批次语义

- **基线批**：`$DSH_HOME/AGENTS.md`（用户全局）+ 项目根 `AGENTS.md`。
- **动态批**：会话过程中读到的子目录 `AGENTS.md`（例如你在仓库里读 `docs/AGENTS.md`、子项目 `AGENTS.md`）。
- 两批**各自**受 `maxBytes` 约束，所以一个长会话累计注入可以接近 2 × `maxBytes`。

### 发现规则

- 从会话 cwd **向上**找含 `projectRootMarkers`（默认 `.git`）的目录作为**项目根**；项目根**之上**的 `AGENTS.md` 不加载。
- 候选文件：`AGENTS.md`、`CLAUDE.md`；本地覆盖：`AGENTS.local.md`、`CLAUDE.local.md`。
- 同目录内**裁剪后内容重复**的条目会去重（`AGENTS.md` 与内容相同的 `CLAUDE.md` 只留最早那个）。

### 截断的可观察现象

注入文本里会出现：

```
Workspace instructions were omitted or truncated to fit the configured byte budget.
```

### 预算的作用边界

`maxBytes` **只管"指令文件"这一段**。系统提示词的其它部分（persona / 工具说明 / runtime context 快照等）不受它约束；模型能装多少上下文仍由模型配置的 `contextWindow` 决定。反过来，一段 1 MiB 的 `AGENTS.md` 即便放开限制也没法用——它会把大半上下文吃掉，所以把预算压在 128 KiB 是合理的工程选择。

---

## 4. 本次落地清单

三个**出厂**预设（`standard` / `ptc` / `cordis`）都是从本机出厂预设**复制、只改一行**，纯新增，未改动任何既有文件；`pwsh-gitbash` 是用户自建预设，**原地改一行**（改动前已备份）：

| 预设目录 | 来源 | 改动 | 文件 |
| --- | --- | --- | --- |
| `C:\Users\admin\.dsh\.agent-presets\standard-128k\` | 复制 `presets\standard` | L34 `65536 → 131072` | `agent.cordis.yml` 12,929 B + `preset.yml` 207 B |
| `C:\Users\admin\.dsh\.agent-presets\ptc-128k\` | 复制 `presets\ptc` | L41 `65536 → 131072` | `agent.cordis.yml` 14,004 B + `preset.yml` |
| `C:\Users\admin\.dsh\.agent-presets\cordis-128k\` | 复制 `presets\cordis` | L35 `65536 → 131072` | `agent.cordis.yml` 14,011 B + `preset.yml` |
| `C:\Users\admin\.dsh\.agent-presets\pwsh-gitbash\` | 用户自建，**原地改** | L33 `65536 → 131072`；显示名加「（大指令预算）」 | `agent.cordis.yml` 13,143 B；备份 `agent.cordis.yml.bak.20260917-190547`、`preset.yml.bak.20260917-190547` |

其中 `standard-128k` 与 WSL 侧 `~/.dsh/.agent-presets/standard-128k/` **逐字节一致**（`agent.cordis.yml` 12,929 B / `preset.yml` 207 B，SHA256 相同）。

**回滚**：

- 副本类：删掉对应目录即可（`Remove-Item -Recurse ~/.dsh/.agent-presets/<id>-128k`）。
- 原地改的 `pwsh-gitbash`：把 `maxBytes` 改回 `65536`（或从同目录 `.bak.20260917-190547` 恢复）。

---

## 5. 以后做同类改造的步骤

1. **定位**
   出厂预设：`<npm 全局>\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-agent-presets\presets\<id>\agent.cordis.yml`
   找这一行并记下值：
   ```yaml
   - id: agent-instructions
     name: '@deepseek-ai/dsh-agent-instructions'
     config:
       maxBytes: 65536
   ```
   如果该 preset 里**没有** `agent-instructions` 行，说明它不加载指令文件，改预算无意义。

2. **选形态：出厂预设做副本，自建预设原地改**
   - **出厂预设**（`presets\<id>` 位于 `node_modules` 内）：**必须做副本**——出厂文件会被 DSH 升级覆盖，不能改原件。复制**本机出厂原件**到用户预设目录（**不要**从别的机器/别的版本直接拷现成预设；本次是先用 diff 确认"与出厂只差一行"之后，才决定从本机出厂文件复制的）：
     ```powershell
     $src = "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-agent-presets\presets\<id>"
     $dst = "$env:USERPROFILE\.dsh\.agent-presets\<id>-128k"
     New-Item -ItemType Directory $dst -Force | Out-Null
     Copy-Item "$src\agent.cordis.yml" "$dst\agent.cordis.yml"
     ```
   - **用户自建预设**（已经在 `~/.dsh/.agent-presets\<id>` 里）：**原地改那一行**，不要做 `<id>-128k` 副本。自建预设是你手工维护的，副本会在你下次修改主体时**静默分叉**（两份内容各自演化，没人知道哪份是当前意图）。原地改前先备份：
     ```powershell
     Copy-Item .\agent.cordis.yml ".\agent.cordis.yml.bak.$(Get-Date -Format yyyyMMdd-HHmmss)"
     ```
     预设目录里的 `.bak` 文件不会被 discovery 读取（它只按固定文件名取 composition / metadata），放在同目录是安全的。

3. **只改 `maxBytes` 一行**（`131072` = 128 KiB）。想更宽就按 2 的幂往上走，但记住 §3 的两条边界。

4. **写 `preset.yml`**（显示名与说明；**不写 `order`** 的预设会排在有 `order` 的之后，用户预设保持不写即可）：
   ```yaml
   name: 标准模式（大指令预算）
   description: 标准模式的副本，仅把工作区指令字节预算由 65,536 提升至 131,072，使 ~/.dsh/AGENTS.md 与项目 AGENTS.md 能同时自动加载。
   ```
   原地改的预设则是在**原有说明后追加预算信息**、显示名加「（大指令预算）」后缀，例如：
   ```yaml
   name: PowerShell + Git Bash（大指令预算）
   description: 在标准模式基础上……其余能力与标准模式一致；工作区指令字节预算由 65,536 提升至 131,072。
   ```
   ⚠️ **只改显示名，不要改预设 id（目录名）**：会话里记录的是 preset **id**（`agentPreset.val`），改 id 会让历史会话的预设引用失效。

5. **校验**（见 §6，用 DSH 自己的发现逻辑，会一并检查"插件包名能否解析"）

6. **生效**：在预设选择器里选新预设。DSH 的 preset discovery 每次调用都重读根目录，所以**不用重启 dsh**；但**已打开的会话能否热切换预设未验证**，稳妥做法是**新开会话**。

7. **回滚**：副本类删目录；原地改的把 `maxBytes` 改回 `65536`（或从同目录 `.bak.<时间戳>` 恢复）。

---

## 6. 校验脚本（可复用）

用 `dsh-agent-presets` 导出的 `discoverPresets` 跑真实发现逻辑：既能确认预设被收录、配置能解析，也能顺带证明"只改了一行"。

```js
// node --input-type=module
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const NPM = 'C:/Users/<you>/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-presets';
const { discoverPresets, SHIPPED_PRESET_ROOT } = await import(pathToFileURL(`${NPM}/lib/index.js`).href);

const root = String.raw`C:\Users\<you>\.dsh\.agent-presets`;   // 用户预设根
const presets = await discoverPresets(
  [
    { path: SHIPPED_PRESET_ROOT, trust: 'system' },            // 出厂预设（system 根）
    { path: root, trust: 'user' },                             // 用户预设（user 根）
  ],
  pathToFileURL('C:/Users/<you>/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/').href, // harnessBase：解析行内包名
);

for (const p of presets) {
  const text = fs.readFileSync(p.path, 'utf8');
  const budget = /maxBytes:\s*(\d+)/.exec(text)?.[1] ?? '(未声明)';
  const mounts = /id:\s*agent-instructions/.test(text) ? 'yes' : 'NO';
  console.log(`${p.id.padEnd(16)} trust=${p.trust.padEnd(6)} broken=${p.broken ?? 'none'} maxBytes=${budget} mounts=${mounts}`);
}

// 证明副本只差一行
for (const [copy, original] of [['standard-128k', 'standard'], ['ptc-128k', 'ptc'], ['cordis-128k', 'cordis']]) {
  const a = fs.readFileSync(`${root}/${copy}/agent.cordis.yml`, 'utf8').split('\n');
  const b = fs.readFileSync(`${NPM}/presets/${original}/agent.cordis.yml`, 'utf8').split('\n');
  const diffs = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) if (a[i] !== b[i]) diffs.push(`L${i + 1}: "${b[i] ?? '<EOF>'}" -> "${a[i] ?? '<EOF>'}"`);
  console.log(`${copy}: 差异 ${diffs.length} 处 ${diffs.join(' | ')}`);
}
```

判定标准：每行 `broken=none`（说明 composition 形状 + 行内插件包名都能解析）、`maxBytes` 符合预期、副本差异恰为 1 处。

### 怎么确认"当前会话到底注入了多少、有没有被截"

- **看上下文**：如果 `~/.dsh/AGENTS.md` 的**末行**出现在你收到的系统提示里，说明它是完整注入的（本次核查就是这样确认 18,007 B 全量进入）。
- **算体量**：`$DSH_HOME/AGENTS.md` + 项目根 `AGENTS.md` 的字节和，与 `maxBytes` 比。注意项目根是"从 cwd 向上第一个含 `.git` 的目录"，根**之上**的 `AGENTS.md` 本来就不该加载。
- **找截断标记**：上下文里搜 `omitted or truncated`。

---

## 7. 陷阱清单

1. **`maxBytes` ≠ 模型上下文上限**。它只管指令注入这一批；上下文由模型的 `contextWindow` 决定。
2. **只提 `maxBytes` 并不能让超大 `AGENTS.md` 生效**：单文件还有 `maxSourceBytes`（默认 1 MiB）硬门槛，超过就整个忽略。而且按本机约定，指令文件应控制在 128 KiB 内——1 MiB 的指令会把上下文吃掉大半，等于没法干活。
3. **别跨版本/跨平台直接拷预设文件**。DSH 升级后出厂 preset 会变；正确做法是"从本机出厂预设复制 + 只改那一行"，并用 §6 的 diff 证明只差一行。
4. **升级 DSH 后要复核**：`-128k` 副本不会自动跟随出厂预设更新。升级后重跑 §6，必要时删掉副本重新生成。
5. **极简模式（`minimal` / `win-minimal-pwsh`）不加载 AGENTS.md**，别指望在那里看到全局规则。
6. **`order` 语义**：`preset.yml` 里不写 `order` 的预设排在有 `order` 的之后（出厂四个是 1~4）。
7. **生效范围**：预算按 preset 生效，且**新会话**才稳妥；当前已开会话仍跑在它启动时选的预设上。

---

## 8. 证据索引

| 结论 | 出处 |
| --- | --- |
| 出厂三预设 `maxBytes: 65536` | `…\dsh-agent-presets\presets\{standard,cordis,ptc}\agent.cordis.yml`（L34 / L35 / L41） |
| 字段语义（批次 vs 单文件） | `…\dsh-agent-instructions\lib\types\config.d.ts`（`maxBytes` / `maxSourceBytes` 注释） |
| 截断提示语原文 | `…\dsh-agent-instructions\lib\index.js` `COMPACT_WORKSPACE_CONTEXT_INTRO` |
| 发现规则默认值 | 同包 `lib\index.js`：`DEFAULT_PROJECT_ROOT_MARKERS = ['.git']`、`DEFAULT_INSTRUCTION_FILE_CANDIDATES`、`DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES`、`DEFAULT_MAX_SOURCE_BYTES = 1048576` |
| 预设发现/健康检查 API | `…\dsh-agent-presets\lib\index.js` 导出 `discoverPresets` / `SHIPPED_PRESET_ROOT` |
| 用户预设根 | `…\dsh-agent-presets\lib\types\discovery.d.ts` `USER_PRESET_DIR = ".agent-presets"` |
| 本机现状台账 | §2，2026-09-17 用 §6 脚本实测 |
