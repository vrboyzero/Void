import { describe, expect, it } from "vitest";
import { Authenticator, constantTimeEquals, extractBearer, readTokenGrants } from "../src/auth.js";
import { ControlError, expandOperations, type ControlOperation } from "../src/protocol.js";

const ALPHA: ControlOperation[] = ["workspace.read", "session.prompt"];
const BETA: ControlOperation[] = ["workspace.read"];

function build(allowAnonymous = false): Authenticator {
  return new Authenticator({
    tokens: [
      { callerId: "alpha", token: "s3cret-alpha", operations: ALPHA },
      { callerId: "beta", token: "s3cret-beta", operations: BETA },
    ],
    allowAnonymous,
  });
}

describe("auth: bearer extraction", () => {
  it("accepts a well-formed header", () => {
    expect(extractBearer("Bearer abc")).toBe("abc");
    expect(extractBearer("bearer   abc  ")).toBe("abc");
  });

  it("rejects malformed or empty headers", () => {
    expect(extractBearer(undefined)).toBeUndefined();
    expect(extractBearer("Basic abc")).toBeUndefined();
    expect(extractBearer("Bearer   ")).toBeUndefined();
  });
});

describe("auth: constant-time comparison", () => {
  it("matches only identical values", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
    expect(constantTimeEquals("abc", "abd")).toBe(false);
  });

  it("does not throw on different lengths", () => {
    expect(constantTimeEquals("short", "a-much-longer-value")).toBe(false);
  });
});

describe("auth: authentication", () => {
  it("resolves the caller identity of a valid token", () => {
    const identity = build().authenticate("Bearer s3cret-beta");
    expect(identity.callerId).toBe("beta");
    expect(identity.operations.has("workspace.read")).toBe(true);
    expect(identity.operations.has("session.prompt")).toBe(false);
  });

  it("applies grant implications", () => {
    const identity = build().authenticate("Bearer s3cret-alpha");
    expect(identity.operations).toEqual(expandOperations(ALPHA));
  });

  it("rejects a missing token with a generic error", () => {
    const error = (() => {
      try {
        build().authenticate(undefined);
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(ControlError);
    expect((error as ControlError).code).toBe("dsh-control/unauthorized");
    // The message must not disclose whether any token is configured.
    expect((error as ControlError).message).toBe("missing or invalid credentials");
  });

  it("rejects an unknown token without revealing which part matched", () => {
    expect(() => build().authenticate("Bearer s3cret-gamma")).toThrowError(/missing or invalid credentials/);
  });

  it("allows anonymous access only when configured", () => {
    expect(() => build(false).authenticate(undefined)).toThrowError(ControlError);
    const identity = build(true).authenticate(undefined);
    expect(identity.callerId).toBe("anonymous");
  });
});

describe("auth: operation enforcement", () => {
  it("permits a granted operation", () => {
    const authenticator = build();
    expect(() => authenticator.require(authenticator.authenticate("Bearer s3cret-beta"), "workspace.read")).not.toThrow();
  });

  it("refuses an ungranted operation with a stable code", () => {
    const authenticator = build();
    const identity = authenticator.authenticate("Bearer s3cret-beta");
    try {
      authenticator.require(identity, "task.cancel");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ControlError);
      expect((error as ControlError).code).toBe("dsh-control/forbidden-operation");
      expect((error as ControlError).details).toEqual({ operation: "task.cancel" });
    }
  });
});

describe("auth: environment grants", () => {
  it("drops grants whose environment variable is unset and reports them", () => {
    const { grants, missingEnv } = readTokenGrants(
      [
        { callerId: "alpha", tokenEnv: "TEST_ALPHA_TOKEN", operations: ALPHA },
        { callerId: "beta", tokenEnv: "TEST_BETA_TOKEN", operations: BETA },
      ],
      { TEST_ALPHA_TOKEN: "  value  " } as NodeJS.ProcessEnv,
    );
    expect(grants).toEqual([{ callerId: "alpha", token: "value", operations: ALPHA }]);
    expect(missingEnv).toEqual(["TEST_BETA_TOKEN"]);
  });

  it("treats a blank environment value as absent", () => {
    const { grants, missingEnv } = readTokenGrants(
      [{ callerId: "alpha", tokenEnv: "TEST_ALPHA_TOKEN", operations: ALPHA }],
      { TEST_ALPHA_TOKEN: "   " } as NodeJS.ProcessEnv,
    );
    expect(grants).toEqual([]);
    expect(missingEnv).toEqual(["TEST_ALPHA_TOKEN"]);
  });
});
