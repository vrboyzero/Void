import { describe, expect, it } from "vitest";
import { checkPatterns, pathPatternError } from "../src/client/patterns.js";

/**
 * `checkPatterns` 与 `pathPatternError` 是这一块唯一有判断逻辑的纯函数，所以单独测；
 * 控件本身是薄渲染层，由真机验证覆盖（面板里的试匹配框）。
 */
describe("void-entry patterns: forbidden-pattern feedback", () => {
  it("reports nothing extra for an empty entry", () => {
    // 空串是「刚点添加、还没填」的中间状态，不该显示成错误。
    expect(checkPatterns([""], "")).toEqual([{ source: "" }]);
  });

  it("flags a pattern that does not compile, with the engine message", () => {
    const [check] = checkPatterns(["("], "");
    expect(check!.error).toBeDefined();
    expect(check!.matched).toBeUndefined();
  });

  it("only checks syntax until a sample is given", () => {
    // 没有试匹配文本时不能报「未命中」——那会让人以为正则不生效。
    expect(checkPatterns(["sk-[a-z]+"], "")).toEqual([{ source: "sk-[a-z]+" }]);
  });

  it("marks which patterns a sample would trip", () => {
    const checks = checkPatterns(["sk-[a-z]+", "BEGIN RSA"], "token sk-abc123 leaked");
    expect(checks[0]).toEqual({ source: "sk-[a-z]+", matched: true });
    expect(checks[1]).toEqual({ source: "BEGIN RSA", matched: false });
  });

  it("keeps syntax errors distinguishable from misses while sampling", () => {
    const [check] = checkPatterns(["(unclosed"], "anything");
    expect(check!.error).toBeDefined();
    expect(check!.matched).toBeUndefined();
  });

  it("preserves input order so rows stay put while typing", () => {
    expect(checkPatterns(["a", "b"], "b").map((c) => c.matched)).toEqual([false, true]);
  });
});

describe("void-entry patterns: document-rule path pattern", () => {
  it("treats an empty pattern as 'any path', not an error", () => {
    // 契约是「留空表示任意路径都满足」，把它标红会让用户以为留空是合法的反例。
    expect(pathPatternError("")).toBeUndefined();
  });

  it("accepts a well-formed pattern", () => {
    expect(pathPatternError("^docs/.*\\.md$")).toBeUndefined();
  });

  it("returns the engine message for a broken pattern", () => {
    expect(pathPatternError("[unclosed")).toBeDefined();
  });
});
