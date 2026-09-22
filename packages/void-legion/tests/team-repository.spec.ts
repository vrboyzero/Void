import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTeamDocument, parseTeamDocument } from "../src/contracts.js";
import {
  composeRunRoster,
  LegionConflictError,
  LegionNotFoundError,
  LegionRepositoryError,
  resolveLegionDataDir,
  TeamRepository,
} from "../src/team-repository.js";
import type { DelegationTeamMember } from "../src/team.js";

const roster: DelegationTeamMember[] = [
  { laneId: "lane_plan", agentId: "xiaobei", role: "researcher" },
  { laneId: "lane_code", agentId: "xiaoma", role: "coder", dependsOn: ["lane_plan"] },
];

let dataDir: string;
let repository: TeamRepository;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "void-legion-teams-"));
  repository = new TeamRepository({ dataDir, now: () => new Date("2026-09-22T00:00:00.000Z") });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function documentOf(id: string) {
  return createTeamDocument({ id, mode: "plan_execute_verify", members: roster, managerAgentId: "xiaobei" });
}

describe("legion team repository", () => {
  // P4 退出条件第一条：重启名单仍在。
  it("keeps a saved roster across a restart (new repository instance, same data root)", async () => {
    const saved = await repository.save({ document: documentOf("legion-demo"), expectedRevision: 0 });
    expect(saved.revision).toBe(1);

    const restarted = new TeamRepository({ dataDir });
    const loaded = await restarted.require("legion-demo");
    expect(loaded.id).toBe("legion-demo");
    expect(loaded.members.map((member) => member.laneId)).toEqual(["lane_plan", "lane_code"]);
    expect(loaded.managerAgentId).toBe("xiaobei");
    expect(loaded.revision).toBe(1);
    expect(await restarted.list()).toHaveLength(1);
  });

  it("reports a missing team instead of inventing one", async () => {
    expect(await repository.load("legion-demo")).toBeUndefined();
    await expect(repository.require("legion-demo")).rejects.toThrow(LegionNotFoundError);
    expect(await repository.list()).toEqual([]);
  });

  it("refuses a stale save (concurrent edit loses, does not overwrite)", async () => {
    const first = await repository.save({ document: documentOf("legion-demo"), expectedRevision: 0 });
    // 第二个保存者手上还是 revision 0。
    await expect(repository.save({ document: documentOf("legion-demo"), expectedRevision: 0 })).rejects.toThrow(LegionConflictError);
    await expect(repository.save({ document: documentOf("legion-demo"), expectedRevision: 0 })).rejects.toThrow(
      /期望修订 0，实际 1/,
    );
    // 读到最新修订后就能保存。
    const second = await repository.save({ document: documentOf("legion-demo"), expectedRevision: first.revision });
    expect(second.revision).toBe(2);
  });

  it("changes the member limit in one read-modify-write (L13)", async () => {
    await repository.save({ document: documentOf("legion-demo"), expectedRevision: 0 });
    const updated = await repository.setMemberLimit("legion-demo", { memberLimit: 3 });
    expect(updated.memberLimit).toBe(3);
    expect(updated.revision).toBe(2);
    await expect(repository.setMemberLimit("legion-demo", { memberLimit: 0 })).rejects.toThrow(/人数上限不合法/);
    await expect(repository.setMemberLimit("legion-missing", { memberLimit: 3 })).rejects.toThrow(LegionNotFoundError);
  });

  it("refuses to lower the member limit below the roster and leaves the file alone", async () => {
    await repository.save({ document: documentOf("legion-demo"), expectedRevision: 0 });
    // 名单里有 2 个人，调到 1 就是把这支队伍改成派不出去的配置：
    // 写盘前那一道 validateTeamPlan 得拦住它，而不是等派活时才发现。
    await expect(repository.setMemberLimit("legion-demo", { memberLimit: 1 })).rejects.toThrow(/队伍人数超出上限: 2 > 1/);
    // 拦住之后磁盘上还是原来那一份：修订与上限都没动。
    const onDisk = parseTeamDocument(await readFile(join(repository.root, "legion-demo.json"), "utf8"));
    expect(onDisk.revision).toBe(1);
    expect(onDisk.memberLimit).toBe(8);
  });

  it("removes a team and then reports it as gone", async () => {
    await repository.save({ document: documentOf("legion-demo"), expectedRevision: 0 });
    await repository.remove("legion-demo", { expectedRevision: 1 });
    expect(await repository.load("legion-demo")).toBeUndefined();
    await expect(repository.remove("legion-demo")).rejects.toThrow(LegionNotFoundError);
  });

  it("refuses to persist a roster that could not be dispatched", async () => {
    const broken = createTeamDocument({
      id: "legion-broken",
      mode: "parallel_subtasks",
      members: [{ laneId: "lane_a", agentId: "xiaobei", dependsOn: ["lane_missing"] }],
    });
    await expect(repository.save({ document: broken, expectedRevision: 0 })).rejects.toThrow(/依赖不在名单里: lane_missing/);
    // 坏名单一个字节都不该落盘。
    await expect(repository.load("legion-broken")).resolves.toBeUndefined();
  });

  it("reports a corrupt team file with its path instead of skipping it", async () => {
    await repository.save({ document: documentOf("legion-demo"), expectedRevision: 0 });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(repository.root, "legion-broken.json"), "{ not json", "utf8");
    await expect(repository.list()).rejects.toThrow(/队伍配置损坏: .*legion-broken\.json/);
  });

  it("writes atomically (no temporary file survives a save)", async () => {
    await repository.save({ document: documentOf("legion-demo"), expectedRevision: 0 });
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(repository.root);
    expect(names).toEqual(["legion-demo.json"]);
    const text = await readFile(join(repository.root, "legion-demo.json"), "utf8");
    expect(parseTeamDocument(text).id).toBe("legion-demo");
  });

  // P4 退出条件第二条：临时成员不污染固定名单。
  it("composes a run roster with temporary members without touching the saved roster", async () => {
    await repository.save({ document: documentOf("legion-demo"), expectedRevision: 0 });
    const before = await readFile(join(repository.root, "legion-demo.json"), "utf8");

    const saved = await repository.require("legion-demo");
    const composed = composeRunRoster(saved, [
      { laneId: "lane_audit", agentId: "xiaoma", role: "verifier", dependsOn: ["lane_code"] },
    ]);
    expect(composed.map((member) => member.laneId)).toEqual(["lane_plan", "lane_code", "lane_audit"]);

    // 固定名单没变：内存里没变，磁盘上一个字节也没变。
    expect(saved.members.map((member) => member.laneId)).toEqual(["lane_plan", "lane_code"]);
    expect(await readFile(join(repository.root, "legion-demo.json"), "utf8")).toBe(before);
    expect((await repository.require("legion-demo")).members).toHaveLength(2);
  });

  it("refuses a temporary member that collides with the fixed roster or breaks the limit", async () => {
    const saved = await repository.save({ document: documentOf("legion-demo"), expectedRevision: 0 });
    expect(() => composeRunRoster(saved, [{ laneId: "lane_plan", agentId: "xiaoma" }])).toThrow(/临时成员与固定名单重复: lane_plan/);
    await repository.setMemberLimit("legion-demo", { memberLimit: 2 });
    const limited = await repository.require("legion-demo");
    expect(() => composeRunRoster(limited, [{ laneId: "lane_audit", agentId: "xiaosan" }])).toThrow(/队伍人数超出上限: 3 > 2/);
  });
});

describe("legion data root resolution", () => {
  it("prefers an explicit dataDir and otherwise follows DSH_HOME + profile", () => {
    expect(resolveLegionDataDir({ dataDir: join(tmpdir(), "void-legion-explicit") })).toBe(join(tmpdir(), "void-legion-explicit"));
    expect(resolveLegionDataDir({ dshHome: join(tmpdir(), "dsh-home"), profile: "web" })).toBe(
      join(tmpdir(), "dsh-home", "void-data", "web"),
    );
    // 绝不猜一个默认档案去读写用户的日常数据。
    expect(() => resolveLegionDataDir({ dshHome: join(tmpdir(), "dsh-home"), env: {} })).toThrow(LegionRepositoryError);
    expect(() => resolveLegionDataDir({ env: {} })).toThrow(/军团缺少数据根/);
    expect(() => resolveLegionDataDir({ dataDir: "relative/path" })).toThrow(/绝对路径/);
  });

  it("refuses a relative data root at construction time", () => {
    expect(() => new TeamRepository({ dataDir: "relative/path" })).toThrow(/军团数据根必须是绝对路径/);
  });
});
