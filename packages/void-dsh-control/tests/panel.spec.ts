import { afterEach, describe, expect, it } from "vitest";
import { CONTROL_OPERATIONS, expandOperations, type ControlOperation } from "../src/protocol.js";
import { buildPanelManifest, impliedOperations, registerVoidPanel } from "../src/panel.js";
import { bootControl, disposeContexts } from "./support/boot.js";
import { FakeSettings } from "./support/fake-settings.js";

afterEach(disposeContexts);

interface Manifest {
  namespace: string;
  groups: Array<{
    id: string;
    title: string;
    fields: Array<{ path: string[]; widget?: string; readOnly?: boolean }>;
  }>;
  operations?: Array<{ value: string; label: string; implies: string[] }>;
}

const manifest = (): Manifest => buildPanelManifest() as Manifest;

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
    registerVoidPanel(ctx as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(registered.has("@void/void-dsh-control")).toBe(true);
  });
});
