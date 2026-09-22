import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createActorResolver } from "./actor.js";
import type { MemoryTarget } from "./documents.js";
import type { AgentMemoryHandle, VoidMemory } from "./service.js";

export const name = "void-memory-tool";
export const inject = ["tools", "voidMemory"];

/** `long-term` 是唯一的关键字目标，其余一律当成条目 id（由仓储再校验一遍）。 */
export function parseMemoryTarget(value: unknown): MemoryTarget {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("记忆目标不能为空");
  const trimmed = value.trim();
  if (trimmed === "long-term" || trimmed === "MEMORY.md") return { kind: "long-term" };
  return { kind: "entry", entryId: trimmed };
}

function renderJson(value: unknown): { type: "text"; text: string }[] {
  return [{ type: "text", text: JSON.stringify(value) }];
}

/**
 * Consumer：注册模型可见的记忆工具。每个工具都在执行时用 `exec.agent`
 * 反查会话绑定，再取该身份的记忆句柄——参数里没有 `agentId`，也没有路径。
 */
export function apply(ctx: Context): void {
  const memory = ctx.get("voidMemory") as VoidMemory;
  const dataRoot = (memory as unknown as { dataRoot?: string }).dataRoot;
  const resolveActor = createActorResolver({ dataDir: dataRoot });
  const handleFor = async (sessionId: string | undefined): Promise<AgentMemoryHandle> =>
    memory.forAgent(await resolveActor(sessionId));

  ctx.tools.register(defineTool({
    name: "memory_search",
    description: "按关键词检索本人记忆（长期文字与日记条目），返回条目 id、来源、修订与片段。",
    parameters: {
      query: { type: "string", required: true, description: "检索词；中文按字与相邻双字切分。" },
      k: { type: "integer", description: "返回条数，默认 5，上限 50。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          results: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                entryId: { type: "string", required: true },
                kind: { type: "string", required: true, enum: ["entry", "long-term"] },
                date: { type: "string", required: true },
                revision: { type: "integer", required: true },
                snippet: { type: "string", required: true },
                score: { type: "number", required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const { query, k } = args as { query: string; k?: number };
      const handle = await handleFor(exec.agent?.id);
      return { results: await handle.search({ query, ...(k === undefined ? {} : { k }) }) };
    },
  }));

  ctx.tools.register(defineTool({
    name: "memory_read",
    description: "读取本人一条记忆正文：目标写 long-term 读长期文字，写条目 id 读日记条目。",
    parameters: {
      target: { type: "string", required: true, description: "long-term 或条目 id（形如 20260922-0001）。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          target: { type: "string", required: true },
          revision: { type: "integer", required: true },
          updatedAt: { type: "string", required: true },
          body: { type: "string", required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const { target } = args as { target: string };
      const handle = await handleFor(exec.agent?.id);
      const view = await handle.read(parseMemoryTarget(target));
      return {
        target: view.target.kind === "long-term" ? "long-term" : view.target.entryId,
        revision: view.revision,
        updatedAt: view.updatedAt,
        body: view.body,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "memory_list",
    description: "分页列出本人记过什么（只列日记条目，按条目 id 倒序）。",
    parameters: {
      limit: { type: "integer", description: "每页条数，默认 20，上限 50。" },
      cursor: { type: "string", description: "上一页返回的 nextCursor，用它继续往后翻。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          total: { type: "integer", required: true },
          nextCursor: { type: "string" },
          entries: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                entryId: { type: "string", required: true },
                date: { type: "string", required: true },
                revision: { type: "integer", required: true },
                updatedAt: { type: "string", required: true },
                preview: { type: "string", required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const { limit, cursor } = args as { limit?: number; cursor?: string };
      const handle = await handleFor(exec.agent?.id);
      const page = await handle.list({ ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) });
      return {
        total: page.total,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        entries: page.entries,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "memory_write",
    description: "记下一条记忆：默认新建日记条目；target 写 long-term 时追加到长期文字。写入前会检查敏感信息。",
    parameters: {
      body: { type: "string", required: true, description: "要记住的文字。" },
      target: { type: "string", enum: ["entry", "long-term"], description: "默认 entry（新建日记条目）。" },
      date: { type: "string", description: "条目归属日期 YYYY-MM-DD，默认今天。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          target: { type: "string", required: true },
          entryId: { type: "string", description: "条目 id；长期文字不返回。" },
          revision: { type: "integer", required: true },
          date: { type: "string", required: true },
          indexSynced: { type: "boolean", required: true },
          warning: { type: "string" },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const { body, target, date } = args as { body: string; target?: "entry" | "long-term"; date?: string };
      const handle = await handleFor(exec.agent?.id);
      const written = await handle.write({ body, ...(target === undefined ? {} : { target }), ...(date === undefined ? {} : { date }) });
      return {
        target: written.target.kind === "long-term" ? "long-term" : written.target.entryId,
        ...(written.entryId === undefined ? {} : { entryId: written.entryId }),
        revision: written.revision,
        date: written.date,
        indexSynced: written.indexSynced,
        ...(written.warning === undefined ? {} : { warning: written.warning }),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "memory_update",
    description: "改写本人已有一条记忆（整文替换）。必须带上读到的 revision，避免覆盖别人的并发修改。",
    parameters: {
      target: { type: "string", required: true, description: "long-term 或条目 id。" },
      body: { type: "string", required: true, description: "替换后的完整正文。" },
      expectedRevision: { type: "integer", required: true, description: "memory_read 返回的 revision。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          target: { type: "string", required: true },
          revision: { type: "integer", required: true },
          date: { type: "string", required: true },
          indexSynced: { type: "boolean", required: true },
          warning: { type: "string" },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const { target, body, expectedRevision } = args as { target: string; body: string; expectedRevision: number };
      const handle = await handleFor(exec.agent?.id);
      const written = await handle.update({ target: parseMemoryTarget(target), body, expectedRevision });
      return {
        target: written.target.kind === "long-term" ? "long-term" : written.target.entryId,
        revision: written.revision,
        date: written.date,
        indexSynced: written.indexSynced,
        ...(written.warning === undefined ? {} : { warning: written.warning }),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "memory_retract",
    description: "撤回本人一条记忆：立刻不再被检索，原文移入恢复区仍可找回，不直接删库或历史。",
    parameters: {
      target: { type: "string", required: true, description: "long-term 或条目 id。" },
      expectedRevision: { type: "integer", description: "可选；带上读到的 revision 可防止误撤回已改过的条目。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          target: { type: "string", required: true },
          revision: { type: "integer", required: true },
          indexSynced: { type: "boolean", required: true },
          recovered: { type: "boolean", required: true },
          warning: { type: "string" },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const { target, expectedRevision } = args as { target: string; expectedRevision?: number };
      const handle = await handleFor(exec.agent?.id);
      const retracted = await handle.retract({
        target: parseMemoryTarget(target),
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      });
      return {
        target: retracted.target.kind === "long-term" ? "long-term" : retracted.target.entryId,
        revision: retracted.revision,
        indexSynced: retracted.indexSynced,
        recovered: retracted.recoveredPath.length > 0,
        ...(retracted.warning === undefined ? {} : { warning: retracted.warning }),
      };
    },
  }));
}
