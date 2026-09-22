import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import * as VoidSoulPlugin from "@void/void-soul/plugin";
import { saveSessionBindings } from "@void/void-soul";
import * as VoidMemoryProvider from "@void/void-memory/provider";
import * as VoidMemoryTool from "@void/void-memory/tool";

/**
 * 「无自动注入」的跨包证据（P3 / 17.2 最后一条，M7）。
 *
 * 要证明的事：带灵魂的会话进模型时，提示词里**只有说明书**；记忆正文一个字节都不进提示词，
 * 它只能由模型主动调 `memory_*` 工具读出来。
 *
 * 为什么非要跨包测：灵魂侧的单测证明「说明书登记了 section」，记忆侧的单测证明「六个工具注册了」。
 * 两件事各自成立时，「记忆没有偷偷塞进提示词」仍然只是一句没人验过的缺席——而缺席最容易在某次
 * 「顺手把记忆摘要加进上下文」的改动里被破坏，且破坏了没有任何用例会红。
 *
 * 做法：真 Loader + 真 SystemPrompt 服务 + 真灵魂插件 + 真记忆插件，在同一个假 Agent 上收集
 * 所有 section 登记。哨兵同时写进 `SOUL.md` 与 `MEMORY.md`：说明书哨兵**必须**出现（这是收集器
 * 活着的正向对照），记忆哨兵**必须**不出现（且单独有用例证明它确实躺在磁盘上，不是没写进去）。
 */

const SOUL_SENTINEL = "SOUL-只在说明书里";
const MEMORY_SENTINEL = "MEMORY-只在记忆里";
const GUIDE_SENTINEL = "GUIDE-先自我介绍";

interface RecordedSection {
  name?: string;
  order?: number;
  text?: string;
}

let context: Context | undefined;
let home: string | undefined;

// 开发机上可能真设了 DSH_*（那就是日常 home）。一律清掉，用例只用自己的临时目录。
beforeEach(() => {
  delete process.env.DSH_HOME;
  delete process.env.DSH_PROFILE;
});

afterEach(async () => {
  await context?.fiber.dispose();
  context = undefined;
  if (home !== undefined) {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    home = undefined;
  }
});

/**
 * 造一个隔离数据根（临时 home + `void-data/web`），把灵魂与记忆都指向它。
 * 会话 `s1` 绑定档案 `xiaobei`——没有绑定的话灵魂会安静跳过，用例就变成了空转。
 */
async function boot(options: { soul: boolean; memory: boolean; guide?: string }): Promise<{ ctx: Context; dataDir: string }> {
  home = await mkdtemp(join(tmpdir(), "void-prompt-closure-"));
  const dataDir = join(home, "void-data", "web");
  await mkdir(join(dataDir, "agents", "xiaobei"), { recursive: true });
  await writeFile(
    join(dataDir, "agents", "xiaobei", "SOUL.md"),
    [
      "---",
      "id: xiaobei",
      "name: 小贝",
      "summary: 统筹",
      ...(options.guide === undefined ? [] : [`firstMeeting: ${options.guide}`]),
      "---",
      "# 底线",
      "",
      SOUL_SENTINEL,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(dataDir, "agents", "xiaobei", "MEMORY.md"),
    ["---", "revision: 1", "updatedAt: 2026-09-22T00:00:00.000Z", "---", MEMORY_SENTINEL, ""].join("\n"),
    "utf8",
  );
  await saveSessionBindings(dataDir, new Map([["s1", "xiaobei"]]));
  process.env.DSH_HOME = home;
  process.env.DSH_PROFILE = "web";

  const ctx = new Context();
  await ctx.plugin(Loader);
  const modules = new Map<string, unknown>([
    ["@deepseek-ai/dsh-system-prompt", SystemPrompt],
    ["@deepseek-ai/dsh-tools", ToolRuntime],
    ["@void/void-soul/plugin", VoidSoulPlugin],
    ["@void/void-memory/provider", VoidMemoryProvider],
    ["@void/void-memory/tool", VoidMemoryTool],
  ]);
  ctx.loader.internal = {
    version: "v2",
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`);
      return modules.get(specifier);
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>;
  // 顺序加载：Include 的并发 fan-out 会丢嵌套 provider（Spike 结论）。
  await ctx.loader.create({ name: "@deepseek-ai/dsh-system-prompt" });
  await ctx.loader.create({ name: "@deepseek-ai/dsh-tools" });
  if (options.soul) await ctx.loader.create({ id: "void-soul", name: "@void/void-soul/plugin" });
  if (options.memory) {
    await ctx.loader.create({ name: "@void/void-memory/provider", config: { dataDir } });
    await ctx.loader.create({ name: "@void/void-memory/tool" });
  }
  await ctx.loader.await();
  return { ctx, dataDir };
}

/** 假 Agent：只记下别人往它的提示词里塞了什么。 */
function recordingAgent(id: string, sections: RecordedSection[]) {
  return {
    id,
    ctx: {
      systemPrompt: {
        section(section: RecordedSection) {
          sections.push(section);
          return () => undefined;
        },
      },
    },
  };
}

/** 灵魂的登记走的是 fire-and-forget 的 promise 链（里面要读磁盘），等到它落地为止。 */
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("提示词闭环：说明书进模型，记忆不进模型", () => {
  it("说明书登记了 section，记忆正文一个字节都没进提示词", async () => {
    const booted = await boot({ soul: true, memory: true });
    context = booted.ctx;
    const sections: RecordedSection[] = [];
    context.emit("agent/created", { agent: recordingAgent("s1", sections) });
    await waitFor(() => sections.length > 0);

    const text = sections.map((section) => section.text ?? "").join("\n");
    // 正向对照：同一个收集器确实抓到了说明书（不然下面的「没抓到记忆」什么都证明不了）。
    expect(sections.map((section) => section.name)).toContain("void:soul");
    expect(text).toContain(SOUL_SENTINEL);
    expect(text).not.toContain(MEMORY_SENTINEL);
    // 提示词的通道就这两条（说明书 + 本次模组）：多一条都算自动注入。
    expect(sections.length).toBeLessThanOrEqual(2);
    // 工具描述也是提示词的一部分：记忆正文同样不该从这里漏出去。
    expect(JSON.stringify(context.tools.schemas())).not.toContain(MEMORY_SENTINEL);
    // 记忆仍然可用——只是要模型自己开口要。
    const names = context.tools
      .schemas()
      .map((schema) => schema.name)
      .filter((name) => name.startsWith("memory_"))
      .sort();
    expect(names).toEqual(["memory_list", "memory_read", "memory_retract", "memory_search", "memory_update", "memory_write"]);
  });

  it("记忆插件单独在场时，一个 section 都不登记", async () => {
    const booted = await boot({ soul: false, memory: true });
    context = booted.ctx;
    // 先确认记忆真的装上了：不然「没登记 section」只是因为它根本没跑。
    expect(context.get("voidMemory")).toBeDefined();
    expect(context.tools.get("memory_search")).toBeDefined();
    const sections: RecordedSection[] = [];
    context.emit("agent/created", { agent: recordingAgent("s1", sections) });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sections).toEqual([]);
  });

  it("记忆哨兵确实躺在磁盘上（不是没写进去才搜不到）", async () => {
    const booted = await boot({ soul: false, memory: true });
    context = booted.ctx;
    const raw = await readFile(join(booted.dataDir, "agents", "xiaobei", "MEMORY.md"), "utf8");
    expect(raw).toContain(MEMORY_SENTINEL);
  });

  it("首次见面引导跟着说明书进模型，记忆仍然不进：引导来自档案，不是记忆", async () => {
    const booted = await boot({ soul: true, memory: true, guide: GUIDE_SENTINEL });
    context = booted.ctx;
    const sections: RecordedSection[] = [];
    context.emit("agent/created", { agent: recordingAgent("s1", sections) });
    await waitFor(() => sections.some((section) => section.name === "void:first-meeting"));

    // 没有模组，所以这一轮提示词的通道正好是两条：说明书 + 引导。
    expect(sections.map((section) => section.name)).toEqual(["void:soul", "void:first-meeting"]);
    expect(sections.map((section) => section.order)).toEqual([1, 3]);
    const text = sections.map((section) => section.text ?? "").join("\n");
    expect(text).toContain(GUIDE_SENTINEL);
    expect(text).not.toContain(MEMORY_SENTINEL);
    expect(JSON.stringify(context.tools.schemas())).not.toContain(MEMORY_SENTINEL);
  });
});
