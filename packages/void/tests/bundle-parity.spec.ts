/**
 * 组合 bundle 与各包 bundle 的一致性。
 *
 * `packages/void/cordis.patch.yml` 是「装一个包拿到全部功能」的那一层，它必须等于
 * 各包自带 bundle 的并集：某个包新挂了插件而这里没跟上时，装组合包与逐个装包会得到
 * 两套不同的运行形态，而后者正是本地开发最常用的装法——不一致只在发布后才暴露。
 * 这层守卫就是为了让那种漏项在测试里红，而不是在真机上诡异。
 *
 * 只做行式解析：这几份文件的结构固定（`- insert:` + `- id:` + `name:` + 可选 `config:`），
 * 为一个测试引 YAML 依赖不划算。注释与空行在比对前剔除——它们属于文档，不属于结构。
 *
 * @module @void/void/tests/bundle-parity
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const packagesRoot = path.resolve(here, "..", "..");

/** 参与并集比对的包层（组合层自己的文件不在此列）。 */
const BUNDLE_OWNERS = [
  "void-entry",
  "void-soul",
  "void-memory",
  "void-tools",
  "void-legion",
] as const;

interface BundleEntry {
  /** 条目 id（profile patch 的定位键）。 */
  readonly id: string;
  /** 条目模块名。 */
  readonly name: string;
  /** 归一化后的条目原文（含 config），用于逐条比对。 */
  readonly block: string;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * 解析一份 bundle 文件里的 `insert` 列表。
 *
 * 条目从 `- id:` 开始，到下一条同缩进的 `- id:` 或缩进回退（列表结束）为止；`name:`
 * 取条目内第一条（tools 的 `config:` 里也有 `- name:`，但它在 `name:` 之后，取不到）。
 */
export function parseBundleEntries(file: string): BundleEntry[] {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const insertAt = lines.findIndex((line) => /^\s*-\s*insert:\s*$/.test(line));
  if (insertAt < 0) throw new Error(`bundle 文件里没有 insert 列表: ${file}`);
  const baseIndent = indentOf(lines[insertAt]!);

  const entries: BundleEntry[] = [];
  let current: { id: string; indent: number; body: string[] } | undefined;
  for (let index = insertAt + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (indentOf(line) <= baseIndent) break;
    const start = /^(\s*)-\s*id:\s*(\S+)\s*$/.exec(line);
    if (start !== null) {
      if (current !== undefined) entries.push(finish(file, current));
      current = { id: start[2]!, indent: start[1]!.length, body: [line.slice(start[1]!.length)] };
      continue;
    }
    if (current === undefined) continue;
    // 注释属于文档，不参与结构比对。
    if (trimmed.startsWith("#")) continue;
    current.body.push(line.slice(current.indent));
  }
  if (current !== undefined) entries.push(finish(file, current));
  return entries;
}

function finish(file: string, current: { id: string; body: string[] }): BundleEntry {
  const nameLine = current.body.find((line) => /^\s*name:\s*\S+/.test(line));
  if (nameLine === undefined) throw new Error(`bundle 条目缺少 name: ${file} → ${current.id}`);
  const name = /^\s*name:\s*(\S+)\s*$/.exec(nameLine)![1]!;
  return {
    id: current.id,
    name: name.replace(/^["']|["']$/g, ""),
    block: current.body.map((line) => line.replace(/\s+$/, "")).join("\n"),
  };
}

function ids(entries: readonly BundleEntry[]): string[] {
  return entries.map((entry) => entry.id);
}

const compositionFile = path.resolve(here, "..", "cordis.patch.yml");
const composition = parseBundleEntries(compositionFile);
const owners = BUNDLE_OWNERS.map((pkg) => ({
  pkg,
  file: path.join(packagesRoot, pkg, "cordis.patch.yml"),
  entries: parseBundleEntries(path.join(packagesRoot, pkg, "cordis.patch.yml")),
}));

describe("组合 bundle 与各包 bundle 的一致性", () => {
  it("组合层的条目集合恰好等于各包层的并集", () => {
    const union = [...new Set(owners.flatMap((owner) => ids(owner.entries)))].sort();
    expect(ids(composition).sort()).toEqual(union);
  });

  it("组合层没有重复 id", () => {
    const seen = ids(composition);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it.each([...BUNDLE_OWNERS])("%s 的条目在组合层里逐字一致（含 config）", (pkg) => {
    const owner = owners.find((candidate) => candidate.pkg === pkg)!;
    for (const entry of owner.entries) {
      const mirrored = composition.find((candidate) => candidate.id === entry.id);
      expect(mirrored, `组合层缺少 ${pkg} 的条目 ${entry.id}`).toBeDefined();
      expect(mirrored!.name, `${entry.id} 的模块名与 ${pkg} 不一致`).toBe(entry.name);
      expect(mirrored!.block, `${entry.id} 的配置与 ${pkg} 不一致`).toBe(entry.block);
    }
  });

  it.each([...BUNDLE_OWNERS])("%s 的条目在组合层里保持原有相对顺序", (pkg) => {
    const owner = owners.find((candidate) => candidate.pkg === pkg)!;
    const ownIds = new Set(ids(owner.entries));
    expect(ids(composition).filter((id) => ownIds.has(id))).toEqual(ids(owner.entries));
  });

  it("组合包的 dependencies 覆盖了每个包层（打包/安装时漏包这里就红）", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(here, "..", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const deps = Object.keys(manifest.dependencies ?? {});
    for (const pkg of BUNDLE_OWNERS) {
      expect(deps, `packages/void 的 dependencies 缺少 @void/${pkg}`).toContain(`@void/${pkg}`);
    }
  });
});
