import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { type ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { Agent } from "@deepseek-ai/dsh-agent";
import * as VoidMemoryFiles from "../src/provider.js";
import * as VoidMemoryTool from "../src/tool.js";

let context: Context | undefined;
let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "void-memory-tool-"));
});

afterEach(async () => {
  await context?.fiber.dispose();
  context = undefined;
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function bind(sessionId: string, agentId: string): Promise<void> {
  const dir = join(dataDir, "runtime");
  await mkdir(dir, { recursive: true });
  const existing = await readFile(join(dir, "session-bindings.json"), "utf8").then(
    (text) => JSON.parse(text) as { sessionId: string; agentId: string }[],
    () => [] as { sessionId: string; agentId: string }[],
  );
  const next = [...existing.filter((item) => item.sessionId !== sessionId), { sessionId, agentId }];
  await writeFile(join(dir, "session-bindings.json"), JSON.stringify(next), "utf8");
}

async function boot(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(Loader);
  const modules = new Map<string, unknown>([
    ["@deepseek-ai/dsh-system-prompt", SystemPrompt],
    ["@deepseek-ai/dsh-tools", ToolRuntime],
    ["@void/void-memory/provider", VoidMemoryFiles],
    ["@void/void-memory/tool", VoidMemoryTool],
  ]);
  ctx.loader.internal = {
    version: "v2",
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`);
      return modules.get(specifier);
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>;
  await ctx.loader.create({ name: "@deepseek-ai/dsh-system-prompt" });
  await ctx.loader.create({ name: "@deepseek-ai/dsh-tools" });
  await ctx.loader.create({ name: "@void/void-memory/provider", config: { dataDir } });
  await ctx.loader.create({ name: "@void/void-memory/tool" });
  await ctx.loader.await();
  return ctx;
}

function mockExec(agent: Agent | undefined): ToolRunContext {
  return { agent, signal: new AbortController().signal } as unknown as ToolRunContext;
}

function agentWithId(id: string): Agent {
  return { id } as unknown as Agent;
}

const TOOLS = ["memory_search", "memory_read", "memory_list", "memory_write", "memory_update", "memory_retract"] as const;

const ARGS: Record<(typeof TOOLS)[number], Record<string, unknown>> = {
  memory_search: { query: "虚空" },
  memory_read: { target: "long-term" },
  memory_list: {},
  memory_write: { body: "随便记一句" },
  memory_update: { target: "long-term", body: "改写", expectedRevision: 1 },
  memory_retract: { target: "long-term" },
};

describe("void memory tools through the Loader", () => {
  it("never exposes an archive id or a path as a model parameter", async () => {
    context = await boot();
    for (const name of TOOLS) {
      const schema = context.tools.schemas().find((item) => item.name === name);
      expect(schema, `${name} 未注册`).toBeDefined();
      const rendered = JSON.stringify(schema);
      expect(rendered).not.toContain("agentId");
      expect(rendered).not.toContain("dataDir");
      expect(rendered).not.toContain("memory.sqlite");
    }
  });

  it("rejects every tool when the execution carries no session", async () => {
    context = await boot();
    for (const name of TOOLS) {
      await expect(context.tools.get(name)!.execute(ARGS[name], mockExec(undefined))).rejects.toThrow(
        "记忆工具缺少执行会话，已拒绝",
      );
    }
  });

  it("rejects a session that void-soul never bound", async () => {
    context = await boot();
    await expect(context.tools.get("memory_list")!.execute({}, mockExec(agentWithId("session-forged")))).rejects.toThrow(
      "会话没有档案绑定: session-forged",
    );
  });

  it("routes each session to its own archive end to end", async () => {
    await bind("session-a", "xiaobei");
    await bind("session-b", "xiaoma");
    context = await boot();

    const written = (await context.tools
      .get("memory_write")!
      .execute({ body: "小贝记住：虚空之钥在星港第三码头", target: "long-term" }, mockExec(agentWithId("session-a")))) as {
      target: string;
      revision: number;
    };
    expect(written).toMatchObject({ target: "long-term", revision: 1 });

    const own = (await context.tools
      .get("memory_search")!
      .execute({ query: "虚空之钥" }, mockExec(agentWithId("session-a")))) as { results: { snippet: string }[] };
    expect(own.results.length).toBeGreaterThan(0);
    expect(own.results[0]!.snippet).toContain("星港");

    // A 记的 B 查不到，伪造会话也拿不到。
    const other = (await context.tools
      .get("memory_search")!
      .execute({ query: "虚空之钥" }, mockExec(agentWithId("session-b")))) as { results: unknown[] };
    expect(other.results).toEqual([]);

    const onDisk = await readFile(join(dataDir, "agents", "xiaobei", "MEMORY.md"), "utf8");
    expect(onDisk).toContain("星港第三码头");
    await expect(readFile(join(dataDir, "agents", "xiaoma", "MEMORY.md"), "utf8")).rejects.toThrow();
  });

  it("records the bound session id on the entry it writes", async () => {
    await bind("session-a", "xiaobei");
    context = await boot();

    const written = (await context.tools
      .get("memory_write")!
      .execute({ body: "今天学会了装门禁", date: "2026-09-22" }, mockExec(agentWithId("session-a")))) as { target: string };
    expect(written.target).toBe("20260922-0001");

    const entry = await readFile(join(dataDir, "agents", "xiaobei", "memory", "2026-09-22", "20260922-0001.md"), "utf8");
    expect(entry).toContain("session: session-a");
  });

  it("keeps a retracted entry out of search immediately", async () => {
    await bind("session-a", "xiaobei");
    context = await boot();
    const exec = mockExec(agentWithId("session-a"));

    const written = (await context.tools.get("memory_write")!.execute({ body: "临时记号：蓝色灯塔" }, exec)) as {
      target: string;
      revision: number;
    };
    expect((await context.tools.get("memory_search")!.execute({ query: "蓝色灯塔" }, exec) as { results: unknown[] }).results.length).toBeGreaterThan(0);

    const retracted = (await context.tools
      .get("memory_retract")!
      .execute({ target: written.target, expectedRevision: written.revision }, exec)) as { recovered: boolean; indexSynced: boolean };
    expect(retracted).toMatchObject({ recovered: true, indexSynced: true });

    expect((await context.tools.get("memory_search")!.execute({ query: "蓝色灯塔" }, exec) as { results: unknown[] }).results).toEqual([]);
    await expect(context.tools.get("memory_read")!.execute({ target: written.target }, exec)).rejects.toThrow();
  });
});
