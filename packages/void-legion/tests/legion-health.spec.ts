import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error 进程外探针是纯 .mjs，不参与包的 tsconfig；这里只验证它的判据。
import { HEALTH_CODES, evaluateLegionHealth, resolveDataDir } from "../../scripts/legion-health.mjs";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "void-legion-health-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function status(plugin: { enabled: boolean } | undefined) {
  return async () => ({
    ok: true,
    json: async () => ({
      plugins: plugin === undefined ? [] : [{ id: "@void/void-legion", enabled: plugin.enabled }],
    }),
  });
}

async function seedDataRoot(): Promise<string> {
  const dataDir = path.join(await tempRoot(), "void-data", "web");
  await mkdir(path.join(dataDir, "legion", "runs"), { recursive: true });
  await mkdir(path.join(dataDir, "legion", "teams"), { recursive: true });
  return dataDir;
}

describe("军团健康探针（B4 四码）", () => {
  it("没有数据根 / 数据根不存在 → 3 等 setup", async () => {
    const savedHome = process.env.DSH_HOME;
    const savedProfile = process.env.DSH_PROFILE;
    delete process.env.DSH_HOME;
    delete process.env.DSH_PROFILE;
    try {
      const noProfile = await evaluateLegionHealth({ dataDir: "", statusUrl: "" });
      expect(noProfile.code).toBe(HEALTH_CODES.waitingSetup);
    } finally {
      if (savedHome !== undefined) process.env.DSH_HOME = savedHome;
      if (savedProfile !== undefined) process.env.DSH_PROFILE = savedProfile;
    }

    const missing = await evaluateLegionHealth({ dataDir: path.join(await tempRoot(), "nope"), statusUrl: "" });
    expect(missing.code).toBe(HEALTH_CODES.waitingSetup);
  });

  it("宿主可达、军团启用、文件都正常 → 0", async () => {
    const dataDir = await seedDataRoot();
    const result = await evaluateLegionHealth({ dataDir, fetchImpl: status({ enabled: true }) });
    expect(result).toMatchObject({ code: HEALTH_CODES.ok, state: "ok" });
  });

  it("军团未安装/被停用 → 3", async () => {
    const dataDir = await seedDataRoot();
    expect((await evaluateLegionHealth({ dataDir, fetchImpl: status(undefined) })).code)
      .toBe(HEALTH_CODES.waitingSetup);
    expect((await evaluateLegionHealth({ dataDir, fetchImpl: status({ enabled: false }) })).code)
      .toBe(HEALTH_CODES.waitingSetup);
  });

  it("宿主不可达且还有 running 记录 → 1 重启可修（重启会结算 interrupted）", async () => {
    const dataDir = await seedDataRoot();
    await writeFile(
      path.join(dataDir, "legion", "runs", "demo-1.json"),
      JSON.stringify({ status: "running" }),
      "utf8",
    );
    const result = await evaluateLegionHealth({
      dataDir,
      fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    });
    expect(result).toMatchObject({ code: HEALTH_CODES.restartCanFix, running: 1 });
    expect(result.reasons.join("\n")).toContain("running");
  });

  it("宿主不可达但没有 running 记录 → 1（重启可修）", async () => {
    const dataDir = await seedDataRoot();
    const result = await evaluateLegionHealth({
      dataDir,
      fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    });
    expect(result.code).toBe(HEALTH_CODES.restartCanFix);
  });

  it("损坏的 JSON → 2 重启也修不了（先于宿主状态判断）", async () => {
    const dataDir = await seedDataRoot();
    await writeFile(path.join(dataDir, "legion", "dispatch-policy.json"), "{ 坏掉的", "utf8");
    const result = await evaluateLegionHealth({ dataDir, fetchImpl: status({ enabled: true }) });
    expect(result.code).toBe(HEALTH_CODES.restartCannotFix);
    expect(result.reasons.join("\n")).toContain("dispatch-policy.json");
  });

  it("手动停机标记 + --respect-stop → 0，不误报", async () => {
    const dataDir = await seedDataRoot();
    await mkdir(path.join(dataDir, "runtime"), { recursive: true });
    await writeFile(path.join(dataDir, "runtime", "legion-health.stop"), "operator stopped", "utf8");
    const result = await evaluateLegionHealth({
      dataDir,
      respectStop: true,
      fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    });
    expect(result).toMatchObject({ code: HEALTH_CODES.ok, stopped: true });
  });

  it("--no-status 只看文件：headless profile 也能判 0", async () => {
    const dataDir = await seedDataRoot();
    const result = await evaluateLegionHealth({ dataDir, statusUrl: "" });
    expect(result.code).toBe(HEALTH_CODES.ok);
  });

  it("数据根解析：显式优先，其次 DSH_HOME + profile", () => {
    expect(resolveDataDir({ dataDir: "E:/x" })).toBe(path.resolve("E:/x"));
    const home = path.resolve("E:/home");
    expect(resolveDataDir({ dshHome: home, profile: "web" })).toBe(path.join(home, "void-data", "web"));
  });
});
