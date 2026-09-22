import { describe, expect, it } from "vitest";
import { guardShell, installShellReadGuard } from "../src/index.js";

const FULL = { readIsolated: true, writeIsolated: true };

describe("guardShell", () => {
  it("does not call the inner shell without read isolation", async () => {
    let called = false;
    const guarded = guardShell({ run: async () => { called = true; return "ok"; } }, { isolation: { readIsolated: false, writeIsolated: true } });
    await expect(guarded.run({ command: "pwd" })).rejects.toThrow(/缺少读隔离/);
    expect(called).toBe(false);
  });

  it("calls the inner shell once the policy declares isolation or the explicit switch", async () => {
    const inner = { run: async () => "ok", start: () => "started" };
    await expect(guardShell(inner, { isolation: FULL }).run({ command: "pwd" })).resolves.toBe("ok");
    await expect(guardShell(inner, { allowUnisolated: true }).run({ command: "pwd" })).resolves.toBe("ok");
    await expect(guardShell(inner, { isolation: FULL }).start?.({ command: "pwd" })).toBe("started");
  });

  it("restores the original shell methods on dispose", async () => {
    const shell = {
      async run() { return "original"; },
      start() { return "started"; },
    };
    const restore = installShellReadGuard(shell);
    await expect(shell.run({ command: "pwd" })).rejects.toThrow(/缺少读隔离/);
    restore();
    await expect(shell.run({ command: "pwd" })).resolves.toBe("original");
  });

  it("放行声明了读隔离的配置：装上门禁后 shell 服务照常执行，卸载后恢复原方法", async () => {
    const shell = { async run() { return "original"; } };
    const restore = installShellReadGuard(shell, { isolation: FULL });
    await expect(shell.run({ command: "pwd" })).resolves.toBe("original");
    restore();
    // 恢复的是原方法本身，不再过门禁。
    await expect(shell.run({ command: "pwd" })).resolves.toBe("original");
  });
});
