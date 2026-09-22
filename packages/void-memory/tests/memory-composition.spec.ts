import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import * as VoidMemoryFiles from "../src/provider.js";
import * as VoidMemoryTool from "../src/tool.js";
import type { VoidMemory } from "../src/service.js";

// ACTIVE (2); FiberState is a const enum erased at runtime.
const ACTIVE = 2;

let context: Context | undefined;
let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "void-memory-composition-"));
});

afterEach(async () => {
  await context?.fiber.dispose();
  context = undefined;
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function findFiber(ctx: Context, pluginName: string) {
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers) {
      if (fiber.name === pluginName) return fiber;
    }
  }
  return undefined;
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
  // Sequential: Include's Promise.allSettled fan-out drops nested-service providers (Spike finding).
  await ctx.loader.create({ name: "@deepseek-ai/dsh-system-prompt" });
  await ctx.loader.create({ name: "@deepseek-ai/dsh-tools" });
  await ctx.loader.create({ name: "@void/void-memory/provider", config: { dataDir } });
  await ctx.loader.create({ name: "@void/void-memory/tool" });
  await ctx.loader.await();
  return ctx;
}

describe("void memory through the Loader", () => {
  it("provides voidMemory and keeps two archives mutually invisible", async () => {
    context = await boot();
    const memory = context.get("voidMemory") as VoidMemory;
    expect(memory).toBeDefined();

    const xiaobei = memory.forAgent({ agentId: "xiaobei" });
    const xiaoma = memory.forAgent({ agentId: "xiaoma" });

    const written = await xiaobei.write({ body: "小贝记住：虚空之钥在星港第三码头", target: "long-term" });
    expect(written.revision).toBe(1);
    expect(written.indexSynced).toBe(true);

    const own = await xiaobei.search({ query: "虚空之钥" });
    expect(own.length).toBeGreaterThan(0);
    expect(own[0]!.snippet).toContain("星港");

    // A 记的 B 查不到。
    expect(await xiaoma.search({ query: "虚空之钥" })).toEqual([]);
    expect(await xiaoma.list()).toMatchObject({ total: 0, entries: [] });

    // 落盘是 Markdown，模型不参与路径选择。
    const longTerm = await readFile(join(dataDir, "agents", "xiaobei", "MEMORY.md"), "utf8");
    expect(longTerm).toContain("虚空之钥");
  });

  it("registers the six memory tools model-visibly", async () => {
    context = await boot();
    const names = context.tools
      .schemas()
      .map((schema) => schema.name)
      .filter((name) => name.startsWith("memory_"))
      .sort();
    expect(names).toEqual(["memory_list", "memory_read", "memory_retract", "memory_search", "memory_update", "memory_write"]);
  });

  it("releases voidMemory when the provider is disposed (HMR-safe)", async () => {
    context = await boot();
    expect(context.get("voidMemory")).toBeDefined();

    const provider = findFiber(context, "VoidMemoryFiles");
    expect(provider).toBeDefined();
    await provider!.dispose();

    expect(context.get("voidMemory")).toBeUndefined();
    expect(context.tools.get("memory_search")).toBeUndefined();
  });
});
