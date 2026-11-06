import { describe, expect, it } from "vitest";
import {
  createFeishuSourceDocument,
  defaultFeishuSourceConfig,
  feishuSourceSnapshotOf,
  type FeishuSourceDocument,
} from "../src/feishu-source.js";
import { createFeishuSourceView, FEISHU_VIEW_ID, type FeishuSourceViewHost } from "../src/feishu-source-view.js";

function document(): FeishuSourceDocument {
  const doc = createFeishuSourceDocument({
    config: defaultFeishuSourceConfig({
      teamId: "alpha",
      allowed: ["alice"],
      chats: { "chat-1": "mentions" },
      direct: "mentions",
    }),
    now: new Date("2026-11-06T00:00:00Z"),
  });
  doc.runtime.status = "ready";
  doc.runtime.botOpenId = "bot-open";
  return doc;
}

function fake(mode: "observe" | "live" = "observe") {
  const doc = document();
  doc.runtime.mode = mode;
  let snapshot = feishuSourceSnapshotOf(doc, new Date("2026-11-06T02:00:00Z"));
  const calls: string[] = [];
  const host: FeishuSourceViewHost = {
    readSnapshot: async () => snapshot,
    setMode: async (next, revision) => {
      calls.push(`mode:${next}:${revision}`);
      doc.runtime.mode = next;
      snapshot = feishuSourceSnapshotOf(doc);
      return snapshot;
    },
    setEnabled: async (enabled, revision) => {
      calls.push(`enabled:${enabled}:${revision}`);
      doc.runtime.status = enabled ? "ready" : "off";
      snapshot = feishuSourceSnapshotOf(doc);
      return snapshot;
    },
    syncAllowed: async (chatId, revision) => {
      calls.push(`sync:${chatId}:${revision}`);
      doc.config.allowed = ["alice", "bob"];
      snapshot = feishuSourceSnapshotOf(doc);
      return snapshot;
    },
    testAuth: async () => { calls.push("auth"); return { botOpenId: "bot-open" }; },
  };
  return { view: createFeishuSourceView(() => host), calls, host };
}

const profile = { home: "/tmp", name: "web" };

describe("飞书来源面板视图", () => {
  it("id 与列表摘要", async () => {
    const { view } = fake();
    expect(FEISHU_VIEW_ID).toBe("void-legion:feishu-source");
    const items = await view.list(profile);
    expect(items[0]).toMatchObject({ id: "feishu", title: "飞书" });
    expect(items[0]?.summary).toContain("observe");
  });

  it("详情含配置/账本与 observe 下的 live 动作", async () => {
    const { view } = fake("observe");
    const body = await view.detail({ ...profile, itemId: "feishu" });
    expect(body.title).toContain("飞书");
    expect(body.sections.map((section) => section.id)).toEqual(["config", "ledger"]);
    expect(body.actions?.map((action) => action.id)).toContain("source-live");
    expect(body.actions?.map((action) => action.id)).toContain("sync-allowed");
  });

  it("动作逐个调用服务，带 revision", async () => {
    const { view, calls } = fake("live");
    await view.act({ ...profile, itemId: "feishu", actionId: "source-off", args: {}, expectedRevision: 5 });
    await view.act({ ...profile, itemId: "feishu", actionId: "source-on", args: {}, expectedRevision: 5 });
    await view.act({ ...profile, itemId: "feishu", actionId: "source-observe", args: {}, expectedRevision: 5 });
    await view.act({ ...profile, itemId: "feishu", actionId: "sync-allowed", args: { chatId: "chat-1" }, expectedRevision: 5 });
    await view.act({ ...profile, itemId: "feishu", actionId: "test-auth", args: {}, expectedRevision: 5 });
    expect(calls).toEqual([
      "enabled:false:5",
      "enabled:true:5",
      "mode:observe:5",
      "sync:chat-1:5",
      "auth",
    ]);
  });

  it("同步名单缺 chatId 直接报错", async () => {
    const { view } = fake();
    await expect(view.act({ ...profile, itemId: "feishu", actionId: "sync-allowed", args: {}, expectedRevision: 0 }))
      .rejects.toThrow(/chat_id/);
  });

  it("管理视图 requireOrigin", () => {
    expect(fake().view.requireOrigin).toBe(true);
  });
});
