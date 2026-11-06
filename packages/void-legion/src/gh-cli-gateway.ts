/**
 * GitHub 网关的真实现：通过 `gh api` 调用 GitHub REST，身份来自独立 gh 配置目录
 * 或 `tokenEnv` 指向的 token。
 *
 * 凭据纪律（§23.2 / §23.6）：
 * - token 值只在子进程环境里出现，不写文件、不进日志、不进运行记录；
 * - 子进程只继承最小环境白名单（PATH/系统变量/临时目录），不把宿主整份环境带过去；
 * - 错误信息截断，避免把 URL 里的 query 或响应体原样抛给模型。
 *
 * 这里刻意不依赖 `gh` 之外的 npm 包：B7 的 shim 与 PATH 强制导向还没落地，先用
 * `GH_CONFIG_DIR` + 最小 env 做第一期隔离。
 *
 * @module @void/void-legion/gh-cli-gateway
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitHubContext, GitHubContextComment, GitHubContextOptions, GitHubGateway, GitHubNotification } from "./github-source.js";

const execFileAsync = promisify(execFile);

const ENV_WHITELIST = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "COMSPEC",
  "HOME",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "APPDATA",
  "LOCALAPPDATA",
] as const;

export class GhCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhCliError";
  }
}

export interface GhCliGatewayOptions {
  /** 独立 gh 配置目录；空则用当前 gh 身份。 */
  ghConfigDir?: string | undefined;
  /** token 的变量名（不是值）；值从宿主 env 读。 */
  tokenEnv?: string | undefined;
  /** 子进程超时；默认 20s。 */
  timeoutMs?: number | undefined;
  /** 测试注入：替换真正的 `gh` 调用。 */
  run?: ((args: readonly string[], signal?: AbortSignal) => Promise<string>) | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

function childEnv(options: GhCliGatewayOptions): NodeJS.ProcessEnv {
  const source = options.env ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_WHITELIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  if (options.ghConfigDir !== undefined && options.ghConfigDir.trim() !== "") {
    env.GH_CONFIG_DIR = options.ghConfigDir;
  }
  if (options.tokenEnv !== undefined && options.tokenEnv.trim() !== "") {
    const token = source[options.tokenEnv];
    if (token !== undefined && token !== "") env.GH_TOKEN = token;
  }
  return env;
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 500);
}

function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GhCliError(`gh api ${what} 返回的不是 JSON: ${text.slice(0, 200)}`);
  }
}

function subjectLocation(url: string): { repo: string; number?: string; kind: "issue" | "pull" | "ci" } {
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  // /repos/{owner}/{repo}/issues/{n} 或 /pulls/{n}；CheckSuite 走 /check-suites/{n}
  const repoIndex = parts.indexOf("repos");
  const owner = parts[repoIndex + 1];
  const name = parts[repoIndex + 2];
  if (repoIndex < 0 || owner === undefined || name === undefined) {
    throw new GhCliError(`不认识的 GitHub subject URL: ${url}`);
  }
  const repo = `${owner}/${name}`;
  const typeIndex = parts.findIndex((part) => part === "issues" || part === "pulls" || part === "check-suites");
  const number = typeIndex >= 0 ? parts[typeIndex + 1] : undefined;
  const kind = parts[typeIndex] === "pulls" ? "pull" : parts[typeIndex] === "check-suites" ? "ci" : "issue";
  return { repo, number, kind };
}

export class GhCliGateway implements GitHubGateway {
  private readonly options: GhCliGatewayOptions;
  private readonly timeoutMs: number;

  constructor(options: GhCliGatewayOptions = {}) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private run(args: readonly string[], signal?: AbortSignal): Promise<string> {
    if (this.options.run !== undefined) {
      return this.options.run(args, signal).catch((error: unknown) => {
        throw new GhCliError(`gh ${args.slice(0, 2).join(" ")} 失败: ${shortError(error)}`);
      });
    }
    return execFileAsync("gh", [...args], {
      env: childEnv(this.options),
      timeout: this.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      ...(signal === undefined ? {} : { signal }),
    }).then((result) => result.stdout, (error: unknown) => {
      throw new GhCliError(`gh ${args.slice(0, 2).join(" ")} 失败: ${shortError(error)}`);
    });
  }

  async checkAuth(repo: string, signal?: AbortSignal): Promise<{ login: string; canPush: boolean }> {
    const login = (await this.run(["api", "user", "--jq", ".login"], signal)).trim();
    if (login === "") throw new GhCliError("gh api user 没有返回登录名");
    const pushText = (await this.run(["api", `repos/${repo}`, "--jq", ".permissions.push"], signal)).trim();
    return { login, canPush: pushText === "true" };
  }

  async listNotifications(signal?: AbortSignal): Promise<GitHubNotification[]> {
    const text = await this.run(["api", "notifications?all=false&participating=false&per_page=100"], signal);
    const rows = parseJson<Array<Record<string, unknown>>>(text, "notifications");
    return rows.map((row) => {
      const subject = (row.subject ?? {}) as Record<string, unknown>;
      const repository = (row.repository ?? {}) as Record<string, unknown>;
      return {
        id: String(row.id ?? ""),
        updatedAt: String(row.updated_at ?? ""),
        reason: String(row.reason ?? ""),
        subject: {
          title: String(subject.title ?? ""),
          type: String(subject.type ?? ""),
          url: String(subject.url ?? ""),
          ...(subject.latest_comment_url === undefined || subject.latest_comment_url === null
            ? {}
            : { latestCommentUrl: String(subject.latest_comment_url) }),
        },
        repository: { fullName: String(repository.full_name ?? "") },
      };
    }).filter((row) => row.id !== "" && row.subject.url !== "");
  }

  async getContext(notification: GitHubNotification, options: GitHubContextOptions): Promise<GitHubContext> {
    const location = subjectLocation(notification.subject.url);
    const channel = `${location.repo}#${location.number ?? notification.id}`;
    if (location.kind === "ci" || location.number === undefined) {
      return {
        channel,
        kind: location.kind,
        title: notification.subject.title,
        body: "",
        url: notification.subject.url,
        comments: [],
      };
    }
    const issue = parseJson<Record<string, unknown>>(
      await this.run(["api", `repos/${location.repo}/issues/${location.number}`], options.signal),
      `issues/${location.number}`,
    );
    const comments: GitHubContextComment[] = [];
    for (let page = 1; page <= options.maxPages; page++) {
      const rows = parseJson<Array<Record<string, unknown>>>(
        await this.run(
          ["api", `repos/${location.repo}/issues/${location.number}/comments?per_page=100&page=${page}`],
          options.signal,
        ),
        `issues/${location.number}/comments`,
      );
      for (const row of rows) {
        const user = (row.user ?? {}) as Record<string, unknown>;
        comments.push({
          id: String(row.id ?? ""),
          author: String(user.login ?? ""),
          body: String(row.body ?? ""),
          createdAt: String(row.created_at ?? ""),
        });
      }
      if (rows.length < 100) break;
    }
    const user = (issue.user ?? {}) as Record<string, unknown>;
    const requester = comments.at(-1)?.author ?? (typeof user.login === "string" ? user.login : undefined);
    return {
      channel,
      kind: location.kind,
      title: String(issue.title ?? notification.subject.title),
      body: String(issue.body ?? ""),
      url: String(issue.html_url ?? notification.subject.url),
      ...(requester === undefined || requester === "" ? {} : { requester }),
      ...(comments.at(-1) === undefined ? {} : { latestCommentId: comments.at(-1)!.id }),
      comments,
    };
  }

  async comment(channel: string, body: string, signal?: AbortSignal): Promise<void> {
    const match = /^([^#]+)#(\d+)$/.exec(channel);
    if (match === null) throw new GhCliError(`不认识的评论 channel: ${channel}`);
    const [, repo, number] = match;
    await this.run(
      ["api", "--method", "POST", `repos/${repo}/issues/${number}/comments`, "-f", `body=${body}`],
      signal,
    );
  }
}
