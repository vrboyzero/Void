import { describe, expect, it } from "vitest";
import { GhCliGateway } from "../src/gh-cli-gateway.js";
import type { GitHubNotification } from "../src/github-source.js";

function notification(): GitHubNotification {
  return {
    id: "1",
    updatedAt: "2026-11-06T01:00:00Z",
    reason: "mention",
    subject: {
      title: "bug",
      type: "Issue",
      url: "https://api.github.com/repos/owner/name/issues/7",
    },
    repository: { fullName: "owner/name" },
  };
}

describe("GhCliGateway", () => {
  it("checkAuth 取登录名与 push 权限", async () => {
    const calls: string[][] = [];
    const gateway = new GhCliGateway({
      run: async (args) => {
        calls.push([...args]);
        return args.includes(".login") ? "void-agent\n" : "true\n";
      },
    });
    await expect(gateway.checkAuth("owner/name")).resolves.toEqual({ login: "void-agent", canPush: true });
    expect(calls).toEqual([
      ["api", "user", "--jq", ".login"],
      ["api", "repos/owner/name", "--jq", ".permissions.push"],
    ]);
  });

  it("listNotifications 映射字段并丢掉坏条目", async () => {
    const gateway = new GhCliGateway({
      run: async () => JSON.stringify([
        {
          id: "1",
          updated_at: "2026-11-06T01:00:00Z",
          reason: "mention",
          subject: { title: "bug", type: "Issue", url: "https://api.github.com/repos/owner/name/issues/7" },
          repository: { full_name: "owner/name" },
        },
        { id: "", subject: {} },
      ]),
    });
    const rows = await gateway.listNotifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "1",
      reason: "mention",
      subject: { title: "bug", type: "Issue" },
      repository: { fullName: "owner/name" },
    });
  });

  it("getContext 读 issue 与评论，发起人取最新评论作者", async () => {
    const gateway = new GhCliGateway({
      run: async (args) => {
        const path = args[1] ?? "";
        if (path.endsWith("/comments?per_page=100&page=1")) {
          return JSON.stringify([
            { id: 9, user: { login: "alice" }, body: "@void-agent 看一下", created_at: "2026-11-06T01:00:00Z" },
          ]);
        }
        return JSON.stringify({
          title: "bug",
          body: "正文",
          html_url: "https://github.com/owner/name/issues/7",
          user: { login: "owner" },
        });
      },
    });
    const context = await gateway.getContext(notification(), {
      maxPages: 1,
      signal: new AbortController().signal,
    });
    expect(context).toMatchObject({
      channel: "owner/name#7",
      kind: "issue",
      requester: "alice",
      latestCommentId: "9",
      title: "bug",
    });
    expect(context.comments[0]?.body).toContain("@void-agent");
  });

  it("comment 走 issues 评论端点，参数不经 shell", async () => {
    const calls: string[][] = [];
    const gateway = new GhCliGateway({
      run: async (args) => {
        calls.push([...args]);
        return "{}";
      },
    });
    await gateway.comment("owner/name#7", "已接单");
    expect(calls[0]).toEqual([
      "api",
      "--method",
      "POST",
      "repos/owner/name/issues/7/comments",
      "-f",
      "body=已接单",
    ]);
  });

  it("gh 失败时抛 GhCliError，错误被截断", async () => {
    const gateway = new GhCliGateway({
      run: async () => { throw new Error("boom ".repeat(500)); },
    });
    await expect(gateway.checkAuth("owner/name")).rejects.toThrow(/gh api user 失败: boom/);
  });
});
