import { describe, expect, it } from "vitest";
import { evaluateRolePolicy } from "../src/contract.js";

describe("evaluateRolePolicy (Star role-policy mirror)", () => {
  const contract = {
    name: "void_exec",
    family: "command-exec" as const,
    isReadOnly: false,
    needsPermission: true,
    riskLevel: "high" as const,
  };

  it("allows when no policy is set", () => {
    expect(evaluateRolePolicy(contract).allowed).toBe(true);
  });

  it("denies when the family is outside the allowed set", () => {
    const decision = evaluateRolePolicy(contract, {
      role: "researcher",
      allowedToolFamilies: ["workspace-read"],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("command-exec");
  });

  it("denies when the risk level exceeds the cap", () => {
    const decision = evaluateRolePolicy(contract, {
      role: "coder",
      allowedToolFamilies: ["command-exec"],
      maxToolRiskLevel: "medium",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("risk");
  });

  it("allows a compliant contract", () => {
    const decision = evaluateRolePolicy(contract, {
      role: "commander",
      allowedToolFamilies: ["command-exec", "workspace-read"],
      maxToolRiskLevel: "critical",
    });
    expect(decision.allowed).toBe(true);
  });
});
