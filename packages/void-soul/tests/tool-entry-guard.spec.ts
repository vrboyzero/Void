import { describe, expect, it } from "vitest";
import { EntryPolicyError } from "../src/entry-policy.js";
import { installToolEntryGuard } from "../src/tool-entry-guard.js";

const NO_ISOLATION = { readIsolated: false, writeIsolated: true };
const FULL_ISOLATION = { readIsolated: true, writeIsolated: true };

/** Host 的 `ToolRuntime.guard` 通道：注册一个返回原因的单调 guard。 */
function guardRegistry() {
  const guards: ((execution: { name?: string }) => string | undefined)[] = [];
  return {
    guards,
    registry: {
      guard(guard: (execution: { name?: string }) => string | undefined) { guards.push(guard); return () => { guards.splice(guards.indexOf(guard), 1); }; },
    },
  };
}

/** 兜底通道：没有 `guard` 的注册表。 */
function registerRegistry() {
  const registered: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[] = [];
  const registry = { register(tool: unknown) { registered.push(tool as (typeof registered)[number]); return () => undefined; } };
  return { registry, registered };
}

describe("installToolEntryGuard", () => {
  it("prefers the host guard channel, which covers tools registered before it", () => {
    const { registry, guards } = guardRegistry();
    const guard = installToolEntryGuard(registry, { isolation: NO_ISOLATION });
    expect(guard.channel()).toBe("guard");
    expect(guards).toHaveLength(1);
    // guard 通道不看注册先后：先注册的 write 一样被拦。
    expect(guards[0]!({ name: "write" })).toMatch(/需要读隔离执行环境/);
    expect(guards[0]!({ name: "read" })).toBeUndefined();
    expect(guards[0]!({ name: "bash" })).toMatch(/原始执行入口/);
    expect(guard.refused()).toEqual(["write", "bash"]);
    // 没有工具名（例如内部派发）不误伤。
    expect(guards[0]!({})).toBeUndefined();
  });

  it("keeps refusing host-private and manage entries through the guard channel", () => {
    const { registry, guards } = guardRegistry();
    installToolEntryGuard(registry, { isolation: FULL_ISOLATION, allowUnisolated: true });
    expect(guards[0]!({ name: "session_search" })).toMatch(/会读到 Host 私人数据/);
    expect(guards[0]!({ name: "cordis_define" })).toMatch(/管理入口/);
    expect(guards[0]!({ name: "cordis_inspect_query" })).toMatch(/会读到 Host 私人数据/);
    // 完整隔离下写/执行放行。
    expect(guards[0]!({ name: "write" })).toBeUndefined();
  });

  it("unregisters the guard on restore", () => {
    const { registry, guards } = guardRegistry();
    const guard = installToolEntryGuard(registry, { isolation: NO_ISOLATION });
    expect(guards).toHaveLength(1);
    guard.restore();
    expect(guards).toEqual([]);
  });

  it("falls back to wrapping register, and only touches the tools it wraps", async () => {
    const { registry, registered } = registerRegistry();
    const guard = installToolEntryGuard(registry, { isolation: NO_ISOLATION });
    expect(guard.channel()).toBe("register");
    let reached = false;
    registry.register({ name: "write", execute: async () => { reached = true; return "done"; } });
    await expect(registered[0]!.execute({}, {})).rejects.toThrow(/工具 write 属于写入入口/);
    expect(reached).toBe(false);
    registry.register({ name: "read", execute: async () => "ok" });
    await expect(registered[1]!.execute({}, {})).resolves.toBe("ok");
    guard.restore();
  });

  it("throws instead of pretending to be installed when the registry has neither channel", () => {
    expect(() => installToolEntryGuard({}, { isolation: NO_ISOLATION })).toThrow(EntryPolicyError);
    expect(() => installToolEntryGuard({}, { isolation: NO_ISOLATION })).toThrow(/入口门禁装不上/);
  });
});
