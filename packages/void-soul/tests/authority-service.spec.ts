import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import { afterEach, describe, expect, it } from "vitest";
import SoulAuthority from "../src/authority-service.js";
import { saveSessionBindings } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDataDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "void-authority-"));
  roots.push(root);
  await mkdir(path.join(root, "agents"), { recursive: true });
  return root;
}

async function writeSoul(dataDir: string, directory: string, lines: readonly string[]): Promise<void> {
  const dir = path.join(dataDir, "agents", directory);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SOUL.md"), [...lines, ""].join("\n"), "utf8");
}

function boss(extra: readonly string[] = []): string[] {
  return ["---", "id: laoban", "name: 老板", "summary: 主人", ...extra, "---"];
}

describe("voidAuthority", () => {
  it("没绑定的会话解析不出身份：返回 undefined，而不是给个默认身份", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝", ["---", "id: xiaobei", "name: 小贝", "summary: 统筹", "---"]);
    const authority = new SoulAuthority(new Context(), { dataDir });
    expect(await authority.forSession("session-a")).toBeUndefined();
  });

  it("绑定后给出派活者与整份身份图，关掉 authority 的档案留在图里但没有任何边", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝", [
      "---", "id: xiaobei", "name: 小贝", "summary: 统筹",
      "authority:", "  superiors: [laoban]", "  subordinates: [xiaoma]", "---",
    ]);
    await writeSoul(dataDir, "小码", ["---", "id: xiaoma", "name: 小码", "summary: 干活", "authority:", "  enabled: false", "---"]);
    await writeSoul(dataDir, "老板", boss());
    await saveSessionBindings(dataDir, new Map([["session-a", "xiaobei"]]));

    const authority = new SoulAuthority(new Context(), { dataDir });
    const snapshot = await authority.forSession("session-a");
    expect(snapshot?.actorId).toBe("xiaobei");
    expect([...(snapshot?.profiles.keys() ?? [])].sort()).toEqual(["laoban", "xiaobei", "xiaoma"]);
    expect(snapshot?.profiles.get("xiaobei")).toEqual({ id: "xiaobei", superiors: ["laoban"], subordinates: ["xiaoma"] });
    // 关掉开关只是把这份档案从身份图里摘出去，不是「默认是上级」。
    expect(snapshot?.profiles.get("xiaoma")).toEqual({ id: "xiaoma", superiors: [], subordinates: [] });
  });

  it("会话绑到不存在的档案就拒绝，不悄悄当成没绑定", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝", ["---", "id: xiaobei", "name: 小贝", "summary: 统筹", "---"]);
    await saveSessionBindings(dataDir, new Map([["session-a", "ghost"]]));
    const authority = new SoulAuthority(new Context(), { dataDir });
    await expect(authority.forSession("session-a")).rejects.toThrow(/没有这份档案，拒绝进入模型: ghost/);
  });

  it("空会话 id 直接拒绝：解析身份不能靠猜", async () => {
    const dataDir = await tempDataDir();
    const authority = new SoulAuthority(new Context(), { dataDir });
    await expect(authority.forSession("   ")).rejects.toThrow(/解析派活身份缺少会话 id/);
  });

  it("每次调用重读磁盘：人类改完 SOUL.md，下一次派活就生效", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝", ["---", "id: xiaobei", "name: 小贝", "summary: 统筹", "---"]);
    await saveSessionBindings(dataDir, new Map([["session-a", "xiaobei"]]));
    const authority = new SoulAuthority(new Context(), { dataDir });
    expect((await authority.forSession("session-a"))?.profiles.get("xiaobei")?.superiors).toEqual([]);

    await writeSoul(dataDir, "老板", boss());
    await writeSoul(dataDir, "小贝", [
      "---", "id: xiaobei", "name: 小贝", "summary: 统筹",
      "authority:", "  superiors: [laoban]", "---",
    ]);
    const after = await authority.forSession("session-a");
    expect(after?.profiles.get("xiaobei")?.superiors).toEqual(["laoban"]);
    expect(after?.profiles.has("laoban")).toBe(true);
  });

  it("经 Loader 装配后登记为 voidAuthority，数据根就是配置里那个", async () => {
    const dataDir = await tempDataDir();
    const ctx = new Context();
    await ctx.plugin(Loader);
    const modules = new Map<string, unknown>([["@void/void-soul/authority-service", SoulAuthority]]);
    ctx.loader.internal = {
      version: "v2",
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`);
        return modules.get(specifier);
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>;
    await ctx.loader.create({ name: "@void/void-soul/authority-service", config: { dataDir } });
    await ctx.loader.await();

    const service = ctx.get("voidAuthority") as SoulAuthority | undefined;
    expect(service).toBeInstanceOf(SoulAuthority);
    expect(service?.dataRoot).toBe(dataDir);
  });

  it("personaFor 按档案 id 取身份：要的是成员自己的底线，不是会话绑定的那份", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝", ["---", "id: xiaobei", "name: 小贝", "summary: 统筹", "---", "", "你是小贝。"]);
    await writeSoul(dataDir, "小码", ["---", "id: xiaoma", "name: 小码", "summary: 干活", "---", "", "你是小马。"]);
    await saveSessionBindings(dataDir, new Map([["session-a", "xiaobei"]]));

    const authority = new SoulAuthority(new Context(), { dataDir });
    // 派活会话绑的是小贝，但 lane 成员是小马：拿到的是**小马**的身份。
    expect(await authority.personaFor("xiaoma")).toBe("你是小马。");
    await expect(authority.personaFor("ghost")).rejects.toThrow(/没有这份档案，取不出派活身份: ghost/);
  });

  it("没配数据根也照常加载，用到才报错：漏一个 DSH_PROFILE 不该掀掉整棵插件树", async () => {
    // profile 给空串 = 明确「没配档案名」，与 DSH_PROFILE 未设同义（不依赖测试进程的环境）。
    const authority = new SoulAuthority(new Context(), { profile: "" });
    expect(authority.dataRoot).toBeUndefined();
    await expect(authority.forSession("session-a")).rejects.toThrow(/权威档案没有数据根，无法解析派活身份/);
    await expect(authority.personaFor("xiaoma")).rejects.toThrow(/权威档案没有数据根，取不出派活身份/);
  });
});
