import { describe, expect, it } from "vitest";
import { AppliedPromptRegistry } from "../src/index.js";

const record = (facetId: string | null) => ({
  snapshot: { soul: "底线", facet: facetId === null ? null : "# 开发\n", facetId, selectionRevision: 1 },
  facetName: facetId === null ? null : "开发专家",
  facetSummary: facetId === null ? null : "写代码",
});

describe("AppliedPromptRegistry", () => {
  it("每个档案只留最近一次：后来的覆盖先前的", () => {
    const registry = new AppliedPromptRegistry();
    expect(registry.size).toBe(0);
    expect(registry.get("xiaobei")).toBeUndefined();
    registry.remember("xiaobei", record("dev"));
    registry.remember("xiaoma", record(null));
    expect(registry.size).toBe(2);
    expect(registry.get("xiaobei")?.facetName).toBe("开发专家");
    registry.remember("xiaobei", record(null));
    expect(registry.size).toBe(2);
    expect(registry.get("xiaobei")?.snapshot.facetId).toBeNull();
  });

  it("档案删掉就清一份，整块清空也不影响别人再记", () => {
    const registry = new AppliedPromptRegistry();
    registry.remember("xiaobei", record("dev"));
    registry.remember("xiaoma", record(null));
    registry.forget("xiaobei");
    expect(registry.size).toBe(1);
    expect(registry.get("xiaobei")).toBeUndefined();
    // 忘一个不存在的档案不是错误：删档案的路径可能被走两遍。
    expect(() => registry.forget("missing")).not.toThrow();
    registry.clear();
    expect(registry.size).toBe(0);
    registry.remember("xiaobei", record("dev"));
    expect(registry.get("xiaobei")?.facetName).toBe("开发专家");
  });
});
