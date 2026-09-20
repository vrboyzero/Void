import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Authenticator,
  constantTimeEquals,
  describeTokenSetup,
  extractBearer,
  readTokenGrants,
  userEnvFilePath,
} from "../src/auth.js";
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

describe("auth: operator-facing token setup guidance", () => {
  it("resolves the user-level .env dsh reads from any invoking directory", () => {
    expect(userEnvFilePath({ DSH_HOME: "D:\\custom home" } as NodeJS.ProcessEnv)).toBe(
      join("D:\\custom home", ".env"),
    );
  });

  it("falls back to ~/.dsh when DSH_HOME is unset or blank", () => {
    const expected = join(homedir(), ".dsh", ".env");
    expect(userEnvFilePath({} as NodeJS.ProcessEnv)).toBe(expected);
    expect(userEnvFilePath({ DSH_HOME: "   " } as NodeJS.ProcessEnv)).toBe(expected);
  });

  it("expands a tilde prefix the way dsh does", () => {
    expect(userEnvFilePath({ DSH_HOME: "~/harness" } as NodeJS.ProcessEnv)).toBe(
      join(homedir(), "harness", ".env"),
    );
  });

  it("names the unset variable, the target file, the fix command and the doc pointer", () => {
    const message = describeTokenSetup(["VOID_DSH_CONTROL_TOKEN"], "C:\\Users\\me\\.dsh\\.env");
    expect(message).toContain("VOID_DSH_CONTROL_TOKEN");
    expect(message).toContain("C:\\Users\\me\\.dsh\\.env");
    expect(message).toContain("Get-Random");
    expect(message).toContain("§25.3");
    // The remediation must name the variable the operator has to set.
    expect(message).toContain("VOID_DSH_CONTROL_TOKEN=$t");
  });

  it("never leaks a token value into the guidance", () => {
    const message = describeTokenSetup(["A_TOKEN", "B_TOKEN"], "/home/me/.dsh/.env");
    expect(message).not.toMatch(/[0-9a-f]{32,}/);
    expect(message).toContain("A_TOKEN");
    expect(message).toContain("B_TOKEN");
  });

  it("still reads sensibly when no variable name is known", () => {
    expect(describeTokenSetup([], "/home/me/.dsh/.env")).toContain("401");
  });
});

describe("auth: token guidance follows the shell the operator actually has", () => {
  const FILE = "/home/me/.dsh/.env";

  it("prints a POSIX command on Linux and macOS, not PowerShell", () => {
    for (const platform of ["linux", "darwin"] as NodeJS.Platform[]) {
      const message = describeTokenSetup(["VOID_DSH_CONTROL_TOKEN"], FILE, platform);
      expect(message).toContain("/dev/urandom");
      expect(message).toContain(`>> "${FILE}"`);
      // A WSL operator has no $env:USERPROFILE and no Add-Content.
      expect(message).not.toContain("Add-Content");
      expect(message).not.toContain("USERPROFILE");
      expect(message).not.toContain("Get-Random");
    }
  });

  it("still prints PowerShell on Windows", () => {
    const message = describeTokenSetup(
      ["VOID_DSH_CONTROL_TOKEN"],
      "C:\\Users\\me\\.dsh\\.env",
      "win32",
    );
    expect(message).toContain("Add-Content");
    expect(message).toContain("Get-Random");
    expect(message).not.toContain("/dev/urandom");
  });

  it("creates the parent directory, since a fresh WSL home may lack it", () => {
    const message = describeTokenSetup(["VOID_DSH_CONTROL_TOKEN"], FILE, "linux");
    expect(message).toContain('mkdir -p "/home/me/.dsh"');
  });

  it("uses the variable name it was given on every platform", () => {
    for (const platform of ["win32", "linux"] as NodeJS.Platform[]) {
      expect(describeTokenSetup(["MY_TOKEN"], FILE, platform)).toContain("MY_TOKEN=$t");
    }
  });
});
