import { afterEach, describe, expect, it } from "vitest";
import { CONTROL_OPERATIONS, expandOperations, type ControlOperation } from "../src/protocol.js";
import { buildPanelManifest, impliedOperations, registerVoidPanel } from "../src/panel.js";
import { bootControl, disposeContexts } from "./support/boot.js";
import { FakeSettings } from "./support/fake-settings.js";

afterEach(disposeContexts);

interface Manifest {
  namespace: string;
  runtime?: { enabled: boolean; path: string; ledger: string; transport: string };
  connect?: { path: string; transport?: string };
  groups: Array<{
    id: string;
    title: string;
    fields: Array<{ path: string[]; widget?: string; readOnly?: boolean; source?: string }>;
  }>;
  operations?: Array<{ value: string; label: string; implies: string[] }>;
}

const ENDPOINT = "/mcp/dsh-agent-control";
const RUNTIME = { enabled: true, path: ENDPOINT, ledger: "storage", transport: "streamable-http" };
const manifest = (): Manifest => buildPanelManifest(RUNTIME) as Manifest;

/** Walk a path through a resolved settings value. */
function at(value: unknown, path: readonly string[]): { found: boolean; value: unknown } {
  let cursor: unknown = value;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object") return { found: false, value: undefined };
    const record = cursor as Record<string, unknown>;
    if (!(key in record)) return { found: false, value: undefined };
    cursor = record[key];
  }
  return { found: true, value: cursor };
}

describe("void-dsh-control panel: 基本 组的说明与实现一致", () => {
  const fields = (): Array<{ path: string[]; help?: string }> => {
    const m = buildPanelManifest(RUNTIME) as unknown as {
      groups: Array<{ id: string; fields: Array<{ path: string[]; help?: string }> }>;
    };
    return m.groups.find((g) => g.id === "basic")!.fields;
  };

  it("declares exactly the four runtime fields, all marked as runtime-sourced", () => {
    // 这四项**不在设置 schema 里**（controlSchema 刻意不含它们），所以 describe() 的 value
    // 与 base 都没有它们——base 是 sectionFromEntry() 的产物，本身只含 schema 的键。
    // 面板无法从设置视图读到，必须标 source: "runtime" 从清单的 runtime 块取。
    expect(fields().map((f) => f.path.join("."))).toEqual(["enabled", "path", "ledger", "transport"]);
    expect(fields().map((f) => f.source)).toEqual(["runtime", "runtime", "runtime", "runtime"]);
  });

  it("warns that a profile patch replaces the whole config, not merges it", () => {
    // patch 的 config 是整体替换（dsh-app-boot 的 applyEntryPatches 对顶层键直接赋值）。
    // 只写 allowedRoots 会把 tokens 一并抹掉，端点还在但所有请求 401。这条必须在「基本」组
    // 最上面看到——那是用户准备动手改 patch 的地方。
    const m = buildPanelManifest(RUNTIME) as unknown as {
      groups: Array<{ id: string; notice?: string }>;
    };
    const basic = m.groups.find((g) => g.id === "basic")!;
    expect(basic.notice).toBeDefined();
    expect(basic.notice).toContain("整体替换");
    expect(basic.notice).toContain("tokens");
    expect(basic.notice).toContain("401");
    expect(basic.notice).toContain("cordis.patch.yml");
    // 其余分组不该被顺手套上警示行。
    expect(m.groups.filter((g) => g.notice !== undefined).map((g) => g.id)).toEqual(["basic"]);
  });

  it("carries the runtime block the runtime-sourced fields read", () => {
    const m = buildPanelManifest(RUNTIME) as unknown as { runtime?: Record<string, unknown> };
    expect(m.runtime).toEqual(RUNTIME);
  });

  it("no field claims a runtime source without one", () => {
    // 反过来也要成立：标了 runtime 就必须真在 runtime 里有值，否则又是四个空。
    const m = buildPanelManifest(RUNTIME) as unknown as {
      runtime?: Record<string, unknown>;
      groups: Array<{ fields: Array<{ path: string[]; source?: string }> }>;
    };
    for (const group of m.groups) {
      for (const field of group.fields) {
        if (field.source !== "runtime") continue;
        expect(m.runtime).toHaveProperty(field.path[0]!);
      }
    }
  });

  it("never promises a restart, because the user patch layer applies live", () => {
    // 实测：往 profile 的 cordis.patch.yml 写 enabled: false 或改 path，端点数秒内消失/
    // 搬家，进程不用重启。原先三处写「改后需重启」，与 dsh 的 watchUserPatches 行为相反。
    // 只针对那三个错词。`ledger` 的「memory 重启即丢」是描述语义，不是重启承诺。
    const stale = fields().filter((f) => /(?<!无)需重启|需要重启/.test(f.help ?? ""));
    expect(stale.map((f) => f.path.join("."))).toEqual([]);
  });

  it("says out loud that a bad transport is rejected instead of ignored", () => {
    // transport 曾是死字段：声明了、显示了，但没有任何代码读它，配错也不报错。
    const transport = fields().find((f) => f.path.join(".") === "transport")!;
    expect(transport.help).toContain("拒绝启动");
  });

  it("warns that storage needs a mounted storage domain", () => {
    // openLedger 在 ledger: storage 且没有 ctx.storageDomain 时抛错，插件起不来。原文案
    // 只说「storage 持久」，漏了这条会让用户以为只是「不持久」。
    const ledger = fields().find((f) => f.path.join(".") === "ledger")!;
    expect(ledger.help).toContain("storage 域");
    expect(ledger.help).toContain("失败");
  });
});
describe("panel: operation vocabulary", () => {
  it("lists every grantable operation exactly once", () => {
    const values = manifest().operations!.map((op) => op.value);
    expect(values).toEqual([...CONTROL_OPERATIONS]);
    expect(new Set(values).size).toBe(values.length);
    // Every entry needs a human label, or the matrix renders a bare identifier.
    for (const op of manifest().operations!) expect(op.label.length).toBeGreaterThan(0);
  });

  it("derives implied permissions from the runtime expansion, not a restated table", () => {
    // The whole point: the greyed-out "granted for you" rows must be exactly the
    // difference between what the runtime grants and what the user ticked.
    for (const granted of CONTROL_OPERATIONS) {
      const selected: ControlOperation[] = [granted];
      const effective = expandOperations(selected);
      const expected = CONTROL_OPERATIONS.filter((op) => effective.has(op) && op !== granted);
      expect(impliedOperations(selected)).toEqual(expected);
    }
  });

  it("ships the transitive closure so the panel never walks the graph", () => {
    // The client only unions these sets. If the manifest shipped direct edges
    // instead, the client would have to reimplement the walk and could drift
    // from the runtime.
    const byValue = new Map(manifest().operations!.map((op) => [op.value, op]));
    expect(byValue.get("session.prompt")!.implies.sort()).toEqual(["session.create", "workspace.read"]);
    expect(byValue.get("session.plan")!.implies.sort()).toEqual(["session.create", "workspace.read"]);
    expect(byValue.get("session.plan")!.label).toContain("Web 评审");
    expect(byValue.get("task.cancel")!.implies.sort()).toEqual(["session.observe", "task.read"]);
    expect(byValue.get("workspace.read")!.implies).toEqual([]);
    // Every operation implied by one entry must itself be a catalogued entry,
    // or the matrix would mark a row the user cannot see.
    for (const op of manifest().operations!) {
      for (const implied of op.implies) expect(byValue.has(implied)).toBe(true);
    }
  });

  it("walks the implication chain rather than only one hop", () => {
    // session.prompt implies session.create implies workspace.read.
    const implied = impliedOperations(["session.prompt"]);
    expect(implied).toContain("session.create");
    expect(implied).toContain("workspace.read");
  });

  it("reports nothing implied for a self-contained permission", () => {
    expect(impliedOperations(["workspace.read"])).toEqual([]);
  });

  it("does not re-list a permission the user already ticked", () => {
    expect(impliedOperations(["session.prompt", "session.create", "workspace.read"])).toEqual([]);
  });
});

describe("panel: manifest against the registered schema", () => {
  it("gives every writable manifest field a path that exists in the namespace", async () => {
    const settings = new FakeSettings();
    await bootControl({ settings });
    const resolved = settings.schemaOf(manifest().namespace)!({}) as Record<string, unknown>;

    const missing: string[] = [];
    for (const group of manifest().groups) {
      for (const field of group.fields) {
        if (field.readOnly === true) continue;
        if (!at(resolved, field.path).found) missing.push(`${group.id}: ${field.path.join(".")}`);
      }
    }
    // A writable field the schema does not have would render as a control that
    // writes nothing — the worst kind of panel bug, because it looks like it
    // worked.
    expect(missing).toEqual([]);
  });

  it("marks every composition-only field read-only rather than offering an edit", async () => {
    const settings = new FakeSettings();
    await bootControl({ settings });
    const resolved = settings.schemaOf(manifest().namespace)!({}) as Record<string, unknown>;

    const wronglyWritable: string[] = [];
    for (const group of manifest().groups) {
      for (const field of group.fields) {
        // Exactly the complement of the previous test: nothing may be both
        // absent from the schema and presented as editable.
        if (field.readOnly !== true && !at(resolved, field.path).found) {
          wronglyWritable.push(`${group.id}: ${field.path.join(".")}`);
        }
        if (field.readOnly === true && at(resolved, field.path).found) {
          wronglyWritable.push(`${group.id}: ${field.path.join(".")} marked read-only but is writable`);
        }
      }
    }
    expect(wronglyWritable).toEqual([]);
  });

  it("reports the configured endpoint path rather than a hard-coded one", () => {
    // A hard-coded path would generate client configs pointing at an endpoint the
    // user had already moved.
    expect(manifest().connect).toEqual({ path: ENDPOINT, transport: "streamable-http" });
    expect((buildPanelManifest({ ...RUNTIME, path: "/custom/mcp" }) as Manifest).connect!.path).toBe("/custom/mcp");
  });

  it("keeps the connect group free of fields", () => {
    // Its content is generated from the manifest plus live values, so a field
    // here would be rendered as an empty control.
    const connect = manifest().groups.find((g) => g.id === "connect");
    expect(connect?.fields).toEqual([]);
  });

  it("groups every live-settable field exactly once", async () => {
    const settings = new FakeSettings();
    await bootControl({ settings });
    const resolved = settings.schemaOf(manifest().namespace)!({}) as Record<string, unknown>;

    const declared = manifest().groups.flatMap((g) => g.fields.map((f) => f.path.join(".")));
    const top = (path: string) => path.split(".")[0]!;
    const covered = new Set(declared.map(top));
    // `enabled` / `path` / `ledger` / `transport` are composition-entry concerns
    // shown read-only, so they are deliberately in the manifest but not the schema.
    const compositionOnly = new Set(["enabled", "path", "ledger", "transport"]);
    const ungrouped = Object.keys(resolved).filter((key) => !covered.has(key) && !compositionOnly.has(key));
    expect(ungrouped).toEqual([]);
  });
});

describe("panel: registration", () => {
  it("registers the manifest with the Void entry when its service is present", async () => {
    const settings = new FakeSettings();
    const registered = new Map<string, unknown>();
    const ctx = await bootControl({ settings, withControllers: true });

    // Stand in for void-entry's service: the plugin must register through it
    // without importing it, which is what keeps the two packages decoupled.
    ctx.provide("voidSuite", {
      registerPanel: (pkg: string, value: unknown) => {
        registered.set(pkg, value);
        return () => registered.delete(pkg);
      },
    } as unknown as Parameters<typeof ctx.provide>[1]);
    ctx.inject?.([] as string[], () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Re-run the contribution against the now-present service.
    registerVoidPanel(ctx as never, ENDPOINT);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(registered.has("@void/void-dsh-control")).toBe(true);
  });
});
