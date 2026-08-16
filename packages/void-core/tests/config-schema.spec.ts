import { describe, expect, it } from "vitest";
import {
  CONFIG_PRECEDENCE,
  maskSecret,
  resolveValue,
  assertConfigField,
  type ConfigField,
} from "../src/config-schema.js";

describe("void-core 配置合同", () => {
  it("优先级顺序固定为 defaults → profile → env → args", () => {
    expect(CONFIG_PRECEDENCE).toEqual(["defaults", "profile", "env", "args"]);
  });

  it("resolveValue 按 args > env > profile > defaults 解析", () => {
    const layers = { defaults: "d", profile: "p", env: "e", args: "a" } as const;
    expect(resolveValue(layers)).toBe("a");
    expect(resolveValue({ defaults: "d", profile: "p", env: "e" })).toBe("e");
    expect(resolveValue({ defaults: "d" })).toBe("d");
    expect(resolveValue({})).toBeUndefined();
    expect(resolveValue({}, "fallback")).toBe("fallback");
  });

  it("maskSecret 脱敏，短值整体打码", () => {
    expect(maskSecret("cli_abcdefgh")).toBe("cli_***gh");
    expect(maskSecret("short")).toBe("***");
  });

  it("assertConfigField：敏感字段必须是 adapter_credential", () => {
    const ok: ConfigField = {
      key: "feishu.appSecret",
      classification: "adapter_credential",
      owner: "void-channel-feishu",
      sensitive: true,
      reloadMode: "restart",
      failureMode: "fail_closed",
    };
    expect(() => assertConfigField(ok)).not.toThrow();

    const bad: ConfigField = { ...ok, classification: "void_native" };
    expect(() => assertConfigField(bad)).toThrow(/sensitive but classified/);
  });
});
