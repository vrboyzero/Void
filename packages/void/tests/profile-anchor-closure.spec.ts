import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PROFILE_DIRECTORY_NAME as ENTRY_PROFILE_DIRECTORY_NAME,
  isProfileName as entryIsProfileName,
  profileLocationFromBaseUrl as entryAnchor,
  resolveProfileLocation,
} from "@void/void-entry";
import {
  PROFILE_DIRECTORY_NAME as SOUL_PROFILE_DIRECTORY_NAME,
  isProfileName as soulIsProfileName,
  profileLocationFromBaseUrl as soulAnchor,
  resolveVoidDataRoot,
  tryResolveVoidDataRoot,
} from "@void/void-soul";

/**
 * 档案锚点的跨包闭环：同一个宿主值，两个包必须认出同一个档案。
 *
 * 为什么要跨包测：`void-soul` 不带任何依赖（连 `@void/void-entry` 都不依赖），所以
 * 「从宿主给的档案目录反推档案」这件事在两份 `profileLocationFromBaseUrl` 里各写了一遍。
 * 各自单测全绿、合起来却一个认 `web`、一个认 `undefined`——那正是这套东西最容易坏的地方：
 * 装包的人会看到「记忆写进了 A、灵魂读的是 B」这种没人能一眼看懂的错。
 *
 * 背景（2026-09-22 真机核对，文档 13.1）：宿主从不设 `DSH_PROFILE`，根树插件的 `ctx.baseUrl`
 * 就是 `<DSH_HOME>/profiles/<档案名>/`。这是运行期唯一能拿到的「我是哪个档案」的宿主事实。
 */

const HOME = join(tmpdir(), "void-profile-anchor");
const PROFILE_DIR = join(HOME, "profiles", "web");
const BASE_URL = pathToFileURL(PROFILE_DIR).href;

interface AnchorCase {
  label: string;
  baseUrl: string | undefined;
  expected: { home: string; name: string } | undefined;
}

const CASES: AnchorCase[] = [
  { label: "宿主给的 file:// 档案目录（真机就是这个）", baseUrl: BASE_URL, expected: { home: HOME, name: "web" } },
  { label: "纯路径、结尾多一个分隔符", baseUrl: PROFILE_DIR + sep, expected: { home: HOME, name: "web" } },
  { label: "档案名带下划线与连字符", baseUrl: join(HOME, "profiles", "soul_mem-2"), expected: { home: HOME, name: "soul_mem-2" } },
  { label: "拿 home 本身当档案目录", baseUrl: HOME, expected: undefined },
  { label: "profiles 目录本身（没有档案名）", baseUrl: join(HOME, "profiles"), expected: undefined },
  { label: "上一级不是 profiles 就不认", baseUrl: join(HOME, "profiles", "..", "web"), expected: undefined },
  { label: "档案名带空格", baseUrl: join(HOME, "profiles", "web extra"), expected: undefined },
  { label: "档案名以点开头", baseUrl: join(HOME, "profiles", ".hidden"), expected: undefined },
  { label: "档案名以连字符开头", baseUrl: join(HOME, "profiles", "-web"), expected: undefined },
  { label: "相对路径不算数", baseUrl: "profiles/web", expected: undefined },
  { label: "别的协议不当路径用", baseUrl: "ftp://host/profiles/web", expected: undefined },
  { label: "空串", baseUrl: "", expected: undefined },
  { label: "宿主没给 baseUrl", baseUrl: undefined, expected: undefined },
];

describe("档案锚点：两份实现同一口径", () => {
  for (const item of CASES) {
    it(item.label, () => {
      expect(soulAnchor(item.baseUrl)).toEqual(item.expected);
      // 闭环本身：两边对同一个宿主值必须给出同一个答案。
      expect(soulAnchor(item.baseUrl)).toEqual(entryAnchor(item.baseUrl));
    });
  }

  it("档案名规则也是同一份", () => {
    for (const name of ["web", "soulmem", "soul_mem-2", "a", "0", "a".repeat(64), "a".repeat(65), "", ".hidden", "-web", "web extra", "档案", "web/"]) {
      expect(soulIsProfileName(name)).toBe(entryIsProfileName(name));
    }
    expect(entryIsProfileName("a".repeat(64))).toBe(true);
    expect(entryIsProfileName("a".repeat(65))).toBe(false);
  });

  it("目录名常量是同一个字面量", () => {
    expect(ENTRY_PROFILE_DIRECTORY_NAME).toBe("profiles");
    expect(SOUL_PROFILE_DIRECTORY_NAME).toBe(ENTRY_PROFILE_DIRECTORY_NAME);
  });
});

describe("数据根：只有宿主给的档案目录也认得出来", () => {
  it("从 baseUrl 推出 `<home>/void-data/<档案名>`", () => {
    expect(tryResolveVoidDataRoot({ env: {}, baseUrl: BASE_URL })).toBe(join(HOME, "void-data", "web"));
    expect(resolveVoidDataRoot({ env: {}, baseUrl: BASE_URL })).toBe(join(HOME, "void-data", "web"));
  });

  it("认不出档案目录就是「没配」：不猜默认档案，也不报错", () => {
    expect(tryResolveVoidDataRoot({ env: {} })).toBeUndefined();
    expect(tryResolveVoidDataRoot({ env: {}, baseUrl: HOME })).toBeUndefined();
    expect(tryResolveVoidDataRoot({ env: {}, baseUrl: join(HOME, "profiles", "web extra") })).toBeUndefined();
    // 但「说了档案名却解析不出来」照实抛（没配 ≠ 配错）。
    expect(() => resolveVoidDataRoot({ env: {} })).toThrowError(/数据根缺少档案名/);
    expect(() => resolveVoidDataRoot({ env: {}, dataDir: "relative/data" })).toThrowError(/数据根必须是绝对路径/);
  });

  it("入口侧同样认 ctx.baseUrl，且有人明说时以他为准", () => {
    expect(resolveProfileLocation({ get: () => undefined, baseUrl: BASE_URL }, {})).toEqual({ home: HOME, name: "web" });
    expect(resolveProfileLocation({ get: () => undefined, baseUrl: HOME }, {})).toBeUndefined();
    expect(resolveProfileLocation({ get: () => undefined, baseUrl: BASE_URL }, { DSH_HOME: HOME, DSH_PROFILE: "soulmem" })).toEqual({ home: HOME, name: "soulmem" });
    // 环境变量没给全（只给 home 没给档案名）时，档案名仍从 baseUrl 认。
    expect(resolveProfileLocation({ get: () => undefined, baseUrl: BASE_URL }, { DSH_HOME: HOME })).toEqual({ home: HOME, name: "web" });
  });
});
