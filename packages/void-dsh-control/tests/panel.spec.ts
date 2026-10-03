import { afterEach, describe, expect, it } from "vitest";
import * as Control from "../src/index.js";
import { CONTROL_OPERATIONS, SETTINGS_NAMESPACE, expandOperations, type ControlOperation } from "../src/protocol.js";
import { buildPanelManifest, impliedOperations, registerVoidPanel } from "../src/panel.js";
import { bootControl, disposeContexts } from "./support/boot.js";
import { plainConfig } from "./support/fake-settings.js";

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
  const fields = (): Array<{ path: string[]; help?: string; source?: string }> => {
    const m = buildPanelManifest(RUNTIME) as unknown as {
      groups: Array<{ id: string; fields: Array<{ path: string[]; help?: string; source?: string }> }>;
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

describe("panel: manifest against the entry's Config schema", () => {
  // 0.2.0 起没有「插件注册的命名空间 schema」可查：宿主直接把入口的 `Config` 投影成表单
  // （命名空间 = 组合入口 id，见 `src/protocol.ts`）。所以这里比对的对象就是 `Control.Config`
  // 本身——面板清单与宿主派生表单读的是同一棵树，任何一边加字段、改归属都会在这里露出来。

  /** schemastery 节点里本例用到的部分：`meta.volatile` 与子字段表 `dict`。 */
  interface SchemaNode {
    meta?: { volatile?: boolean };
    dict?: Record<string, SchemaNode | undefined>;
  }
  const SCHEMA = Control.Config as unknown as SchemaNode;

  /**
   * 宿主判定「该字段可热改」的规则，逐字复刻 dsh-settings 的 `isVolatilePath`：
   * 路径上出现 volatile 节点（含路径末端）即可热改。
   */
  function isVolatilePath(path: readonly string[]): boolean {
    let node: SchemaNode | undefined = SCHEMA;
    for (const key of path) {
      if (node?.meta?.volatile === true) return true;
      node = node.dict?.[key];
      if (node === undefined) return false;
    }
    return node.meta?.volatile === true;
  }

  /** 对空对象解析一遍得到的字段视图，等价于面板读到的默认值。 */
  const resolved = (): Record<string, unknown> => plainConfig(Control.Config({})) as Record<string, unknown>;

  it("清单声明的命名空间就是宿主用的那个入口 id", () => {
    // 面板按这个键去设置视图里读值；写成别的（旧值是 "dsh-agent-control"）会让整块面板
    // 渲染出一片空值，而写入还会打到不存在的命名空间上。
    expect(manifest().namespace).toBe(SETTINGS_NAMESPACE);
  });

  it("gives every writable manifest field a path that exists in the Config schema", () => {
    const value = resolved();
    const missing: string[] = [];
    const notEditable: string[] = [];
    for (const group of manifest().groups) {
      for (const field of group.fields) {
        if (field.readOnly === true) continue;
        if (!at(value, field.path).found) missing.push(`${group.id}: ${field.path.join(".")}`);
        // 可写还不够：路径必须落在宿主允许热改的位置上，否则面板存下去的不是运行时读的那份。
        else if (!isVolatilePath(field.path)) notEditable.push(`${group.id}: ${field.path.join(".")}`);
      }
    }
    // A writable field the schema does not have would render as a control that
    // writes nothing — the worst kind of panel bug, because it looks like it
    // worked.
    expect(missing).toEqual([]);
    expect(notEditable).toEqual([]);
  });

  it("marks every composition-only field read-only rather than offering an edit", () => {
    const wronglyWritable: string[] = [];
    for (const group of manifest().groups) {
      for (const field of group.fields) {
        // Exactly the complement of the previous test, against the same rule the
        // host applies: editable ⟺ the path is live-settable.
        const live = isVolatilePath(field.path);
        if (field.readOnly === true && live) {
          wronglyWritable.push(`${group.id}: ${field.path.join(".")} marked read-only but the host would accept a write`);
        }
        if (field.readOnly !== true && !live) {
          wronglyWritable.push(`${group.id}: ${field.path.join(".")} offered for edit but is composition-only`);
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

  it("groups every live-settable field exactly once", () => {
    // 可热改的字段由 schema 决定（不是靠清单里手写的名单）：路径上最近的 volatile 祖先。
    const live = Object.keys(SCHEMA.dict ?? {}).filter((key) => isVolatilePath([key]));
    const compositionOnly = Object.keys(SCHEMA.dict ?? {}).filter((key) => !isVolatilePath([key]));
    // `enabled` / `path` / `ledger` / `transport` 是组合入口的事，只读展示。
    expect(compositionOnly).toEqual(["enabled", "transport", "path", "ledger"]);

    const groupsOf = new Map<string, Set<string>>();
    for (const group of manifest().groups) {
      for (const field of group.fields) {
        const top = field.path[0]!;
        const seen = groupsOf.get(top) ?? new Set<string>();
        seen.add(group.id);
        groupsOf.set(top, seen);
      }
    }

    const ungrouped = live.filter((key) => !groupsOf.has(key));
    // 反过来也拦一道：清单里不能出现 schema 没有的顶层字段（那会渲染成一个写不进去的控件）。
    const unknown = [...groupsOf.keys()].filter((key) => !(key in (SCHEMA.dict ?? {})));
    // 「恰好一次」：同一个可热改字段不能被拆到两个分组里，否则两个控件会互相覆盖。
    const split = [...groupsOf].filter(([key, groups]) => live.includes(key) && groups.size > 1).map(([key]) => key);

    expect(ungrouped).toEqual([]);
    expect(unknown).toEqual([]);
    expect(split).toEqual([]);
  });
});

describe("panel: registration", () => {
  it("registers the manifest with the Void entry when its service is present", async () => {
    const registered = new Map<string, unknown>();
    const ctx = await bootControl({ withControllers: true });

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
    registerVoidPanel(ctx as never, RUNTIME);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(registered.has("@void/void-dsh-control")).toBe(true);
  });
});
