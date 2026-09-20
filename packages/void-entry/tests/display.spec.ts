import { describe, expect, it } from "vitest";
import { readonlyText } from "../src/client/display.js";

describe("void-entry display: read-only text", () => {
  it("shows a string as-is, without JSON quotes", () => {
    // 端点路径与账本后端都是字符串。JSON.stringify 会把它们渲染成 "/mcp/x"，摆在界面上
    // 像值里真有引号——这正是「基本」组修好取值后暴露出来的下一个问题。
    expect(readonlyText("/mcp/dsh-agent-control")).toBe("/mcp/dsh-agent-control");
    expect(readonlyText("storage")).toBe("storage");
    expect(readonlyText("")).toBe("");
  });

  it("renders booleans and numbers the way a person reads them", () => {
    expect(readonlyText(true)).toBe("true");
    expect(readonlyText(false)).toBe("false");
    expect(readonlyText(0)).toBe("0");
    expect(readonlyText(1234)).toBe("1234");
  });

  it("keeps JSON for values that need delimiters", () => {
    expect(readonlyText(["a", "b"])).toBe('["a","b"]');
    expect(readonlyText({ k: 1 })).toBe('{"k":1}');
  });

  it("marks absent values instead of printing undefined", () => {
    expect(readonlyText(undefined)).toBe("—");
    expect(readonlyText(null)).toBe("null");
  });
});
