import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createExternalSourceDocument,
  defaultExternalSourceConfig,
  ExternalSourceRepository,
} from "../src/external-source.js";
import { GitHubSourceRunner } from "../src/github-source-runner.js";
import type { GitHubContext, GitHubGateway, GitHubNotification, GitHubTicket } from "../src/github-source.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

async function setup(mode: "observe" | "live" = "observe"): Promise<{
  repository: ExternalSourceRepository;
  document: Awaited<ReturnType<ExternalSourceRepository["load"]>>;
}> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "void-github-runner-"));
  directories.push(dataDir);
  const repository = new ExternalSourceRepository({ dataDir });
  const document = createExternalSourceDocument({
    config: defaultExternalSourceConfig({ repo: "owner/name", teamId: "alpha", allowed: ["alice"] }),
  });
  document.runtime.mode = mode;
  document.runtime.status = "ready";
  await repository.save(document);
  return { repository, document };
}

function notification(): GitHubNotification {
  return {
    id: "n1",
    updatedAt: "2026-11-06T01:00:00Z",
    reason: "mention",
    subject: { title: "bug", type: "Issue", url: "https://api.github.com/repos/owner/name/issues/1" },
    repository: { fullName: "owner/name" },
  };
}

function context(): GitHubContext {
  return {
    channel: "owner/name#1",
    kind: "issue",
    title: "bug",
    body: "@void-agent 看一下",
    url: "https://github.com/owner/name/issues/1",
    requester: "alice",
    latestCommentId: "c1",
    comments: [{ id: "c1", author: "alice", body: "@void-agent 看一下", createdAt: "2026-11-06T01:00:00Z" }],
  };
}

function gateway(overrides: {
  canPush?: boolean;
  notifications?: GitHubNotification[];
  listError?: Error;
} = {}): GitHubGateway {
  return {
    checkAuth: async () => ({ login: "void-agent", canPush: overrides.canPush ?? true }),
    listNotifications: async () => {
      if (overrides.listError !== undefined) throw overrides.listError;
      return overrides.notifications ?? [notification()];
    },
    getContext: async () => context(),
    comment: async () => {},
  };
}

function timers() {
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  return {
    scheduled,
    setTimeout: (fn: () => void, ms: number) => {
      scheduled.push({ fn, ms });
      return scheduled.length;
    },
    clearTimeout: () => {},
  };
}

describe("GitHubSourceRunner", () => {
  it("observe：启动后 setup 成功、只记账、按 interval 排下一轮", async () => {
    const { repository } = await setup("observe");
    const clock = timers();
    const runner = new GitHubSourceRunner({
      repository,
      gateway: gateway(),
      dispatch: async () => ({ runId: "run-x" }),
      now: () => new Date("2026-11-06T02:00:00Z"),
      ...clock,
    });
    await runner.start();
    const doc = await repository.load();
    expect(doc?.runtime.status).toBe("ready");
    expect(doc?.runtime.agentLogin).toBe("void-agent");
    expect(doc?.runtime.counts["2026-11-06"]?.observed).toBe(1);
    expect(doc?.runtime.counts["2026-11-06"]?.dispatched).toBe(0);
    expect(clock.scheduled[0]?.ms).toBe(60_000);
    runner.stop();
  });

  it("live：派活并触发回写回调", async () => {
    const { repository } = await setup("live");
    const tickets: GitHubTicket[] = [];
    const deliveries: string[] = [];
    const runner = new GitHubSourceRunner({
      repository,
      gateway: gateway(),
      dispatch: async (ticket) => { tickets.push(ticket); return { runId: "run-42" }; },
      onDispatched: (_ticket, runId) => { deliveries.push(runId); },
      now: () => new Date("2026-11-06T02:00:00Z"),
      ...timers(),
    });
    await runner.start();
    expect(tickets[0]?.channel).toBe("owner/name#1");
    expect(deliveries).toEqual(["run-42"]);
    const doc = await repository.load();
    expect(doc?.runtime.counts["2026-11-06"]?.dispatched).toBe(1);
    expect(doc?.runtime.entries.at(-1)).toMatchObject({ outcome: "dispatched", runId: "run-42" });
    runner.stop();
  });

  it("账号没有 push 权限时把来源标成 error，不派活", async () => {
    const { repository } = await setup("live");
    let dispatched = 0;
    const runner = new GitHubSourceRunner({
      repository,
      gateway: gateway({ canPush: false }),
      dispatch: async () => { dispatched += 1; return { runId: "run-x" }; },
      now: () => new Date("2026-11-06T02:00:00Z"),
      ...timers(),
    });
    await runner.start();
    expect(dispatched).toBe(0);
    const doc = await repository.load();
    expect(doc?.runtime.status).toBe("error");
    expect(doc?.runtime.consecutiveFailures).toBe(1);
    expect(doc?.runtime.lastError).toContain("push 权限");
    runner.stop();
  });

  it("轮询失败按指数退避，连续失败计数保留", async () => {
    const { repository } = await setup("observe");
    const clock = timers();
    const runner = new GitHubSourceRunner({
      repository,
      gateway: gateway({ listError: new Error("rate limited") }),
      dispatch: async () => ({ runId: "run-x" }),
      now: () => new Date("2026-11-06T02:00:00Z"),
      ...clock,
    });
    await runner.start();
    const doc = await repository.load();
    expect(doc?.runtime.status).toBe("error");
    expect(doc?.runtime.consecutiveFailures).toBe(1);
    expect(doc?.runtime.lastError).toContain("rate limited");
    expect(clock.scheduled[0]?.ms).toBe(120_000);
    runner.stop();
  });

  it("status=off 时 start 不认证、不轮询，宿主不受影响", async () => {
    const { repository } = await setup("observe");
    await repository.mutate((document) => ({
      ...document,
      runtime: { ...document.runtime, status: "off" },
    }));
    let auth = 0;
    const clock = timers();
    const runner = new GitHubSourceRunner({
      repository,
      gateway: {
        checkAuth: async () => { auth += 1; return { login: "void-agent", canPush: true }; },
        listNotifications: async () => { throw new Error("不该轮询"); },
        getContext: async () => { throw new Error("不该读上下文"); },
        comment: async () => {},
      },
      dispatch: async () => ({ runId: "run-x" }),
      now: () => new Date("2026-11-06T02:00:00Z"),
      ...clock,
    });
    await runner.start();
    expect(auth).toBe(0);
    expect(clock.scheduled).toHaveLength(0);
    expect((await repository.load())?.runtime.status).toBe("off");
  });

  it("pollNow 不额外排定时器，也不要求先 start", async () => {
    const { repository } = await setup("observe");
    const clock = timers();
    const runner = new GitHubSourceRunner({
      repository,
      gateway: gateway(),
      dispatch: async () => ({ runId: "run-x" }),
      now: () => new Date("2026-11-06T02:00:00Z"),
      ...clock,
    });
    const report = await runner.pollNow();
    expect(report?.observed).toBe(1);
    expect(clock.scheduled).toHaveLength(0);
  });
});
