import { describe, expect, it } from "vitest";
import { assertRawCommandAllowed, entryDenialReason, isExecutionAllowed, type EntryPolicyOptions } from "../src/index.js";

const FULL = { readIsolated: true, writeIsolated: true };
const WRITE_ONLY = { readIsolated: false, writeIsolated: true };

describe("assertRawCommandAllowed", () => {
  it("rejects write-only isolation and allows both read and write isolation", () => {
    expect(() => assertRawCommandAllowed({ isolation: WRITE_ONLY })).toThrow(/缺少读隔离/);
    expect(() => assertRawCommandAllowed(undefined)).toThrow(/缺少读隔离/);
    expect(() => assertRawCommandAllowed({})).toThrow(/缺少读隔离/);
    expect(() => assertRawCommandAllowed({ isolation: FULL })).not.toThrow();
  });

  it("honours the explicit allowUnisolated switch", () => {
    expect(() => assertRawCommandAllowed({ allowUnisolated: true })).not.toThrow();
    expect(isExecutionAllowed({ isolation: WRITE_ONLY, allowUnisolated: true })).toBe(true);
    expect(isExecutionAllowed({ isolation: WRITE_ONLY })).toBe(false);
  });

  it("agrees with the tool entry gate on every combination of the same config", () => {
    // 两道门禁（模型工具入口 / 底层 shell 服务）对同一份配置必须同答，否则会出现
    // 「工具放行 pwsh、底层仍以缺少读隔离拒绝」的分叉。
    const policies: EntryPolicyOptions[] = [
      {},
      { isolation: WRITE_ONLY },
      { isolation: { readIsolated: true, writeIsolated: false } },
      { isolation: FULL },
      { allowUnisolated: true },
      { isolation: WRITE_ONLY, allowUnisolated: true },
    ];
    for (const policy of policies) {
      const toolAllowed = entryDenialReason({ name: "pwsh", policy }) === undefined;
      expect(isExecutionAllowed(policy), JSON.stringify(policy)).toBe(toolAllowed);
    }
  });
});
