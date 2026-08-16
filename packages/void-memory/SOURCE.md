# 快照来源（belldandy-memory）

- **来源**：`E:\project\star-sanctuary\packages\belldandy-memory`（Star 只读，commit `064de90`，2026-08-15）。
- **快照位置**：`packages/void-memory/src/star/`（方案 B 合并后内嵌于插件包；原 `vendor/star/belldandy-memory` 已移除）。
- **快照方式**：全量快照（101 个非测试源文件，忠实复制）+ `src/protocol/` shim（3 个文件：`index.ts` 转发 + `outbound-request-policy.ts` + `state-dir.ts`，替换 `@belldandy/protocol` 依赖）。
- **Void 补丁**：
  1. `@belldandy/protocol` → 本地 `./protocol/index.js`（shim 只含 `OutboundRequestPolicy` + `resolveStateDir`/`resolveWorkspaceStateDir`）。
  2. `resolveStateDir` 仍读 `BELLDANDY_STATE_DIR`（Star 语义）；迁移到 `VOID_STATE_DIR` 属后续补丁。
  3. `openai`（embedding/summary 模型调用）暂保留原 SDK；`openai→ctx.llm` 补丁已实现 **chat-completion 路径**（`packages/void-memory/src/llm.ts` 的 `requestChatCompletionViaLlm`），**embedding 仍走 openai**（dsh 无 embedding seam）。
- **依赖**：`better-sqlite3`、`sqlite-vec`、`chokidar`、`openai`、`ipaddr.js`；`fastembed`（optional）。
- **同步**：逐文件同步 Star 对应模块到 `src/star/`；同步触发点 = family/risk/拓扑/记忆 schema 契约变更。
- **校验**：根命令 `pnpm run verify:star-memory-snapshot`（`scripts/verify-star-memory-snapshot.mjs`）自动比较 Star 源与 `src/star/`，只允许本文件记录的白名单补丁与 protocol shim extras。
