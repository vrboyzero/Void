/**
 * GitHub 来源的轮询跑腿：setup、定时、退避、状态写回。
 *
 * 协议与准入在 `github-source.ts`，文件读写在 `external-source.ts`；这里只负责
 * 「什么时候跑下一次、失败了怎么退、状态写到哪」。定时器可注入，测试不需要真等 1 分钟。
 *
 * @module @void/void-legion/github-source-runner
 */
import {
  ExternalSourceRepository,
  type ExternalSourceDocument,
  type ExternalSourceSnapshot,
} from "./external-source.js";
import {
  pollGitHubNotifications,
  type GitHubGateway,
  type GitHubPollReport,
  type GitHubTicket,
} from "./github-source.js";

const MAX_BACKOFF_MS = 30 * 60 * 1000;
const AUTH_TIMEOUT_MS = 30_000;

export interface GitHubSourceRunnerOptions {
  repository: ExternalSourceRepository;
  gateway: GitHubGateway;
  dispatch: (ticket: GitHubTicket) => Promise<{ runId: string }>;
  /** 派活成功后的异步回写（宿主侧等 run 落定再评论）；失败只记 lastDeliveryError。 */
  onDispatched?: (ticket: GitHubTicket, runId: string) => void;
  now?: () => Date;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  logger?: { info: (message: string) => void; warn: (message: string) => void };
}

export interface GitHubSourceRunnerStatus {
  started: boolean;
  polling: boolean;
  nextDelayMs?: number;
}

export class GitHubSourceRunner {
  private readonly options: GitHubSourceRunnerOptions;
  private readonly now: () => Date;
  private timer: unknown;
  private started = false;
  private polling = false;
  private nextDelayMs: number | undefined;

  constructor(options: GitHubSourceRunnerOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  status(): GitHubSourceRunnerStatus {
    return {
      started: this.started,
      polling: this.polling,
      ...(this.nextDelayMs === undefined ? {} : { nextDelayMs: this.nextDelayMs }),
    };
  }

  /** 启动：先跑一轮，再按来源配置的间隔排下一轮。失败只影响本来源。 */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.tick(true);
  }

  stop(): void {
    this.started = false;
    this.nextDelayMs = undefined;
    if (this.timer !== undefined) {
      const clear = this.options.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
      clear(this.timer);
      this.timer = undefined;
    }
  }

  /** 面板「立即轮询」：跑一轮，不重复排定时器。 */
  async pollNow(): Promise<GitHubPollReport | undefined> {
    return this.tick(false);
  }

  async snapshot(): Promise<ExternalSourceSnapshot | undefined> {
    return this.options.repository.trySnapshot();
  }

  private async tick(scheduleNext: boolean): Promise<GitHubPollReport | undefined> {
    if (this.polling) return undefined;
    this.polling = true;
    let report: GitHubPollReport | undefined;
    let delay = 60_000;
    try {
      const current = await this.options.repository.load();
      if (current === undefined) {
        this.options.logger?.info("GitHub 来源还没配置，跳过");
        this.started = false;
        return undefined;
      }
      if (current.runtime.status === "off") {
        this.options.logger?.info("GitHub 来源已停用，跳过");
        this.started = false;
        return undefined;
      }
      await this.options.repository.mutate((document) => ({
        ...document,
        runtime: { ...document.runtime, status: "starting" },
      }));

      const auth = await this.options.gateway.checkAuth(current.config.repo, AbortSignal.timeout(AUTH_TIMEOUT_MS));
      if (!auth.canPush) {
        throw new Error(`来源账号 ${auth.login} 对 ${current.config.repo} 没有 push 权限`);
      }

      const prepared: ExternalSourceDocument = {
        ...current,
        runtime: {
          ...current.runtime,
          status: "ready",
          agentLogin: auth.login,
          consecutiveFailures: 0,
          lastError: undefined,
        },
      };
      const polled = await pollGitHubNotifications(prepared, {
        gateway: this.options.gateway,
        dispatch: async (ticket) => {
          const result = await this.options.dispatch(ticket);
          if (this.options.onDispatched !== undefined) {
            // 回写不阻塞轮询；失败只记在来源状态里，不改 run 结果。
            try {
              this.options.onDispatched(ticket, result.runId);
            } catch (error) {
              this.options.logger?.warn(`GitHub 回写安排失败: ${describeError(error)}`);
            }
          }
          return result;
        },
        now: this.now(),
        agentLogin: auth.login,
      });
      report = polled.report;
      const at = this.now();
      const nextAt = new Date(at.getTime() + current.config.intervalMs).toISOString();
      await this.options.repository.mutate((document) => ({
        ...document,
        runtime: {
          ...document.runtime,
          status: "ready",
          agentLogin: auth.login,
          lastPollAt: at.toISOString(),
          nextPollAt: nextAt,
          consecutiveFailures: 0,
          lastError: undefined,
          seen: polled.document.runtime.seen,
          counts: polled.document.runtime.counts,
          entries: polled.document.runtime.entries,
        },
      }));
      delay = current.config.intervalMs;
    } catch (error) {
      const message = describeError(error);
      this.options.logger?.warn(`GitHub 来源轮询失败: ${message}`);
      try {
        const current = await this.options.repository.load();
        const failures = (current?.runtime.consecutiveFailures ?? 0) + 1;
        const interval = current?.config.intervalMs ?? 60_000;
        delay = Math.min(interval * 2 ** Math.min(failures, 10), MAX_BACKOFF_MS);
        const nextAt = new Date(this.now().getTime() + delay).toISOString();
        await this.options.repository.mutate((document) => ({
          ...document,
          runtime: {
            ...document.runtime,
            status: "error",
            consecutiveFailures: failures,
            lastError: message,
            nextPollAt: nextAt,
          },
        }));
      } catch (saveError) {
        this.options.logger?.warn(`GitHub 来源失败状态没写成: ${describeError(saveError)}`);
      }
    } finally {
      this.polling = false;
      if (this.started && scheduleNext) this.schedule(delay);
    }
    return report;
  }

  private schedule(delayMs: number): void {
    this.nextDelayMs = delayMs;
    this.timer = (this.options.setTimeout ?? setTimeout)(() => {
      void this.tick(true);
    }, delayMs);
  }
}

function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 500);
}
