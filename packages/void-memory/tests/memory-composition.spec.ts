import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import * as VoidMemorySqlite from "../src/sqlite.js";
import * as VoidMemoryTool from "../src/tool.js";
import type { VoidMemory } from "../src/service.js";

// ACTIVE (2); FiberState is a const enum erased at runtime.
const ACTIVE = 2;

let context: Context | undefined;

afterEach(async () => {
  await context?.fiber.dispose();
  context = undefined;
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
    ["@void/void-memory/sqlite", VoidMemorySqlite],
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
  await ctx.loader.create({ name: "@void/void-memory/sqlite" });
  await ctx.loader.create({ name: "@void/void-memory/tool" });
  await ctx.loader.await();
  return ctx;
}

describe("void memory through the Loader", () => {
  it("provides voidMemory and round-trips FTS5 + vec0 search", async () => {
    context = await boot();
    const memory = context.get("voidMemory") as VoidMemory;
    expect(memory).toBeDefined();

    const id = memory.store("the void remembers hello world", new Float32Array([0.1, 0.2, 0.3, 0.4]));
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    const fts = memory.search("void", 5);
    expect(fts.length).toBeGreaterThan(0);
    expect(fts[0]!.content).toContain("hello world");

    const vec = memory.searchByVector(new Float32Array([0.1, 0.2, 0.3, 0.4]), 5);
    expect(vec.length).toBeGreaterThan(0);
    expect(vec[0]!.content).toContain("hello world");
    expect(vec[0]!.score).toBeGreaterThan(0);

    // Consumer tool registered + model-visible.
    expect(context.tools.get("memory_search")).toBeDefined();
    expect(context.tools.schemas().some((s) => s.name === "memory_search")).toBe(true);
  });

  it("releases voidMemory when the provider is disposed (HMR-safe)", async () => {
    context = await boot();
    expect(context.get("voidMemory")).toBeDefined();

    const provider = findFiber(context, "VoidMemorySqlite");
    expect(provider).toBeDefined();
    await provider!.dispose();

    expect(context.get("voidMemory")).toBeUndefined();
    expect(context.tools.get("memory_search")).toBeUndefined();
  });

  it("rebuilds the vector table on a dimension change without residue", async () => {
    context = await boot();
    const memory = context.get("voidMemory") as VoidMemory;

    memory.store("first chunk with four dims", new Float32Array([1, 2, 3, 4]));
    // Dimension change triggers a vec0 rebuild (snapshot semantics: no throw, no residue).
    memory.store("second chunk with three dims", new Float32Array([1, 2, 3]));

    // Both chunks remain keyword-searchable (no corruption after rebuild).
    expect(memory.search("first", 5).length).toBeGreaterThan(0);
    expect(memory.search("second", 5).length).toBeGreaterThan(0);
  });

  it("ingests a document into blank-line-delimited chunks", async () => {
    context = await boot();
    const memory = context.get("voidMemory") as VoidMemory;

    const count = memory.ingest("chunk one about void\n\nchunk two about memory\n\nchunk three about legion");
    expect(count).toBe(3);
    expect(memory.search("legion", 5).length).toBeGreaterThan(0);
    expect(memory.search("memory", 5).length).toBeGreaterThan(0);
  });
});
