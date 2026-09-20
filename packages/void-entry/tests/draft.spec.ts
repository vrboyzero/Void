import { describe, expect, it } from "vitest";
import {
  draftOps,
  editDraft,
  isDirty,
  pathKey,
  sanitizeForSave,
  saveBlockers,
  shownValue,
  type Draft,
} from "../src/client/draft.js";

describe("void-entry draft: editing", () => {
  it("starts a draft from nothing and keeps the first revision seen", () => {
    // 以「草稿开始编辑时」的 revision 设栅，中途别处的改动**不**跟着更新——否则设栅
    // 就失去意义了。
    const first = editDraft(undefined, ["callerInstructions"], "a", 7);
    expect(first.revision).toBe(7);

    const later = editDraft(first, ["requiredFields"], ["x"], 9);
    expect(later.revision).toBe(7);
    expect(later.values).toEqual({ callerInstructions: "a", "requiredFields": ["x"] });
  });

  it("keys nested paths unambiguously enough to overwrite the same field", () => {
    const a = editDraft(undefined, ["callback", "url"], "http://x", 1);
    const b = editDraft(a, ["callback", "url"], "http://y", 1);
    expect(Object.keys(b.values)).toEqual(["callback.url"]);
    expect(b.values[pathKey(["callback", "url"])]).toBe("http://y");
  });

  it("shows the draft over the server value, and the server value for untouched fields", () => {
    const view = { callerInstructions: "server", requiredFields: ["a"] };
    const draft = editDraft(undefined, ["callerInstructions"], "draft", 1);
    expect(shownValue(view, draft, ["callerInstructions"])).toBe("draft");
    expect(shownValue(view, draft, ["requiredFields"])).toEqual(["a"]);
    expect(isDirty(draft, ["callerInstructions"])).toBe(true);
    expect(isDirty(draft, ["requiredFields"])).toBe(false);
  });

  it("treats a draft value of undefined as a real edit, not an absent one", () => {
    // 用 hasOwnProperty 而不是 `!== undefined`：把字段显式清空也是一次改动。
    const draft: Draft = { values: { x: undefined }, revision: 1 };
    expect(isDirty(draft, ["x"])).toBe(true);
    expect(shownValue({ x: "server" }, draft, ["x"])).toBeUndefined();
  });
});

describe("void-entry draft: sanitizing before save", () => {
  it("drops blank rows from string lists", () => {
    // 「点添加」产生的空行只是草稿；提交上去会被服务端按「必须是存在的绝对目录」这类
    // 规则拒掉，用户看到一句错误、行还没加出来。
    expect(sanitizeForSave("list", ["a", "", "  ", "b"])).toEqual(["a", "b"]);
    expect(sanitizeForSave("patterns", ["sk-[a-z]+", ""])).toEqual(["sk-[a-z]+"]);
  });

  it("drops rules with no id", () => {
    const rows = [
      { id: "spec", description: "", required: true, pathPattern: "" },
      { id: "", description: "还没填", required: true, pathPattern: "" },
    ];
    expect(sanitizeForSave("rules", rows)).toEqual([rows[0]]);
  });

  it("drops caller rows that are missing either half", () => {
    const rows = [
      { callerId: "codex", tokenEnv: "CODEX_TOKEN", operations: [] },
      { callerId: "half", tokenEnv: "", operations: [] },
      { callerId: "", tokenEnv: "ORPHAN", operations: [] },
    ];
    expect(sanitizeForSave("tokens", rows)).toEqual([rows[0]]);
  });

  it("leaves non-list widgets untouched", () => {
    expect(sanitizeForSave("text", "  padded  ")).toBe("  padded  ");
    expect(sanitizeForSave(undefined, ["a", ""])).toEqual(["a", ""]);
  });
});

describe("void-entry draft: blockers", () => {
  const widgets = { tokens: "tokens", requiredDocumentRules: "rules", allowedRoots: "list" };

  it("says nothing when the draft is empty", () => {
    expect(saveBlockers(undefined, widgets)).toEqual([]);
  });

  it("blocks a rule with no id and explains why", () => {
    // 服务端会回 `invalid pathPattern of rule ""`——看不懂的话。这里先拦住并说人话。
    const draft = editDraft(undefined, ["requiredDocumentRules"], [{ id: "", description: "", required: true, pathPattern: "" }], 1);
    const reasons = saveBlockers(draft, widgets);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("没填 id");
  });

  it("blocks a half-filled caller row", () => {
    const draft = editDraft(undefined, ["tokens"], [{ callerId: "codex", tokenEnv: "", operations: [] }], 1);
    expect(saveBlockers(draft, widgets)[0]).toContain("两个都要填");
  });

  it("does not block a blank row the user has not filled in yet", () => {
    // 「点添加」后还没填的空行会被静默丢掉，不该拦着保存。
    const draft = editDraft(undefined, ["tokens"], [{ callerId: "", tokenEnv: "", operations: [] }], 1);
    expect(saveBlockers(draft, widgets)).toEqual([]);
  });

  it("does not block a value the user edited back to what is already stored", () => {
    const already = [{ id: "spec", description: "", required: true, pathPattern: "" }];
    const draft = editDraft(undefined, ["requiredDocumentRules"], [{ id: "", description: "", required: true, pathPattern: "" }], 1);
    // 草稿里有空 id，但规整后与已存值不同——这条确实要拦。反过来，改回原值时不该拦：
    const same = editDraft(undefined, ["requiredDocumentRules"], already, 1);
    expect(saveBlockers(same, widgets)).toEqual([]);
    expect(saveBlockers(draft, widgets)).toHaveLength(1);
  });
});

describe("void-entry draft: ops", () => {
  const widgets = { allowedRoots: "list", callerInstructions: "text" };

  it("sends only the fields that actually changed", () => {
    // 把没动的字段也写一遍会平白抬高 revision，让别人的编辑器无谓地冲突。
    const view = { allowedRoots: ["E:/a"], callerInstructions: "same" };
    const draft: Draft = {
      values: { allowedRoots: ["E:/a"], callerInstructions: "same" },
      revision: 1,
    };
    expect(draftOps(draft, widgets, view)).toEqual([]);
  });

  it("emits the sanitized value, not the raw draft", () => {
    const view = { allowedRoots: [] };
    const draft: Draft = { values: { allowedRoots: ["E:/a", ""] }, revision: 1 };
    expect(draftOps(draft, widgets, view)).toEqual([
      { op: "set", path: ["allowedRoots"], value: ["E:/a"] },
    ]);
  });

  it("emits one op per changed field, so a save is a single mutation", () => {
    const view = { allowedRoots: [], callerInstructions: "old" };
    const draft: Draft = {
      values: { allowedRoots: ["E:/a"], callerInstructions: "new" },
      revision: 1,
    };
    const ops = draftOps(draft, widgets, view);
    expect(ops).toHaveLength(2);
    expect(ops.map((op) => op.path.join(".")).sort()).toEqual(["allowedRoots", "callerInstructions"]);
  });
});
