/**
 * 每个工作单元一个独立检出（B6）。
 *
 * 共享工作区靠写锁串行，解决的是「不互相踩」；它不解决「互不可见」。并行 lane 只要有
 * 一条跑 `git` 操作，写锁就会让人干等。这里给声明了 `checkout: "worktree"` 的成员
 * 开一个独立 `git worktree`，**不占共享工作区锁**；lane 结束后删除检出并尝试删分支。
 *
 * 三条边界：
 * 1. **每个成员显式 opt-in**（缺省 `shared`）。默认不改，因为不是每个工作区都是 git
 *    仓库，也不是每个用户都愿意让 Agent 建分支。
 * 2. **检出目录必须在我们自己的根下**（`<数据根>/legion/worktrees/<runId>/<laneId>`），
 *    失败清理只敢动这个根，不碰用户的工作区。
 * 3. **建立/清理都是失败可见的**：建立失败这条 lane 直接失败、不起子代理；清理失败
 *    写进运行事件，不静默留下一个没人知道的检出。
 *
 * @module @void/void-legion/worktree
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { assertLaneId } from "./contracts.js";
import { assertRunId } from "./run-store.js";

const execFileAsync = promisify(execFile);

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

export interface WorktreeManagerOptions {
  /** 仓库目录（可以是仓库里的子目录；执行时用 `rev-parse --show-toplevel` 找根）。 */
  repoDir: string;
  /** 检出根目录；必须绝对路径，所有 worktree 都落在这里下面。 */
  rootDir: string;
  /** git 可执行文件；测试/特殊环境可改。 */
  git?: string | undefined;
  /** 单次 git 命令超时；默认 60 秒。 */
  timeoutMs?: number | undefined;
}

export interface CreatedWorktree {
  repoDir: string;
  path: string;
  branch: string;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * worktree 管理器。一个实例对应一个仓库根；同一实例内的建立/清理串行，
 * 避免两个 lane 同时写 `.git/worktrees` 的元数据。
 */
export class WorktreeManager {
  private readonly repoDir: string;
  private readonly rootDir: string;
  private readonly git: string;
  private readonly timeoutMs: number;
  private resolvedRepo: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: WorktreeManagerOptions) {
    if (!path.isAbsolute(options.repoDir)) throw new WorktreeError("worktree 的仓库目录必须是绝对路径");
    if (!path.isAbsolute(options.rootDir)) throw new WorktreeError("worktree 的检出根目录必须是绝对路径");
    this.repoDir = path.resolve(options.repoDir);
    this.rootDir = path.resolve(options.rootDir);
    this.git = options.git ?? "git";
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  get repoRootDir(): string {
    return this.repoDir;
  }

  get worktreeRoot(): string {
    return this.rootDir;
  }

  /** 找仓库真实根；不是 git 仓库时给出可读错误，而不是让后续命令各自报一遍。 */
  async resolveRepoRoot(): Promise<string> {
    if (this.resolvedRepo !== undefined) return this.resolvedRepo;
    try {
      const { stdout } = await this.runGit(["-C", this.repoDir, "rev-parse", "--show-toplevel"]);
      const root = stdout.trim();
      if (root === "") throw new WorktreeError(`不是 git 仓库（rev-parse 输出为空）: ${this.repoDir}`);
      this.resolvedRepo = path.resolve(root);
      return this.resolvedRepo;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // git 自己的报错对使用者不友好（Windows 下还带一长串路径），先翻成人话。
      if (/not a git repository/i.test(message)) {
        throw new WorktreeError(`不是 git 仓库: ${this.repoDir}（${message}）`);
      }
      if (error instanceof WorktreeError) throw error;
      throw new WorktreeError(`不是 git 仓库或 git 不可用: ${this.repoDir}（${message}）`);
    }
  }

  /** 建立一个独立检出。**只在我们的 rootDir 下建**。 */
  async create(input: { runId: string; laneId: string }): Promise<CreatedWorktree> {
    return this.enqueue(async () => {
      const runId = assertRunId(input.runId);
      assertLaneId(input.laneId);
      const laneId = input.laneId;
      const repoDir = await this.resolveRepoRoot();
      const target = path.join(this.rootDir, runId, laneId);
      const branch = `agent/${runId}-${laneId}`;
      if (await exists(target)) {
        throw new WorktreeError(`检出目录已存在，拒绝覆盖: ${target}（先清理上一次的残留）`);
      }
      await mkdir(path.dirname(target), { recursive: true });
      try {
        await this.runGit(["-C", repoDir, "worktree", "add", "-b", branch, target, "HEAD"]);
      } catch (error) {
        // 建立失败时只清理我们自己的 root 下那个路径；不碰用户工作区。
        await rm(target, { recursive: true, force: true }).catch(() => undefined);
        await this.runGit(["-C", repoDir, "worktree", "prune"]).catch(() => undefined);
        throw error;
      }
      return { repoDir, path: target, branch };
    });
  }

  /** 删除检出并尝试删分支。清理失败会抛，让调度器写进运行事件。 */
  async remove(tree: CreatedWorktree): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.runGit(["-C", tree.repoDir, "worktree", "remove", "--force", tree.path]);
      } catch (first) {
        // git 自己删不掉（锁/临时占用）时退一步：删目录 + prune；两条都失败才算清理失败。
        await rm(tree.path, { recursive: true, force: true }).catch(() => undefined);
        await this.runGit(["-C", tree.repoDir, "worktree", "prune"]).catch(() => undefined);
        if (await exists(tree.path)) {
          throw new WorktreeError(
            `清理检出失败: ${tree.path}（${first instanceof Error ? first.message : String(first)}）`,
          );
        }
      }
      await this.runGit(["-C", tree.repoDir, "branch", "-D", tree.branch]).catch(() => undefined);
    });
  }

  /** 清理 git 元数据里已经不存在的 worktree（宿主被杀后的残留）。 */
  async prune(): Promise<void> {
    return this.enqueue(async () => {
      const repoDir = await this.resolveRepoRoot();
      await this.runGit(["-C", repoDir, "worktree", "prune"]);
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFileAsync(this.git, args, {
        cwd: this.repoDir,
        timeout: this.timeoutMs,
        windowsHide: true,
        maxBuffer: 1_000_000,
      });
    } catch (error) {
      const detail = error as { stderr?: string; stdout?: string; message?: string };
      const message = (detail.stderr || detail.stdout || detail.message || String(error)).trim().slice(0, 500);
      throw new WorktreeError(`git ${args.join(" ")} 失败: ${message}`);
    }
  }
}
