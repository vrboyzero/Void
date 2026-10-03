import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 宿主原语契约的回归锁。
 *
 * 背景（0.1.7-rc.1 真机白屏）：宿主把产品图标从 `Icon<字形><尺寸>` 改名成
 * `Icon<字形>Regular` / `Icon<字形>Medium`，尺寸改为 `size` prop。本插件仍按旧名
 * import，拿到的就是 `undefined`；把它交给 React 渲染会抛「element type is
 * invalid」，打掉**整个 `settings.section` 条目**——现象是设置面板全白，而不是
 * 少一个图标。`primitives.d.ts` 是按宿主同版生成的，所以「源码 import 的名字」
 * 与「声明里有的名字」一旦不一致，就是这类事故的前兆。
 *
 * 这两条都是**源码扫描**，不 import 宿主模块：该包由宿主的冻结模块表在运行时提供，
 * 磁盘上装不进来（见 `primitives.d.ts` 顶部说明），渲染层仍由真机验证覆盖。
 */
const CLIENT_DIR = fileURLToPath(new URL("../src/client", import.meta.url));
const HOST_MODULE = "@deepseek-ai/dsh-client-ui-primitives";

/** 客户端源码文件（生成的声明参与「声明集合」，不参与「import 集合」）。 */
function clientFiles(): { name: string; text: string }[] {
  return readdirSync(CLIENT_DIR)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .map((name) => ({ name, text: readFileSync(join(CLIENT_DIR, name), "utf8") }));
}

/**
 * 从客户端源码里取出「从宿主模块 import 了哪些名字」。
 *
 * `typeOnly` 区分 `import type` / 内联 `type` 修饰符：类型在编译期就被擦掉，运行时
 * 不需要宿主导出它，所以只有值导入才要求进运行期探测清单。
 */
function importedNames(): Map<string, { file: string; typeOnly: boolean }> {
  const found = new Map<string, { file: string; typeOnly: boolean }>();
  const re = new RegExp(
    `import\\s+(type\\s+)?\\{([^}]*)\\}\\s+from\\s+["']${HOST_MODULE}["']`,
    "g",
  );
  for (const { name, text } of clientFiles()) {
    if (name === "primitives.d.ts") continue;
    for (const match of text.matchAll(re)) {
      const importIsTypeOnly = match[1] !== undefined;
      for (const raw of match[2]!.split(",")) {
        const trimmed = raw.trim();
        const token = trimmed.replace(/^type\s+/, "");
        const id = token.split(/\s+as\s+/)[0]!.trim();
        if (id === "") continue;
        found.set(id, { file: name, typeOnly: importIsTypeOnly || trimmed.startsWith("type ") });
      }
    }
  }
  return found;
}

/** `primitives.d.ts` 里声明的名字。 */
function declaredNames(): Set<string> {
  const text = readFileSync(join(CLIENT_DIR, "primitives.d.ts"), "utf8");
  const names = new Set<string>();
  // 生成器把 `declare module` 的每一行都缩进了两格，所以行首允许空白。
  const re = /^\s*export\s+(?:declare\s+)?(?:function|const|interface|type|class)\s+(\w+)/gm;
  for (const match of text.matchAll(re)) names.add(match[1]!);
  if (names.size === 0) throw new Error("primitives.d.ts 里没解析出任何声明——正则与生成器格式脱节了");
  return names;
}

/** `primitives-probe.ts` 的 `REQUIRED_PRIMITIVES` 字面量里的字符串。 */
function probedNames(): Set<string> {
  const text = readFileSync(join(CLIENT_DIR, "primitives-probe.ts"), "utf8");
  const block = /const REQUIRED_PRIMITIVES\s*=\s*\[([^\]]*)\]/.exec(text);
  if (block === null) throw new Error("primitives-probe.ts 里找不到 REQUIRED_PRIMITIVES");
  return new Set([...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!));
}

describe("void-entry host primitives contract", () => {
  it("imports only names the host version actually exports", () => {
    // primitives.d.ts 是按宿主同版重生成的；它没有的名字，运行时读出来就是 undefined。
    // 忘了重跑 scripts/gen-primitives-types.mjs 时，这条会先于真机白屏失败。
    const declared = declaredNames();
    const missing = [...importedNames()]
      .filter(([id]) => !declared.has(id))
      .map(([id, at]) => `${id}（${at.file}）`);
    expect(missing).toEqual([]);
  });

  it("keeps every imported value primitive in the runtime gap probe", () => {
    // 探测清单漏项不会报错，只会让 PRIMITIVE_GAPS 少报一个名字——而那正是白屏时
    // 唯一能说明「是宿主改名了」的证据。类型导入运行期不存在，不在此列。
    const probed = probedNames();
    const uncovered = [...importedNames()]
      .filter(([id, at]) => !at.typeOnly && !probed.has(id))
      .map(([id]) => id)
      .sort();
    expect(uncovered).toEqual([]);
  });

  it("declares no icon under the pre-0.1.7 size-suffixed name", () => {
    // 锁住改名本身：0.1.7 起尺寸是 prop，名字里不再带 14/16。
    const legacy = [...declaredNames()].filter((id) => /^Icon\w+Outline\d+$/.test(id));
    expect(legacy).toEqual([]);
  });
});
