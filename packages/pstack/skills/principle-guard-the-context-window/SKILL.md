---
name: principle-guard-the-context-window
description: 上下文窗口快被占满时适用——大输出、长文件、重复读取、fan-out 规划。把批量内容交给 subagents，主线程只留摘要，不塞原始载荷。Apply when context is filling up - large outputs, long files, repeated reads, fan-out planning. Route bulk to subagents; keep summaries in the main thread, not raw payloads.
disable-model-invocation: true
---

# Guard the Context Window

**Why:** Context overflow degrades reasoning quality, creates compression artifacts, and halts progress.

**Pattern:**
- **Size phases and cap scope.** Limit files per phase, set turn budgets, account for mechanism costs.
