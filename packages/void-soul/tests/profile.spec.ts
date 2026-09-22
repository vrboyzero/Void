import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FACET_DIRECTORY_NAME,
  SoulProfileError,
  indexSoulProfiles,
  isFacetDirectoryName,
  parseSoulDocument,
  resolveAgentDirectory,
  resolveVoidDataDir,
  tryResolveVoidDataRoot,
} from "../src/index.js";

const home = path.resolve("/tmp/dsh-home");

describe("resolveVoidDataDir", () => {
  it("默认落在 DSH_HOME/void-data/profile", () => {
    expect(resolveVoidDataDir({ dshHome: home, profile: "web" })).toBe(path.join(home, "void-data", "web"));
  });

  it("接受绝对覆盖路径，拒绝相对路径和非法 profile", () => {
    const override = path.resolve("/data/void");
    expect(resolveVoidDataDir({ dshHome: home, profile: "web", override })).toBe(override);
    expect(() => resolveVoidDataDir({ dshHome: home, profile: "web", override: "relative" })).toThrow(SoulProfileError);
    expect(() => resolveVoidDataDir({ dshHome: home, profile: "../web" })).toThrow(SoulProfileError);
  });
});

describe("tryResolveVoidDataRoot", () => {
  it("没给 dataDir 也没有档案名：返回 undefined，不猜一个默认档案", () => {
    expect(tryResolveVoidDataRoot({ env: {} })).toBeUndefined();
    // 空串与「没写」同义：宿主没给 DSH_PROFILE 时就是这个样子。
    expect(tryResolveVoidDataRoot({ dataDir: "", profile: "", env: {} })).toBeUndefined();
  });

  it("给了 dataDir、profile 或 DSH_PROFILE 就照常解析", () => {
    const explicit = path.resolve("/data/void");
    expect(tryResolveVoidDataRoot({ dataDir: explicit, env: {} })).toBe(explicit);
    expect(tryResolveVoidDataRoot({ dshHome: home, profile: "web", env: {} })).toBe(path.join(home, "void-data", "web"));
    expect(tryResolveVoidDataRoot({ env: { DSH_HOME: home, DSH_PROFILE: "web" } })).toBe(path.join(home, "void-data", "web"));
  });

  it("配错照实抛：相对 dataDir、非法档案名不静默降级", () => {
    expect(() => tryResolveVoidDataRoot({ dataDir: "relative", env: {} })).toThrow(SoulProfileError);
    expect(() => tryResolveVoidDataRoot({ profile: "../web", env: {} })).toThrow(SoulProfileError);
    expect(() => tryResolveVoidDataRoot({ dshHome: "relative", profile: "web", env: {} })).toThrow(/DSH_HOME 必须是绝对路径/);
  });
});

describe("resolveAgentDirectory", () => {
  const dataDir = path.join(home, "void-data", "web");

  it("允许可读目录名，拒绝越界和共用库保留名", () => {
    expect(resolveAgentDirectory(dataDir, "小贝")).toBe(path.join(dataDir, "agents", "小贝"));
    expect(() => resolveAgentDirectory(dataDir, "..")).toThrow(/非法 Agent 目录名/);
    expect(() => resolveAgentDirectory(dataDir, "facets")).toThrow(/非法 Agent 目录名/);
    expect(() => resolveAgentDirectory(dataDir, "a/b")).toThrow(/非法 Agent 目录名/);
  });

  it("保留名不区分大小写：Windows 上 Facets 就是 facets 那个目录", () => {
    expect(FACET_DIRECTORY_NAME).toBe("facets");
    expect(isFacetDirectoryName("facets")).toBe(true);
    expect(isFacetDirectoryName("Facets")).toBe(true);
    expect(isFacetDirectoryName("FACETS")).toBe(true);
    expect(isFacetDirectoryName("facets2")).toBe(false);
    expect(isFacetDirectoryName("小贝")).toBe(false);
    // 挡的是目录名，不是「名字里带 facets」。
    expect(() => resolveAgentDirectory(dataDir, "Facets")).toThrow(/非法 Agent 目录名/);
    expect(resolveAgentDirectory(dataDir, "facet_dev")).toBe(path.join(dataDir, "agents", "facet_dev"));
  });
});

describe("parseSoulDocument", () => {
  it("读取 id、显示名和简介，正文原样保留", () => {
    const parsed = parseSoulDocument(`---\nid: xiaobei\nname: "小贝"\nsummary: 统筹\n---\n# 底线\n`);
    expect(parsed.frontMatter).toEqual({ id: "xiaobei", name: "小贝", summary: "统筹" });
    expect(parsed.body).toBe("# 底线\n");
  });

  it("缺字段、未知字段和坏 id 都拒绝，不生成默认档案", () => {
    expect(() => parseSoulDocument("# 没有头")).toThrow(/front matter/);
    expect(() => parseSoulDocument("---\nname: 小贝\nsummary: 统筹\n---\n")).toThrow(/缺少 id/);
    expect(() => parseSoulDocument("---\nid: xiaobei\nname: 小贝\nsummary: 统筹\nnickname: 贝贝\n---\n")).toThrow(/不接受/);
    expect(() => parseSoulDocument("---\nid: ../xiaobei\nname: 小贝\nsummary: 统筹\n---\n")).toThrow(/非法档案 id/);
  });

  it("owner 只认主人 UUID：写别的值一律拒绝，不悄悄当成一个主人", () => {
    const owner = "8f14e45f-ceea-467a-9575-1b0f0f0b0a11";
    expect(parseSoulDocument(`---\nid: xiaobei\nname: 小贝\nsummary: 统筹\nowner: ${owner}\n---\n`).frontMatter.owner).toBe(owner);
    expect(() => parseSoulDocument("---\nid: xiaobei\nname: 小贝\nsummary: 统筹\nowner: 主人\n---\n")).toThrow(/owner 必须是主人 UUID/);
  });

  it("读缩进写的 authority 块：上下级引用稳定 id，enabled 缺省为 true", () => {
    const parsed = parseSoulDocument([
      "---",
      "id: xiaobei",
      "name: 小贝",
      "summary: 统筹",
      "authority:",
      "  superiors:",
      "    - laoban",
      "  subordinates: [xiaoma, xiaohong]",
      "---",
      "",
    ].join("\n"));
    expect(parsed.frontMatter.authority).toEqual({
      enabled: true,
      superiors: ["laoban"],
      subordinates: ["xiaoma", "xiaohong"],
    });
  });

  it("authority 可以显式关掉，但关掉时不能再留着关系", () => {
    const off = parseSoulDocument("---\nid: xiaobei\nname: 小贝\nsummary: 统筹\nauthority:\n  enabled: false\n---\n");
    expect(off.frontMatter.authority).toEqual({ enabled: false, superiors: [], subordinates: [] });
    expect(() => parseSoulDocument([
      "---", "id: xiaobei", "name: 小贝", "summary: 统筹",
      "authority:", "  enabled: false", "  superiors: [laoban]", "---", "",
    ].join("\n"))).toThrow(/已关掉，却还写着 superiors/);
  });

  it("authority 写错就报错，不猜：空列表、自引用、重复、非法 id、坏开关、未知字段", () => {
    const soul = (lines: readonly string[]) => ["---", "id: xiaobei", "name: 小贝", "summary: 统筹", ...lines, "---", ""].join("\n");
    // 开了列表却一个条目都没写：让人写 [] 表示空，而不是留一个说不清的空。
    expect(() => parseSoulDocument(soul(["authority:", "  superiors:"]))).toThrow(/列表字段为空: superiors/);
    expect(parseSoulDocument(soul(["authority:", "  superiors: []"])).frontMatter.authority?.superiors).toEqual([]);
    expect(() => parseSoulDocument(soul(["authority:", "  superiors: [xiaobei]"]))).toThrow(/不能写自己/);
    expect(() => parseSoulDocument(soul(["authority:", "  subordinates: [xiaoma, xiaoma]"]))).toThrow(/重复的档案 id/);
    expect(() => parseSoulDocument(soul(["authority:", "  superiors: [../laoban]"]))).toThrow(/非法档案 id/);
    expect(() => parseSoulDocument(soul(["authority:", "  enabled: yes"]))).toThrow(/必须是 true 或 false/);
    expect(() => parseSoulDocument(soul(["authority:", "  reportsTo: [laoban]"]))).toThrow(/不接受的 authority 字段/);
    expect(() => parseSoulDocument(soul(["authority:", "  superiors: laoban"]))).toThrow(/必须写成 \[a, b\] 这样的列表/);
    expect(() => parseSoulDocument(soul(["  superiors: [laoban]"]))).toThrow(/缩进不对/);
    expect(() => parseSoulDocument(soul(["authority: true"]))).toThrow(/不接受行内值/);
    expect(() => parseSoulDocument(soul(["authority:", "  - laoban"]))).toThrow(/列表项没有归属的字段/);
  });
});

describe("indexSoulProfiles", () => {
  it("同一 id 只能出现一次", () => {
    expect(indexSoulProfiles([{ directory: "小贝", id: "xiaobei" }]).get("xiaobei")).toBe("小贝");
    expect(() => indexSoulProfiles([
      { directory: "小贝", id: "xiaobei" },
      { directory: "贝贝", id: "xiaobei" },
    ])).toThrow(/重复/);
  });
});
