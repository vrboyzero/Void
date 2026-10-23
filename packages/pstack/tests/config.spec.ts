import { describe, expect, it } from "vitest";
import { resolvePstackConfig } from "../src/config.js";

describe("resolvePstackConfig", () => {
  it("defaults to registering everything and not renaming anything", () => {
    const resolved = resolvePstackConfig();
    expect(resolved.skills).toBe(true);
    expect(resolved.subagents).toBe(true);
    expect(resolved.potetoMode).toBe("off");
    expect(resolved.renameSkills.size).toBe(0);
    expect(resolved.subagentProvider).toBe("spawn");
    // 没有 preset 就没有工具面约束——默认值必须是「不假装有约束」。
    expect(resolved.commentSickoPreset).toBeUndefined();
  });

  it("rejects a rename target that is not kebab-case", () => {
    expect(() => resolvePstackConfig({ renameSkills: { tdd: "pstack tdd" } })).toThrow(/kebab-case/);
  });

  it("rejects two skills renamed onto the same name", () => {
    expect(() => resolvePstackConfig({ renameSkills: { tdd: "pstack-x", teach: "pstack-x" } })).toThrow(/同一个名字/);
  });

  it("rejects an empty subagent provider name", () => {
    expect(() => resolvePstackConfig({ subagentProvider: "  " })).toThrow(/不能是空字符串/);
  });

  it("treats a blank preset id as no preset at all", () => {
    expect(resolvePstackConfig({ commentSickoPreset: "  " }).commentSickoPreset).toBeUndefined();
    expect(resolvePstackConfig({ commentSickoPreset: " void-pstack:reader " }).commentSickoPreset).toBe("void-pstack:reader");
  });
});
