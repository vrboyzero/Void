# Star 能力盘点目录（P0 第一阶段）

> 只读盘点 `E:\project\star-sanctuary\.env.example`（1752 行）的现役配置项。机器可校验清单见 `config/void-capabilities.json`（同一份数据真源）；本文件是人读投影。

## 概览

| 指标 | 值 |
| --- | --- |
| `.env.example` 总行数 | 1752 |
| 出现过（含注释示例）的 `BELLDANDY_*` 变量 | 418 |
| **现役变量（有默认值的非注释行）** | **56** |
| 现役变量覆盖 | 56/56（无缺漏） |

## 七类分类定义

| 分类 | 含义 |
| --- | --- |
| `void_native` | Void 差异化能力，进入对应插件的配置 Schema |
| `dsh_mapped` | dsh 已有等价能力，只记录映射，不新建实现 |
| `plugin_internal` | 插件内部开关/阈值，不形成独立配置项 |
| `adapter_credential` | 第三方 provider/channel 凭据，走 credentials/secret store |
| `development_only` | 测试/CI/调试专用，不进普通设置页 |
| `legacy_or_omit` | 历史别名/兼容占位/Void 不需要的 Star 专属配置，不迁移 |
| `defer` | 方向成立但当前阶段不实施，记录前置条件 |

## 现役变量分类分布

| 分类 | 数量 | 说明 |
| --- | ---: | --- |
| `void_native` | 32 | 记忆/军团/渠道/安全/浏览器/媒体/核心/UI 差异化 |
| `dsh_mapped` | 13 | 模型/会话/压缩/tools/MCP/cron，dsh 已有等价能力 |
| `legacy_or_omit` | 6 | office.goddess.ai 专属（3）+ Docker 别名/镜像 + CLI bridge |
| `adapter_credential` | 3 | AUTH_TOKEN / OPENAI_API_KEY / TOOL_CONTROL 口令 |
| `plugin_internal` | 1 | embedding 批处理大小 |
| `defer` | 1 | heartbeat（先做 dsh 覆盖审计） |

## 逐项归属（按 Void Module 聚合）

### void-core（基础运行 / 路径 / 日志）

| Star 变量 | 分类 | 敏感 | 说明 |
| --- | --- | --- | --- |
| BELLDANDY_HOST | void_native | 否 | Void 独立绑定地址 |
| BELLDANDY_PORT | void_native | 否 | Void 独立端口 |
| BELLDANDY_UPDATE_CHECK | void_native | 否 | 更新检查（可 defer 到发行阶段） |
| BELLDANDY_STATE_DIR | void_native | 否 | VOID_HOME 独立数据目录 |
| BELLDANDY_WORKSPACE_DIR | void_native | 否 | VOID 工作区目录 |
| BELLDANDY_LOG_LEVEL | void_native | 否 | 日志级别 |
| BELLDANDY_LOG_CONSOLE | void_native | 否 | 控制台输出 |
| BELLDANDY_LOG_FILE | void_native | 否 | 文件落盘 |
| BELLDANDY_LOG_DIR | void_native | 否 | 日志目录 |
| BELLDANDY_LOG_MAX_SIZE | void_native | 否 | 轮转大小 |
| BELLDANDY_LOG_RETENTION_DAYS | void_native | 否 | 保留天数 |

### void-security（认证 / 审批）

| Star 变量 | 分类 | 敏感 | 说明 |
| --- | --- | --- | --- |
| BELLDANDY_AUTH_MODE | void_native | 否 | 配对/auth 差异化（阶段 5） |
| BELLDANDY_AUTH_TOKEN | adapter_credential | **是** | 走 credentials store |
| BELLDANDY_EXTERNAL_OUTBOUND_REQUIRE_CONFIRMATION | void_native | 否 | 外发审批（阶段 5） |

### void-memory（记忆 / 检索 / 经验 / dream / Obsidian）

| Star 变量 | 分类 | 敏感 | 说明 |
| --- | --- | --- | --- |
| BELLDANDY_MEMORY_ENABLED | void_native | 否 | 记忆总开关 |
| BELLDANDY_EMBEDDING_ENABLED | void_native | 否 | dsh 无 embedding seam |
| BELLDANDY_EMBEDDING_PROVIDER | void_native | 否 | openai/local |
| BELLDANDY_EMBEDDING_MODEL | void_native | 否 | embedding 模型 |
| BELLDANDY_EMBEDDING_BATCH_SIZE | plugin_internal | 否 | 内部批处理阈值 |
| BELLDANDY_EXPERIENCE_AUTO_PROMOTION_ENABLED | void_native | 否 | experience 沉淀（可 defer） |
| BELLDANDY_EXPERIENCE_AUTO_METHOD_ENABLED | void_native | 否 | method 沉淀 |
| BELLDANDY_EXPERIENCE_AUTO_SKILL_ENABLED | void_native | 否 | skill 沉淀 |
| BELLDANDY_DREAM_AUTO_HEARTBEAT_ENABLED | void_native | 否 | dream 自动化 |
| BELLDANDY_DREAM_AUTO_CRON_ENABLED | void_native | 否 | dream 自动化 |
| BELLDANDY_DREAM_OBSIDIAN_ENABLED | void_native | 否 | Obsidian 同步 |
| BELLDANDY_COMMONS_OBSIDIAN_ENABLED | void_native | 否 | Commons 导出 |

### void-tools（工具治理）

| Star 变量 | 分类 | 敏感 | 说明 |
| --- | --- | --- | --- |
| BELLDANDY_AGENT_TOOL_CONTROL_MODE | void_native | 否 | 工具开关治理 |
| BELLDANDY_AGENT_TOOL_CONTROL_CONFIRM_PASSWORD | adapter_credential | **是** | 敏感口令，走 credentials |

### void-browser / void-media / void-channel-* / void-automation（阶段 5）

| Star 变量 | 分类 | 敏感 | 说明 |
| --- | --- | --- | --- |
| BELLDANDY_BROWSER_RELAY_ENABLED | void_native | 否 | CDP relay（阶段 5） |
| BELLDANDY_BROWSER_OUTBOUND_PROFILE | void_native | 否 | 出站策略（阶段 5） |
| BELLDANDY_TTS_PROVIDER | void_native | 否 | 语音合成（阶段 5） |
| BELLDANDY_TTS_VOICE | void_native | 否 | 音色（阶段 5） |
| BELLDANDY_ASSISTANT_EXTERNAL_DELIVERY_PREFERENCE | void_native | 否 | 渠道投递顺序 |
| BELLDANDY_HEARTBEAT_ENABLED | defer | 否 | 先做 dsh workflow/cron 覆盖审计 |

### void-entry / UI

| Star 变量 | 分类 | 敏感 | 说明 |
| --- | --- | --- | --- |
| BELLDANDY_WEB_GOVERNANCE_DETAIL_MODE | void_native | 否 | 治理 UI 差异化 |
| BELLDANDY_WEB_EXPERIENCE_DRAFT_GENERATE_NOTICE_ENABLED | void_native | 否 | 草稿提示（可 defer） |

### dsh_mapped（不重建，直接复用 dsh）

| Star 变量 | dsh 等价能力 |
| --- | --- |
| BELLDANDY_AGENT_PROVIDER | agent provider |
| BELLDANDY_OPENAI_BASE_URL | llm provider baseUrl |
| BELLDANDY_OPENAI_API_KEY | credentials（敏感） |
| BELLDANDY_OPENAI_MODEL | llm model |
| BELLDANDY_TOOLS_ENABLED | tools 总开关 |
| BELLDANDY_RESPONSES_SANITIZE_TOOL_SCHEMA | wire API |
| BELLDANDY_MCP_ENABLED | mcp |
| BELLDANDY_CRON_ENABLED | workflow/cron（待覆盖审计） |
| BELLDANDY_ASSISTANT_MODE_ENABLED | workflow/automation（待覆盖审计） |
| BELLDANDY_CONVERSATION_ALLOWED_KINDS | session kinds |
| BELLDANDY_COMPACTION_THRESHOLD | compaction |
| BELLDANDY_MODEL_CONTEXT_WINDOW | model context window |
| BELLDANDY_COMPACTION_CONTEXT_WINDOW_FRACTION | compaction |
| BELLDANDY_COMPACTION_KEEP_RECENT | compaction |

### legacy_or_omit（不迁移）

| Star 变量 | 原因 |
| --- | --- |
| BELLDANDY_IMAGE | Docker 镜像名，Void 发行形态不同 |
| BELLDANDY_GATEWAY_PORT | Docker Compose 别名 |
| BELLDANDY_COMMUNITY_API_ENABLED | office.goddess.ai 专属 |
| BELLDANDY_TOKEN_USAGE_UPLOAD_ENABLED | office token 上报专属 |
| BELLDANDY_TOKEN_USAGE_STRICT_UUID | office 专属 |
| BELLDANDY_AGENT_BRIDGE_ENABLED | CLI/IDE bridge 专属 |

## 后续计划（P0 未完成部分）

1. **交叉核对**（约 360 个注释示例变量）：读 Star 源码/Settings/Doctor/项目地图，标出失效项、无环境变量能力，防止把注释示例误当现役。
2. **`void-core` Schema 草案**：把 `void_native` 的 32 项收敛成结构化 `config-schema.ts`（配置合同 + 优先级 + 错误分类）。
3. **校验 Gate**：`scripts/verify-config-contract.mjs` 检查缺项/重复/未知/敏感回显 + Star 只读约束。
