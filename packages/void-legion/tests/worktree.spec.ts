import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeError, WorktreeManager } from "../src/worktree.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "void-legion-worktree-"));
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

async function makeRepo(): Promise<{ repo: string; root: string }> {
  const base = await tempRoot();
  const repo = path.join(base, "repo");
  await mkdir(repo, { recursive: true });
  git(repo, ["init"]);
  await writeFile(path.join(repo, "README.md"), "hello\n", "utf8");
  git(repo, ["add", "README.md"]);
  git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
  return { repo, root: path.join(base, "worktrees") };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }
});

describe("独立检出（B6）", () => {
  it("给两条 lane 各建一个独立 worktree，路径互不相同，删除后目录消失", async () => {
    const { repo, root } = await makeRepo();
    const manager = new WorktreeManager({ repoDir: repo, rootDir: root });
    const a = await manager.create({ runId: "legion-demo-20261106120000-01", laneId: "lane_a" });
    const b = await manager.create({ runId: "legion-demo-20261106120000-01", laneId: "lane_b" });

    expect(a.path).not.toBe(b.path);
    expect(path.resolve(a.path).startsWith(path.resolve(root))).toBe(true);
    expect((await stat(path.join(a.path, ".git"))).isFile()).toBe(true);
    expect(git(a.path, ["rev-parse", "--is-inside-work-tree"]).trim()).toBe("true");
    expect(git(b.path, ["rev-parse", "--is-inside-work-tree"]).trim()).toBe("true");

    await manager.remove(a);
    await manager.remove(b);
    await expect(stat(a.path)).rejects.toThrow();
    await expect(stat(b.path)).rejects.toThrow();
    expect(git(repo, ["branch", "--list", "agent/legion-demo-20261106120000-01-lane_a"]).trim()).toBe("");
  });

  it("同一 lane 重复建会拒绝覆盖，不静默复用旧目录", async () => {
    const { repo, root } = await makeRepo();
    const manager = new WorktreeManager({ repoDir: repo, rootDir: root });
    await manager.create({ runId: "legion-demo-20261106120000-01", laneId: "lane_a" });
    await expect(manager.create({ runId: "legion-demo-20261106120000-01", laneId: "lane_a" }))
      .rejects.toThrow(/已存在/);
  });

  it("不是 git 仓库时明确拒，而不是让后续子代理跑在错误目录里", async () => {
    const base = await tempRoot();
    const notRepo = path.join(base, "plain");
    await mkdir(notRepo, { recursive: true });
    const manager = new WorktreeManager({ repoDir: notRepo, rootDir: path.join(base, "worktrees") });
    await expect(manager.create({ runId: "legion-demo-20261106120000-01", laneId: "lane_a" }))
      .rejects.toBeInstanceOf(WorktreeError);
    await expect(manager.create({ runId: "legion-demo-20261106120000-01", laneId: "lane_a" }))
      .rejects.toThrow(/不是 git 仓库|git 不可用/);
  });
});
