# Void 来源清单（Sources Manifest）

> 复用来源与复用方式的统一记录（阶段 3 MVP 完成标准 #6）。

## 基座与只读来源

| 来源 | 路径 | 提交/版本 | 复用方式 |
| --- | --- | --- | --- |
| Star 工作树（只读） | `E:\project\star-sanctuary` | `064de90`（2026-08-15） | 只读勘察，零修改 |
| dsh 基座（只读） | `E:\project\star-sanctuary\Void\deepseek-harness-master` | `master@47f9438`（`0.1.0-rc.5`） | 只读，零修改 |
| 参考插件（只读） | `E:\project\star-sanctuary\Void\参考项目\` | dsh-auto-mode / DSH-better-sidebar | 只读，模板校准 |

## 每插件复用记录

复用方式：**最小重实现**（PoC 阶段验证 seam 形状，非全量源码快照）。全量/选择性快照待 seam 稳定后再决策（见 `虚空寄生实施方案计划.md` §11.5 与阶段 2 样本 ① 结论）。

| Void 插件 | Star 来源（提交 064de90） | 复用范围 | Void 补丁/差异 | 测试 |
| --- | --- | --- | --- | --- |
| `@void/void-memory` | `packages/belldandy-memory/`（全量快照，见 `vendor/star/belldandy-memory/SOURCE.md`） | 全量快照 101 文件 + protocol shim，`VoidMemorySqlite` 薄封装 `MemoryStore` | 全量快照；`openai→ctx.llm` 补丁已实现 chat-completion 路径（`src/llm.ts`），embedding 保留 openai | `memory-composition.spec.ts`（4）+ `llm.spec.ts`（2） |
| `@void/void-tools` | `packages/belldandy-skills/src/tool-contract.ts`、`runtime-policy.ts`、`security-matrix.ts`、`faqi.ts` | ToolContract 词汇 + `evaluateRolePolicy` 纯函数 | 纯类型/纯函数快照；映射到 dsh `ctx.tools.guard`（非 Star 自有 executor） | `contract.spec.ts`（4）+ `policy-composition.spec.ts`（2） |
| `@void/void-legion` | `packages/belldandy-skills/src/delegation-protocol.ts`、`packages/belldandy-core/src/team-identity-governance.ts` | `DelegationTeamMetadata`/`Member` + 权威关系 | 拓扑类型快照；执行引擎（orchestrator/launch-spec）未复用，留待 MVP 后续 | `team-composition.spec.ts`（2） |
| `@void/void-channel-feishu` | `packages/belldandy-channels/src/types.ts`（Channel 接口）+ `feishu-http-transport.ts`（传输） | 渠道 transport/receive/send 形状（脱耦 BelldandyAgent） | mock 传输；真实 Lark SDK + webhook 未接入（需 Feishu 凭据） | `channel-composition.spec.ts`（2） |

## 同步状态

- 当前为 PoC 最小重实现，与 Star 源码**无逐文件同步**关系；若后续转为全量快照，需重建 SOURCE.md + 逐文件来源提交 + 同步测试。
- 同步触发点：Star 对应模块的 family/risk/拓扑类型契约变更。
