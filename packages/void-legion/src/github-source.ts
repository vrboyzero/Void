/**
 * GitHub 外部触发源（B8-1）：通知轮询、准入判定、去重与派活回调。
 *
 * **只轮询，不架 webhook**（§23.3）：读的是 Agent 账号自己的通知流，1 分钟默认。
 * 协议细节收在 `GitHubGateway` 后面，测试用假 gateway，不触网。
 *
 * 这一层不创建 Agent/子代理，也不写运行记录：准入通过后交给注入的 `dispatch`
 * 回调（宿主侧用 `voidTeam.dispatchExternal` 实现），回写评论由宿主侧在 run
 * 落定后做。这样轮询逻辑可以在没有宿主的测试里完整驱动。
 *
 * @module @void/void-legion/github-source
 */
import {
  ExternalSourceError,
  externalSeenKey,
  hasSeenExternalEvent,
  rememberExternalSeen,
  recordExternalSourceOutcome,
  type ExternalSourceDocument,
  type ExternalSourceEntry,
  type ExternalSourceMode,
  MAX_EVENTS_PER_POLL,
  type ExternalSourceSeen,
} from "./external-source.js";

/** 通知里认的 reason；其余 reason 只有在 receive 开关打开时才接。 */
export const GITHUB_MENTION_REASONS = ["mention", "team_mention", "assign", "review_requested"] as const;
const ASSIGN_REASONS = new Set(["assign", "review_requested"]);

export interface GitHubNotification {
  id: string;
  updatedAt: string;
  reason: string;
  subject: {
    title: string;
    type: string;
    url: string;
    latestCommentUrl?: string;
  };
  repository: {
    fullName: string;
  };
}

export interface GitHubContextComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface GitHubContext {
  /** `owner/repo#123`，也是回写评论用的 channel。 */
  channel: string;
  kind: "issue" | "pull" | "ci";
  title: string;
  body: string;
  url: string;
  /** 发起人：最新评论作者，没有评论时是 Issue/PR 作者。 */
  requester?: string;
  latestCommentId?: string;
  comments: readonly GitHubContextComment[];
}

export interface GitHubContextOptions {
  maxPages: number;
  signal: AbortSignal;
}

/** 真实实现用 `gh` CLI；测试用假实现。 */
export interface GitHubGateway {
  /** 校验账号与仓库 push 权限；失败要给出人能读的原因。 */
  checkAuth(repo: string, signal?: AbortSignal): Promise<{ login: string; canPush: boolean }>;
  listNotifications(signal?: AbortSignal): Promise<GitHubNotification[]>;
  getContext(notification: GitHubNotification, options: GitHubContextOptions): Promise<GitHubContext>;
  /** 回写评论；channel 形如 `owner/repo#123`。 */
  comment(channel: string, body: string, signal?: AbortSignal): Promise<void>;
}

/** 准入通过后交给宿主派的活。 */
export interface GitHubTicket {
  notificationId: string;
  channel: string;
  requester: string;
  eventId: string;
  url: string;
  kind: GitHubContext["kind"];
  title: string;
  body: string;
  comments: readonly GitHubContextComment[];
}

export interface GitHubPollDeps {
  gateway: Pick<GitHubGateway, "listNotifications" | "getContext">;
  /** 返回 runId；抛错按 filtered 记账，不假装派出去了。 */
  dispatch: (ticket: GitHubTicket) => Promise<{ runId: string }>;
  now?: Date;
  /** setup 时拿到的登录名；缺省读 runtime.agentLogin。 */
  agentLogin?: string;
}

export interface GitHubPollReport {
  processed: number;
  observed: number;
  dispatched: number;
  filtered: number;
  dropped: number;
}

function isBotLogin(login: string): boolean {
  return login.toLowerCase().endsWith("[bot]") || login.toLowerCase().endsWith("-bot");
}

function textOf(context: GitHubContext): string {
  return [context.title, context.body, ...context.comments.map((comment) => comment.body)].join("\n");
}

function notificationKind(notification: GitHubNotification): GitHubContext["kind"] | undefined {
  if (notification.subject.type === "Issue") return "issue";
  if (notification.subject.type === "PullRequest") return "pull";
  if (notification.subject.type === "CheckSuite") return "ci";
  return undefined;
}

/** 接收范围：基础只认 @/指派/review；receive 开关只放大对应类别的通知。 */
export function notificationIsCandidate(
  notification: GitHubNotification,
  document: ExternalSourceDocument,
): boolean {
  const kind = notificationKind(notification);
  if (kind === undefined) return false;
  const receive = document.config.receive;
  if (notification.reason === "mention" || notification.reason === "team_mention") return true;
  if (ASSIGN_REASONS.has(notification.reason)) return kind === "issue" || kind === "pull";
  if (kind === "issue" && receive.issues) return true;
  if (kind === "pull" && receive.pulls) return true;
  if (kind === "ci" && receive.ci) return true;
  if (receive.comments && notification.reason === "comment") return true;
  return false;
}

function entryFor(input: {
  outcome: ExternalSourceEntry["outcome"];
  notification?: GitHubNotification;
  channel?: string;
  requester?: string;
  reason?: string;
  runId?: string;
  detail?: string;
  droppedKind?: ExternalSourceEntry["droppedKind"];
}): Omit<ExternalSourceEntry, "at"> {
  return {
    outcome: input.outcome,
    ...(input.notification === undefined ? {} : { eventId: input.notification.id }),
    ...(input.channel === undefined ? {} : { channel: input.channel }),
    ...(input.requester === undefined ? {} : { requester: input.requester }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    ...(input.droppedKind === undefined ? {} : { droppedKind: input.droppedKind }),
  };
}

/**
 * 轮询一轮。**不抛**：单条失败只记 filtered/dropped，整轮失败由 runner 记
 * `lastError`；返回新的文档，由调用方落盘。
 */
export async function pollGitHubNotifications(
  document: ExternalSourceDocument,
  deps: GitHubPollDeps,
): Promise<{ document: ExternalSourceDocument; report: GitHubPollReport }> {
  const report: GitHubPollReport = { processed: 0, observed: 0, dispatched: 0, filtered: 0, dropped: 0 };
  let next = document;
  const now = deps.now ?? new Date();
  const login = deps.agentLogin ?? document.runtime.agentLogin;
  if (login === undefined || login.trim() === "") {
    throw new ExternalSourceError("GitHub 来源还没完成 setup：没有 agentLogin");
  }
  const notifications = await deps.gateway.listNotifications();
  const maxEvents = MAX_EVENTS_PER_POLL;

  for (const notification of notifications) {
    if (notification.repository.fullName !== document.config.repo) continue;
    if (!notificationIsCandidate(notification, document)) continue;
    if (report.processed >= maxEvents) {
      next = recordExternalSourceOutcome(next, entryFor({
        outcome: "dropped",
        notification,
        reason: "本轮候选超过上限，留到下一轮",
        droppedKind: "channelIgnored",
      }), now);
      report.dropped += 1;
      continue;
    }
    report.processed += 1;

    const earlySeen: ExternalSourceSeen = { notificationId: notification.id, updatedAt: notification.updatedAt };
    if (hasSeenExternalEvent(next, earlySeen)) continue;

    let context: GitHubContext;
    try {
      context = await deps.gateway.getContext(notification, {
        maxPages: document.config.admissionContextMaxPages,
        signal: AbortSignal.timeout(document.config.admissionContextTimeoutMs),
      });
    } catch (error) {
      next = recordExternalSourceOutcome(next, entryFor({
        outcome: "filtered",
        notification,
        reason: `读取上下文失败：${describeError(error)}`,
      }), now);
      report.filtered += 1;
      next = rememberExternalSeen(next, earlySeen);
      continue;
    }

    const seen: ExternalSourceSeen = {
      ...earlySeen,
      ...(context.latestCommentId === undefined ? {} : { commentId: context.latestCommentId }),
    };
    if (hasSeenExternalEvent(next, seen)) continue;

    const requester = context.requester?.trim();
    const text = textOf(context);
    const mentioned = text.toLowerCase().includes(`@${login.toLowerCase()}`);
    const base: Omit<ExternalSourceEntry, "at"> = {
      ...entryFor({ outcome: "observed", notification, channel: context.channel }),
      ...(requester === undefined ? {} : { requester }),
    };

    if (requester === undefined || requester === "") {
      next = rememberExternalSeen(recordExternalSourceOutcome(next, {
        ...base,
        outcome: "filtered",
        reason: "读不到发起人",
      }, now), seen);
      report.filtered += 1;
      continue;
    }
    if (isBotLogin(requester)) {
      if (!document.config.bots.includes(requester)) {
        next = rememberExternalSeen(recordExternalSourceOutcome(next, {
          ...base,
          outcome: "dropped",
          reason: `bot 不在 bots 名单: ${requester}`,
          droppedKind: "channelIgnored",
        }, now), seen);
        report.dropped += 1;
        continue;
      }
    } else if (!document.config.allowed.some((item) => item.toLowerCase() === requester.toLowerCase())) {
      next = rememberExternalSeen(recordExternalSourceOutcome(next, {
        ...base,
        outcome: "filtered",
        reason: `发起人不在 allowed: ${requester}`,
      }, now), seen);
      report.filtered += 1;
      continue;
    }

    const admissionKey = context.kind === "pull" ? "pulls" : context.kind === "ci" ? "ci" : "issues";
    if (document.config.admission[admissionKey] === "reject") {
      next = rememberExternalSeen(recordExternalSourceOutcome(next, {
        ...base,
        outcome: "filtered",
        reason: `admission.${admissionKey} = reject`,
      }, now), seen);
      report.filtered += 1;
      continue;
    }

    const receiveBroadened =
      (context.kind === "issue" && document.config.receive.issues) ||
      (context.kind === "pull" && document.config.receive.pulls) ||
      (context.kind === "ci" && document.config.receive.ci) ||
      (document.config.receive.comments && notification.reason === "comment");
    if (!mentioned && !ASSIGN_REASONS.has(notification.reason) && !receiveBroadened) {
      next = rememberExternalSeen(recordExternalSourceOutcome(next, {
        ...base,
        outcome: "filtered",
        reason: "没有 @ 到 Agent 账号",
      }, now), seen);
      report.filtered += 1;
      continue;
    }

    if (document.runtime.mode === "observe") {
      next = rememberExternalSeen(recordExternalSourceOutcome(next, {
        ...base,
        outcome: "observed",
        reason: "observe：只记录，不执行",
        detail: `本来会派 ${context.channel} 的活`,
      }, now), seen);
      report.observed += 1;
      continue;
    }

    try {
      const dispatched = await deps.dispatch({
        notificationId: notification.id,
        channel: context.channel,
        requester,
        eventId: notification.id,
        url: context.url,
        kind: context.kind,
        title: context.title,
        body: context.body,
        comments: context.comments,
      });
      next = rememberExternalSeen(recordExternalSourceOutcome(next, {
        ...base,
        outcome: "dispatched",
        runId: dispatched.runId,
        reason: "已派活",
      }, now), seen);
      report.dispatched += 1;
    } catch (error) {
      next = rememberExternalSeen(recordExternalSourceOutcome(next, {
        ...base,
        outcome: "filtered",
        reason: `派活失败：${describeError(error)}`,
      }, now), seen);
      report.filtered += 1;
    }
  }

  return { document: next, report };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 给回写评论用的一段人话；不含 token/内部路径。 */
export function deliveryComment(input: {
  runId: string;
  status: string;
  conclusion: string;
  acceptance: string;
}): string {
  const lines = [
    `已接单：${input.runId}`,
    `状态：${input.status}`,
    input.conclusion,
  ];
  if (input.status === "awaiting_acceptance") {
    lines.push("等待人工验收；验收通过前不会标记为完成。");
  } else if (input.status === "failed") {
    lines.push("执行未通过；详情见运行记录。");
  }
  return lines.join("\n");
}

/** 外部来源的执行模式必须显式；这里只做校验，不替调用方决定。 */
export function assertSourceMode(mode: string): ExternalSourceMode {
  if (mode !== "observe" && mode !== "live") throw new ExternalSourceError(`来源模式不认识: ${mode}`);
  return mode;
}

/** 去重键在外部来源模块里定义；这里再导出一次，方便调用方不用双 import。 */
export { externalSeenKey };
