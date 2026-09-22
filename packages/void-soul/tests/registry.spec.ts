import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppliedPromptRegistry, describeAppliedRecord, loadFacetLibrary, recordAppliedPrompt, snapshotPrompt, SoulProfileError, bindSession, facetViewRegistration, loadFacetRegistrations, loadFirstMeetingView, loadProfileFacetRegistrations, loadSavedFacetView, loadSessionBindings, loadSoulRegistry, resolveBinding, saveFacetSelection, saveFirstMeetingState, saveProfileFacetSelection, saveSessionBindings } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDataDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "void-soul-"));
  roots.push(root);
  await mkdir(path.join(root, "agents", "facets"), { recursive: true });
  return root;
}

async function writeSoul(dataDir: string, directory: string, id: string, firstMeeting?: string): Promise<void> {
  const dir = path.join(dataDir, "agents", directory);
  await mkdir(dir, { recursive: true });
  const guide = firstMeeting === undefined ? "" : `firstMeeting: ${firstMeeting}\n`;
  await writeFile(path.join(dir, "SOUL.md"), `---\nid: ${id}\nname: ${directory}\nsummary: 测试\n${guide}---\n# ${id}\n`, "utf8");
}

describe("loadSoulRegistry", () => {
  it("读取各档案并跳过共用模组库", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝", "xiaobei");
    await writeSoul(dataDir, "小码", "xiaoma");
    await writeFile(path.join(dataDir, "agents", "facets", "开发专家.md"), "# 模组", "utf8");
    const registry = await loadSoulRegistry(dataDir);
    expect([...registry.keys()].sort()).toEqual(["xiaobei", "xiaoma"]);
    expect(registry.get("xiaobei")?.directoryName).toBe("小贝");
  });

  it("数据根或 agents 目录还不存在时回空表，而且不建目录", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "void-soul-missing-"));
    roots.push(root);
    const missing = path.join(root, "void-data");
    expect((await loadSoulRegistry(missing)).size).toBe(0);
    expect(existsSync(missing)).toBe(false);
    const empty = path.join(root, "empty");
    await mkdir(empty, { recursive: true });
    expect((await loadSoulRegistry(empty)).size).toBe(0);
    expect(existsSync(path.join(empty, "agents"))).toBe(false);
  });

  it("重复 id 拒绝", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝", "same");
    await writeSoul(dataDir, "贝贝", "same");
    await expect(loadSoulRegistry(dataDir)).rejects.toThrow(/重复/);
  });

  it("SOUL.md 不是 UTF-8 就拒绝，并点名是哪一份档案", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝", "xiaobei");
    const broken = path.join(dataDir, "agents", "坏档案");
    await mkdir(broken, { recursive: true });
    await writeFile(path.join(broken, "SOUL.md"), Buffer.concat([Buffer.from("---\nid: broken\nname: 坏的\n---\n", "utf8"), Buffer.from([0xff, 0xfe])]));
    await expect(loadSoulRegistry(dataDir)).rejects.toThrow(/坏档案 的 SOUL\.md 不是有效的 UTF-8 文本/);
  });

  it("指向数据根外的链接拒绝", async (context) => {
    const dataDir = await tempDataDir();
    const outside = await mkdtemp(path.join(tmpdir(), "void-soul-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "SOUL.md"), "---\nid: leaked\nname: 外部\nsummary: 不该读\n---\n", "utf8");
    try {
      // 目录符号链接（"dir"）在 Windows 上要特权，junction 不要——用 junction 才能真跑到拒绝分支。
      await symlink(outside, path.join(dataDir, "agents", "链接"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      // 本机连 junction 都建不了：标成 skipped 让人看得见，不悄悄当成通过。
      context.skip();
      return;
    }
    await expect(loadSoulRegistry(dataDir)).rejects.toThrow(/档案目录是链接，拒绝读入: 链接（指向数据根外 /);
  });

  it("指向库内的链接也拒绝：链接本身就不该出现在 agents 下", async (context) => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝", "xiaobei");
    try {
      await symlink(path.join(dataDir, "agents", "小贝"), path.join(dataDir, "agents", "小贝的别名"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      context.skip();
      return;
    }
    // 不因为「它指回库内、id 会重复」而放行：链接一律拒绝，报错里说清指向哪里。
    await expect(loadSoulRegistry(dataDir)).rejects.toThrow(/档案目录是链接，拒绝读入: 小贝的别名（指向库内 /);
  });

  it("agents 下的普通文件不是档案，跳过不报错", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝", "xiaobei");
    await writeFile(path.join(dataDir, "agents", "README.md"), "放档案的目录，一个子目录一份 SOUL.md", "utf8");
    const registry = await loadSoulRegistry(dataDir);
    expect([...registry.keys()]).toEqual(["xiaobei"]);
  });

  it("上下级引用了不存在的档案就拒绝：写错一个字母不等于少一条边", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝", "xiaobei");
    await mkdir(path.join(dataDir, "agents", "小码"), { recursive: true });
    await writeFile(path.join(dataDir, "agents", "小码", "SOUL.md"), [
      "---", "id: xiaoma", "name: 小码", "summary: 测试",
      "authority:", "  superiors: [xiaobei, laoban]", "---", "",
    ].join("\n"), "utf8");
    await expect(loadSoulRegistry(dataDir)).rejects.toThrow(/xiaoma 的 superiors 引用了不存在的档案: laoban/);
  });

  it("关掉 authority 的档案可以留着不成立的引用，因为它本来就不在身份图里", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝", "xiaobei");
    await mkdir(path.join(dataDir, "agents", "小码"), { recursive: true });
    await writeFile(path.join(dataDir, "agents", "小码", "SOUL.md"), [
      "---", "id: xiaoma", "name: 小码", "summary: 测试",
      "authority:", "  enabled: false", "---", "",
    ].join("\n"), "utf8");
    const registry = await loadSoulRegistry(dataDir);
    expect([...registry.keys()].sort()).toEqual(["xiaobei", "xiaoma"]);
  });
});

describe("loadSavedFacetView", () => {
  it("从 state.json 读取已保存版本，没有请求时本次生效为空", async () => {
    const dataDir = await tempDataDir();
    await writeFile(path.join(dataDir, "agents", "facets", "dev.md"), "---\nid: dev\nname: 开发专家\nsummary: 写代码\n---\n# 开发\n", "utf8");
    await writeSoul(dataDir, "小贝", "xiaobei");
    await writeFile(path.join(dataDir, "agents", "小贝", "state.json"), JSON.stringify({ schemaVersion: 1, activeFacetId: "dev", selectionRevision: 2 }), "utf8");
    const registry = await loadSoulRegistry(dataDir);
    const view = await loadSavedFacetView(dataDir, registry.get("xiaobei")!);
    expect(view.applied).toBeNull();
    expect(view.saved).toMatchObject({ facetId: "dev", name: "开发专家", summary: "写代码", selectionRevision: 2, pending: false });
    expect(facetViewRegistration(view).lines).toEqual(["已保存：开发专家（写代码）", "本次生效：还没有请求"]);
    const registrations = await loadFacetRegistrations(dataDir, registry);
    expect(registrations.map((item) => item.id)).toEqual(["void-soul:facet-version:xiaobei"]);
    const fromProfile = await loadProfileFacetRegistrations({ dshHome: path.dirname(dataDir), profile: "web", override: dataDir });
    expect(fromProfile.map((item) => item.id)).toEqual(["void-soul:facet-version:xiaobei"]);
    await expect(loadProfileFacetRegistrations({ dshHome: dataDir, profile: "missing" })).resolves.toEqual([]);
    const record = registry.get("xiaobei")!;
    const saved = await saveFacetSelection({ dataDir, record, facetId: null, expectedRevision: 2, soulBody: record.body });
    expect(saved.saved.facetId).toBeNull();
    const soul = await readFile(path.join(dataDir, "agents", "小贝", "SOUL.md"), "utf8");
    expect(soul).toContain("id: xiaobei");
    await expect(saveFacetSelection({ dataDir, record, facetId: "dev", expectedRevision: 2, soulBody: record.body })).rejects.toThrow(/重试/);
    await expect(saveFacetSelection({ dataDir, record, facetId: "dev", expectedRevision: 3, soulBody: "被改过的底线" })).rejects.toThrow(/不能修改底线/);
    const explicit = await saveProfileFacetSelection({ dshHome: path.dirname(dataDir), profile: "web", override: dataDir, agentId: "xiaobei", facetId: "dev", expectedRevision: 3 });
    expect(explicit.saved).toMatchObject({ facetId: "dev", pending: false });
    await expect(saveProfileFacetSelection({ dshHome: dataDir, profile: "web", override: dataDir, agentId: "missing", facetId: null, expectedRevision: 4 })).rejects.toThrow(/没有这份档案/);
  });

  it("给了「上一次请求装进去的那一版」就把本次生效说出来，没给就照实说还没有请求", async () => {
    const dataDir = await tempDataDir();
    await writeFile(path.join(dataDir, "agents", "facets", "dev.md"), "---\nid: dev\nname: 开发专家\nsummary: 写代码\n---\n# 开发\n", "utf8");
    await writeSoul(dataDir, "小贝", "xiaobei");
    await writeFile(path.join(dataDir, "agents", "小贝", "state.json"), JSON.stringify({ schemaVersion: 1, activeFacetId: "dev", selectionRevision: 2 }), "utf8");
    const registry = await loadSoulRegistry(dataDir);
    const record = registry.get("xiaobei")!;
    const cards = await loadFacetLibrary(dataDir);

    // 选中的就是当前这一版：已保存与本次生效一致，没有 pending。
    const same = recordAppliedPrompt({ snapshot: snapshotPrompt({ soulBody: record.body, state: { schemaVersion: 1, activeFacetId: "dev", selectionRevision: 2, firstMeetingDone: false }, cards }), cards });
    const view = await loadSavedFacetView(dataDir, record, same);
    expect(view.saved).toMatchObject({ facetId: "dev", pending: false, pendingReason: null });
    expect(view.applied).toMatchObject({ kind: "applied", facetId: "dev", name: "开发专家", summary: "写代码", selectionRevision: 2 });
    expect(facetViewRegistration(view).lines).toEqual(["已保存：开发专家（写代码）", "本次生效：开发专家（写代码）"]);

    // 面板那条通路：appliedFor 由外面（内存注册表）提供，同一个档案只有一份。
    const applied = new AppliedPromptRegistry();
    applied.remember("xiaobei", same);
    const fromProfile = await loadProfileFacetRegistrations({ dshHome: path.dirname(dataDir), profile: "web", override: dataDir, appliedFor: (agentId) => applied.get(agentId) });
    expect(fromProfile[0]?.lines).toEqual(["已保存：开发专家（写代码）", "本次生效：开发专家（写代码）"]);
    expect((await loadProfileFacetRegistrations({ dshHome: path.dirname(dataDir), profile: "web", override: dataDir }))[0]?.lines[1]).toBe("本次生效：还没有请求");

    // 人类改完模组正文、下一次请求还没来：面板要说「模组正文已改」，并且点明下面那行还是改前那份。
    await writeFile(path.join(dataDir, "agents", "facets", "dev.md"), "---\nid: dev\nname: 开发专家\nsummary: 写代码\n---\n# 开发 v2\n", "utf8");
    const stale = await loadSavedFacetView(dataDir, record, same);
    expect(stale.saved).toMatchObject({ pending: true, pendingReason: "facet-body" });
    expect(facetViewRegistration(stale).lines).toEqual([
      "已保存：开发专家（写代码），模组正文已改，待下一次请求生效",
      "本次生效：开发专家（写代码）（还是改前那份）",
    ]);
    // 「本次生效」那行不回头看现在的盘：模组后来改名或删掉，它照样说得出那次请求用的是什么。
    expect(describeAppliedRecord(recordAppliedPrompt({ snapshot: same.snapshot, cards }))).toMatchObject({ facetId: "dev", name: "开发专家" });
    expect(describeAppliedRecord(recordAppliedPrompt({ snapshot: same.snapshot, cards: new Map() }))).toMatchObject({ facetId: "dev", name: null, summary: null });
  });
});

describe("首次见面引导", () => {
  it("档案写了引导就能标完成：只改 state.json，底线正文一个字节都不动", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝", "xiaobei", "先自我介绍，再问主人怎么称呼。");
    const record = (await loadSoulRegistry(dataDir)).get("xiaobei")!;
    const soulPath = path.join(dataDir, "agents", "小贝", "SOUL.md");
    const before = await readFile(soulPath, "utf8");

    const fresh = await loadFirstMeetingView(dataDir, record);
    expect(fresh).toEqual({ agentId: "xiaobei", name: "小贝", required: true, done: false, guidance: "先自我介绍，再问主人怎么称呼。" });
    expect((await loadSavedFacetView(dataDir, record)).firstMeetingDone).toBe(false);

    const done = await saveFirstMeetingState({ dataDir, record, done: true, soulBody: record.body });
    expect(done).toMatchObject({ required: true, done: true });
    expect((await loadSavedFacetView(dataDir, record)).firstMeetingDone).toBe(true);
    // 落盘的是同一个 state.json：角色选择与修订号都留在原地，只多了一个布尔值。
    const state = JSON.parse(await readFile(path.join(dataDir, "agents", "小贝", "state.json"), "utf8")) as Record<string, unknown>;
    expect(state).toEqual({ schemaVersion: 1, activeFacetId: null, selectionRevision: 0, firstMeetingDone: true, suspended: false });
    expect(await readFile(soulPath, "utf8")).toBe(before);

    // 重来一遍也允许，而且不改底线。
    const again = await saveFirstMeetingState({ dataDir, record, done: false, soulBody: record.body });
    expect(again.done).toBe(false);
    expect(await readFile(soulPath, "utf8")).toBe(before);
  });

  it("没有写引导的档案拒绝标完成，改过底线一律拒绝", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝", "xiaobei");
    const record = (await loadSoulRegistry(dataDir)).get("xiaobei")!;
    await expect(loadFirstMeetingView(dataDir, record)).resolves.toEqual({ agentId: "xiaobei", name: "小贝", required: false, done: false, guidance: null });
    await expect(saveFirstMeetingState({ dataDir, record, done: true, soulBody: record.body })).rejects.toThrow(/没有写首次见面引导，不用标完成: xiaobei/);
    await expect(saveFirstMeetingState({ dataDir, record, done: false, soulBody: "被改过的底线" })).rejects.toThrow(/首次见面状态不能修改底线/);
    expect(existsSync(path.join(dataDir, "agents", "小贝", "state.json"))).toBe(false);
  });
});

describe("session bindings", () => {
  it("保存后能按会话读回，损坏文件拒绝", async () => {
    const dataDir = await tempDataDir();
    await saveSessionBindings(dataDir, new Map([["session-a", "xiaobei"]]));
    expect(await loadSessionBindings(dataDir)).toEqual(new Map([["session-a", "xiaobei"]]));
    await writeFile(path.join(dataDir, "runtime", "session-bindings.json"), "{", "utf8");
    await expect(loadSessionBindings(dataDir)).rejects.toThrow(SoulProfileError);
  });
});

describe("bindSession", () => {
  it("未知档案拒绝，已绑定会话不能改身份", () => {
    const registry = new Map([["xiaobei", { id: "xiaobei" }], ["xiaoma", { id: "xiaoma" }]]) as never;
    const once = bindSession({ bindings: new Map(), registry, sessionId: "s1", agentId: "xiaobei" });
    expect(resolveBinding(once, "s1")).toBe("xiaobei");
    expect(() => bindSession({ bindings: new Map(), registry, sessionId: "s2", agentId: "missing" })).toThrow(/没有这份档案/);
    expect(() => bindSession({ bindings: once, registry, sessionId: "s1", agentId: "xiaoma" })).toThrow(/不能改成/);
  });
});
