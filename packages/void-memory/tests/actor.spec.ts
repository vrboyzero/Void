import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createActorResolver, MemoryIdentityError, resolveDataRoot, resolveHarnessHome } from "../src/actor.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "void-memory-actor-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function bind(sessionId: string, agentId: string): Promise<void> {
  const dir = join(dataDir, "runtime");
  await mkdir(dir, { recursive: true });
  const existing = await import("node:fs/promises").then(({ readFile }) =>
    readFile(join(dir, "session-bindings.json"), "utf8").then(
      (text) => JSON.parse(text) as { sessionId: string; agentId: string }[],
      () => [] as { sessionId: string; agentId: string }[],
    ),
  );
  const next = [...existing.filter((item) => item.sessionId !== sessionId), { sessionId, agentId }];
  await writeFile(join(dir, "session-bindings.json"), JSON.stringify(next), "utf8");
}

describe("createActorResolver", () => {
  it("resolves a bound session to its archive id and tags the write source", async () => {
    await bind("session-a", "xiaobei");
    const resolve = createActorResolver({ dataDir, source: "tool" });
    await expect(resolve("session-a")).resolves.toEqual({ agentId: "xiaobei", sessionId: "session-a", source: "tool" });
  });

  it("rejects an execution without a session instead of falling back to a default archive", async () => {
    const resolve = createActorResolver({ dataDir });
    await expect(resolve(undefined)).rejects.toBeInstanceOf(MemoryIdentityError);
    await expect(resolve(undefined)).rejects.toThrow("记忆工具缺少执行会话，已拒绝");
    await expect(resolve("")).rejects.toThrow("记忆工具缺少执行会话，已拒绝");
  });

  it("rejects a session that has no archive binding", async () => {
    await bind("session-a", "xiaobei");
    const resolve = createActorResolver({ dataDir });
    await expect(resolve("session-forged")).rejects.toThrow("会话没有档案绑定: session-forged");
  });

  it("re-reads the binding file so a newly bound session works without a new resolver", async () => {
    await bind("session-a", "xiaobei");
    const resolve = createActorResolver({ dataDir });
    await expect(resolve("session-b")).rejects.toThrow("会话没有档案绑定: session-b");

    await bind("session-b", "xiaoma");
    await expect(resolve("session-b")).resolves.toMatchObject({ agentId: "xiaoma" });
  });

  it("keeps rejecting a forged archive id even when the session is bound", async () => {
    await bind("session-a", "../../etc");
    const resolve = createActorResolver({ dataDir });
    await expect(resolve("session-a")).resolves.toMatchObject({ agentId: "../../etc" });
    // 越界 id 由仓储在拼路径时拒绝，解析器只负责如实转述绑定。
    const { agentMemoryRoot } = await import("../src/agent-store.js");
    expect(() => agentMemoryRoot(dataDir, "../../etc")).toThrow("记忆档案 id 不合法");
  });
});

describe("resolveDataRoot", () => {
  it("prefers an explicit dataDir over the environment", () => {
    expect(resolveDataRoot({ dataDir }, { DSH_HOME: "C:\\nope", DSH_PROFILE: "web" })).toBe(dataDir);
  });

  it("derives the root from DSH_HOME plus profile", () => {
    const root = resolveDataRoot({}, { DSH_HOME: join(dataDir, "home"), DSH_PROFILE: "web" });
    expect(root).toBe(join(dataDir, "home", "void-data", "web"));
  });

  it("refuses to guess a root when the profile is missing", () => {
    expect(() => resolveDataRoot({}, { DSH_HOME: join(dataDir, "home") })).toThrow(
      "记忆工具缺少数据根：需要显式 dataDir，或 profile（DSH_PROFILE / 宿主给的档案目录）与可选的 dshHome（DSH_HOME）",
    );
  });

  it("follows the host definition of DSH_HOME: env wins, otherwise ~/.dsh", () => {
    expect(resolveHarnessHome({ DSH_HOME: join(dataDir, "home") })).toBe(join(dataDir, "home"));
    expect(resolveHarnessHome({})).toBe(join(homedir(), ".dsh"));
    // 只给 profile 时按宿主默认 home 拼出数据根（纯路径计算，不落盘）。
    expect(resolveDataRoot({ profile: "web" }, {})).toBe(join(homedir(), ".dsh", "void-data", "web"));
  });
});
