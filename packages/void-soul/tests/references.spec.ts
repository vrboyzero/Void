import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LEGION_TEAMS_DIRECTORY, loadProfileReferences } from "../src/references.js";
import { loadSessionBindings, loadSoulRegistry, saveSessionBindings } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDataDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "void-references-"));
  roots.push(root);
  await mkdir(path.join(root, "agents"), { recursive: true });
  return root;
}

/** 一份档案：`extra` 是 front matter 里额外的行（组织图就写在这里）。 */
async function writeSoul(dataDir: string, directory: string, id: string, name: string, extra: readonly string[] = []): Promise<void> {
  const dir = path.join(dataDir, "agents", directory);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SOUL.md"), ["---", `id: ${id}`, `name: ${name}`, `summary: ${name}的简介`, ...extra, "---", "", `你是${name}。`, ""].join("\n"), "utf8");
}

async function writeTeam(dataDir: string, file: string, body: string): Promise<void> {
  const dir = path.join(dataDir, LEGION_TEAMS_DIRECTORY);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), body, "utf8");
}

async function referencesOf(dataDir: string, agentId: string) {
  const records = await loadSoulRegistry(dataDir);
  const record = records.get(agentId);
  if (!record) throw new Error(`夹具里没有这份档案: ${agentId}`);
  return loadProfileReferences({ dataDir, record, records, bindings: await loadSessionBindings(dataDir) });
}

const ALPHA = JSON.stringify({
  schemaVersion: 1,
  id: "alpha",
  mode: "parallel_subtasks",
  members: [
    { laneId: "lane_plan", agentId: "xiaobei", role: "commander" },
    { laneId: "lane_front", agentId: "ajia", role: "coder" },
  ],
  managerAgentId: "xiaobei",
});

describe("引用检查（停用/删除前先看清还有谁在用它）", () => {
  it("三处来源一起报：绑定会话排序、队伍里的 lane 与管理者、组织图两边都认", async () => {
    const dataDir = await tempDataDir();
    // 组织图两边都声明：小贝自己写了 subordinates，阿乙反过来把小贝写成上级。
    await writeSoul(dataDir, "小贝", "xiaobei", "小贝", ["authority:", "  enabled: true", "  superiors: []", "  subordinates: [xiaoma]"]);
    await writeSoul(dataDir, "小码", "xiaoma", "小码");
    await writeSoul(dataDir, "阿乙", "ayi", "阿乙", ["authority:", "  enabled: true", "  superiors: [xiaobei]", "  subordinates: []"]);
    await writeSoul(dataDir, "阿甲", "ajia", "阿甲");
    await writeTeam(dataDir, "alpha.json", ALPHA);
    await saveSessionBindings(dataDir, new Map([
      ["s-2", "xiaobei"],
      ["s-1", "xiaobei"],
      ["s-3", "xiaoma"],
    ]));

    const references = await referencesOf(dataDir, "xiaobei");
    expect(references.sessions).toEqual(["s-1", "s-2"]);
    // 队伍：排进 lane 的算一处，当管理者的另算一处——两处都要人看见。
    expect(references.teams).toEqual([
      { teamId: "alpha", kind: "member", laneId: "lane_plan", role: "commander" },
      { teamId: "alpha", kind: "manager", laneId: null, role: null },
    ]);
    // 组织图只列**别人**写进来的引用：阿乙把小贝写成上级；小贝自己写的 subordinates 不算，
    // 因为那是它自己的声明（删了它这份声明也一起没了），别人写的 id 才会悬空。
    expect(references.subordinates).toEqual(["ayi"]);
    expect(references.superiors).toEqual([]);
    expect(references.unreadableTeams).toEqual([]);

    // 反过来问小码：小贝自己写的 subordinates 到了它这里就是「别人写它当上级的」。
    const xiaoma = await referencesOf(dataDir, "xiaoma");
    expect(xiaoma.superiors).toEqual(["xiaobei"]);
    expect(xiaoma.subordinates).toEqual([]);
    // 阿乙自己写的上级（xiaobei）不是别人写它的，所以这里两边都是空——它自己的声明在
    // 「主人与权限」那一节，不在引用检查里。
    const ayi = await referencesOf(dataDir, "ayi");
    expect(ayi.superiors).toEqual([]);
    expect(ayi.subordinates).toEqual([]);
    expect(ayi.teams).toEqual([]);
    // 排进 lane 的成员照样查得到，管理者那一处不会串到别人头上。
    const ajia = await referencesOf(dataDir, "ajia");
    expect(ajia.teams).toEqual([{ teamId: "alpha", kind: "member", laneId: "lane_front", role: "coder" }]);
  });

  it("还没建军团不算错：队伍目录不在就是「没有引用」，不是读不了", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝", "xiaobei", "小贝");
    const references = await referencesOf(dataDir, "xiaobei");
    expect(references).toEqual({ sessions: [], teams: [], unreadableTeams: [], superiors: [], subordinates: [] });
  });

  it("读不了的队伍文件单独报出来，绝不混成「没人用它」", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝", "xiaobei", "小贝");
    await writeTeam(dataDir, "alpha.json", ALPHA);
    await writeTeam(dataDir, "broken.json", "{ 这不是 JSON");
    await writeTeam(dataDir, "list.json", "[]");
    // 缺 id 的队伍：退回文件名，总比报一个空 id 强。
    await writeTeam(dataDir, "nameless.json", JSON.stringify({ members: [{ laneId: "lane_x", agentId: "xiaobei" }] }));
    // 同名目录：readFile 会 EISDIR，这一处也算读不动。
    await mkdir(path.join(dataDir, LEGION_TEAMS_DIRECTORY, "dir.json"), { recursive: true });
    // 非 .json 的文件根本不进扫描。
    await writeTeam(dataDir, "notes.txt", "随手记的");

    const references = await referencesOf(dataDir, "xiaobei");
    expect(references.teams).toEqual([
      { teamId: "alpha", kind: "member", laneId: "lane_plan", role: "commander" },
      { teamId: "alpha", kind: "manager", laneId: null, role: null },
      { teamId: "nameless", kind: "member", laneId: "lane_x", role: null },
    ]);
    expect(references.unreadableTeams.map((problem) => [problem.file, problem.reason])).toEqual([
      [path.join(LEGION_TEAMS_DIRECTORY, "broken.json"), "不是能读的 JSON"],
      [path.join(LEGION_TEAMS_DIRECTORY, "dir.json"), "文件读不动"],
      [path.join(LEGION_TEAMS_DIRECTORY, "list.json"), "顶层不是一支队伍"],
    ]);
    expect(references.unreadableTeams[0]!.detail).toContain("JSON");
    expect(references.unreadableTeams[2]!.detail).toBeUndefined();
  });

  it("队伍里排的是别人就不算引用；lane 与角色缺了就报 null，不编一个", async () => {
    const dataDir = await tempDataDir();
    await writeSoul(dataDir, "小贝", "xiaobei", "小贝");
    await writeTeam(dataDir, "beta.json", JSON.stringify({ id: "beta", members: [{ agentId: "ajia" }, { laneId: "lane_x" }], managerAgentId: "ajia" }));
    const references = await referencesOf(dataDir, "xiaobei");
    expect(references.teams).toEqual([]);
    expect(references.unreadableTeams).toEqual([]);
  });
});
