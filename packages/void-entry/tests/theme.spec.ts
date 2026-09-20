import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BORDER,
  DANGER,
  ROW_TITLE_CLASS,
  ensureStyles,
  TEXT_SECONDARY,
  WARN,
} from "../src/client/theme.js";

const CLIENT_DIR = fileURLToPath(new URL("../src/client", import.meta.url));

/** 客户端里所有手写样式的文件。 */
function styleSources(): { name: string; text: string }[] {
  return readdirSync(CLIENT_DIR)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    // 生成的 ambient 声明里没有样式，主题模块自己就是字面量的家。
    .filter((name) => name !== "primitives.d.ts" && name !== "theme.ts")
    .map((name) => ({ name, text: readFileSync(join(CLIENT_DIR, name), "utf8") }));
}

describe("void-entry theme: tokens", () => {
  it("routes every color through a host token, so both themes stay readable", () => {
    // 这条是回归锁。最初我们用 `#888` 表示弱化文字：深色下勉强能读，浅色下对比度只有
    // 3.54:1（WCAG AA 要求 4.5:1），再叠上未授权行的 opacity 后降到约 1.9:1，看起来就是
    // 失效态。写死的颜色不会跟着主题走，所以这里直接禁止字面量。
    const offenders: string[] = [];
    for (const { name, text } of styleSources()) {
      for (const [index, line] of text.split("\n").entries()) {
        // 注释里可以提到色值（说明「为什么不能用」），只看代码。
        const code = line.replace(/\/\/.*$/, "").replace(/\/\*[\s\S]*?\*\//g, "");
        const hit = /#[0-9a-fA-F]{3,8}\b|\brgba?\(/.exec(code);
        if (hit !== null) offenders.push(`${name}:${index + 1} ${hit[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("offers no tier below AA, so a readable-looking token cannot be picked by accident", () => {
    // 宿主还有 label-tertiary（浅色 3.71:1）与 label-caption（2.13:1）。我们曾用前者做帮助
    // 文字，结果整块面板 14 处不达标——且都是用户必须读的内容。这里锁住「不提供」。
    expect(TEXT_SECONDARY).toBe("var(--dsw-alias-label-secondary)");
    const theme = readFileSync(join(CLIENT_DIR, "theme.ts"), "utf8");
    for (const banned of ["label-tertiary", "label-caption", "label-dimmed"]) {
      expect(theme).not.toContain(`'var(--dsw-alias-${banned})'`);
    }
  });

  it("names the state and surface tokens the host defines", () => {
    for (const token of [BORDER, DANGER, WARN]) {
      expect(token).toMatch(/^var\(--dsw-alias-[a-z0-9-]+\)$/);
    }
  });
});

describe("void-entry theme: bold row titles", () => {
  it("passes the class to both disclosure call sites", () => {
    // DisclosureRow 的 title 是字符串、没有 weight 参数，加粗只能走 titleClassName + 注入的
    // 样式表。两处（插件卡片、分组）都要带上，漏一处就会出现一级粗一级不粗。
    // 匹配标识符而不是它解析后的值：源码里传的就是这个常量，正是「用了统一出处」的证据。
    const withClass = styleSources().filter(({ text }) =>
      /titleClassName:\s*ROW_TITLE_CLASS\b/.test(text),
    );
    expect(withClass.map((f) => f.name).sort()).toEqual(["controls.tsx", "index.tsx"]);
  });

  it("injects the bold rule under a stable id, exactly once", () => {
    // 幂等很重要：模块工厂在 HMR 下会重新执行，攒下多张表是隐性泄漏。
    const nodes: { id: string; textContent: string }[] = [];
    const doc = {
      getElementById: (id: string) => nodes.find((n) => n.id === id) ?? null,
      createElement: () => ({ id: "", textContent: "" }),
      head: { append: (el: { id: string; textContent: string }) => void nodes.push(el) },
    };
    (globalThis as Record<string, unknown>).document = doc;
    try {
      ensureStyles();
      ensureStyles();
    } finally {
      delete (globalThis as Record<string, unknown>).document;
    }
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.textContent).toContain(`.${ROW_TITLE_CLASS}`);
    expect(nodes[0]!.textContent).toContain("font-weight:600");
  });

  it("does nothing when there is no document, so the host half can import it", () => {
    expect(() => ensureStyles()).not.toThrow();
  });
});
