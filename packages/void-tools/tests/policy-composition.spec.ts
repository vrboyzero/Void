import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import * as VoidToolsContracts from "../src/registry.js";
import * as VoidToolsPolicy from "../src/policy.js";
import type { VoidToolContracts } from "../src/registry.js";

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
    ["@void/void-tools/registry", VoidToolsContracts],
    ["@void/void-tools/policy", VoidToolsPolicy],
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
  await ctx.loader.create({ name: "@void/void-tools/registry" });
  await ctx.loader.create({
    name: "@void/void-tools/policy",
    config: {
      contracts: [{ name: "void_exec", family: "command-exec", isReadOnly: false, needsPermission: true, riskLevel: "high" }],
      rolePolicy: { role: "researcher", allowedToolFamilies: ["workspace-read"], maxToolRiskLevel: "medium" },
    },
  });
  await ctx.loader.await();
  return ctx;
}

describe("void tools governance through the Loader", () => {
  it("registers contracts and wires the guard (HMR-safe)", async () => {
    context = await boot();
    const registry = context.get("voidToolContracts") as VoidToolContracts;
    expect(registry).toBeDefined();
    expect(registry.get("void_exec")?.family).toBe("command-exec");
    // policy plugin reached ACTIVE => its apply() registered the guard without error.
    expect(findFiber(context, "void-tools-policy")?.state).toBe(ACTIVE);
  });

  it("releases the contract when the registry provider is disposed", async () => {
    context = await boot();
    const registry = context.get("voidToolContracts") as VoidToolContracts;
    expect(registry.get("void_exec")).toBeDefined();

    const provider = findFiber(context, "VoidToolContracts");
    expect(provider).toBeDefined();
    await provider!.dispose();
    expect(context.get("voidToolContracts")).toBeUndefined();
  });
});
