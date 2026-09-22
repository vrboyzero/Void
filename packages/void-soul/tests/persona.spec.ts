import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMemberPersona, personaTextOf } from "../src/persona.js";
import { selectFacetForProfile, setFirstMeetingDone, setProfileSuspended } from "../src/soul-library.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDataDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "void-persona-"));
  roots.push(root);
  await mkdir(path.join(root, "agents"), { recursive: true });
  return root;
}

async function writeSoul(dataDir: string, directory: string, lines: readonly string[]): Promise<void> {
  const dir = path.join(dataDir, "agents", directory);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SOUL.md"), [...lines, ""].join("\n"), "utf8");
}

async function writeFacet(dataDir: string, file: string, lines: readonly string[]): Promise<void> {
  const dir = path.join(dataDir, "agents", "facets");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), [...lines, ""].join("\n"), "utf8");
}

/** 小马：一份带底线的档案，下面几个用例都从它出发。 */
async function xiaoma(dataDir: string, extra: readonly string[] = [], body = "你是小马，负责写码。"): Promise<void> {
  await writeSoul(dataDir, "小码", ["---", "id: xiaoma", "name: 小码", "summary: 写码", ...extra, "---", "", body]);
}

describe("逐子代理身份（persona）", () => {
  it("取的是这个成员自己的底线，字数与真正交出去的文本一致", async () => {
    const dataDir = await tempDataDir();
    await xiaoma(dataDir);
    await writeSoul(dataDir, "小贝", ["---", "id: xiaobei", "name: 小贝", "summary: 统筹", "---", "", "你是小贝，负责统筹。"]);

    const persona = await buildMemberPersona({ dataDir, agentId: "xiaoma" });
    expect(persona.agentId).toBe("xiaoma");
    expect(persona.text).toBe("你是小马，负责写码。");
    expect(persona.characters).toBe(persona.text.length);
    expect(persona.budgetSource).toBe("default");
    // 派活者自己的底线不在里面（文档：不能误把父身份当子身份）。
    expect(persona.text).not.toContain("你是小贝");
  });

  it("选了模组就把当前角色接在底线后面，中间只用一个换行", async () => {
    const dataDir = await tempDataDir();
    await xiaoma(dataDir);
    await writeFacet(dataDir, "coder.md", ["---", "id: coder", "name: 写码专家", "summary: 只写代码", "---", "", "# 角色", "只写代码，别改需求。"]);
    await selectFacetForProfile(dataDir, { profileId: "xiaoma", facetId: "coder" });

    const persona = await buildMemberPersona({ dataDir, agentId: "xiaoma" });
    expect(persona.text).toBe("你是小马，负责写码。\n# 角色\n只写代码，别改需求。");
    // 一个换行：预算就是按 soul + 1 + facet 量的，多一个换行报出来的字数就对不上了。
    expect(persona.text.split("\n")[1]).toBe("# 角色");
  });

  it("首次见面引导不进身份：那是跟主人见面用的，不是干活的说明书", async () => {
    const dataDir = await tempDataDir();
    await xiaoma(dataDir, ["firstMeeting: 先自我介绍，再问主人怎么称呼。"]);

    const persona = await buildMemberPersona({ dataDir, agentId: "xiaoma" });
    expect(persona.text).toBe("你是小马，负责写码。");
    expect(persona.text).not.toContain("自我介绍");
    // 标过「已完成」也不影响身份：引导本来就不在里面。
    await setFirstMeetingDone(dataDir, { profileId: "xiaoma", done: true });
    expect((await buildMemberPersona({ dataDir, agentId: "xiaoma" })).text).toBe("你是小马，负责写码。");
  });

  it("没有这份档案就拒绝，不退回别人的身份", async () => {
    const dataDir = await tempDataDir();
    await xiaoma(dataDir);
    await expect(buildMemberPersona({ dataDir, agentId: "ghost" })).rejects.toThrow(/没有这份档案，取不出派活身份: ghost/);
    await expect(buildMemberPersona({ dataDir, agentId: "   " })).rejects.toThrow(/取派活身份缺少档案 id/);
  });

  it("底线是空的就拒绝：不给子代理一个空名分", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小码", ["---", "id: xiaoma", "name: 小码", "summary: 写码", "---", "", "   "]);
    await expect(buildMemberPersona({ dataDir, agentId: "xiaoma" })).rejects.toThrow(/档案 xiaoma 没有底线正文，取不出派活身份/);
  });

  it("超出预算就拒绝，并带上预算与字数", async () => {
    const dataDir = await tempDataDir();
    await xiaoma(dataDir);
    await expect(buildMemberPersona({ dataDir, agentId: "xiaoma", maxCharacters: 5 })).rejects.toThrow(/预算 5 字/);
  });

  it("变量只查名字、不预检取值：白名单里的名字放过，别的名字一律拒", async () => {
    const dataDir = await tempDataDir();
    // 子代理的 provider/model 由宿主在它自己组装那一刻决定，这里拿不到，也就不假装检过。
    await xiaoma(dataDir, [], "你在 {{cwd}} 里写码，模型是 {{model}}。");
    const persona = await buildMemberPersona({ dataDir, agentId: "xiaoma" });
    expect(persona.text).toBe("你在 {{cwd}} 里写码，模型是 {{model}}。");

    await xiaoma(dataDir, [], "你在 {{secret}} 里写码。");
    await expect(buildMemberPersona({ dataDir, agentId: "xiaoma" })).rejects.toThrow(/未知说明书变量: secret/);
  });

  it("停用的档案拒绝派活：理由说清是「停用」而不是「没有档案」，正文一个字节没动", async () => {
    const dataDir = await tempDataDir();
    await xiaoma(dataDir);
    await setProfileSuspended(dataDir, { profileId: "xiaoma", suspended: true });

    await expect(buildMemberPersona({ dataDir, agentId: "xiaoma" })).rejects.toThrow(/档案已停用，拒绝派活: xiaoma/);
    // 停用不是删：正文还在，启用回来立刻又能取身份。
    expect(await readFile(path.join(dataDir, "agents", "小码", "SOUL.md"), "utf8")).toContain("你是小马，负责写码。");
    await setProfileSuspended(dataDir, { profileId: "xiaoma", suspended: false });
    expect((await buildMemberPersona({ dataDir, agentId: "xiaoma" })).text).toBe("你是小马，负责写码。");
  });

  it("personaTextOf 只管拼接：没有模组就只是底线，底线为空就只是模组", async () => {
    expect(personaTextOf({ soul: "底线", facet: null, facetId: null, selectionRevision: 0 })).toBe("底线");
    expect(personaTextOf({ soul: "底线", facet: "  ", facetId: "x", selectionRevision: 1 })).toBe("底线");
    expect(personaTextOf({ soul: "  ", facet: "模组", facetId: "x", selectionRevision: 1 })).toBe("模组");
    expect(personaTextOf({ soul: " 底线 ", facet: " 模组 ", facetId: "x", selectionRevision: 1 })).toBe("底线\n模组");
  });
});
