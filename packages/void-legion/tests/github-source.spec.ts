import { describe, expect, it } from "vitest";
import {
  createExternalSourceDocument,
  defaultExternalSourceConfig,
  type ExternalSourceDocument,
} from "../src/external-source.js";
import {
  deliveryComment,
  pollGitHubNotifications,
  type GitHubContext,
  type GitHubNotification,
  type GitHubTicket,
} from "../src/github-source.js";

function doc(overrides: {
  mode?: "observe" | "live";
  config?: Partial<Parameters<typeof defaultExternalSourceConfig>[0]> & {
    receive?: Partial<Record<"issues" | "pulls" | "comments" | "ci", boolean>>;
    admission?: Partial<Record<"issues" | "pulls" | "comments" | "ci", "accept" | "reject">>;
  };
} = {}): ExternalSourceDocument {
  const base = defaultExternalSourceConfig({ repo: "owner/name", teamId: "alpha", allowed: ["alice"], ...overrides.config });
  const document = createExternalSourceDocument({
    config: {
      ...base,
      receive: { ...base.receive, ...(overrides.config?.receive ?? {}) },
      admission: { ...base.admission, ...(overrides.config?.admission ?? {}) },
    },
    now: new Date("2026-11-06T00:00:00Z"),
  });
  document.runtime.status = "ready";
  document.runtime.mode = overrides.mode ?? "observe";
  document.runtime.agentLogin = "void-agent";
  return document;
}

function notification(overrides: Partial<GitHubNotification> = {}): GitHubNotification {
  return {
    id: "notif-1",
    updatedAt: "2026-11-06T01:00:00Z",
    reason: "mention",
    subject: {
      title: "请看一下这个 bug",
      type: "Issue",
      url: "https://api.github.com/repos/owner/name/issues/1",
    },
    repository: { fullName: "owner/name" },
    ...overrides,
  };
}

function context(overrides: Partial<GitHubContext> = {}): GitHubContext {
  return {
    channel: "owner/name#1",
    kind: "issue",
    title: "请看一下这个 bug",
    body: "@void-agent 帮忙看看",
    url: "https://github.com/owner/name/issues/1",
    requester: "alice",
    latestCommentId: "c1",
    comments: [{ id: "c1", author: "alice", body: "@void-agent 帮忙看看", createdAt: "2026-11-06T01:00:00Z" }],
    ...overrides,
  };
}

function gateway(input: {
  notifications?: GitHubNotification[];
  context?: GitHubContext | Error;
  comments?: Array<{ channel: string; body: string }>;
}) {
  return {
    listNotifications: async () => input.notifications ?? [notification()],
    getContext: async () => {
      if (input.context instanceof Error) throw input.context;
      return input.context ?? context();
    },
    comment: async (channel: string, body: string) => {
      input.comments?.push({ channel, body });
    },
  };
}

const emptyReport = { processed: 0, observed: 0, dispatched: 0, filtered: 0, dropped: 0 };

describe("GitHub 通知轮询", () => {
  it("observe：mention + allowed 只记账，不派活", async () => {
    let dispatched = 0;
    const result = await pollGitHubNotifications(doc({ mode: "observe" }), {
      gateway: gateway({}),
      dispatch: async () => { dispatched += 1; return { runId: "run-1" }; },
    });
    expect(result.report).toEqual({ ...emptyReport, processed: 1, observed: 1 });
    expect(dispatched).toBe(0);
    expect(result.document.runtime.counts["2026-11-06"]).toMatchObject({ observed: 1, dispatched: 0 });
    expect(result.document.runtime.entries.at(-1)).toMatchObject({
      outcome: "observed",
      channel: "owner/name#1",
      requester: "alice",
    });
  });

  it("live：allowed 的 mention 派活并记 runId", async () => {
    const tickets: GitHubTicket[] = [];
    const result = await pollGitHubNotifications(doc({ mode: "live" }), {
      gateway: gateway({}),
      dispatch: async (ticket) => { tickets.push(ticket); return { runId: "run-42" }; },
    });
    expect(result.report).toMatchObject({ processed: 1, dispatched: 1 });
    expect(tickets[0]).toMatchObject({ channel: "owner/name#1", requester: "alice", eventId: "notif-1" });
    expect(result.document.runtime.entries.at(-1)).toMatchObject({ outcome: "dispatched", runId: "run-42" });
  });

  it("发起人不在 allowed 时 filtered，绝不派活", async () => {
    let dispatched = 0;
    const result = await pollGitHubNotifications(doc({ mode: "live" }), {
      gateway: gateway({ context: context({ requester: "bob" }) }),
      dispatch: async () => { dispatched += 1; return { runId: "run-x" }; },
    });
    expect(dispatched).toBe(0);
    expect(result.document.runtime.entries.at(-1)).toMatchObject({ outcome: "filtered", reason: expect.stringContaining("allowed") });
  });

  it("bot 不在 bots 名单时 dropped，不占观察/派发计数", async () => {
    const result = await pollGitHubNotifications(doc({ mode: "live" }), {
      gateway: gateway({ context: context({ requester: "dependabot[bot]" }) }),
      dispatch: async () => ({ runId: "run-x" }),
    });
    expect(result.document.runtime.entries.at(-1)).toMatchObject({
      outcome: "dropped",
      droppedKind: "channelIgnored",
      reason: expect.stringContaining("bots"),
    });
  });

  it("bot 在 bots 名单里可以成为候选", async () => {
    const document = doc({ mode: "live", config: { bots: ["dependabot[bot]"] } });
    const result = await pollGitHubNotifications(document, {
      gateway: gateway({ context: context({ requester: "dependabot[bot]" }) }),
      dispatch: async () => ({ runId: "run-bot" }),
    });
    expect(result.document.runtime.entries.at(-1)).toMatchObject({ outcome: "dispatched", runId: "run-bot" });
  });

  it("admission.reject 拦下对应类型", async () => {
    const document = doc({ mode: "live", config: { admission: { issues: "reject" } } });
    const result = await pollGitHubNotifications(document, {
      gateway: gateway({}),
      dispatch: async () => ({ runId: "run-x" }),
    });
    expect(result.document.runtime.entries.at(-1)).toMatchObject({ outcome: "filtered", reason: expect.stringContaining("admission.issues") });
  });

  it("receive.issues 放大后，没有 @ 也能接", async () => {
    const document = doc({ mode: "live", config: { receive: { issues: true } } });
    const result = await pollGitHubNotifications(document, {
      gateway: gateway({ context: context({ body: "一个新 issue", comments: [] }) }),
      dispatch: async () => ({ runId: "run-broad" }),
    });
    expect(result.document.runtime.entries.at(-1)).toMatchObject({ outcome: "dispatched", runId: "run-broad" });
  });

  it("没有 @ 且未放大 receive 时 filtered", async () => {
    const result = await pollGitHubNotifications(doc({ mode: "live" }), {
      gateway: gateway({ context: context({ body: "普通评论", comments: [] }) }),
      dispatch: async () => ({ runId: "run-x" }),
    });
    expect(result.document.runtime.entries.at(-1)).toMatchObject({ outcome: "filtered", reason: expect.stringContaining("没有 @") });
  });

  it("同一通知同一评论只处理一次", async () => {
    let calls = 0;
    const first = await pollGitHubNotifications(doc({ mode: "observe" }), {
      gateway: gateway({}),
      dispatch: async () => { calls += 1; return { runId: "run-1" }; },
    });
    const second = await pollGitHubNotifications(first.document, {
      gateway: gateway({}),
      dispatch: async () => { calls += 1; return { runId: "run-2" }; },
    });
    expect(calls).toBe(0);
    expect(second.document.runtime.counts["2026-11-06"]).toMatchObject({ observed: 1 });
    expect(second.document.runtime.entries).toHaveLength(1);
  });

  it("读上下文失败记 filtered，不抛整轮", async () => {
    const result = await pollGitHubNotifications(doc({ mode: "live" }), {
      gateway: gateway({ context: new Error("timeout") }),
      dispatch: async () => ({ runId: "run-x" }),
    });
    expect(result.document.runtime.entries.at(-1)).toMatchObject({
      outcome: "filtered",
      reason: expect.stringContaining("读取上下文失败"),
    });
  });

  it("每轮最多 10 条候选，超出记 dropped", async () => {
    const notifications = Array.from({ length: 12 }, (_, index) => notification({
      id: `n-${index}`,
      updatedAt: `2026-11-06T01:00:${String(index).padStart(2, "0")}Z`,
    }));
    const result = await pollGitHubNotifications(doc({ mode: "observe" }), {
      gateway: gateway({ notifications }),
      dispatch: async () => ({ runId: "run-x" }),
    });
    expect(result.report.processed).toBe(10);
    expect(result.report.dropped).toBe(2);
    expect(result.document.runtime.counts["2026-11-06"]).toMatchObject({ observed: 10, dropped: 2 });
  });

  it("别的仓库的通知直接忽略，不进账本", async () => {
    const result = await pollGitHubNotifications(doc({ mode: "live" }), {
      gateway: gateway({ notifications: [notification({ repository: { fullName: "other/repo" } })] }),
      dispatch: async () => ({ runId: "run-x" }),
    });
    expect(result.report).toEqual(emptyReport);
    expect(result.document.runtime.entries).toHaveLength(0);
  });

  it("回写评论文案写 runId 与待验收，不写内部路径", () => {
    const text = deliveryComment({
      runId: "run-1",
      status: "awaiting_acceptance",
      conclusion: "已结算 1/1",
      acceptance: "human",
    });
    expect(text).toContain("run-1");
    expect(text).toContain("等待人工验收");
    expect(text).not.toContain("void-data");
  });
});
