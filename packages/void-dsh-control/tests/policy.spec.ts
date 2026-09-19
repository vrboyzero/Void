import { describe, expect, it } from "vitest";
import { EMPTY_CALLER_POLICY, checkPolicy, compilePolicy, describePolicy, throwOnViolations, type CallerPolicy } from "../src/policy.js";
import { ControlError } from "../src/protocol.js";

const BASE: CallerPolicy = {
  callerInstructions: "下单前必须说明目标和验收标准。",
  requiredFields: ["objective", "acceptanceCriteria"],
  requiredDocumentRules: [
    { id: "task-spec", description: "必须提供任务规格文档", required: true, pathPattern: "^docs/.+\\.(md|txt)$" },
  ],
  forbiddenPatterns: ["BEGIN PRIVATE KEY"],
  instructionsVersion: 3,
};

describe("policy: compilation", () => {
  it("compiles the empty policy", () => {
    const compiled = compilePolicy(EMPTY_CALLER_POLICY);
    expect(compiled.instructionsVersion).toBe(0);
    expect(compiled.restrictsDocumentPaths).toBe(false);
    expect(checkPolicy(compiled, { texts: ["anything"] })).toEqual([]);
  });

  it("fails loud on an invalid regular expression instead of at request time", () => {
    expect(() => compilePolicy({ ...EMPTY_CALLER_POLICY, forbiddenPatterns: ["("] })).toThrowError(ControlError);
    expect(() => compilePolicy({ ...EMPTY_CALLER_POLICY, forbiddenPatterns: ["("] })).toThrowError(/invalid forbiddenPatterns/);
  });

  it("fails loud on an invalid document rule pattern", () => {
    expect(() =>
      compilePolicy({
        ...EMPTY_CALLER_POLICY,
        requiredDocumentRules: [{ id: "bad", description: "", required: true, pathPattern: "[unclosed" }],
      }),
    ).toThrowError(/pathPattern of rule "bad"/);
  });
});

describe("policy: required fields", () => {
  const compiled = compilePolicy(BASE);

  it("accepts a request that supplies every field", () => {
    expect(
      checkPolicy(compiled, {
        metadata: { objective: "完成任务", acceptanceCriteria: ["测试通过"] },
        documentPaths: ["docs/task.md"],
        texts: ["请完成"],
      }),
    ).toEqual([]);
  });

  it("reports every missing field in one round trip", () => {
    const violations = checkPolicy(compiled, { metadata: {}, documentPaths: ["docs/task.md"], texts: [] });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.code).toBe("dsh-control/policy-required-field");
    expect(violations[0]!.details["missingFields"]).toEqual(["objective", "acceptanceCriteria"]);
  });

  it("does not let a placeholder satisfy a required field", () => {
    const violations = checkPolicy(compiled, {
      metadata: { objective: "   ", acceptanceCriteria: [] },
      documentPaths: ["docs/task.md"],
      texts: [],
    });
    expect(violations[0]!.details["missingFields"]).toEqual(["objective", "acceptanceCriteria"]);
  });
});

describe("policy: document rules", () => {
  const compiled = compilePolicy(BASE);

  it("rejects a dispatch with no matching document", () => {
    const violations = checkPolicy(compiled, {
      metadata: { objective: "x", acceptanceCriteria: ["y"] },
      documentPaths: [],
      texts: [],
    });
    expect(violations.map((violation) => violation.code)).toEqual(["dsh-control/policy-document-missing"]);
    expect(violations[0]!.details["ruleId"]).toBe("task-spec");
  });

  it("rejects a document that matches no configured rule", () => {
    const violations = checkPolicy(compiled, {
      metadata: { objective: "x", acceptanceCriteria: ["y"] },
      documentPaths: ["src/index.ts"],
      texts: [],
    });
    expect(violations.map((violation) => violation.code).sort()).toEqual([
      "dsh-control/policy-document-invalid",
      "dsh-control/policy-document-missing",
    ]);
  });

  it("accepts a matching document and no pattern restriction when none is declared", () => {
    const permissive = compilePolicy({
      ...EMPTY_CALLER_POLICY,
      requiredDocumentRules: [{ id: "any", description: "", required: true }],
    });
    expect(checkPolicy(permissive, { documentPaths: ["anything/at/all.bin"], texts: [] })).toEqual([]);
  });
});

describe("policy: forbidden content", () => {
  const compiled = compilePolicy(BASE);

  it("rejects forbidden text without echoing it back", () => {
    const secret = "-----BEGIN PRIVATE KEY-----\nMIIE...";
    const violations = checkPolicy(compiled, {
      metadata: { objective: "x", acceptanceCriteria: ["y"] },
      documentPaths: ["docs/task.md"],
      texts: [secret],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.code).toBe("dsh-control/policy-forbidden-content");
    expect(JSON.stringify(violations[0]!.details)).not.toContain("MIIE");
  });

  it("scans nested metadata values", () => {
    const violations = checkPolicy(compiled, {
      metadata: {
        objective: "x",
        acceptanceCriteria: ["y"],
        extra: { nested: ["-----BEGIN PRIVATE KEY-----"] },
      },
      documentPaths: ["docs/task.md"],
      texts: [],
    });
    expect(violations.map((violation) => violation.code)).toContain("dsh-control/policy-forbidden-content");
  });
});

describe("policy: error projection", () => {
  it("throws the first violation with a stable code", () => {
    const compiled = compilePolicy(BASE);
    const violations = checkPolicy(compiled, { metadata: {}, documentPaths: [], texts: [] });
    try {
      throwOnViolations(violations);
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ControlError);
      expect((error as ControlError).code).toBe("dsh-control/policy-required-field");
      expect((error as ControlError).details["violationCount"]).toBeGreaterThan(1);
    }
  });

  it("does nothing when there are no violations", () => {
    expect(() => throwOnViolations([])).not.toThrow();
  });
});

describe("policy: description", () => {
  it("describes the live rules without leaking compiled state", () => {
    const described = describePolicy(compilePolicy(BASE));
    expect(described["instructionsVersion"]).toBe(3);
    expect(described["requiredFields"]).toEqual(["objective", "acceptanceCriteria"]);
    const rules = described["requiredDocumentRules"] as { id: string; description: string; required: boolean; pathPattern: string }[];
    expect(rules).toHaveLength(1);
    expect(rules[0]!.id).toBe("task-spec");
    expect(rules[0]!.description).toBe("必须提供任务规格文档");
    expect(rules[0]!.required).toBe(true);
    // `RegExp#source` is the canonical form; it re-compiles to the same matcher.
    expect(new RegExp(rules[0]!.pathPattern).test("docs/task.md")).toBe(true);
    expect(new RegExp(rules[0]!.pathPattern).test("src/index.ts")).toBe(false);
    expect(described["forbiddenPatternCount"]).toBe(1);
  });
});
