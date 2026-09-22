import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasSuspensionNews, loadSuspensionIndex, memberSuspensions } from "../src/suspensions.js";
import type { DelegationTeamMember } from "../src/team.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "void-legion-suspensions-"));
  roots.push(root);
  return root;
}

async function tempDataDir(): Promise<string> {
  const root = await tempRoot();
  await mkdir(path.join(root, "agents"), { recursive: true });
  return root;
}

async function writeSoul(dataDir: string, directory: string, id: string, name: string): Promise<void> {
  const dir = path.join(dataDir, "agents", directory);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SOUL.md"),
    ["---", `id: ${id}`, `name: ${name}`, `summary: ${name}的简介`, "---", "", `你是${name}。`, ""].join("\n"),
    "utf8",
  );
}

/** 老状态文件（没有停用位）——按「启用」算。 */
const LEGACY_STATE = JSON.stringify({ schemaVersion: 1, activeFacetId: null, selectionRevision: 0, firstMeetingDone: false });
const SUSPENDED_STATE = JSON.stringify({ ...JSON.parse(LEGACY_STATE), suspended: true });

function member(laneId: string, agentId: string): DelegationTeamMember {
  return { laneId, agentId, role: "coder", dependsOn: [] };
}

describe("军团读停用表（A17：派活之前就看得出来）", () => {
  it("都好好的就不说话：读过了、没人停用、没有读不动的", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝", "xiaobei", "小贝");
    await writeSoul(dataDir, "小马", "xiaoma", "小马");
    // 一份老状态文件（缺停用位）、一份干脆没有状态文件：两种都算启用。
    await writeFile(path.join(dataDir, "agents", "小马", "state.json"), LEGACY_STATE, "utf8");

    const index = await loadSuspensionIndex(dataDir);
    expect([...index.known].sort()).toEqual(["xiaobei", "xiaoma"]);
    expect([...index.suspended]).toEqual([]);
    expect(index.problems).toEqual([]);

    const members = [member("lane_code", "xiaoma"), member("lane_verify", "xiaobei")];
    expect(memberSuspensions({ members, index })).toEqual([]);
    expect(hasSuspensionNews({ members, index })).toBe(false);
  });

  it("停用的才收进表里：老状态文件缺字段算启用", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝", "xiaobei", "小贝");
    await writeSoul(dataDir, "小马", "xiaoma", "小马");
    await writeFile(path.join(dataDir, "agents", "小贝", "state.json"), SUSPENDED_STATE, "utf8");
    await writeFile(path.join(dataDir, "agents", "小马", "state.json"), LEGACY_STATE, "utf8");

    const index = await loadSuspensionIndex(dataDir);
    expect([...index.suspended]).toEqual(["xiaobei"]);
    expect(index.problems).toEqual([]);

    const members = [member("lane_code", "xiaoma"), member("lane_verify", "xiaobei")];
    // 好的那个一个字都不提：这一节只报「有话要说」的人。
    expect(memberSuspensions({ members, index })).toEqual([{ laneId: "lane_verify", agentId: "xiaobei", suspended: true }]);
    expect(hasSuspensionNews({ members, index })).toBe(true);
  });

  it("登记表里没有这份档案：如实报出来，不当成「没停用」", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小马", "xiaoma", "小马");

    const index = await loadSuspensionIndex(dataDir);
    expect(index.problems).toEqual([]);
    const members = [member("lane_front", "ghost")];
    expect(memberSuspensions({ members, index })).toEqual([
      { laneId: "lane_front", agentId: "ghost", suspended: false, reason: "登记表里没有这份档案" },
    ]);
    expect(hasSuspensionNews({ members, index })).toBe(true);
  });

  it("状态位读不动只影响那一份：报出是谁，别的照读", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝", "xiaobei", "小贝");
    await writeSoul(dataDir, "小马", "xiaoma", "小马");
    // 坏值：灵魂侧会抛「停用状态损坏」，这里必须如实报，不能吞掉当成启用。
    await writeFile(path.join(dataDir, "agents", "小贝", "state.json"), JSON.stringify({ ...JSON.parse(LEGACY_STATE), suspended: "是" }), "utf8");
    await writeFile(path.join(dataDir, "agents", "小马", "state.json"), SUSPENDED_STATE, "utf8");

    const index = await loadSuspensionIndex(dataDir);
    expect(index.problems).toEqual(["小贝（xiaobei）：读不出停用状态（停用状态损坏）"]);
    expect([...index.suspended]).toEqual(["xiaoma"]);
    // 读不出来的那份**不在** known 之外的任何一边：它既不算停用，也不算「没有这份档案」。
    expect(index.known.has("xiaobei")).toBe(true);
  });

  it("整张登记表读不动：空表加一句问题，绝不假装「没人停用」", async () => {
    const root = await tempRoot();
    // agents 是个文件而不是目录：读登记表当场就炸。
    await writeFile(path.join(root, "agents"), "not a directory", "utf8");

    const index = await loadSuspensionIndex(root);
    expect([...index.known]).toEqual([]);
    expect([...index.suspended]).toEqual([]);
    expect(index.problems).toHaveLength(1);
    expect(index.problems[0]).toMatch(/^档案登记表读不动：/);
    expect(hasSuspensionNews({ members: [member("lane_code", "xiaoma")], index })).toBe(true);
  });

  it("没有档案 id 的成员跳过：那是另一条检查的事", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小马", "xiaoma", "小马");
    const index = await loadSuspensionIndex(dataDir);

    const members: DelegationTeamMember[] = [{ laneId: "lane_todo", role: "coder", dependsOn: [] }];
    expect(memberSuspensions({ members, index })).toEqual([]);
    expect(hasSuspensionNews({ members, index })).toBe(false);
  });
});
