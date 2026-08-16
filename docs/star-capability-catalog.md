# Star 能力盘点目录（P0 第一阶段）

> 只读盘点 Star 的现役配置。机器真源 = `config/void-capabilities.json`（由 `scripts/generate-void-capabilities.py` 生成，可复现）；本文件是人读投影。

## 概览

| 指标 | 值 |
| --- | --- |
| 现役配置（`.env.local` 实际生效） | **347 项** |
| 能力面（`.env.example` 模板） | 418 项（含 77 项 `.env.local` 未配置） |
| 覆盖 | 347/347，无缺漏、无未匹配 |
| 敏感凭据 | 20 项（已标记，不回显值） |

> ⚠️ 早前误把 `.env.example` 的「注释行」当作「不现役」，得出 56 个现役的错误结论。实际 `.env.example` 是模板（注释行 = 变量存在但默认留空待配置），真实现役以 `.env.local` 的 347 项为准。

## 七类分类定义

| 分类 | 含义 |
| --- | --- |
| `void_native` | Void 差异化能力，进入对应插件的配置 Schema |
| `dsh_mapped` | dsh 已有等价能力，只记录映射，不新建实现 |
| `plugin_internal` | 插件内部开关/阈值 |
| `adapter_credential` | 第三方 provider/channel 凭据，走 credentials store |
| `development_only` | 测试/CI/调试专用 |
| `legacy_or_omit` | 历史/兼容占位/Void 不需要，不迁移 |
| `defer` | 方向成立但当前阶段不实施 |

## 现役变量分类分布（347 项）

| 分类 | 数量 | 说明 |
| --- | ---: | --- |
| `void_native` | 230 | 记忆/军团/渠道/安全/浏览器/媒体/核心/UI 差异化 |
| `dsh_mapped` | 85 | 模型/会话/压缩/workflow/goal/prompt/mcp，dsh 已有等价 |
| `adapter_credential` | 20 | 各类 API key / token / secret / password |
| `legacy_or_omit` | 8 | office.goddess.ai 专属 + Docker 别名/镜像 + CLI bridge |
| `defer` | 3 | heartbeat（先做 dsh 覆盖审计） |
| `development_only` | 1 | MV3 测试专用 |

## 按 Void Module 归属（前缀 → Module）

| 前缀 | Module | 说明 |
| --- | --- | --- |
| `BELLDANDY_MEMORY_*` / `EMBEDDING_*` / `DREAM_*` / `EXPERIENCE_*` / `RERANKER_*` / `TASK_*` / `SKILL_*` / `METHOD_*` / `FACET_*` / `TEAM_SHARED_MEMORY` / `AUTO_RECALL_*` / `CARRYOVER_CONTEXT` / `CONTEXT_INJECTION*` / `MIND_PROFILE_*` / `LOCAL_EMBEDDING` / `SHARED_REVIEW_*` / `COMMONS_OBSIDIAN*` / `TOOL_RESULT_*` | void-memory | 记忆/检索/经验/dream/embedding/reranker/任务沉淀 |
| `BELLDANDY_IMAGE_*` / `VIDEO_*` / `TTS_*` / `STT_*` / `CAMERA_*` / `SCREEN_CAPTURE` / `AUDIO_TRANSCRIPT` / `UNDERSTANDING_CACHE` | void-media | 图片/视频理解、语音合成/转写、摄像头 |
| `BELLDANDY_FEISHU_*` / `QQ_*` / `DISCORD_*` / `EMAIL_*` / `CHANNEL_*` / `ROOM_*` / `STARWEAVER_*` / `ASSISTANT_EXTERNAL*` / `AUTO_TASK_*` / `WEBHOOK_*` | void-channel-* | 各渠道 adapter + 路由 + 主动通知 |
| `BELLDANDY_BROWSER_*` / `RELAY_*` | void-browser | CDP relay + 出站策略 |
| `BELLDANDY_AGENT_TOOL_CONTROL*` / `DANGEROUS_TOOLS` / `TOOLS_POLICY_FILE` / `COMMAND_SANDBOX_*` / `EXTENSION_HOST_*` / `REMOTE_DELIVERY` / `PRIVILEGED_WORKSPACE_WRITE*` / `WEB_ALLOW_PRIVILEGED` / `CODE_INTEL_*` / `TOOL_GROUPS` | void-tools | 工具治理/沙箱/命令/extension host |
| `BELLDANDY_SUB_AGENT_*` / `COMMANDER_*` / `AGENT_CONFIG_FILE` | void-legion | 子 Agent 并发/角色/团队拓扑 |
| `BELLDANDY_AUTH_*` / `ALLOWED_ORIGINS` / `EXTERNAL_OUTBOUND*` | void-security | 认证/allowlist/外发审批 |
| `BELLDANDY_HEARTBEAT_*` | void-automation（defer） | 心跳主动助手，先做 dsh 覆盖审计 |
| `BELLDANDY_HOST` / `PORT` / `STATE_DIR*` / `WORKSPACE_DIR` / `EXTRA_WORKSPACE_ROOTS` / `LOG_*` / `RUNTIME_RESOURCE*` / `ATTACHMENT_*` / `WEB_ROOT` / `UPDATE_CHECK` | void-core | 基础运行/路径/日志/资源/附件 |
| `BELLDANDY_WEBCHAT_*` / `WEB_*` | void-entry | WebChat UI/成本预算/治理模式 |
| `BELLDANDY_OPENAI_*` / `AGENT_PROVIDER` / `AGENT_PROTOCOL` / `AGENT_TIMEOUT` / `MODEL_*` / `PROMPT_*` / `INJECT_*` / `PRIMARY_*` / `DEEPSEEK_ROUTE` / `COMPACTION_*` / `COMPRESSION_*` / `PREFLIGHT_*` / `BUDGET_PROTECT*` / `STABLE_PREFIX` / `MAX_*` / `TOOL_LOOP_*` / `WORKFLOW_*` / `GOAL_*` / `MCP_*` / `CONVERSATION_ALLOWED_KINDS` / `RESPONSES_SANITIZE` / `TOOLS_ENABLED` | dsh（dsh_mapped） | 模型/会话/压缩/workflow/goal/prompt/mcp 等 dsh 已有等价 |

## 敏感凭据清单（20 项，分类 adapter_credential）

`BELLDANDY_OPENAI_API_KEY`、`BELLDANDY_COMPACTION_API_KEY`、`BELLDANDY_EMBEDDING_OPENAI_API_KEY`、`BELLDANDY_MEMORY_SUMMARY_API_KEY`、`BELLDANDY_MEMORY_EVOLUTION_API_KEY`、`BELLDANDY_TASK_SUMMARY_API_KEY`、`BELLDANDY_IMAGE_OPENAI_API_KEY`、`BELLDANDY_IMAGE_UNDERSTAND_OPENAI_API_KEY`、`BELLDANDY_VIDEO_UNDERSTAND_OPENAI_API_KEY`、`BELLDANDY_VIDEO_FILE_API_KEY`、`BELLDANDY_STT_OPENAI_API_KEY`、`BELLDANDY_STT_GROQ_API_KEY`、`BELLDANDY_TTS_OPENAI_API_KEY`、`BELLDANDY_FEISHU_APP_SECRET`、`BELLDANDY_QQ_APP_SECRET`、`BELLDANDY_EMAIL_SMTP_PASS`、`BELLDANDY_EMAIL_IMAP_PASS`、`BELLDANDY_DISCORD_BOT_TOKEN`、`BELLDANDY_AGENT_TOOL_CONTROL_CONFIRM_PASSWORD`、`DASHSCOPE_API_KEY`

## legacy_or_omit（8 项，不迁移）

`BELLDANDY_IMAGE`（Docker 镜像）、`BELLDANDY_GATEWAY_PORT`（Docker 别名）、`BELLDANDY_COMMUNITY_API_ENABLED` + `BELLDANDY_TOKEN_USAGE_*`（office.goddess.ai 专属）、`BELLDANDY_AGENT_BRIDGE_ENABLED`（CLI/IDE bridge 专属）

## 后续计划（P0 剩余）

1. **交叉核对**：读 Star 源码/Settings/Doctor/项目地图，验证 85 项 `dsh_mapped` 的 dsh 等价能力确凿 + 补无环境变量能力 + 标失效项。
2. **`void-core` Schema**：把 230 项 `void_native` 收敛成结构化 `config-schema.ts`（配置合同 + 优先级 + 错误分类）。
3. **校验 Gate**：`scripts/verify-config-contract.mjs` 检查缺项/重复/未知/敏感回显 + Star 只读约束。
