import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import * as VoidSoulPlugin from "@void/void-soul/plugin";
import { loadProfileSummaries, loadSessionBindings, loadSoulRegistry, saveProfileDisplayFields, saveSessionBindings } from "@void/void-soul";
import * as VoidMemoryProvider from "@void/void-memory/provider";
import * as VoidMemoryTool from "@void/void-memory/tool";

/**
 * 「改名不改 id」的跨包证据（P1 / 17.2 第二条退出条件）。
 *
 * 要证明的事：把档案的显示名从「小贝」改成「贝总」，**身份还是 `xiaobei`**——会话绑定不断、
 * 记忆根不动、提示词照样装得进去；反过来，谁要是把 `id` 改了，绑定当场悬空，记忆也不会
 * 自己跟过去。
 *
 * 为什么非要跨包测：灵魂侧的单测只证明「SOUL.md 里其余字段与正文一个字节没动」；记忆侧的单测
 * 只证明「记忆按 `agents/<档案 id>/` 存放」。两件事各自成立时，「改个名字不会把记忆弄丢」仍然
 * 是一句没人验过的缺席——而它一旦坏了，坏的方式是**安静的**：档案还在、记忆还在，只是不再
 * 互相认得，界面上看什么都不缺。
 *
 * 夹具故意让目录名（`小贝`）与档案 id（`xiaobei`）不同：这正是真实数据根里的样子，也是
 * 「目录名只是位置，id 才是身份」这句话唯一能被证伪的地方。
 */

const SOUL_SENTINEL = "SOUL-改名前的底线";
const MEMORY_SENTINEL = "MEMORY-改名前写下的记忆";

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

/** 档案 front matter。`id` 是身份，目录名只是位置——两者在这里故意不同。 */
function soulMarkdown(input: { id: string; name: string }): string {
  return ["---", `id: ${input.id}`, `name: ${input.name}`, "summary: 统筹", "---", "# 底线", "", SOUL_SENTINEL, ""].join("\n");
}

/**
 * 造一个隔离数据根（临时 home + `void-data/web`）：档案在 `agents/小贝/`（id `xiaobei`），
 * 记忆在 `agents/xiaobei/`（按 id 走），会话 `s1` 绑到 `xiaobei`。灵魂与记忆都指向它。
 */
async function boot(): Promise<{ ctx: Context; dataDir: string; soulPath: string }> {
  home = await mkdtemp(join(tmpdir(), "void-rename-closure-"));
  const dataDir = join(home, "void-data", "web");
  await mkdir(join(dataDir, "agents", "小贝"), { recursive: true });
  await mkdir(join(dataDir, "agents", "xiaobei"), { recursive: true });
  const soulPath = join(dataDir, "agents", "小贝", "SOUL.md");
  await writeFile(soulPath, soulMarkdown({ id: "xiaobei", name: "小贝" }), "utf8");
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
  await ctx.loader.create({ name: "@deepseek-ai/dsh-system-prompt" });
  await ctx.loader.create({ name: "@deepseek-ai/dsh-tools" });
  await ctx.loader.create({ id: "void-soul", name: "@void/void-soul/plugin" });
  await ctx.loader.create({ name: "@void/void-memory/provider", config: { dataDir } });
  await ctx.loader.create({ name: "@void/void-memory/tool" });
  await ctx.loader.await();
  return { ctx, dataDir, soulPath };
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

/** 灵魂的登记走的是 fire-and-forget 的 promise 链（里面要读磁盘），等它落定再看结果。 */
async function sectionsFor(ctx: Context, sessionId: string, settleMs = 300): Promise<RecordedSection[]> {
  const sections: RecordedSection[] = [];
  ctx.emit("agent/created", { agent: recordingAgent(sessionId, sections) });
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  return sections;
}

describe("改名不改 id：显示名与身份分开", () => {
  it("改显示名之后，id、目录、绑定、记忆根都不动，提示词照样装得进去", async () => {
    const booted = await boot();
    context = booted.ctx;
    const memoryPath = join(booted.dataDir, "agents", "xiaobei", "MEMORY.md");
    const memoryBefore = await readFile(memoryPath, "utf8");

    const before = (await loadProfileSummaries(booted.dataDir)).find((item) => item.id === "xiaobei")!;
    expect(before.name).toBe("小贝");
    expect(before.directoryName).toBe("小贝");
    expect(before.boundSessions).toEqual(["s1"]);

    const saved = await saveProfileDisplayFields(booted.dataDir, {
      profileId: "xiaobei",
      changes: { name: "贝总" },
      expectedRevision: before.revision,
    });
    expect(saved.name).toBe("贝总");
    // 改了名字，身份一个字节没动：id、目录、绑定都还在原地。
    expect(saved.id).toBe("xiaobei");
    expect(saved.directoryName).toBe("小贝");
    expect(saved.boundSessions).toEqual(["s1"]);
    expect(saved.revision).not.toBe(before.revision);

    // 注册表里还是只有 `xiaobei` 这一份，`贝总` 不是新的身份。
    const registry = await loadSoulRegistry(booted.dataDir);
    expect([...registry.keys()]).toEqual(["xiaobei"]);
    expect(registry.get("xiaobei")?.frontMatter.name).toBe("贝总");
    expect(registry.has("贝总")).toBe(false);

    // 文件层面：`id:` 那一行没动，改的只是 `name:`。
    const soulRaw = await readFile(booted.soulPath, "utf8");
    expect(soulRaw).toContain("id: xiaobei");
    expect(soulRaw).toContain("name: 贝总");
    expect(soulRaw).toContain(SOUL_SENTINEL);

    // 记忆根按 id 走，所以改名之后一个字节都不该动。
    expect(await readFile(memoryPath, "utf8")).toBe(memoryBefore);
    expect((await loadSessionBindings(booted.dataDir)).get("s1")).toBe("xiaobei");

    // 最有分量的一条：改完名字，这条绑定仍然解析得到档案，说明书照常进模型。
    const sections = await sectionsFor(booted.ctx, "s1");
    expect(sections.map((section) => section.name)).toContain("void:soul");
    expect(sections.map((section) => section.text ?? "").join("\n")).toContain(SOUL_SENTINEL);
  });

  it("改名入口碰不到 id：递上去就被拒，磁盘上那一行也不动", async () => {
    const booted = await boot();
    context = booted.ctx;
    const before = (await loadProfileSummaries(booted.dataDir)).find((item) => item.id === "xiaobei")!;

    await expect(
      saveProfileDisplayFields(booted.dataDir, { profileId: "xiaobei", changes: { id: "xiaobei2" }, expectedRevision: before.revision }),
    ).rejects.toThrow("灵魂档案只允许改显示名与头像: id");

    expect(await readFile(booted.soulPath, "utf8")).toContain("id: xiaobei");
    expect([...(await loadSoulRegistry(booted.dataDir)).keys()]).toEqual(["xiaobei"]);
  });

  it("手工把 id 改了：旧绑定当场悬空，记忆不会自己跟过去", async () => {
    const booted = await boot();
    context = booted.ctx;
    // 绕过入口直接改文件——模拟有人手工编辑 front matter。
    await writeFile(booted.soulPath, soulMarkdown({ id: "xiaobei2", name: "小贝" }), "utf8");

    const registry = await loadSoulRegistry(booted.dataDir);
    expect([...registry.keys()]).toEqual(["xiaobei2"]);
    // 绑定还指着旧 id：这就是「悬空」。
    expect((await loadSessionBindings(booted.dataDir)).get("s1")).toBe("xiaobei");

    // 先确认插件是活的，不然「没登记 section」只是因为根本没跑。
    expect(booted.ctx.get("voidMemory")).toBeDefined();
    const sections = await sectionsFor(booted.ctx, "s1");
    expect(sections).toEqual([]);

    // 记忆还在磁盘上，只是没人认领了——所以 id 不是能随手改的东西。
    expect(await readFile(join(booted.dataDir, "agents", "xiaobei", "MEMORY.md"), "utf8")).toContain(MEMORY_SENTINEL);
    expect((await loadProfileSummaries(booted.dataDir)).map((item) => item.id)).toEqual(["xiaobei2"]);
  });
});
