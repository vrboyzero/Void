import { describe, expect, it } from "vitest";
import {
  createExternalSourceDocument,
  defaultExternalSourceConfig,
  externalSourceSnapshotOf,
  type ExternalSourceDocument,
} from "../src/external-source.js";
import { createSourceView, SOURCE_VIEW_ID, type SourceViewHost } from "../src/source-view.js";

function document(): ExternalSourceDocument {
  const doc = createExternalSourceDocument({
    config: defaultExternalSourceConfig({ repo: "owner/name", teamId: "alpha", allowed: ["alice"] }),
    now: new Date("2026-11-06T00:00:00Z"),
  });
  doc.runtime.status = "ready";
  doc.runtime.agentLogin = "void-agent";
  doc.runtime.lastPollAt = "2026-11-06T01:00:00Z";
  return doc;
}

function fake(mode: "observe" | "live" = "observe") {
  const doc = document();
  doc.runtime.mode = mode;
  let snapshot = externalSourceSnapshotOf(doc, new Date("2026-11-06T02:00:00Z"));
  const calls: string[] = [];
  const host: SourceViewHost = {
    readSnapshot: async () => snapshot,
    setMode: async (next, revision) => {
      calls.push(`mode:${next}:${revision}`);
      doc.runtime.mode = next;
      snapshot = externalSourceSnapshotOf(doc, new Date("2026-11-06T02:00:00Z"));
      return snapshot;
    },
    setEnabled: async (enabled, revision) => {
      calls.push(`enabled:${enabled}:${revision}`);
      doc.runtime.status = enabled ? "ready" : "off";
      snapshot = externalSourceSnapshotOf(doc, new Date("2026-11-06T02:00:00Z"));
      return snapshot;
    },
    pollNow: async () => { calls.push("poll"); },
    testAuth: async () => { calls.push("auth"); return { login: "void-agent", canPush: true }; },
  };
  return { host, calls, view: createSourceView(() => host) };
}

const profile = { home: "/tmp", name: "web" };

describe("外部来源面板视图", () => {
  it("没配置时列表为空；配置后一行摘要带状态与今日计数", async () => {
    const none = createSourceView(() => undefined);
    expect(SOURCE_VIEW_ID).toBe("void-legion:sources");
    await expect(none.list(profile)).rejects.toThrow(/没装上/);
    const { view } = fake();
    const items = await view.list(profile);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "github", title: "GitHub" });
    expect(items[0]?.summary).toContain("observe");
  });

  it("详情有状态/配置/账本与 observe 下的切 live 动作", async () => {
    const { view } = fake("observe");
    const body = await view.detail({ ...profile, itemId: "github" });
    expect(body.title).toContain("GitHub");
    expect(body.revision).toBe(0);
    expect(body.fields?.find((field) => field.key === "state")?.value).toBe("ready");
    expect(body.sections.map((section) => section.id)).toEqual(["config", "ledger"]);
    expect(body.actions?.map((action) => action.id)).toContain("source-live");
    expect(body.actions?.map((action) => action.id)).not.toContain("source-on");
  });

  it("停用状态下只给启用动作", async () => {
    const { view, host } = fake();
    await host.setEnabled(false, 0);
    const body = await view.detail({ ...profile, itemId: "github" });
    expect(body.actions?.map((action) => action.id)).toEqual(expect.arrayContaining(["source-on", "poll-now", "test-auth"]));
    expect(body.actions?.map((action) => action.id)).not.toContain("source-off");
  });

  it("动作带面板打开的修订号，逐个调用服务", async () => {
    const { view, calls } = fake("live");
    await view.act({ ...profile, itemId: "github", actionId: "source-off", args: {}, expectedRevision: 7 });
    await view.act({ ...profile, itemId: "github", actionId: "source-on", args: {}, expectedRevision: 7 });
    await view.act({ ...profile, itemId: "github", actionId: "source-observe", args: {}, expectedRevision: 7 });
    await view.act({ ...profile, itemId: "github", actionId: "poll-now", args: {}, expectedRevision: 7 });
    await view.act({ ...profile, itemId: "github", actionId: "test-auth", args: {}, expectedRevision: 7 });
    expect(calls).toEqual([
      "enabled:false:7",
      "enabled:true:7",
      "mode:observe:7",
      "poll",
      "auth",
    ]);
  });

  it("测试账号把 push 权限结果写在正文里", async () => {
    const { view } = fake();
    const body = await view.act({ ...profile, itemId: "github", actionId: "test-auth", args: {}, expectedRevision: 0 });
    expect(body.markdown).toContain("push 权限");
  });

  it("视图是管理视图：写请求必须来自浏览器面板", () => {
    const { view } = fake();
    expect(view.requireOrigin).toBe(true);
  });
});
