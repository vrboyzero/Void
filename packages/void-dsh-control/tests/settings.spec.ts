import { afterEach, describe, expect, it } from "vitest";
import { bootControl, disposeContexts, ENDPOINT } from "./support/boot.js";
import { FakeSettings } from "./support/fake-settings.js";

afterEach(disposeContexts);

const NS = "dsh-agent-control";
const TOKEN_ENV = "VOID_DSH_CONTROL_SPEC_TOKEN";

describe("settings: namespace coverage", () => {
  it("registers dsh-agent-control and leaves the composition entry authoritative", async () => {
    // No settings service: the plugin must still start and honour the entry.
    const ctx = await bootControl();
    const service = ctx.get("voidDshControl")!;
    expect(service.guard.allowedRoots).toEqual([]);
    expect(service.policy.callerInstructions).toBe("");
  });

  it("covers every live-settable field of the plugin configuration", async () => {
    const settings = new FakeSettings();
    await bootControl({ settings });
    const schema = settings.schemaOf(NS);
    expect(schema).toBeDefined();

    // Resolving against an empty document yields exactly the schema defaults,
    // which is how the settings panel discovers the fields it must render.
    const resolved = schema!({}) as Record<string, unknown>;
    expect(Object.keys(resolved).sort()).toEqual([
      "allowAnonymous",
      "allowedOperations",
      "allowedRoots",
      "callback",
      "callerInstructions",
      "forbiddenPatterns",
      "instructionsVersion",
      "requiredDocumentRules",
      "requiredFields",
      "tokens",
    ]);
    expect(Object.keys(resolved.callback as Record<string, unknown>).sort()).toEqual([
      "allowedHosts",
      "enabled",
      "events",
      "includeAssistantSummary",
      "maxAttempts",
      "secretEnv",
      "timeoutMs",
      "url",
    ]);
  });

  it("takes schema defaults from the composition entry, not a second opinion", async () => {
    const settings = new FakeSettings();
    await bootControl({
      settings,
      config: { allowedOperations: ["session.list"], instructionsVersion: 7 },
    });
    const resolved = settings.schemaOf(NS)!({}) as Record<string, unknown>;
    expect(resolved.allowedOperations).toEqual(["session.list"]);
    expect(resolved.instructionsVersion).toBe(7);
  });
});

describe("settings: validation", () => {
  async function bootWith(settings: FakeSettings) {
    return bootControl({ settings, config: { tokens: [{ callerId: "spec", tokenEnv: TOKEN_ENV }] } });
  }

  it("refuses an unknown operation name and stores nothing", async () => {
    const settings = new FakeSettings();
    await bootWith(settings);
    expect(() => settings.update(NS, { allowedOperations: ["session.prompt", "not.an.operation"] })).toThrowError(
      /allowedOperations names an unknown operation/,
    );
    // The refused write must not reach the user layer — otherwise the panel
    // would show a value the runtime rejects.
    expect(settings.user(NS)).toBeUndefined();
  });

  it("refuses an unknown operation on one token", async () => {
    const settings = new FakeSettings();
    await bootWith(settings);
    expect(() =>
      settings.update(NS, { tokens: [{ callerId: "spec", tokenEnv: TOKEN_ENV, operations: ["nope"] }] }),
    ).toThrowError(/tokens\[spec\]\.operations names an unknown operation/);
  });

  it("refuses an invalid forbidden pattern", async () => {
    const settings = new FakeSettings();
    await bootWith(settings);
    expect(() => settings.update(NS, { forbiddenPatterns: ["("] })).toThrowError(
      /invalid forbiddenPatterns regular expression/,
    );
  });

  it("refuses an enabled callback with no usable target", async () => {
    const settings = new FakeSettings();
    await bootWith(settings);
    // The secret check precedes the URL check inside resolveCallbackUrl, so the
    // variable has to be set for the URL rule to be the one under test.
    process.env["VOID_DSH_CONTROL_CALLBACK_SECRET"] = "spec-callback-secret";
    try {
      // resolveCallbackUrl is what the dispatcher calls per delivery, so storing
      // this would turn the next task event into a throw.
      expect(() => settings.update(NS, { callback: { enabled: true, url: "not-a-url" } })).toThrowError(
        /callback\.url is not a valid absolute URL/,
      );
    } finally {
      delete process.env["VOID_DSH_CONTROL_CALLBACK_SECRET"];
    }
  });
});

describe("settings: live effect", () => {
  it("applies a permission change to the running endpoint without a restart", async () => {
    const settings = new FakeSettings();
    const ctx = await bootControl({ settings, config: { allowAnonymous: false } });
    const url = `http://127.0.0.1:${ctx.get("webServer")!.port}${ENDPOINT}`;
    const initialize = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    };

    // Before: no credential, anonymous refused.
    expect((await fetch(url, initialize)).status).toBe(401);

    // A settings write stands in for the panel's update call.
    settings.update(NS, { allowAnonymous: true });

    // After: the very same request gets past authentication, with no
    // re-registration and no restart — the authenticator reads the section per
    // request. The exact success code is the MCP layer's business (406 for a
    // missing Accept header), so the assertion is on the refusal itself.
    expect((await fetch(url, initialize)).status).not.toBe(401);
  });

  it("drops a caller when its token binding changes", async () => {
    const settings = new FakeSettings();
    const ctx = await bootControl({
      settings,
      config: { tokens: [{ callerId: "spec", tokenEnv: TOKEN_ENV }] },
    });
    const url = `http://127.0.0.1:${ctx.get("webServer")!.port}${ENDPOINT}`;
    const call = (bearer: string) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });

    expect((await call("spec-token")).status).not.toBe(401);

    // Rebind the caller to a variable nobody set: the old token must stop
    // working immediately, because token values are re-read from the
    // environment rather than cached from activation.
    settings.update(NS, { tokens: [{ callerId: "spec", tokenEnv: "VOID_DSH_CONTROL_UNSET_TOKEN", operations: [] }] });
    expect((await call("spec-token")).status).toBe(401);
  });
});
