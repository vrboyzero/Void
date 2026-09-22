import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ARCHIVE_ENTRY_NAMES,
  bindSessionToProfile,
  createProfile,
  deleteProfile,
  DELETION_LOG_FILE,
  inspectProfile,
  loadBindings,
  loadFacetDetail,
  loadFacetSummaries,
  loadProfileBody,
  loadProfileSummaries,
  loadSuspensionHistory,
  restoreProfileBody,
  revisionOf,
  rewriteSoulFile,
  RUNTIME_DIRECTORY_NAME,
  saveFacetMarkdown,
  saveProfileBody,
  saveProfileDisplayFields,
  selectFacetForProfile,
  setFirstMeetingDone,
  setProfileSuspended,
  SOUL_HISTORY_DIRECTORY_NAME,
  SOUL_HISTORY_LOG_FILE,
  SUSPENSION_LOG_FILE,
  TRASH_DIRECTORY_NAME,
  unbindSession,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDataDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "void-soul-library-"));
  roots.push(root);
  await mkdir(path.join(root, "agents", "facets"), { recursive: true });
  return root;
}

const SOUL = [
  "---",
  "id: xiaobei",
  "name: 小贝",
  "summary: 主人的贴身助手",
  "owner: 6f1c2f9e-1111-4222-8333-444455556666",
  "---",
  "",
  "# 小贝",
  "",
  "底线正文。",
  "",
].join("\n");

/** 带上下级关系的档案：关系只能指向真实存在的档案，所以它得跟 xiaoma 一起出现。 */
const SOUL_WITH_AUTHORITY = SOUL.replace(
  "owner: 6f1c2f9e-1111-4222-8333-444455556666",
  ["owner: 6f1c2f9e-1111-4222-8333-444455556666", "authority:", "  enabled: true", "  superiors: []", "  subordinates: [xiaoma]"].join("\n"),
);

const SOUL_XIAOMA = SOUL.replace("id: xiaobei", "id: xiaoma").replace("name: 小贝", "name: 小码");

/** 写了首次见面引导的档案：引导是 front matter 里的一行，正文照旧。 */
const SOUL_WITH_GUIDE = SOUL.replace("owner: 6f1c2f9e-1111-4222-8333-444455556666", [
  "owner: 6f1c2f9e-1111-4222-8333-444455556666",
  "firstMeeting: 先自我介绍，再问主人怎么称呼。",
].join("\n"));

async function writeSoul(dataDir: string, directory: string, content = SOUL): Promise<void> {
  const dir = path.join(dataDir, "agents", directory);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SOUL.md"), content, "utf8");
}

async function writePair(dataDir: string): Promise<void> {
  await writeSoul(dataDir, "小贝", SOUL_WITH_AUTHORITY);
  await writeSoul(dataDir, "小码", SOUL_XIAOMA);
}

async function writeFacet(dataDir: string, file: string, content: string): Promise<void> {
  await writeFile(path.join(dataDir, "agents", "facets", file), content, "utf8");
}

const FACET = [
  "---",
  "id: facet_dev",
  "name: 开发专家",
  "summary: 写代码时用",
  "---",
  "",
  "按小步改，每步都跑测试。",
  "",
].join("\n");

describe("void-soul 人类管理入口", () => {
  it("内容哈希当修订：内容一样就一样，改一个字符就变", () => {
    expect(revisionOf("abc")).toBe(revisionOf("abc"));
    expect(revisionOf("abc")).not.toBe(revisionOf("abd"));
    expect(revisionOf("abc")).toHaveLength(16);
  });

  it("卡片读出身份、主人、权限、绑定会话与当前角色", async () => {
    const dataDir = await tempDataDir();
    await writePair(dataDir);
    await writeFacet(dataDir, "开发专家.md", FACET);
    await bindSessionToProfile(dataDir, { profileId: "xiaobei", sessionId: "s-1" });
    await selectFacetForProfile(dataDir, { profileId: "xiaobei", facetId: "facet_dev" });
    const [profile] = await loadProfileSummaries(dataDir);
    expect(profile).toMatchObject({
      id: "xiaobei",
      name: "小贝",
      summary: "主人的贴身助手",
      owner: "6f1c2f9e-1111-4222-8333-444455556666",
      directoryName: "小贝",
      authorityEnabled: true,
      superiors: [],
      subordinates: ["xiaoma"],
      boundSessions: ["s-1"],
      facetId: "facet_dev",
      facetName: "开发专家",
      selectionRevision: 1,
    });
    expect(profile?.revision).toBe(revisionOf(SOUL_WITH_AUTHORITY));
  });

  it("改显示名与头像：其余字段与正文一个字节都不动", async () => {
    const dataDir = await tempDataDir();
    await writePair(dataDir);
    const before = (await loadProfileSummaries(dataDir)).find((item) => item.id === "xiaobei")!;
    const saved = await saveProfileDisplayFields(dataDir, {
      profileId: "xiaobei",
      changes: { name: "贝贝", avatar: "https://example.com/a.png" },
      expectedRevision: before.revision,
    });
    expect(saved.name).toBe("贝贝");
    expect(saved.avatar).toBe("https://example.com/a.png");
    const raw = await readFile(path.join(dataDir, "agents", "小贝", "SOUL.md"), "utf8");
    expect(raw).toContain("owner: 6f1c2f9e-1111-4222-8333-444455556666");
    expect(raw).toContain("authority:");
    expect(raw).toContain("  enabled: true");
    expect(raw).toContain("  superiors: []");
    expect(raw).toContain("  subordinates: [xiaoma]");
    expect(raw.endsWith("# 小贝\n\n底线正文。\n")).toBe(true);
    expect(raw.split("\n")).toHaveLength(SOUL_WITH_AUTHORITY.split("\n").length + 1);
    expect(raw.indexOf("name: 贝贝")).toBeLessThan(raw.indexOf("avatar:"));
    expect(raw.indexOf("avatar:")).toBeLessThan(raw.indexOf("owner:"));
    expect(saved.revision).not.toBe(before.revision);
  });

  it("头像留空就是清掉这一行；显示名不能留空", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝");
    const first = (await loadProfileSummaries(dataDir))[0]!;
    await saveProfileDisplayFields(dataDir, { profileId: "xiaobei", changes: { avatar: "a.png" }, expectedRevision: first.revision });
    const second = (await loadProfileSummaries(dataDir))[0]!;
    const cleared = await saveProfileDisplayFields(dataDir, { profileId: "xiaobei", changes: { avatar: "" }, expectedRevision: second.revision });
    expect(cleared.avatar).toBeUndefined();
    const raw = await readFile(path.join(dataDir, "agents", "小贝", "SOUL.md"), "utf8");
    expect(raw).not.toContain("avatar:");
    await expect(
      saveProfileDisplayFields(dataDir, { profileId: "xiaobei", changes: { name: "  " }, expectedRevision: cleared.revision }),
    ).rejects.toThrow("显示名不能为空");
  });

  it("只认显示名与头像：底线、主人、权限都进不来", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝");
    const before = (await loadProfileSummaries(dataDir))[0]!;
    await expect(
      saveProfileDisplayFields(dataDir, { profileId: "xiaobei", changes: { owner: "00000000-0000-4000-8000-000000000000" }, expectedRevision: before.revision }),
    ).rejects.toThrow("只允许改显示名与头像");
    await expect(
      saveProfileDisplayFields(dataDir, { profileId: "xiaobei", changes: { body: "换个底线" }, expectedRevision: before.revision }),
    ).rejects.toThrow("只允许改显示名与头像");
    await expect(saveProfileDisplayFields(dataDir, { profileId: "xiaobei", changes: {}, expectedRevision: before.revision })).rejects.toThrow("没有要保存的改动");
    const raw = await readFile(path.join(dataDir, "agents", "小贝", "SOUL.md"), "utf8");
    expect(raw).toBe(SOUL);
  });

  it("首次见面：标记只写 state.json，档案正文、内容哈希与选择修订都不动", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝", SOUL_WITH_GUIDE);
    const before = (await loadProfileSummaries(dataDir))[0]!;
    expect(before).toMatchObject({ firstMeeting: "先自我介绍，再问主人怎么称呼。", firstMeetingDone: false });

    const done = await setFirstMeetingDone(dataDir, { profileId: "xiaobei", done: true });
    expect(done).toMatchObject({ firstMeetingDone: true, revision: before.revision, selectionRevision: 0 });
    expect(await readFile(path.join(dataDir, "agents", "小贝", "SOUL.md"), "utf8")).toBe(SOUL_WITH_GUIDE);
    expect(JSON.parse(await readFile(path.join(dataDir, "agents", "小贝", "state.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      activeFacetId: null,
      selectionRevision: 0,
      firstMeetingDone: true,
      suspended: false,
    });

    const again = await setFirstMeetingDone(dataDir, { profileId: "xiaobei", done: false });
    expect(again.firstMeetingDone).toBe(false);
    expect(await readFile(path.join(dataDir, "agents", "小贝", "SOUL.md"), "utf8")).toBe(SOUL_WITH_GUIDE);
  });

  it("首次见面：没写引导的档案拒绝标完成，没有这份档案也拒绝", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝");
    expect((await loadProfileSummaries(dataDir))[0]).toMatchObject({ firstMeeting: null, firstMeetingDone: false });
    await expect(setFirstMeetingDone(dataDir, { profileId: "xiaobei", done: true })).rejects.toThrow(/没有写首次见面引导，不用标完成: xiaobei/);
    await expect(setFirstMeetingDone(dataDir, { profileId: "nobody", done: false })).rejects.toThrow("没有这份档案: nobody");
    expect(existsSync(path.join(dataDir, "agents", "小贝", "state.json"))).toBe(false);
  });

  it("修订对不上就拒绝，让人重读而不是硬覆盖", async () => {    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝");
    const stale = (await loadProfileSummaries(dataDir))[0]!;
    await saveProfileDisplayFields(dataDir, { profileId: "xiaobei", changes: { name: "贝贝" }, expectedRevision: stale.revision });
    await expect(
      saveProfileDisplayFields(dataDir, { profileId: "xiaobei", changes: { name: "又改一次" }, expectedRevision: stale.revision }),
    ).rejects.toThrow(/期望修订 .*实际 .*请重读后再改/);
  });

  it("字段值带换行就拒绝：那会把 front matter 写坏", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝");
    const before = (await loadProfileSummaries(dataDir))[0]!;
    await expect(
      saveProfileDisplayFields(dataDir, { profileId: "xiaobei", changes: { name: "小贝\nsummary: 骗人的" }, expectedRevision: before.revision }),
    ).rejects.toThrow("显示名不能带换行");
  });

  it("新建档案：目录与文件都建出来，并立刻进注册表", async () => {
    const dataDir = await tempDataDir();
    const created = await createProfile(dataDir, {
      id: "xiaoma",
      directoryName: "小码",
      name: "小码",
      summary: "干活的",
      owner: "6f1c2f9e-1111-4222-8333-444455556666",
    });
    expect(created.id).toBe("xiaoma");
    expect(created.owner).toBe("6f1c2f9e-1111-4222-8333-444455556666");
    expect((await loadProfileSummaries(dataDir)).map((item) => item.id)).toEqual(["xiaoma"]);
    const raw = await readFile(path.join(dataDir, "agents", "小码", "SOUL.md"), "utf8");
    expect(raw).toContain("id: xiaoma");
    expect(raw).toContain("（小码 的身份说明还没有写");
  });

  it("新建档案：重复 id、占用的目录、越界目录名都拒绝", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝");
    await expect(createProfile(dataDir, { id: "xiaobei", directoryName: "另一个", name: "重名", summary: "x" })).rejects.toThrow("档案 id 已经被占用");
    await expect(createProfile(dataDir, { id: "new", directoryName: "小贝", name: "重名", summary: "x" })).rejects.toThrow("Agent 目录已经被占用");
    await expect(createProfile(dataDir, { id: "new", directoryName: "../外面", name: "越界", summary: "x" })).rejects.toThrow("非法 Agent 目录名");
    await expect(createProfile(dataDir, { id: "new", directoryName: "facets", name: "占保留名", summary: "x" })).rejects.toThrow("非法 Agent 目录名");
  });

  it("模组库列表带出谁在用，改正文只动正文", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝");
    await writeFacet(dataDir, "开发专家.md", FACET);
    await selectFacetForProfile(dataDir, { profileId: "xiaobei", facetId: "facet_dev" });
    const [summary] = await loadFacetSummaries(dataDir);
    expect(summary).toMatchObject({ id: "facet_dev", name: "开发专家", usedBy: ["xiaobei"] });
    const detail = await loadFacetDetail(dataDir, "facet_dev");
    const saved = await saveFacetMarkdown(dataDir, {
      facetId: "facet_dev",
      changes: { body: "先写测试。\n", summary: "改代码时用" },
      expectedRevision: detail.revision,
    });
    expect(saved.body).toBe("先写测试。\n");
    expect(saved.summary).toBe("改代码时用");
    const raw = await readFile(path.join(dataDir, "agents", "facets", "开发专家.md"), "utf8");
    expect(raw).toContain("id: facet_dev");
    expect(raw).toContain("name: 开发专家");
    expect(raw).not.toContain("按小步改");
  });

  it("模组 id 不许改：要换 id 就新建一个文件", async () => {
    const dataDir = await tempDataDir();
    await writeFacet(dataDir, "开发专家.md", FACET);
    const detail = await loadFacetDetail(dataDir, "facet_dev");
    await expect(
      saveFacetMarkdown(dataDir, { facetId: "facet_dev", changes: { id: "facet_other" }, expectedRevision: detail.revision }),
    ).rejects.toThrow("模组 id 不能改: facet_dev → facet_other");
    await expect(
      saveFacetMarkdown(dataDir, { facetId: "nope", changes: { body: "x" }, expectedRevision: detail.revision }),
    ).rejects.toThrow("没有这个模组: nope");
    const raw = await readFile(path.join(dataDir, "agents", "facets", "开发专家.md"), "utf8");
    expect(raw).toBe(FACET);
  });

  it("模组文件在磁盘上被换过 id：按旧 id 存会被修订栅挡下", async () => {
    const dataDir = await tempDataDir();
    await writeFacet(dataDir, "开发专家.md", FACET);
    const before = await loadFacetDetail(dataDir, "facet_dev");
    const renamed = FACET.replace("id: facet_dev", "id: facet_other");
    await writeFacet(dataDir, "开发专家.md", renamed);
    const after = await loadFacetDetail(dataDir, "facet_other");
    expect(after.revision).not.toBe(before.revision);
    await expect(
      saveFacetMarkdown(dataDir, { facetId: "facet_other", changes: { body: "x" }, expectedRevision: before.revision }),
    ).rejects.toThrow(/期望修订/);
  });

  it("模组正文里的未知变量保存时就拦下：到下次请求才炸太晚", async () => {
    const dataDir = await tempDataDir();
    await writeFacet(dataDir, "开发专家.md", FACET);
    const detail = await loadFacetDetail(dataDir, "facet_dev");
    await expect(
      saveFacetMarkdown(dataDir, { facetId: "facet_dev", changes: { body: "用 {{secret}} 说话" }, expectedRevision: detail.revision }),
    ).rejects.toThrow("未知说明书变量: secret");
    await expect(
      saveFacetMarkdown(dataDir, { facetId: "facet_dev", changes: { body: "在 {{cwd}} 里干活" }, expectedRevision: detail.revision }),
    ).resolves.toMatchObject({ body: "在 {{cwd}} 里干活" });
  });

  it("模组只认显示名、简介与正文", async () => {
    const dataDir = await tempDataDir();
    await writeFacet(dataDir, "开发专家.md", FACET);
    const detail = await loadFacetDetail(dataDir, "facet_dev");
    await expect(
      saveFacetMarkdown(dataDir, { facetId: "facet_dev", changes: { frontMatter: "改整块" }, expectedRevision: detail.revision }),
    ).rejects.toThrow("只允许改显示名、简介与正文: frontMatter");
    await expect(saveFacetMarkdown(dataDir, { facetId: "facet_dev", changes: {}, expectedRevision: detail.revision })).rejects.toThrow("没有要保存的改动");
  });

  it("绑定会话：同一档案重复绑是幂等，换成另一个档案要拒绝", async () => {
    const dataDir = await tempDataDir();
    await writePair(dataDir);
    await bindSessionToProfile(dataDir, { profileId: "xiaobei", sessionId: "s-1" });
    await expect(bindSessionToProfile(dataDir, { profileId: "xiaobei", sessionId: "s-1" })).resolves.toHaveLength(1);
    await expect(bindSessionToProfile(dataDir, { profileId: "xiaoma", sessionId: "s-1" })).rejects.toThrow("会话已绑定 xiaobei，不能改成 xiaoma");
    await expect(bindSessionToProfile(dataDir, { profileId: "nobody", sessionId: "s-2" })).rejects.toThrow("没有这份档案");
    await unbindSession(dataDir, "s-1");
    expect(await loadBindings(dataDir)).toEqual([]);
    await expect(unbindSession(dataDir, "s-1")).rejects.toThrow("这个会话没有绑定档案");
  });

  it("换角色与清角色：选择修订自增，未知模组拒绝", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝");
    await writeFacet(dataDir, "开发专家.md", FACET);
    const first = await selectFacetForProfile(dataDir, { profileId: "xiaobei", facetId: "facet_dev" });
    expect(first).toMatchObject({ facetId: "facet_dev", name: "开发专家", selectionRevision: 1 });
    const cleared = await selectFacetForProfile(dataDir, { profileId: "xiaobei", facetId: null });
    expect(cleared).toMatchObject({ facetId: null, name: null, selectionRevision: 2 });
    await expect(selectFacetForProfile(dataDir, { profileId: "xiaobei", facetId: "nope" })).rejects.toThrow("没有这个模组: nope");
    await expect(selectFacetForProfile(dataDir, { profileId: "nobody", facetId: null })).rejects.toThrow("没有这份档案");
  });

  it("rewriteSoulFile 保留未触碰的行与顺序", () => {
    const next = rewriteSoulFile(SOUL, { scalars: { name: "贝贝" } });
    expect(next.split("\n").filter((line) => line !== "").length).toBe(SOUL.split("\n").filter((line) => line !== "").length);
    expect(next.indexOf("id: xiaobei")).toBeLessThan(next.indexOf("name: 贝贝"));
    expect(next.indexOf("name: 贝贝")).toBeLessThan(next.indexOf("summary:"));
    expect(() => rewriteSoulFile("# 没有 front matter", { scalars: { name: "x" } })).toThrow("档案缺少开头的 front matter");
  });

  it("模组库整层是链接时拒绝：不看穿它就会去读数据根外面的模组", async (context) => {
    const { rm, symlink } = await import("node:fs/promises");
    const dataDir = await tempDataDir();
    const outside = await mkdtemp(path.join(tmpdir(), "void-soul-facets-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "外面的模组.md"), FACET, "utf8");
    // 把 agents/facets 换成指向外面的 junction：readdir 里它跟普通目录长得一样。
    await rm(path.join(dataDir, "agents", "facets"), { recursive: true, force: true });
    try {
      await symlink(outside, path.join(dataDir, "agents", "facets"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      context.skip();
      return;
    }
    await expect(loadFacetSummaries(dataDir)).rejects.toThrow(/路径经链接后越界/);
  });

  it("模组库里的单个条目是链接、指向库外时也拒绝", async (context) => {
    const { symlink } = await import("node:fs/promises");
    const dataDir = await tempDataDir();
    const outside = await mkdtemp(path.join(tmpdir(), "void-soul-facet-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "SOUL.md"), "外面", "utf8");
    try {
      // 目录 junction 顶一个 .md 名字：过得了后缀检查，但真实位置在库外。
      await symlink(outside, path.join(dataDir, "agents", "facets", "外链.md"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      context.skip();
      return;
    }
    await expect(loadFacetSummaries(dataDir)).rejects.toThrow(/路径经链接后越界/);
  });

  it("模组库还不存在时按空库处理，不报错也不建目录", async () => {
    const { existsSync } = await import("node:fs");
    const root = await mkdtemp(path.join(tmpdir(), "void-soul-nofacets-"));
    roots.push(root);
    await expect(loadFacetSummaries(root)).resolves.toEqual([]);
    expect(existsSync(path.join(root, "agents"))).toBe(false);
  });
});

describe("底线正文的人类编辑入口（2026-09-22 定案）", () => {
  const soulPath = (dataDir: string): string => path.join(dataDir, "agents", "小贝", "SOUL.md");
  const historyDir = (dataDir: string): string => path.join(dataDir, "agents", "小贝", "history");

  it("改正文：front matter 一个字节不动，旧版整份进留痕", async () => {
    const dataDir = await tempDataDir();
    await writePair(dataDir);
    const before = await loadProfileBody(dataDir, "xiaobei");
    const nextBody = before.body.replace("底线正文。", "新底线：先问主人。");
    const saved = await saveProfileBody(dataDir, {
      profileId: "xiaobei",
      body: nextBody,
      expectedRevision: before.revision,
      note: "换口径",
    });
    expect(saved.revision).not.toBe(before.revision);
    const raw = await readFile(soulPath(dataDir), "utf8");
    expect(raw).toContain("id: xiaobei");
    expect(raw).toContain("owner: 6f1c2f9e-1111-4222-8333-444455556666");
    expect(raw).toContain("subordinates: [xiaoma]");
    expect(raw).toContain("新底线：先问主人。");
    expect(raw).not.toContain("底线正文。");
    // 留痕：旧版是**整份**存的，连 front matter 一起，所以回滚回去不会丢字段。
    const archived = path.join(historyDir(dataDir), `SOUL-${before.revision}.md`);
    expect(existsSync(archived)).toBe(true);
    expect(await readFile(archived, "utf8")).toBe(SOUL_WITH_AUTHORITY);
    const after = await loadProfileBody(dataDir, "xiaobei");
    expect(after.body).toBe(nextBody);
    expect(after.history).toHaveLength(1);
    expect(after.history[0]?.revision).toBe(before.revision);
    expect(after.history[0]?.action).toBe("save");
    expect(after.history[0]?.note).toBe("换口径");
    expect(after.history[0]?.nextRevision).toBe(saved.revision);
    const log = await readFile(path.join(historyDir(dataDir), SOUL_HISTORY_LOG_FILE), "utf8");
    expect(log.trim().split("\n")).toHaveLength(1);
  });

  it("空正文被拒：磁盘与留痕都不动", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝");
    const before = await loadProfileBody(dataDir, "xiaobei");
    await expect(
      saveProfileBody(dataDir, { profileId: "xiaobei", body: "  \n\n", expectedRevision: before.revision }),
    ).rejects.toThrow("底线正文不能为空：没有底线的档案取不出派活身份，要清空就先删档案");
    expect(await readFile(soulPath(dataDir), "utf8")).toBe(SOUL);
    expect(existsSync(historyDir(dataDir))).toBe(false);
  });

  it("修订对不上就拒绝：不写盘、不留痕", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝");
    await expect(
      saveProfileBody(dataDir, { profileId: "xiaobei", body: "另一版。", expectedRevision: "0000000000000000" }),
    ).rejects.toThrow(/档案已被其他保存更新/);
    expect(await readFile(soulPath(dataDir), "utf8")).toBe(SOUL);
    expect(existsSync(historyDir(dataDir))).toBe(false);
  });

  it("超预算的正文在保存时就被拒：不会等到下次进模型才炸", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝");
    const before = await loadProfileBody(dataDir, "xiaobei");
    await expect(
      saveProfileBody(dataDir, { profileId: "xiaobei", body: "长".repeat(100_001), expectedRevision: before.revision }),
    ).rejects.toThrow(/说明书超出本次上下文预算/);
    expect(existsSync(historyDir(dataDir))).toBe(false);
  });

  it("回滚：正文换回旧版，回滚本身也留痕，还能再滚回来", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝");
    const v1 = await loadProfileBody(dataDir, "xiaobei");
    await saveProfileBody(dataDir, {
      profileId: "xiaobei",
      body: v1.body.replace("底线正文。", "第二版。"),
      expectedRevision: v1.revision,
    });
    const v2 = await loadProfileBody(dataDir, "xiaobei");
    // 中途改一次显示名：回滚只换正文，显示名要留在「现在」这一版上。
    await saveProfileDisplayFields(dataDir, { profileId: "xiaobei", changes: { name: "贝总" }, expectedRevision: v2.revision });
    const v3 = await loadProfileBody(dataDir, "xiaobei");
    expect(v3.body).toContain("第二版。");
    const restored = await restoreProfileBody(dataDir, {
      profileId: "xiaobei",
      revision: v1.revision,
      expectedRevision: v3.revision,
      note: "还是原来那句好",
    });
    const raw = await readFile(soulPath(dataDir), "utf8");
    expect(raw).toContain("name: 贝总");
    expect(raw).not.toContain("第二版。");
    expect(restored.revision).toBe(revisionOf(raw));
    const after = await loadProfileBody(dataDir, "xiaobei");
    expect(after.body).toBe(v1.body);
    // 只记正文改动：中间那次改名不进留痕，所以是两条（改正文、回滚），不是三条。
    expect(after.history).toHaveLength(2);
    expect(after.history[0]?.action).toBe("restore");
    expect(after.history[0]?.revision).toBe(v3.revision);
    expect(after.history[0]?.sourceRevision).toBe(v1.revision);
    expect(after.history[0]?.note).toBe("还是原来那句好");
    // 再滚回来：被回滚换掉的那一版（v3）也在留痕里。
    await restoreProfileBody(dataDir, { profileId: "xiaobei", revision: v3.revision, expectedRevision: after.revision });
    expect((await loadProfileBody(dataDir, "xiaobei")).body).toContain("第二版。");
    expect(await readFile(soulPath(dataDir), "utf8")).toContain("name: 贝总");
  });

  it("回滚到一个不在留痕里的修订会被拒", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝");
    const before = await loadProfileBody(dataDir, "xiaobei");
    await expect(
      restoreProfileBody(dataDir, { profileId: "xiaobei", revision: "deadbeefdeadbeef", expectedRevision: before.revision }),
    ).rejects.toThrow(/留痕里没有这一版: deadbeefdeadbeef/);
    await expect(
      restoreProfileBody(dataDir, { profileId: "xiaobei", revision: "  ", expectedRevision: before.revision }),
    ).rejects.toThrow("回滚要指明回滚到哪一版");
  });

  it("留痕坏了要报出来，不能当成没有历史", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝");
    const before = await loadProfileBody(dataDir, "xiaobei");
    await saveProfileBody(dataDir, {
      profileId: "xiaobei",
      body: before.body.replace("底线正文。", "第二版。"),
      expectedRevision: before.revision,
    });
    const log = path.join(historyDir(dataDir), SOUL_HISTORY_LOG_FILE);
    await appendFile(log, "这不是 JSON\n", "utf8");
    await expect(loadProfileBody(dataDir, "xiaobei")).rejects.toThrow(/第 2 行不是 JSON，没法据此回滚/);
    await writeFile(log, `${JSON.stringify({ revision: "abc" })}\n`, "utf8");
    await expect(loadProfileBody(dataDir, "xiaobei")).rejects.toThrow(/第 1 行缺字段，没法据此回滚/);
  });
});

describe("删档案（2026-09-22 定案：删档案不删记忆、不删聊天记录）", () => {
  const archiveDir = (dataDir: string, directory: string): string => path.join(dataDir, "agents", directory);
  const MEMORY_BODY = "长期记忆：主人只喝美式。\n";

  /** 造一份带记忆的档案：记忆目录按**档案 id** 走，与档案目录可以同名，也可以是另一个。 */
  async function writeMemory(dataDir: string, directory: string): Promise<void> {
    const dir = archiveDir(dataDir, directory);
    await mkdir(path.join(dir, "memory", "2026-09-23"), { recursive: true });
    await mkdir(path.join(dir, "retracted"), { recursive: true });
    await writeFile(path.join(dir, "MEMORY.md"), MEMORY_BODY, "utf8");
    await writeFile(path.join(dir, "memory", "2026-09-23", "20260923-0001.md"), "今天修好了删档案。\n", "utf8");
    await writeFile(path.join(dir, "memory.sqlite"), Buffer.from([1, 2, 3]));
    await writeFile(path.join(dir, "retracted", "20260922-0001.md"), "收回的一条。\n", "utf8");
  }

  /** 档案自己的另外两样：首次见面状态与底线正文留痕。 */
  async function writeArchiveExtras(dataDir: string, directory: string): Promise<void> {
    const dir = archiveDir(dataDir, directory);
    await mkdir(path.join(dir, "history"), { recursive: true });
    await writeFile(path.join(dir, "state.json"), '{"firstMeeting":{"done":true}}\n', "utf8");
    await writeFile(path.join(dir, "history", SOUL_HISTORY_LOG_FILE), "", "utf8");
  }

  /** 记忆那几样的当前内容，用来逐字节比对「一个字节都没动」。 */
  async function readMemory(dataDir: string, directory: string): Promise<Record<string, string>> {
    const dir = archiveDir(dataDir, directory);
    return {
      "MEMORY.md": await readFile(path.join(dir, "MEMORY.md"), "utf8"),
      "memory/2026-09-23/20260923-0001.md": await readFile(path.join(dir, "memory", "2026-09-23", "20260923-0001.md"), "utf8"),
      "memory.sqlite": (await readFile(path.join(dir, "memory.sqlite"))).toString("base64"),
      "retracted/20260922-0001.md": await readFile(path.join(dir, "retracted", "20260922-0001.md"), "utf8"),
    };
  }

  it("目录名和档案 id 不是同一个：只搬档案自己的三样，记忆一个字节都不动", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝");
    await writeMemory(dataDir, "xiaobei");
    await writeArchiveExtras(dataDir, "小贝");
    await bindSessionToProfile(dataDir, { profileId: "xiaobei", sessionId: "s-1" });
    const memoryBefore = await readMemory(dataDir, "xiaobei");

    const deleted = await deleteProfile(dataDir, {
      profileId: "xiaobei",
      expectedRevision: revisionOf(await readFile(path.join(archiveDir(dataDir, "小贝"), "SOUL.md"), "utf8")),
    });

    expect(deleted.profileId).toBe("xiaobei");
    expect(deleted.name).toBe("小贝");
    expect(deleted.directoryName).toBe("小贝");
    expect(deleted.archiveDirectory).toBe("agents/小贝");
    expect(deleted.memoryDirectory).toBe("agents/xiaobei");
    expect(deleted.movedTo).toMatch(/^trash\/.+-小贝$/);
    expect(deleted.moved).toEqual([...ARCHIVE_ENTRY_NAMES]);
    expect(deleted.leftBehind).toEqual([]);
    expect(deleted.removedDirectory).toBe(true);
    expect(deleted.boundSessions).toEqual(["s-1"]);
    expect(existsSync(archiveDir(dataDir, "小贝"))).toBe(false);
    // 搬走的三样都在回收站里，一件不少。
    for (const name of ARCHIVE_ENTRY_NAMES) {
      expect(existsSync(path.join(dataDir, TRASH_DIRECTORY_NAME, path.basename(deleted.movedTo), name))).toBe(true);
    }
    // 记忆一个字节都没动。
    expect(await readMemory(dataDir, "xiaobei")).toEqual(memoryBefore);
    // 绑定与聊天记录留着，由用户自己处理。
    expect(await loadBindings(dataDir)).toEqual([{ sessionId: "s-1", profileId: "xiaobei" }]);
    // 回收站里的副本不会被当成一份档案列出来。
    expect(await loadProfileSummaries(dataDir)).toEqual([]);
  });

  it("目录名正好就是档案 id：记忆留在原地，目录不删", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "xiaobei");
    await writeMemory(dataDir, "xiaobei");
    const memoryBefore = await readMemory(dataDir, "xiaobei");

    const deleted = await deleteProfile(dataDir, { profileId: "xiaobei" });

    expect(deleted.archiveDirectory).toBe("agents/xiaobei");
    expect(deleted.memoryDirectory).toBe("agents/xiaobei");
    expect(deleted.moved).toEqual(["SOUL.md"]);
    expect(deleted.leftBehind).toEqual(["MEMORY.md", "memory", "memory.sqlite", "retracted"]);
    expect(deleted.removedDirectory).toBe(false);
    // 档案没了，记忆还在，而且目录还在原地。
    expect(existsSync(path.join(archiveDir(dataDir, "xiaobei"), "SOUL.md"))).toBe(false);
    expect(await readMemory(dataDir, "xiaobei")).toEqual(memoryBefore);
    expect(await loadProfileSummaries(dataDir)).toEqual([]);
  });

  it("删一次留一条痕：trash/deletions.jsonl 写清搬走什么、留下什么", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝");
    await writeMemory(dataDir, "xiaobei");
    await bindSessionToProfile(dataDir, { profileId: "xiaobei", sessionId: "s-2" });

    const deleted = await deleteProfile(dataDir, { profileId: "xiaobei", note: "  主人说不用了  " });
    const lines = (await readFile(path.join(dataDir, TRASH_DIRECTORY_NAME, DELETION_LOG_FILE), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({ ...deleted, note: "主人说不用了" });

    await writeSoul(dataDir, "小码", SOUL_XIAOMA);
    await deleteProfile(dataDir, { profileId: "xiaoma" });
    const after = (await readFile(path.join(dataDir, TRASH_DIRECTORY_NAME, DELETION_LOG_FILE), "utf8")).trim().split("\n");
    expect(after).toHaveLength(2);
    expect(JSON.parse(after[0] ?? "{}").profileId).toBe("xiaobei");
    expect(JSON.parse(after[1] ?? "{}").profileId).toBe("xiaoma");
    expect(JSON.parse(after[1] ?? "{}").note).toBeUndefined();
  });

  it("修订对不上就拒绝：档案一样没动，回收站也没建", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝");
    await expect(
      deleteProfile(dataDir, { profileId: "xiaobei", expectedRevision: "deadbeefdeadbeef" }),
    ).rejects.toThrow(/档案已被其他保存更新（期望修订 deadbeefdeadbeef/);
    expect(existsSync(path.join(archiveDir(dataDir, "小贝"), "SOUL.md"))).toBe(true);
    expect(existsSync(path.join(dataDir, TRASH_DIRECTORY_NAME))).toBe(false);
  });

  it("没有这份档案：报出来，别去动别的目录", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝");
    await expect(deleteProfile(dataDir, { profileId: "nope" })).rejects.toThrow("没有这份档案: nope");
    expect(existsSync(path.join(archiveDir(dataDir, "小贝"), "SOUL.md"))).toBe(true);
  });

  it("档案目录是链接：拒绝删，链接外面那份档案一个字节都不动", async () => {
    const dataDir = await tempDataDir();
    const outside = path.join(dataDir, "..", `void-soul-outside-${path.basename(dataDir)}`);
    roots.push(outside);
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "SOUL.md"), SOUL, "utf8");
    await symlink(outside, path.join(dataDir, "agents", "链接档案"), "junction");
    await expect(deleteProfile(dataDir, { profileId: "xiaobei" })).rejects.toThrow(/档案目录是链接/);
    expect(await readFile(path.join(outside, "SOUL.md"), "utf8")).toBe(SOUL);
  });
});

describe("停用/启用一份档案（2026-09-23：只改一个布尔值，不删任何字节）", () => {
  const archiveDir = (dataDir: string, directory: string): string => path.join(dataDir, "agents", directory);
  const MEMORY_BODY = "长期记忆：主人只喝美式。\n";

  /** 造一份带记忆的档案：记忆目录按**档案 id** 走，与档案目录可以同名也可以不同名。 */
  async function writeMemory(dataDir: string, directory: string): Promise<void> {
    const dir = archiveDir(dataDir, directory);
    await mkdir(path.join(dir, "memory", "2026-09-23"), { recursive: true });
    await writeFile(path.join(dir, "MEMORY.md"), MEMORY_BODY, "utf8");
    await writeFile(path.join(dir, "memory", "2026-09-23", "20260923-0001.md"), "今天把停用做出来了。\n", "utf8");
    await writeFile(path.join(dir, "memory.sqlite"), Buffer.from([1, 2, 3]));
  }

  async function readMemory(dataDir: string, directory: string): Promise<Record<string, string>> {
    const dir = archiveDir(dataDir, directory);
    return {
      "MEMORY.md": await readFile(path.join(dir, "MEMORY.md"), "utf8"),
      "memory/2026-09-23/20260923-0001.md": await readFile(path.join(dir, "memory", "2026-09-23", "20260923-0001.md"), "utf8"),
      "memory.sqlite": (await readFile(path.join(dir, "memory.sqlite"))).toString("base64"),
    };
  }

  /** 一份**真的**角色选择状态：停用位就住在这里，别的字段一个都不该被它碰。 */
  async function writeFacetState(dataDir: string, directory: string): Promise<void> {
    const state = {
      schemaVersion: 1,
      activeFacetId: "facet_dev",
      selectionRevision: 3,
      firstMeetingDone: true,
      suspended: false,
    };
    await writeFile(path.join(archiveDir(dataDir, directory), "state.json"), `${JSON.stringify(state)}\n`, "utf8");
  }

  async function readState(dataDir: string, directory: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(path.join(archiveDir(dataDir, directory), "state.json"), "utf8")) as Record<string, unknown>;
  }

  it("停用：只写 state.json 的一个布尔值，正文、记忆、绑定一个字节都不动", async () => {
    const dataDir = await tempDataDir();
    await writeFacet(dataDir, "dev.md", FACET);
    await writePair(dataDir);
    await writeMemory(dataDir, "xiaobei");
    await writeFacetState(dataDir, "小贝");
    await bindSessionToProfile(dataDir, { profileId: "xiaobei", sessionId: "s-1" });
    await bindSessionToProfile(dataDir, { profileId: "xiaobei", sessionId: "s-2" });
    const soulBefore = await readFile(path.join(archiveDir(dataDir, "小贝"), "SOUL.md"), "utf8");
    const memoryBefore = await readMemory(dataDir, "xiaobei");

    const receipt = await setProfileSuspended(dataDir, { profileId: "xiaobei", suspended: true, note: "  先在旁边看着  " });
    expect(receipt).toMatchObject({
      profileId: "xiaobei",
      name: "小贝",
      suspended: true,
      stateFile: path.join("agents", "小贝", "state.json"),
      logFile: path.join(RUNTIME_DIRECTORY_NAME, SUSPENSION_LOG_FILE),
    });
    expect(receipt.references.sessions).toEqual(["s-1", "s-2"]);

    // 状态只动了停用位：角色选择与首次见面状态原样。
    expect(await readState(dataDir, "小贝")).toEqual({
      schemaVersion: 1,
      activeFacetId: "facet_dev",
      selectionRevision: 3,
      firstMeetingDone: true,
      suspended: true,
    });
    // 正文与记忆逐字节不变。
    expect(await readFile(path.join(archiveDir(dataDir, "小贝"), "SOUL.md"), "utf8")).toBe(soulBefore);
    expect(await readMemory(dataDir, "xiaobei")).toEqual(memoryBefore);
    // 绑定一个都没少：停用不改绑定。
    expect(await loadBindings(dataDir)).toEqual([
      { sessionId: "s-1", profileId: "xiaobei" },
      { sessionId: "s-2", profileId: "xiaobei" },
    ]);
    // 列表上看得出来，且别的字段照旧。
    const summaries = await loadProfileSummaries(dataDir);
    expect(summaries.find((item) => item.id === "xiaobei")).toMatchObject({
      suspended: true,
      revision: revisionOf(soulBefore),
      facetId: "facet_dev",
      selectionRevision: 3,
      firstMeetingDone: true,
      boundSessions: ["s-1", "s-2"],
    });
    expect(summaries.find((item) => item.id === "xiaoma")?.suspended).toBe(false);
    // 留痕一行，备注去了空白。
    const logged = (await readFile(path.join(dataDir, RUNTIME_DIRECTORY_NAME, SUSPENSION_LOG_FILE), "utf8")).trim().split("\n");
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0] ?? "{}")).toEqual({
      profileId: "xiaobei",
      name: "小贝",
      directoryName: "小贝",
      suspended: true,
      at: receipt.at,
      note: "先在旁边看着",
    });
    // 聊天记录不在数据根里，插件不碰它：预览里照实写明，数据根里也不会冒出 sessions/。
    expect(receipt.reclaimScope.find((entry) => entry.path.startsWith("sessions/"))?.action).toBe("keep");
    expect(existsSync(path.join(dataDir, "sessions"))).toBe(false);
  });

  it("启用：状态切回来，正文与记忆还是原样，留痕里两条都在", async () => {
    const dataDir = await tempDataDir();
    await writeFacet(dataDir, "dev.md", FACET);
    await writeSoul(dataDir, "小贝");
    await writeMemory(dataDir, "xiaobei");
    await writeFacetState(dataDir, "小贝");
    const soulBefore = await readFile(path.join(archiveDir(dataDir, "小贝"), "SOUL.md"), "utf8");
    const memoryBefore = await readMemory(dataDir, "xiaobei");

    await setProfileSuspended(dataDir, { profileId: "xiaobei", suspended: true, note: "先歇一会" });
    const back = await setProfileSuspended(dataDir, { profileId: "xiaobei", suspended: false });
    expect(back.suspended).toBe(false);
    expect(await readState(dataDir, "小贝")).toMatchObject({ suspended: false, selectionRevision: 3, firstMeetingDone: true });
    expect(await readFile(path.join(archiveDir(dataDir, "小贝"), "SOUL.md"), "utf8")).toBe(soulBefore);
    expect(await readMemory(dataDir, "xiaobei")).toEqual(memoryBefore);

    const history = await loadSuspensionHistory(dataDir, "xiaobei");
    expect(history.map((entry) => entry.suspended)).toEqual([false, true]);
    expect(history[0]?.note).toBeUndefined();
    expect(history[1]?.note).toBe("先歇一会");
    // 记的是**结果**：这一条说的是「现在启用」，不是「刚才请求的是启用」。
    expect(history[0]?.at).toBe(back.at);
  });

  it("停用留痕：倒着给最近几条，别的档案的不混进来，limit 管用", async () => {
    const dataDir = await tempDataDir();
    await writePair(dataDir);
    await setProfileSuspended(dataDir, { profileId: "xiaobei", suspended: true });
    await setProfileSuspended(dataDir, { profileId: "xiaoma", suspended: true });
    await setProfileSuspended(dataDir, { profileId: "xiaobei", suspended: false });

    const mine = await loadSuspensionHistory(dataDir, "xiaobei");
    expect(mine.map((entry) => entry.suspended)).toEqual([false, true]);
    expect(mine.every((entry) => entry.profileId === "xiaobei")).toBe(true);
    expect(await loadSuspensionHistory(dataDir, "xiaoma")).toHaveLength(1);
    expect(await loadSuspensionHistory(dataDir, "xiaobei", 1)).toHaveLength(1);
    // 还没停过／根本没这份档案：都是空表，不报错也不建文件。
    expect(await loadSuspensionHistory(dataDir, "nobody")).toEqual([]);
  });

  it("留痕坏了要报出来：坏行与缺字段都点名第几行，不假装没有历史", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝");
    await setProfileSuspended(dataDir, { profileId: "xiaobei", suspended: true });
    const logPath = path.join(dataDir, RUNTIME_DIRECTORY_NAME, SUSPENSION_LOG_FILE);
    const good = (await readFile(logPath, "utf8")).trim();

    await writeFile(logPath, `${good}\n{不是 JSON}\n`, "utf8");
    await expect(loadSuspensionHistory(dataDir, "xiaobei")).rejects.toThrow(/停用留痕坏了：runtime\/suspensions\.jsonl 第 2 行不是 JSON/);

    await writeFile(logPath, `${good}\n${JSON.stringify({ profileId: "xiaobei", suspended: true })}\n`, "utf8");
    await expect(loadSuspensionHistory(dataDir, "xiaobei")).rejects.toThrow(/第 2 行缺字段/);

    // 修好之后照样读得出来：报错是「拒绝猜」，不是把历史丢掉。
    await writeFile(logPath, `${good}\n`, "utf8");
    expect(await loadSuspensionHistory(dataDir, "xiaobei")).toHaveLength(1);
  });

  it("没有这份档案：停用、查引用、看留痕都拒绝，什么都不建", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝");
    await expect(setProfileSuspended(dataDir, { profileId: "nope", suspended: true })).rejects.toThrow("没有这份档案: nope");
    await expect(inspectProfile(dataDir, "nope")).rejects.toThrow("没有这份档案: nope");
    expect(existsSync(path.join(dataDir, RUNTIME_DIRECTORY_NAME))).toBe(false);
    expect(existsSync(path.join(archiveDir(dataDir, "小贝"), "state.json"))).toBe(false);
  });

  it("回收范围预览：目录名与档案 id 不同名时目录会走，同名时只搬三样、目录留着", async () => {
    const dataDir = await tempDataDir();
    await writePair(dataDir);
    const different = await inspectProfile(dataDir, "xiaobei");
    expect(different.reclaimScope.map((entry) => [entry.path, entry.action])).toEqual([
      [path.join("agents", "小贝", "SOUL.md"), "move"],
      [path.join("agents", "小贝", "state.json"), "move"],
      [path.join("agents", "小贝", SOUL_HISTORY_DIRECTORY_NAME), "move"],
      [path.join("agents", "小贝"), "move"],
      [path.join("agents", "xiaobei"), "keep"],
      ["sessions/（在 DSH_HOME 下，不在数据根里）", "keep"],
      [path.join(RUNTIME_DIRECTORY_NAME, "session-bindings.json"), "keep"],
      [path.join("legion", "teams"), "keep"],
      [path.join(TRASH_DIRECTORY_NAME, DELETION_LOG_FILE), "append"],
    ]);
    expect(different.reclaimScope[4]?.what).toContain("MEMORY.md");

    // 目录名正好是档案 id：同一行路径不能出现两遍，记忆与目录并成一条说清。
    const sameDir = await tempDataDir();
    await writeSoul(sameDir, "xiaoma", SOUL_XIAOMA);
    const same = await inspectProfile(sameDir, "xiaoma");
    const paths = same.reclaimScope.map((entry) => entry.path);
    expect(paths).toHaveLength(new Set(paths).size);
    expect(same.reclaimScope).toHaveLength(8);
    expect(same.reclaimScope.find((entry) => entry.path === path.join("agents", "xiaoma"))).toMatchObject({ action: "keep" });
    expect(same.reclaimScope.find((entry) => entry.path === path.join("agents", "xiaoma"))?.what).toContain("同一层");
    expect(same.reclaimScope.some((entry) => entry.what.includes("搬空之后才删"))).toBe(false);
  });
});
