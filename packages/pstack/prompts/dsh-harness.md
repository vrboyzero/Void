# pstack 在 DeepSeek Harness 上的适配层

pstack 原文面向 Cursor（以及 Claude Code）。这份表把 Cursor 的工具名与专有能力映射到本机（DSH）。**每个会话读一次**，按表翻译；**表里没有的字段直接丢掉并说明**，绝不传递对方 schema 不接受的值。这条约定照抄 pstack 自己的 `docs/harness/claude-code.md`。

## 工具与子代理

| pstack 原文（Cursor） | 本机（DSH） |
|---|---|
| `Task` 工具 | `subagent` 工具；需要继承当前对话时用 `subagent_fork` |
| `run_in_background: true` | 省略。`subagent` 本身就是后台运行，完成后会通知 |
| `resume` 一个子代理 | 用 `send_message` 续聊（目标可以是刚跑完的子代理），或开新代理并把它先前的结果粘进 brief |
| `subagent_type: "poteto-agent"` | `pstack_agent` 工具 |
| 只读评审类子代理（`comment-sicko`） | `pstack_comment_sicko` 工具，它带工具白名单，读写面被真正限制住 |
| `AskQuestion` | `ask_user_question` |
| `environment: "cloud"` | 无。都在本机跑，不要声称用了云端隔离 |
| `readonly: true` | DSH 的只读通过子代理工具的工具白名单实现，不是靠 prompt 约定；用 `pstack_comment_sicko` 或自己写 brief |

**子代理的派生规则**照旧：新工作默认开新代理并给它合并后的完整范围；只有新工作严格依赖对方手里的昂贵状态（本地 checkout、未提交改动、还在跑的进程）才续用。

## 模型分工

pstack 的 `/setup-pstack` 写的是 `~/.cursor/rules/pstack-models.mdc`（或 Claude Code 的 `~/.claude/rules/pstack-models.md`），给每个角色指定一个 Cursor 模型 slug。**本机不适用**：

- DSH 的模型与推理档位由会话组合决定，不是一份规则文件。子代理工具可暴露 `provider` / `model` / `reasoning_effort`，但只在部署启用了逐会话模型选择时才可见。
- 因此 `/setup-pstack` 这一步在本机**跳过**（写一行 `Skipped`），角色的模型分工改用本机实际可用的模型承担。多模型家族对抗（`interrogate`、`arena` 的核心信号）只有在确实配了多个模型家族时才成立；只有一个家族时按同家族多次采样处理，并**明说这一点**，不要假装面板是多样的。

## 本机没有的能力

| pstack 引用的东西 | 现状 | 替代 |
|---|---|---|
| `/deslop`、`deslop` 技能（来自 `cursor-team-kit`） | 没有 | 改完 diff 用 `code-review-and-quality` 技能过一遍 |
| `control-cli`（驱动 CLI/TUI） | 没有 | 用 `terminal` 或 shell 工具真实驱动，拿真实输出 |
| `control-ui`（驱动浏览器/Electron） | 没有 | 装了 chrome-devtools MCP 就用它；否则用真实终端路径 |
| Bugbot 与其评论 | 没有 | 把评审评论当普通 review thread 处理 |
| Cursor Automations、`update_state`、webhook、`SendToUser` | 没有 | 整块跳过。pstack 的 `automations/benny/` 在本机不可运行 |
| Cursor cloud agents | 没有 | 用 `subagent` / `pstack_agent` 在本机跑 |
| `/loop` | 没有同名命令 | `schedule` 工具，或 `goal` 加继续轮次 |
| `create-skill`（Cursor 内建） | 没有 | `write-a-skill` 技能 |
| `/autopilot`（Cursor 内建） | 没有 | 按 pstack 的 Autopilot playbook 文本执行 |

## 跳过协议

某个步骤需要上表里「本机没有」的能力时，在回复里写**恰好一行**：

```
Skipped: <步骤名>. <原因>.
```

然后**继续下一步**。不要停下来问，不要重试，不要静默绕过。如果缺的只是内建 PR 工具而有等价的 forge 命令，那不算跳过，**不要写这一行**。
