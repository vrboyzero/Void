import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import SoulLibrary from "../src/soul-service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("voidSoul（面板门面）", () => {
  it("有数据根时照常读写，数据根就是配置里那个", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "void-soul-service-"));
    roots.push(root);
    await mkdir(path.join(root, "agents", "facets"), { recursive: true });
    const service = new SoulLibrary(new Context(), { dataDir: root });
    expect(service.dataRoot).toBe(root);
    expect(await service.listProfiles()).toEqual([]);
  });

  it("数据根还在、但 agents 目录还没建出来时，列档案与列模组都回空表而不是报错", async () => {
    // 首次运行就是这个形状：装完插件、数据根还没写过任何东西（2026-09-22 在 tarball 装的 profile 上真机抓到 500）。
    const root = await mkdtemp(path.join(tmpdir(), "void-soul-fresh-"));
    roots.push(root);
    const service = new SoulLibrary(new Context(), { dataDir: root });
    expect(await service.listProfiles()).toEqual([]);
    expect(await service.listFacets()).toEqual([]);
    expect(existsSync(path.join(root, "agents"))).toBe(false);
  });

  it("没配数据根也照常加载，用到才报错：方法与 forSession 一样是 reject，不是同步抛", async () => {
    // profile 给空串 = 明确「没配档案名」，与 DSH_PROFILE 未设同义（不依赖测试进程的环境）。
    const service = new SoulLibrary(new Context(), { profile: "" });
    expect(service.dataRoot).toBeUndefined();
    await expect(service.listProfiles()).rejects.toThrow(/灵魂档案没有数据根，无法读写档案与模组/);
    await expect(service.listBindings()).rejects.toThrow(/灵魂档案没有数据根/);
  });

  it("删档案走的是库函数：搬走档案、留下记忆，门面不自己实现一套", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "void-soul-delete-"));
    roots.push(root);
    const soul = ["---", "id: xiaobei", "name: 小贝", "summary: 主人的贴身助手", "---", "", "底线正文。", ""].join("\n");
    await mkdir(path.join(root, "agents", "小贝"), { recursive: true });
    await mkdir(path.join(root, "agents", "xiaobei"), { recursive: true });
    await writeFile(path.join(root, "agents", "小贝", "SOUL.md"), soul, "utf8");
    await writeFile(path.join(root, "agents", "xiaobei", "MEMORY.md"), "长期记忆：主人只喝美式。\n", "utf8");
    const service = new SoulLibrary(new Context(), { dataDir: root });

    const deleted = await service.deleteProfile({ profileId: "xiaobei" });

    expect(deleted.movedTo).toMatch(/^trash\//);
    expect(deleted.moved).toEqual(["SOUL.md"]);
    expect(existsSync(path.join(root, "agents", "小贝", "SOUL.md"))).toBe(false);
    expect(existsSync(path.join(root, "agents", "xiaobei", "MEMORY.md"))).toBe(true);
    expect(await service.listProfiles()).toEqual([]);
  });

  it("停用/启用也走库函数：门面只转调，记忆与聊天记录照样不动", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "void-soul-suspend-"));
    roots.push(root);
    const soul = ["---", "id: xiaobei", "name: 小贝", "summary: 主人的贴身助手", "---", "", "底线正文。", ""].join("\n");
    await mkdir(path.join(root, "agents", "小贝"), { recursive: true });
    await mkdir(path.join(root, "agents", "xiaobei"), { recursive: true });
    await writeFile(path.join(root, "agents", "小贝", "SOUL.md"), soul, "utf8");
    await writeFile(path.join(root, "agents", "xiaobei", "MEMORY.md"), "长期记忆：主人只喝美式。\n", "utf8");
    const service = new SoulLibrary(new Context(), { dataDir: root });

    const suspended = await service.setProfileSuspended({ profileId: "xiaobei", suspended: true, note: "先歇一会" });
    expect(suspended).toMatchObject({ profileId: "xiaobei", suspended: true, stateFile: path.join("agents", "小贝", "state.json") });
    expect((await service.listProfiles())[0]).toMatchObject({ id: "xiaobei", suspended: true });
    expect(await service.loadSuspensionHistory("xiaobei")).toHaveLength(1);
    expect((await service.inspectProfile("xiaobei")).reclaimScope.some((entry) => entry.path === path.join("agents", "xiaobei"))).toBe(true);
    expect(await readFile(path.join(root, "agents", "小贝", "SOUL.md"), "utf8")).toBe(soul);
    expect(existsSync(path.join(root, "agents", "xiaobei", "MEMORY.md"))).toBe(true);

    const back = await service.setProfileSuspended({ profileId: "xiaobei", suspended: false });
    expect(back.suspended).toBe(false);
    expect((await service.listProfiles())[0]?.suspended).toBe(false);
  });

  it("没配数据根时三个新方法一样是 reject，不是同步抛", async () => {
    const service = new SoulLibrary(new Context(), { profile: "" });
    await expect(service.setProfileSuspended({ profileId: "xiaobei", suspended: true })).rejects.toThrow(/灵魂档案没有数据根/);
    await expect(service.inspectProfile("xiaobei")).rejects.toThrow(/灵魂档案没有数据根/);
    await expect(service.loadSuspensionHistory("xiaobei")).rejects.toThrow(/灵魂档案没有数据根/);
  });
});
