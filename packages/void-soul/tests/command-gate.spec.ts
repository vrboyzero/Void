import { describe, expect, it } from "vitest";
import { runGuardedCommand } from "../src/index.js";

describe("runGuardedCommand", () => {
  it("does not call the executor when read isolation is missing", async () => {
    let called = false;
    await expect(runGuardedCommand({
      policy: { isolation: { readIsolated: false, writeIsolated: true } },
      request: { command: "Get-Content secret.txt" },
      execute: async () => { called = true; return "secret"; },
    })).rejects.toThrow(/缺少读隔离/);
    expect(called).toBe(false);
  });

  it("calls the executor once the policy allows raw execution", async () => {
    await expect(runGuardedCommand({
      policy: { isolation: { readIsolated: true, writeIsolated: true } },
      request: { command: "pwd" },
      execute: async (request) => `ran ${request.command}`,
    })).resolves.toBe("ran pwd");
  });
});
