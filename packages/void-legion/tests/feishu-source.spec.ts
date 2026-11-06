import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFeishuSourceDocument,
  defaultFeishuSourceConfig,
  FeishuInbox,
  FeishuSourceRepository,
  parseFeishuSourceDocument,
  serializeFeishuSourceDocument,
  type FeishuGateway,
  type FeishuInboundEvent,
  type FeishuMember,
  type FeishuSourceDocument,
} from "../src/feishu-source.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function doc(overrides: {
  mode?: "observe" | "live";
  chats?: Record<string, "mentions" | "all" | "none">;
  direct?: "mentions" | "all" | "none";
  allowed?: string[];
  bots?: string[];
} = {}): FeishuSourceDocument {
  const document = createFeishuSourceDocument({
    config: defaultFeishuSourceConfig({
      teamId: "alpha",
      allowed: overrides.allowed ?? ["alice"],
      bots: overrides.bots ?? [],
      chats: overrides.chats ?? { "chat-1": "mentions" },
      direct: overrides.direct ?? "none",
    }),
    now: new Date("2026-11-06T00:00:00Z"),
  });
  document.runtime.status = "ready";
  document.runtime.mode = overrides.mode ?? "observe";
  document.runtime.botOpenId = "bot-open";
  return document;
}

function event(overrides: Partial<FeishuInboundEvent> = {}): FeishuInboundEvent {
  return {
    eventId: "evt-1",
    messageId: "msg-1",
    chatId: "chat-1",
    chatType: "group",
    senderId: "alice",
    senderType: "user",
    text: "@bot 看一下",
    mentions: ["bot-open"],
    timestamp: "2026-11-06T01:00:00Z",
    ...overrides,
  };
}

class FakeGateway implements FeishuGateway {
  readonly sent: Array<{ chatId: string; text: string }> = [];
  readonly members: FeishuMember[] = [{ id: "alice", name: "Alice" }, { id: "bob" }];
  handler: ((event: FeishuInboundEvent) => void) | undefined;
  async checkAuth() { return { botOpenId: "bot-open" }; }
  async start(handler: (event: FeishuInboundEvent) => void) { this.handler = handler; }
  async stop() {}
  async sendMessage(chatId: string, text: string) { this.sent.push({ chatId, text }); }
  async listMembers() { return this.members; }
}

async function makeInbox(input: {
  mode?: "observe" | "live";
  chats?: Record<string, "mentions" | "all" | "none">;
  direct?: "mentions" | "all" | "none";
  allowed?: string[];
  bots?: string[];
} = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "void-feishu-"));
  directories.push(dataDir);
  const repository = new FeishuSourceRepository(dataDir);
  await repository.save(doc(input));
  const gateway = new FakeGateway();
  const dispatched: string[] = [];
  const inbox = new FeishuInbox({
    repository,
    gateway,
    dispatch: async (item) => { dispatched.push(item.eventId); return { runId: "run-1" }; },
    now: () => new Date("2026-11-06T02:00:00Z"),
  });
  return { repository, gateway, inbox, dispatched };
}

describe("飞书来源契约", () => {
  it("默认 observe / allowed 空 / 只接 @", () => {
    const document = createFeishuSourceDocument({
      config: defaultFeishuSourceConfig({ teamId: "alpha" }),
    });
    expect(document.config.allowed).toEqual([]);
    expect(document.config.direct).toBe("none");
    expect(document.runtime.mode).toBe("observe");
    expect(document.runtime.status).toBe("setup");
  });

  it("缺 runtime 的手写配置按默认状态补，不猜 live", () => {
    const parsed = parseFeishuSourceDocument(JSON.stringify({
      schemaVersion: 1,
      revision: 0,
      updatedAt: "2026-11-06T00:00:00Z",
      updatedBy: "owner",
      config: defaultFeishuSourceConfig({ teamId: "alpha" }),
    }));
    expect(parsed.runtime.mode).toBe("observe");
    expect(parsed.runtime.status).toBe("setup");
  });

  it("对话规则只认 mentions/all/none", () => {
    const base = JSON.parse(serializeFeishuSourceDocument(doc()));
    expect(() => parseFeishuSourceDocument(JSON.stringify({
      ...base,
      config: { ...base.config, chats: { "chat-1": "all-messages" } },
    }))).toThrow(/config.chats/);
  });
});

describe("FeishuInbox 开关", () => {
  it("status=off 时 start 不认证、不连 WS", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "void-feishu-off-"));
    directories.push(dataDir);
    const repository = new FeishuSourceRepository(dataDir);
    const document = doc();
    document.runtime.status = "off";
    await repository.save(document);
    const gateway = new FakeGateway();
    let auth = 0;
    let started = 0;
    gateway.checkAuth = async () => { auth += 1; return { botOpenId: "bot-open" }; };
    gateway.start = async () => { started += 1; };
    const inbox = new FeishuInbox({
      repository,
      gateway,
      dispatch: async () => ({ runId: "run-x" }),
    });
    await inbox.start();
    expect(auth).toBe(0);
    expect(started).toBe(0);
    expect((await repository.load())?.runtime.status).toBe("off");
  });
});

describe("FeishuInbox 入站", () => {
  it("observe：命中 @ + allowed 只记账，不派活", async () => {
    const { repository, inbox, dispatched } = await makeInbox({ mode: "observe" });
    await inbox.handle(event());
    expect(dispatched).toEqual([]);
    const saved = await repository.load();
    expect(saved?.runtime.counts["2026-11-06"]).toMatchObject({ observed: 1, dispatched: 0 });
    expect(saved?.runtime.entries.at(-1)).toMatchObject({ outcome: "observed", channel: "feishu:chat-1", requester: "alice" });
  });

  it("live：派活并记 runId", async () => {
    const { repository, inbox, dispatched } = await makeInbox({ mode: "live" });
    await inbox.handle(event());
    expect(dispatched).toEqual(["evt-1"]);
    const saved = await repository.load();
    expect(saved?.runtime.entries.at(-1)).toMatchObject({ outcome: "dispatched", runId: "run-1" });
  });

  it("不在接收范围的群直接 dropped", async () => {
    const { repository, inbox, dispatched } = await makeInbox({ mode: "live" });
    await inbox.handle(event({ chatId: "chat-unknown" }));
    expect(dispatched).toEqual([]);
    expect((await repository.load())?.runtime.entries.at(-1)).toMatchObject({
      outcome: "dropped",
      droppedKind: "channelIgnored",
    });
  });

  it("mentions 规则下没 @ 机器人 → filtered", async () => {
    const { repository, inbox } = await makeInbox({ mode: "live" });
    await inbox.handle(event({ mentions: [] }));
    expect((await repository.load())?.runtime.entries.at(-1)).toMatchObject({
      outcome: "filtered",
      reason: expect.stringContaining("@"),
    });
  });

  it("all 规则下没 @ 也能接", async () => {
    const { repository, inbox, dispatched } = await makeInbox({ mode: "live", chats: { "chat-1": "all" } });
    await inbox.handle(event({ mentions: [] }));
    expect(dispatched).toEqual(["evt-1"]);
    expect((await repository.load())?.runtime.entries.at(-1)).toMatchObject({ outcome: "dispatched" });
  });

  it("发起人不在 allowed → filtered，绝不派活", async () => {
    const { repository, inbox, dispatched } = await makeInbox({ mode: "live" });
    await inbox.handle(event({ senderId: "mallory" }));
    expect(dispatched).toEqual([]);
    expect((await repository.load())?.runtime.entries.at(-1)).toMatchObject({
      outcome: "filtered",
      reason: expect.stringContaining("allowed"),
    });
  });

  it("bot 不在 bots 名单 → dropped；在名单里可接", async () => {
    const first = await makeInbox({ mode: "live" });
    await first.inbox.handle(event({ senderType: "bot", senderId: "other-bot" }));
    expect(first.dispatched).toEqual([]);
    expect((await first.repository.load())?.runtime.entries.at(-1)).toMatchObject({ outcome: "dropped" });

    const second = await makeInbox({ mode: "live", bots: ["other-bot"] });
    await second.inbox.handle(event({ senderType: "bot", senderId: "other-bot" }));
    expect(second.dispatched).toEqual(["evt-1"]);
  });

  it("同一 eventId 只处理一次", async () => {
    const { repository, inbox, dispatched } = await makeInbox({ mode: "live" });
    await inbox.handle(event());
    await inbox.handle(event());
    expect(dispatched).toEqual(["evt-1"]);
    expect((await repository.load())?.runtime.counts["2026-11-06"]).toMatchObject({ dispatched: 1 });
  });

  it("syncAllowed 从群成员同步名单并 bump revision", async () => {
    const { repository, inbox } = await makeInbox();
    const snapshot = await inbox.syncAllowed("chat-1", 0);
    expect(snapshot.revision).toBe(1);
    expect(snapshot.config.allowed).toEqual(["alice", "bob"]);
    expect((await repository.load())?.config.allowed).toEqual(["alice", "bob"]);
  });

  it("setMode / setEnabled 带 revision CAS，旧修订被拒", async () => {
    const { inbox } = await makeInbox();
    await expect(inbox.setMode("live", 99)).rejects.toThrow(/期望 99/);
    const next = await inbox.setMode("live", 0);
    expect(next.runtime.mode).toBe("live");
    expect(next.revision).toBe(1);
  });
});
