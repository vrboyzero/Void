# @void/pstack

把 [pstack](https://github.com/cursor/plugins)（Cursor 官方插件仓库里的一个 agent 工作流技能集，作者 Lauren Tan，MIT，快照版本 `0.15.27`）搬到 DeepSeek Harness。

pstack 几乎没有代码。它是一套「组织 agent 怎么理解、设计、构建、验证、交付代码」的流程规范，产物几乎全是 Markdown，正好落在 DSH 的原生扩展点上。

## 装了什么

| 内容 | DSH 形态 | 说明 |
|---|---|---|
| **55 个技能** | 运行期技能注册（`ctx.skills.register`） | 23 个 playbook、24 条原则、`how` / `why` / `architect` / `arena` / `swarm` / `interrogate` / `unslop` 等情境技能，全在 `/` 菜单里 |
| **DSH 适配层** | 技能 `pstack-dsh-harness`（模型可调用） | pstack 原文写的 Cursor 工具名全靠它翻译，见下 |
| **poteto-mode 常驻段** | `agent.ctx.systemPrompt.section` | 对应 Cursor 的 Custom Mode；默认关 |
| **两个子代理** | `pstack_agent`、`pstack_comment_sicko` | 对应 `poteto-agent` 与 `comment-sicko`；后者目前只有提示词层面的只读性，见「宿主版本」 |
| **`/pstack-mode`** | 用户命令（不进模型） | 会话内开关常驻段 |

54 个技能在 pstack 原文里标着 `disable-model-invocation: true`，意思是**只有用户能调**，模型不会自作主张去用。DSH 的 `disable-model-invocation` 是同一个键，所以这个策略原样生效——它们出现在 `/` 菜单里，带「仅用户」标记，模型侧的目录里看不到。

唯一的例外是 `setup-pstack`（6.3 KB）。它是唯一一个模型可以自己调的技能，也刚好落在宿主 8192 字符的工具结果修剪阈值之内，所以走模型这条路也不会被截断。其余 4 个超过 8 KB 的技能（`poteto-mode` 20 KB、`poteto-help` 15 KB、`technical-writing` 与 `why` 约 9 KB）全部只走 `/` 注入通道，而注入不是工具结果，不受那个阈值管。

## 与 Cursor 原版的差异

诚实清单。这些不是漏做，是本机没有对应物或刻意换掉的。

| pstack 原版 | 这里 | 为什么 |
|---|---|---|
| `poteto-agent` / `comment-sicko` 是 `subagent_type` 的取值 | 两个独立工具 `pstack_agent` / `pstack_comment_sicko` | 宿主的子代理工具**每实例固定**一个 persona，要另一种角色就得另一个名字的工具 |
| `comment-sicko` 的只读靠 prompt 约定（两个 agent 文件都没有 `tools` 字段） | **目前也还是 prompt 约定**，只多了一个 `commentSickoPreset` 透传口 | 本机宿主把子代理的 `toolFilter` 删了（见下节），换工具面只剩 `agentPreset` 一条路，而那条路要部署方自己搭 preset。**不假装有约束**：工具描述与日志都写明只读性是提示词层面的要求 |
| persona 写在 agent 文件里 | 文本拼进子代理提示词 | 用 `SubagentStartRequest.persona` 会把子代理的 `deployment:persona-prefix` 段**整段顶掉**，那是宿主的身份底线 |
| 常驻时每轮塞整份 20 KB `SKILL.md` | 一份 4.7 KB 的压缩常驻段 + 按需加载 `/poteto-mode` | 20 KB 里真正「每轮都生效」的只有回复规则、注释规则、自主度与一部分 non-negotiables |
| `/setup-pstack` 写 `~/.cursor/rules/pstack-models.mdc` | 跳过 | DSH 的模型分工由会话组合决定，不是一份规则文件。适配层技能里写明了跳过协议 |
| `/deslop`、`control-cli`、`control-ui`、Bugbot、Cursor Automations、cloud agents | 没有 | 替代物（`code-review-and-quality`、chrome-devtools MCP、真实终端）写在 `pstack-dsh-harness` 里 |
| `automations/benny/` | 没搬 | 运行时载体是 Cursor Automations，本机不可能运行 |
| `docs/guide/`（11 篇教程）、`assets/logo.png` | 没搬 | 对运行时无贡献。教程在 pstack 仓库里 |
| `skills/poteto-mode/scripts/`（`orch` / `watch-pr` / `check-plan.mjs`） | **原样随技能目录发布，但没有包成工具** | 见下 |

### 还没做完的

`skills/poteto-mode/scripts/` 里的四个 CLI 是 pstack 唯一的可执行代码，目前只作为技能目录的附带文件躺着：

- `check-plan.mjs`（纯 node、零依赖）：最容易包成一个 DSH 工具，还没做。
- `orch/`（commander，`store.ts` 1777 行）与 `watch-pr/`（4 个文件，约 60 KB）：跑在 `bun` 上，`watch-pr` 还依赖 GitHub CLI。包成工具要先决定 bun 依赖怎么办。
- `worktree-audit.sh` 用的是 BSD/macOS 语法（`stat -f`、`date -r`），在 Windows 上必须先重写。

`comment-sicko` 的只读**强制**是同一类待办：需要部署方先提供一个 preset（`dsh-persona` 加一个自己写的 `ctx.tools.restrict()` row 插件，宿主没有现成的），再把 preset id 填进 `commentSickoPreset`。本包不替部署方预置这个 preset——preset 装哪些行属于那份 profile 的组合决定，插件替人定下来只会让「为什么这个子代理少了一批工具」更难查。

playbook 正文里的 Cursor 术语**没有逐处改写**——那是 100 多处文本改动，而且改完就与上游分叉了。适配层的做法（读一次映射表再照表翻译）是 pstack 自己给 Claude Code 用的方案，这里沿用。

## 配置

全部字段可从 profile 的 `cordis.patch.yml` 覆盖。

| 字段 | 默认 | 含义 |
|---|---|---|
| `skills` | `true` | 是否注册 55 个技能 |
| `renameSkills` | `{}` | 注册时的改名表 |
| `skipSkills` | `[]` | 不注册的技能名（按改名前的原名） |
| `potetoMode` | `'off'` | `'always'` 给每个新会话自动装常驻段 |
| `subagents` | `true` | 是否提供两个子代理工具 |
| `subagentProvider` | `'spawn'` | 子代理走哪个提供方（`spawn` 全新、`fork` 继承对话前缀） |
| `commentSickoPreset` | 空 | `pstack_comment_sicko` 要挂的组合 preset id。空 = 不挂，只读性只是提示词要求（见下节） |

### 宿主版本：0.2.0 与 0.2.1 的子代理 API 不兼容

这是本包开发期间踩到的最贵的一个坑，记在这里免得下次重踩。

仓库 `参考项目/` 里最新的快照是 **0.2.0-rc.2**，而本机已装宿主（CLI 外壳 + `profiles/node_modules` 下全部 294 个运行时包）是 **0.2.1-rc.2**。子代理这一面**破坏性变更**：

| 0.2.0-rc.2 | 0.2.1-rc.2（本机，权威） |
|---|---|
| `ctx.subagents.start(name, request)` | **删了**，改为 `startActivation(spec)` |
| `SubagentStartRequest.persona` | **删了** |
| `SubagentStartRequest.toolFilter` | **删了**，位置换成 `agentPreset` |
| `SubagentRun.result` | `SubagentActivation.result`（另有 `childId` / `messageId` / `dispose`） |

证据：`%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-subagent\lib\types\index.d.ts:135` 只有 `startActivation`，`types.d.ts:25-45` 是新的 `SubagentActivationSpec`。

照快照写出来的代码不会在构建期或测试期报错，只会在**某次真实调用里**蹦出 `start is not a function`。所以 `src/subagents.ts` 现在对着 0.2.1 写，并在注册前用 `isCompatibleSubagentRuntime()` 检查一次——版本不匹配时在插件加载日志里说清楚，而不是等模型调用。

### 关于 `renameSkills`

运行期技能的 rank 是 250，**高于**用户级技能根目录（`<dshHome>/skills` 400、`<agentsHome>/skills` 500）。同名的技能会被静默顶掉，用户只会发现技能内容换了一份。

本机 `<agentsHome>/skills` 里已经有 `tdd` 与 `teach`，所以本包的 `cordis.patch.yml` 显式写了：

```yaml
renameSkills:
  tdd: pstack-tdd
  teach: pstack-teach
```

不想要这两个的话换成 `skipSkills: [tdd, teach]`；不在乎覆盖就把 `renameSkills` 清空。**库默认不改名**——哪些名字会撞取决于本机装了什么，这件事不能由库替部署方猜。

## 安装与验证

装进隔离 profile：

```powershell
# 先构建再打包（pnpm pack 不编译，见仓库 AGENTS.md）
pnpm --filter @void/pstack run build
pwsh -File scripts/pack-all.ps1
```

真机验证的判据：

1. 终端里插件加载日志出现 `技能已注册 55 个`、`子代理工具已注册`。
2. Web 输入 `/` 能看到 `poteto-mode`、`how`、`why`、`arena`，并带「仅用户」标记。
3. 发 `/poteto-mode` 之后，模型的回复遵守短句与「无长破折号」的写法。
4. `/pstack-mode on` 之后随便问一句，让它把含特征串的行原样抄出来——只有模型嘴里的话能证明常驻段真的进了提示词。

## 真机验证（2026-10-12）

装进隔离 home（`.tmp/void-entry-p1`，profile `web`），用 `.tmp/live-signal/pstack-live.mjs` boot 一次，实测结果：

| 判据 | 结果 |
|---|---|
| 插件 fiber | `ACTIVE` |
| 技能目录 | 57 条，其中运行期技能 **56**（55 vendored + `pstack-dsh-harness`） |
| `poteto-mode` | 在册，`{modelInvocable: false, userInvocable: true}`，`resourceBase` 指向包内技能目录 |
| 正文加载 | `skills.get('poteto-mode')` 取到完整正文（含 `## Playbooks`） |
| 工具注册表 | `pstack_agent`、`pstack_comment_sicko` 都在 `schemas()` 里 |

### 两个只有真机才暴露的坑

**1. `ctx.get()` 在 `apply` 里拿不到晚起的服务。** 第一版用 `ctx.get('subagents')` 取服务，而插件在 `apply` 那一刻只能拿到先起来的 `skills`/`tools`——`subagents` 还没激活，`get()` 返回 `undefined`，于是两个子代理工具**一声不响地没注册**，插件 fiber 照样 ACTIVE、技能照样在册，任何单元测试和集成测试都看不出来（它们把服务顶替好了）。

改成 `ctx.inject(['skills'|'commands'|'subagents'], cb)`：等这个服务出现再跑那一段，把时序列进 cordis 的依赖图，而不是靠加载顺序碰运气。

**2. 插件的 `ctx.logger` 输出默认不进终端。** 上面那条"没注册"本来有 `logger.warn`，但 boot 输出里一个字都看不到。所以「至少留一条日志」在这条路上等于没留——真正的判据只能是**去注册表里查**，不是去看日志。探针现在会直接读 `ctx.get('tools').schemas()` 和 `ctx.get('skills').list()`。

## 开发

```powershell
pnpm --filter @void/pstack run typecheck
pnpm --filter @void/pstack test
node scripts/gen-pstack-skills.mjs          # 重生成技能索引
node scripts/gen-pstack-skills.mjs --check  # 打包门禁用的校验
```

`src/skills/index.generated.ts` 是生成物，从 `skills/*/SKILL.md` 的 frontmatter 抽出来。改技能要改 `skills/` 下的原文再重跑生成器——**不要手改生成物**，`scripts/pack-all.ps1` 的 `--check` 会拦。

## 许可

pstack 是 MIT（Copyright (c) 2026 Lauren Tan），`LICENSE-pstack` 是原文件，`skills/` 与 `prompts/agent-*.md` 里的内容来自它。本包的移植代码同样按仓库许可发布。
