import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveVoidDataRoot } from "@void/void-soul";
import { RUN_VIEW_ID, TEAM_VIEW_ID, apply, createLegionViews, type LegionViewHost } from "../src/detail-view.js";
import type { TeamDocument } from "../src/contracts.js";
import type { LegionRunProgress } from "../src/run-coordinator.js";
import type { RunRecord } from "../src/run-store.js";

// 队伍面板要读灵魂档案登记表才知道谁被停用（A17），所以夹具得有个**真**数据根：
// 三位成员都在、都启用——默认这一节不出现；要演停用就改那份档案的 state.json。
const HOME = mkdtempSync(path.join(tmpdir(), "void-legion-detail-"));
const PROFILE = { home: HOME, name: "web" };
const DATA_ROOT = resolveVoidDataRoot({ dshHome: PROFILE.home, profile: PROFILE.name });

function seedProfile(directory: string, id: string, name: string): void {
  const dir = path.join(DATA_ROOT, "agents", directory);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SOUL.md"),
    ["---", `id: ${id}`, `name: ${name}`, `summary: ${name}的简介`, "---", "", `你是${name}。`, ""].join("\n"),
    "utf8",
  );
}

seedProfile("小贝", "xiaobei", "小贝");
seedProfile("小马", "xiaoma", "小马");
seedProfile("小红", "xiaohong", "小红");

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

/** 给某份档案写一个停用位：`"broken"` 写的是坏值（灵魂侧会抛「停用状态损坏」）。 */
function writeSuspension(directory: string, suspended: boolean | "broken"): void {
  const state = { schemaVersion: 1, activeFacetId: null, selectionRevision: 0, firstMeetingDone: false, suspended };
  writeFileSync(
    path.join(DATA_ROOT, "agents", directory, "state.json"),
    JSON.stringify(suspended === "broken" ? { ...state, suspended: "是" } : state),
    "utf8",
  );
}

function clearSuspension(directory: string): void {
  rmSync(path.join(DATA_ROOT, "agents", directory, "state.json"), { force: true });
}

const TEAM: TeamDocument = {
  schemaVersion: 1,
  id: "demo-team",
  mode: "plan_execute_verify",
  schedule: "parallel",
  sharedGoal: "把登录接口改完并验一遍",
  managerAgentId: "xiaobei",
  managerIdentityLabel: "小贝",
  memberLimit: 8,
  maxConcurrentTasks: 4,
  revision: 3,
  updatedAt: "2026-09-22T10:00:00.000Z",
  members: [
    { laneId: "lane_code", agentId: "xiaoma", role: "coder", dependsOn: [], modelRef: "cheap/fast" },
    {
      laneId: "lane_verify",
      agentId: "xiaohong",
      role: "verifier",
      dependsOn: ["lane_code"],
      reportsTo: ["xiaobei"],
      mayDirect: [],
    },
  ],
};

const OTHER_TEAM: TeamDocument = { ...TEAM, id: "alpha-team", managerIdentityLabel: undefined, revision: 1, members: [] };

const RUN: RunRecord = {
  schemaVersion: 1,
  runId: "demo-team-1",
  teamId: "demo-team",
  task: "改登录接口",
  schedule: "parallel",
  status: "running",
  createdAt: "2026-09-22T10:00:00.000Z",
  updatedAt: "2026-09-22T10:00:05.000Z",
  frozenRoster: TEAM.members,
  memberLimit: 8,
  maxConcurrentTasks: 4,
  tasks: [
    {
      laneId: "lane_code",
      agentId: "xiaoma",
      status: "completed",
      dependsOn: [],
      attempts: 1,
      childSessionId: "child-1",
      startedAt: "2026-09-22T10:00:01.000Z",
      endedAt: "2026-09-22T10:00:04.000Z",
      output: { summary: "改完了" },
    },
    { laneId: "lane_verify", agentId: "xiaohong", status: "running", dependsOn: ["lane_code"], attempts: 1 },
  ],
  events: [{ at: "2026-09-22T10:00:01.000Z", kind: "lane_started", laneId: "lane_code" }],
};

const OLD_RUN: RunRecord = { ...RUN, runId: "demo-team-0", status: "completed", updatedAt: "2026-09-22T09:00:00.000Z" };

const PROGRESS: LegionRunProgress = {
  runId: RUN.runId,
  teamId: RUN.teamId,
  status: RUN.status,
  schedule: RUN.schedule,
  summary: { total: 2, completed: 1, failed: 0, blocked: 0, cancelled: 0, running: 1, pending: 0 },
  running: [{ laneId: "lane_verify", agentId: "xiaohong", startedAt: "2026-09-22T10:00:04.000Z" }],
  pending: [],
  lastActivityAt: "2026-09-22T10:00:05.000Z",
  childSessionIds: ["child-1"],
  conclusion: "还在跑：已结算 1/2，在跑 1，还没轮到 0",
  events: RUN.events,
};

type Call = { kind: string; args: unknown[] };

function fakeHost(overrides: Partial<LegionViewHost> = {}): LegionViewHost & { calls: Call[] } {
  const calls: Call[] = [];
  const host: LegionViewHost = {
    dataRoot: DATA_ROOT,
    async listTeams() {
      return [TEAM, OTHER_TEAM];
    },
    async loadTeam(teamId) {
      return teamId === TEAM.id ? TEAM : undefined;
    },
    async saveTeam(document, options) {
      calls.push({ kind: "saveTeam", args: [document, options] });
      return { ...document, revision: (options?.expectedRevision ?? 0) + 1 };
    },
    async removeTeam(teamId, options) {
      calls.push({ kind: "removeTeam", args: [teamId, options] });
    },
    async setMemberLimit(teamId, input) {
      calls.push({ kind: "setMemberLimit", args: [teamId, input] });
      return { ...TEAM, memberLimit: input.memberLimit, revision: TEAM.revision + 1 };
    },
    async setMaxConcurrentTasks(teamId, input) {
      calls.push({ kind: "setMaxConcurrentTasks", args: [teamId, input] });
      return { ...TEAM, maxConcurrentTasks: input.maxConcurrentTasks, revision: TEAM.revision + 2 };
    },
    async listRuns() {
      return [OLD_RUN, RUN];
    },
    async runRecord(runId) {
      if (runId !== RUN.runId) throw new Error(`运行不存在: ${runId}`);
      return RUN;
    },
    async runProgress() {
      return PROGRESS;
    },
    async cancelRun(runId, reason) {
      calls.push({ kind: "cancelRun", args: [runId, reason] });
      return { ...RUN, status: "cancelled" };
    },
    async cancelLane(runId, laneId, reason) {
      calls.push({ kind: "cancelLane", args: [runId, laneId, reason] });
      return { ...RUN, status: "running" };
    },
    ...overrides,
  };
  return Object.assign(host, { calls });
}

function viewsOf(host: LegionViewHost | undefined) {
  const views = createLegionViews(() => host);
  const teams = views.find((view) => view.id === TEAM_VIEW_ID)!;
  const runs = views.find((view) => view.id === RUN_VIEW_ID)!;
  return { teams, runs };
}

function sectionOf(body: { sections: readonly { id: string }[] }, id: string): never {
  const section = body.sections.find((item) => item.id === id);
  expect(section).toBeDefined();
  return section as never;
}

describe("void-legion detail views", () => {
  it("registers exactly the two business views", () => {
    const views = createLegionViews(() => fakeHost());
    expect(views.map((view) => view.id)).toEqual([TEAM_VIEW_ID, RUN_VIEW_ID]);
    expect(views.map((view) => view.title)).toEqual(["军团队伍", "军团运行"]);
  });

  it("lists teams sorted by id with the member count and revision", async () => {
    const { teams } = viewsOf(fakeHost());
    expect(await teams.list(PROFILE)).toEqual([
      {
        id: "alpha-team",
        title: "alpha-team",
        summary: "plan_execute_verify · 并行 · 0/8 人",
        meta: "修订 1",
      },
      {
        id: "demo-team",
        title: "小贝",
        summary: "plan_execute_verify · 并行 · 2/8 人",
        meta: "修订 3",
      },
    ]);
  });

  it("shows the org chart, the roster table and the team's recent runs", async () => {
    const { teams } = viewsOf(fakeHost());
    const body = await teams.detail({ ...PROFILE, itemId: "demo-team" });

    expect(body.title).toBe("小贝");
    expect(body.markdown).toBe("## 共同目标\n\n把登录接口改完并验一遍");
    expect(body.revision).toBe(3);

    const org = sectionOf(body, "org") as { kind: string; lines: string[] };
    // 组织图与表读的是同一份队伍数据（§16.1）：这里断言的是它真的来自 renderOrgChart。
    expect(org.kind).toBe("org");
    expect(org.lines[0]).toBe("队伍 demo-team（plan_execute_verify · parallel，人数上限 8，当前 2 人）");
    expect(org.lines.join("\n")).toContain("lane_code · xiaoma · [coder]");

    const members = sectionOf(body, "members") as {
      kind: string;
      key: string;
      editable: boolean;
      addLabel: string;
      columns: { key: string; label: string; type?: string }[];
      rows: Record<string, unknown>[];
    };
    // 名单是可编辑的行表格：面板照着列定义画控件，改完整组交回来。
    expect(members.kind).toBe("rows");
    expect(members.key).toBe("members");
    expect(members.editable).toBe(true);
    expect(members.addLabel).toBe("加一个成员");
    expect(members.columns.map((column) => column.key)).toEqual([
      "laneId",
      "agentId",
      "identityLabel",
      "role",
      "stage",
      "reportsTo",
      "mayDirect",
      "dependsOn",
      "handoffTo",
      "modelRef",
      "workspace",
      "writes",
    ]);
    expect(members.columns.find((column) => column.key === "writes")!.type).toBe("boolean");
    expect(members.columns.find((column) => column.key === "reportsTo")!.type).toBe("list");
    expect(members.rows).toEqual([
      { laneId: "lane_code", agentId: "xiaoma", role: "coder", dependsOn: [], modelRef: "cheap/fast" },
      {
        laneId: "lane_verify",
        agentId: "xiaohong",
        role: "verifier",
        dependsOn: ["lane_code"],
        reportsTo: ["xiaobei"],
        mayDirect: [],
      },
    ]);

    // 名称/用途/模式这些以前只能手改 JSON，现在都在面板上。
    expect(body.fields!.map((field) => field.key)).toEqual([
      "sharedGoal",
      "mode",
      "schedule",
      "managerIdentityLabel",
      "memberLimit",
      "maxConcurrentTasks",
      "revision",
      "updatedAt",
    ]);
    expect(body.fields!.find((field) => field.key === "mode")!.readOnly).toBeUndefined();
    expect(body.fields!.find((field) => field.key === "revision")!.readOnly).toBe(true);
    expect(body.actions!.map((action) => action.id)).toEqual(["delete-team"]);
    expect(body.actions![0]!.danger).toBe(true);

    const runs = sectionOf(body, "runs") as { rows: string[][] };
    // 只列同队的运行，按最近活动倒序。
    expect(runs.rows.map((row) => row[0])).toEqual(["demo-team-1", "demo-team-0"]);
    expect(runs.rows[0]![3]).toBe("已结算 1/2");
    // 状态这一格说中文：通知栏写「被宿主重启中断」，面板写 `interrupted` 会像两件事。
    expect(runs.rows.map((row) => row[1])).toEqual(["在跑", "已跑完"]);
  });

  it("says a team does not exist instead of showing an empty page", async () => {
    const { teams } = viewsOf(fakeHost());
    await expect(teams.detail({ ...PROFILE, itemId: "nope" })).rejects.toThrow("队伍不存在: nope");
  });

  it("saves the two editable numbers and carries the revision between them", async () => {
    const host = fakeHost();
    const { teams } = viewsOf(host);
    const body = await teams.save!({ ...PROFILE, itemId: "demo-team", expectedRevision: 3, changes: { memberLimit: 5, maxConcurrentTasks: 2 } });

    // 两个 setter 各自 +1 修订，所以第二次必须用第一次返回的新修订，否则会被自己刚写的那次挡下。
    expect(host.calls).toEqual([
      { kind: "setMemberLimit", args: ["demo-team", { memberLimit: 5, expectedRevision: 3 }] },
      { kind: "setMaxConcurrentTasks", args: ["demo-team", { maxConcurrentTasks: 2, expectedRevision: 4 }] },
    ]);
    // 返回的是重读后的视图，不是提交上去的值。
    expect(body.revision).toBe(3);
  });

  it("refuses unknown keys, empty changes and non-integer numbers", async () => {
    const { teams } = viewsOf(fakeHost());
    await expect(teams.save!({ ...PROFILE, itemId: "demo-team", expectedRevision: 3, changes: { teamId: "other" } })).rejects.toThrow(
      "队伍详情不接受这个改动: teamId",
    );
    await expect(teams.save!({ ...PROFILE, itemId: "demo-team", expectedRevision: 3, changes: {} })).rejects.toThrow("没有要保存的改动");
    await expect(teams.save!({ ...PROFILE, itemId: "demo-team", expectedRevision: 3, changes: { memberLimit: "5" } })).rejects.toThrow(
      '人数上限必须是整数: "5"',
    );
    // 修订栅只认整数：面板回传一个非数字字符串说明它拿的不是这份修订。
    await expect(teams.save!({ ...PROFILE, itemId: "demo-team", expectedRevision: "三", changes: { memberLimit: 5 } })).rejects.toThrow(
      '队伍修订必须是整数: "三"',
    );
  });

  it("refuses to answer when the asked profile is not the one the service uses", async () => {
    const { teams } = viewsOf(fakeHost());
    await expect(teams.list({ home: "E:/isolated", name: "headless" })).rejects.toThrow(/业务视图的档案与军团数据根不一致：请求 headless/);
  });

  it("reports a missing data root as an error, not an empty list", async () => {
    const { teams } = viewsOf(fakeHost({ dataRoot: undefined }));
    await expect(teams.list(PROFILE)).rejects.toThrow("军团没有数据根，业务视图没有可读的队伍与运行");
  });

  it("reports a missing service instead of pretending the list is empty", async () => {
    const { runs } = viewsOf(undefined);
    await expect(runs.list(PROFILE)).rejects.toThrow("军团服务没装上，业务视图不可用");
  });

  it("lists runs newest first with a settled count, never a percentage", async () => {
    const { runs } = viewsOf(fakeHost());
    const items = await runs.list(PROFILE);
    expect(items.map((item) => item.id)).toEqual(["demo-team-1", "demo-team-0"]);
    expect(items[0]!.summary).toBe("在跑 · 已结算 1/2");
    expect(items[0]!.summary).not.toContain("%");
  });

  it("shows the authoritative conclusion, the tasks with their child sessions and the events", async () => {
    const { runs } = viewsOf(fakeHost());
    const body = await runs.detail({ ...PROFILE, itemId: "demo-team-1" });

    const progress = sectionOf(body, "progress") as { lines: string[] };
    expect(progress.lines[0]).toBe("还在跑：已结算 1/2，在跑 1，还没轮到 0");
    expect(progress.lines[1]).toBe("已结算 1/2，在跑 1，还没轮到 0");

    const tasks = sectionOf(body, "tasks") as { rows: string[][] };
    expect(tasks.rows[0]).toEqual([
      "lane_code",
      "xiaoma",
      "已完成",
      "—",
      "1",
      "child-1",
      "2026-09-22T10:00:01.000Z",
      "2026-09-22T10:00:04.000Z",
      '{"summary":"改完了"}',
    ]);
    expect(tasks.rows[1]!.slice(0, 4)).toEqual(["lane_verify", "xiaohong", "在跑", "lane_code"]);

    const events = sectionOf(body, "events") as { lines: string[] };
    expect(events.lines).toEqual(["2026-09-22T10:00:01.000Z lane_started lane_code"]);
    expect(body.actions!.map((action) => action.id)).toEqual(["cancel-lane", "cancel-run"]);
    expect(body.actions!.find((action) => action.id === "cancel-run")!.danger).toBe(true);
  });

  it("lists the lanes that are running or waiting, and marks a running run as live", async () => {
    const { runs } = viewsOf(fakeHost());
    const body = await runs.detail({ ...PROFILE, itemId: "demo-team-1" });

    const progress = sectionOf(body, "progress") as { lines: string[] };
    // 只给「在跑 1」的话，还得去下面的表里找是哪一条。
    expect(progress.lines).toEqual([
      "还在跑：已结算 1/2，在跑 1，还没轮到 0",
      "已结算 1/2，在跑 1，还没轮到 0",
      "在跑：lane_verify（xiaohong），开始 2026-09-22T10:00:04.000Z",
      "最近活动 2026-09-22T10:00:05.000Z",
    ]);
    // 还在跑：面板要自己重读，不然「进度」只是打开那一刻的快照。
    expect(body.live).toBe(true);
  });

  it("names the running lane's child session and what the next one waits for", async () => {
    const host = fakeHost({
      async runProgress() {
        return {
          ...PROGRESS,
          running: [
            { laneId: "lane_verify", agentId: "xiaohong", startedAt: "2026-09-22T10:00:04.000Z", childSessionId: "child-2" },
          ],
          pending: [{ laneId: "lane_docs", blockedBy: "lane_verify" }],
        };
      },
    });
    const { runs } = viewsOf(host);
    const body = await runs.detail({ ...PROFILE, itemId: "demo-team-1" });

    const progress = sectionOf(body, "progress") as { lines: string[] };
    expect(progress.lines).toContain("在跑：lane_verify（xiaohong），开始 2026-09-22T10:00:04.000Z，子会话 child-2");
    expect(progress.lines).toContain("还没轮到：lane_docs，等 lane_verify");
    expect(progress.lines.join("\n")).not.toContain("%");
  });

  it("stops asking the panel to re-read once the run is finished", async () => {
    const host = fakeHost({
      async runRecord() {
        return OLD_RUN;
      },
    });
    const { runs } = viewsOf(host);
    const body = await runs.detail({ ...PROFILE, itemId: "demo-team-1" });
    expect(body.live).toBeUndefined();
  });

  it("gives the child-session cell a link and leaves every other cell plain", async () => {
    const { runs } = viewsOf(fakeHost());
    const body = await runs.detail({ ...PROFILE, itemId: "demo-team-1" });

    const tasks = sectionOf(body, "tasks") as { columns: string[]; sessionLinks?: Record<string, string> };
    const childColumn = tasks.columns.indexOf("子会话");
    expect(childColumn).toBeGreaterThan(0);
    // 只有真跑起来的任务才有会话可跳；没跑起来的那条不给一个点不动的入口。
    expect(tasks.sessionLinks).toEqual({ [`0:${childColumn}`]: "child-1" });
  });

  it("says statuses in Chinese, keeps the raw value in the field help, and passes unknown ones through", async () => {
    const host = fakeHost({
      async runRecord() {
        return {
          ...RUN,
          status: "interrupted",
          tasks: [
            { ...RUN.tasks[0]!, status: "blocked" },
            { ...RUN.tasks[1]!, status: "interrupted" },
            // 磁盘上的状态是外部输入：将来多一个值也不该在面板上变成空白或「未知」。
            { ...RUN.tasks[1]!, laneId: "lane_odd", status: "做梦" as unknown as RunRecord["status"] },
          ],
        };
      },
    });
    const { runs } = viewsOf(host);
    const body = await runs.detail({ ...PROFILE, itemId: "demo-team-1" });

    const status = body.fields!.find((field) => field.key === "status")!;
    expect(status.value).toBe("被宿主重启中断");
    // 原始值不能丢：界面说中文，磁盘上那份仍然写着 interrupted。
    expect(status.help).toContain("interrupted");
    expect(status.readOnly).toBe(true);

    const tasks = sectionOf(body, "tasks") as { rows: string[][] };
    expect(tasks.rows.map((row) => row[2])).toEqual(["被上游堵住", "被宿主重启中断", "做梦"]);
  });

  it("truncates a long output instead of dumping it into the panel", async () => {
    const long = { text: "x".repeat(400) };
    const host = fakeHost({
      async runRecord() {
        return { ...RUN, tasks: [{ ...RUN.tasks[0]!, output: long, error: undefined }] };
      },
    });
    const { runs } = viewsOf(host);
    const body = await runs.detail({ ...PROFILE, itemId: "demo-team-1" });
    const tasks = sectionOf(body, "tasks") as { rows: string[][] };
    expect(tasks.rows[0]![8]).toContain("…（共 411 字符）");
  });

  it("cancels one lane or the whole run, and refreshes the view afterwards", async () => {
    const host = fakeHost();
    const { runs } = viewsOf(host);

    const afterLane = await runs.act!({ ...PROFILE, itemId: "demo-team-1", actionId: "cancel-lane", args: { laneId: "lane_verify", reason: "改需求了" } });
    expect(host.calls).toEqual([{ kind: "cancelLane", args: ["demo-team-1", "lane_verify", "改需求了"] }]);
    expect(afterLane.title).toBe("运行 demo-team-1");

    await runs.act!({ ...PROFILE, itemId: "demo-team-1", actionId: "cancel-run", args: {} });
    expect(host.calls[1]).toEqual({ kind: "cancelRun", args: ["demo-team-1", undefined] });
  });

  it("refuses an unknown action and a cancel without a lane", async () => {
    const { runs } = viewsOf(fakeHost());
    await expect(runs.act!({ ...PROFILE, itemId: "demo-team-1", actionId: "restart", args: {} })).rejects.toThrow("运行详情不认识这个动作: restart");
    await expect(runs.act!({ ...PROFILE, itemId: "demo-team-1", actionId: "cancel-lane", args: {} })).rejects.toThrow("任务 lane是必填");
  });

  it("saves an edited roster as one document, keeping the fields the panel did not touch", async () => {
    const host = fakeHost();
    const { teams } = viewsOf(host);
    const members = [
      { laneId: "lane_code", agentId: "xiaoma", role: "coder", reportsTo: [], writes: true },
      { laneId: "lane_plan", agentId: "xiaobei", role: "commander", mayDirect: ["lane_code"] },
    ];
    await teams.save!({
      ...PROFILE,
      itemId: "demo-team",
      expectedRevision: 3,
      changes: { members, sharedGoal: "改成先探路再动手", mode: "research_grid" },
    });

    const saved = host.calls.find((call) => call.kind === "saveTeam")!;
    const document = saved.args[0] as TeamDocument;
    expect(saved.args[1]).toEqual({ expectedRevision: 3 });
    expect(document.members).toEqual(members);
    expect(document.sharedGoal).toBe("改成先探路再动手");
    expect(document.mode).toBe("research_grid");
    // 面板没带上的字段必须原样留着，不能被一次保存抹掉。
    expect(document.managerAgentId).toBe("xiaobei");
    expect(document.managerIdentityLabel).toBe("小贝");
    expect(document.memberLimit).toBe(8);
    expect(document.maxConcurrentTasks).toBe(4);
    expect(document.schedule).toBe("parallel");
  });

  it("clears an optional text field when the panel sends an empty string", async () => {
    const host = fakeHost();
    const { teams } = viewsOf(host);
    await teams.save!({
      ...PROFILE,
      itemId: "demo-team",
      expectedRevision: 3,
      changes: { sharedGoal: "  ", managerIdentityLabel: "" },
    });
    const document = host.calls.find((call) => call.kind === "saveTeam")!.args[0] as TeamDocument;
    // 空串是「清掉」，不是「设成空字符串」：键要从文档里消失。
    expect("sharedGoal" in document).toBe(false);
    expect("managerIdentityLabel" in document).toBe(false);
  });

  it("carries the new revision from the roster save into the two limit setters", async () => {
    const host = fakeHost();
    const { teams } = viewsOf(host);
    await teams.save!({
      ...PROFILE,
      itemId: "demo-team",
      expectedRevision: 3,
      changes: { members: [{ laneId: "lane_code" }], memberLimit: 5 },
    });
    // 假仓库的 saveTeam 把修订 +1，所以 setter 必须收到 4——用旧修订会被自己刚写的那次挡下。
    expect(host.calls.map((call) => call.kind)).toEqual(["saveTeam", "setMemberLimit"]);
    expect(host.calls[1]!.args[1]).toEqual({ memberLimit: 5, expectedRevision: 4 });
  });

  it("refuses a broken roster with the row number, before anything is written", async () => {
    const { teams } = viewsOf(fakeHost());
    const save = (changes: Record<string, unknown>) =>
      teams.save!({ ...PROFILE, itemId: "demo-team", expectedRevision: 3, changes });
    await expect(save({ members: "lane_code" })).rejects.toThrow("成员名单必须是数组");
    await expect(save({ members: [{ laneId: "lane_code", nope: 1 }] })).rejects.toThrow("成员名单第 1 行有不认识的字段: nope");
    await expect(save({ members: [{ laneId: "lane_code" }, { agentId: "xiaoma" }] })).rejects.toThrow(
      "成员名单第 2 行缺少成员 id（lane）",
    );
    await expect(save({ mode: "whatever" })).rejects.toThrow("队伍模式不认识: whatever（只认 parallel_subtasks");
    await expect(save({ schedule: "whenever" })).rejects.toThrow("队伍调度不认识: whenever（只认 parallel / sequential / staged）");
  });

  it("creates a team from the list action instead of asking for hand-written JSON", async () => {
    const host = fakeHost();
    const { teams } = viewsOf(host);
    expect(teams.viewActions!.map((action) => action.id)).toEqual(["new-team"]);
    expect(teams.viewActions![0]!.args!.map((field) => field.key)).toEqual([
      "teamId",
      "laneId",
      "agentId",
      "mode",
      "schedule",
      "sharedGoal",
    ]);

    await teams.actView!({
      ...PROFILE,
      actionId: "new-team",
      args: { teamId: "night-shift", laneId: "lane_code", agentId: "xiaoma", mode: "verify_swarm", schedule: "staged" },
    });

    const saved = host.calls.find((call) => call.kind === "saveTeam")!;
    const document = saved.args[0] as TeamDocument;
    expect(saved.args[1]).toEqual({ expectedRevision: 0 });
    expect(document.id).toBe("night-shift");
    expect(document.mode).toBe("verify_swarm");
    expect(document.schedule).toBe("staged");
    expect(document.members).toEqual([{ laneId: "lane_code", agentId: "xiaoma" }]);
    expect(document.memberLimit).toBe(8);
    expect(document.maxConcurrentTasks).toBe(4);
    expect(document.sharedGoal).toBeUndefined();
  });

  it("refuses to create a team on a taken id, an unknown action or a missing lane", async () => {
    const { teams } = viewsOf(fakeHost());
    const create = (args: Record<string, unknown>) => teams.actView!({ ...PROFILE, actionId: "new-team", args });
    await expect(create({ teamId: "demo-team", laneId: "lane_code", mode: "verify_swarm" })).rejects.toThrow(
      "队伍 id 已经被占用: demo-team",
    );
    await expect(create({ teamId: "night-shift", mode: "verify_swarm" })).rejects.toThrow("第一个成员的 lane是必填");
    await expect(teams.actView!({ ...PROFILE, actionId: "clone-team", args: {} })).rejects.toThrow("队伍列表不认识这个动作: clone-team");
  });

  it("deletes a team only when the typed id matches, with the revision as the gate", async () => {
    const host = fakeHost();
    const { teams } = viewsOf(host);
    const remove = (args: Record<string, unknown>, expectedRevision?: number | string) =>
      teams.act!({ ...PROFILE, itemId: "demo-team", actionId: "delete-team", args, ...(expectedRevision === undefined ? {} : { expectedRevision }) });

    await expect(remove({ confirmTeamId: "other-team" }, 3)).rejects.toThrow("确认的队伍 id 和要删的不是同一支: other-team ≠ demo-team");
    await expect(remove({}, 3)).rejects.toThrow("确认用的队伍 id是必填");
    await expect(remove({ confirmTeamId: "demo-team" }, "三")).rejects.toThrow('队伍修订必须是整数: "三"');
    expect(host.calls).toEqual([]);

    const body = await remove({ confirmTeamId: "demo-team" }, 3);
    expect(host.calls).toEqual([{ kind: "removeTeam", args: ["demo-team", { expectedRevision: 3 }] }]);
    expect(body.title).toBe("已删除 demo-team");
    expect(body.sections).toEqual([]);
  });

  it("checks the profile on every operation, not only on the list", async () => {
    const { teams, runs } = viewsOf(fakeHost());
    const other = { home: "E:/isolated", name: "headless" };
    const mismatch = /业务视图的档案与军团数据根不一致：请求 headless/;
    // 只查列表的话，直接按 id 打详情、保存、动作都能绕过核对。
    await expect(teams.detail({ ...other, itemId: "demo-team" })).rejects.toThrow(mismatch);
    await expect(teams.save!({ ...other, itemId: "demo-team", expectedRevision: 3, changes: { memberLimit: 5 } })).rejects.toThrow(mismatch);
    await expect(teams.act!({ ...other, itemId: "demo-team", actionId: "delete-team", args: { confirmTeamId: "demo-team" } })).rejects.toThrow(mismatch);
    await expect(teams.actView!({ ...other, actionId: "new-team", args: {} })).rejects.toThrow(mismatch);
    await expect(runs.detail({ ...other, itemId: "demo-team-1" })).rejects.toThrow(mismatch);
    await expect(runs.act!({ ...other, itemId: "demo-team-1", actionId: "cancel-run", args: {} })).rejects.toThrow(mismatch);
  });

  it("registers both views into the suite and takes them back on dispose", () => {
    const registered: string[] = [];
    const suite = {
      registerDetail(source: { id: string }) {
        registered.push(source.id);
        return () => {
          registered.splice(registered.indexOf(source.id), 1);
        };
      },
    };
    const team = fakeHost();
    const disposers: Array<() => void> = [];
    const fakeCtx = {
      inject: (_deps: string[], callback: (ctx: unknown) => void) =>
        callback({
          get: (name: string) => (name === "voidSuite" ? suite : team),
          effect: (factory: () => () => void) => {
            disposers.push(factory());
          },
        }),
    };

    apply(fakeCtx as never);
    expect(registered).toEqual([TEAM_VIEW_ID, RUN_VIEW_ID]);
    for (const dispose of disposers) dispose();
    expect(registered).toEqual([]);
  });
});

describe("停用的成员（A17：派活之前就在面板上看得出来）", () => {
  const CLOSING =
    "停用只改那份档案 state.json 里的一个布尔值，名单一个字节都不动：要临时换人就改上面的名单，想让它回来就去灵魂档案面板启用。";

  it("停用的人在列表上带标记，详情里单开一节点名 lane 与理由", async () => {
    writeSuspension("小马", true);
    try {
      const { teams } = viewsOf(fakeHost());
      const list = await teams.list(PROFILE);
      expect(list.map((item) => item.summary)).toEqual([
        "plan_execute_verify · 并行 · 0/8 人",
        "plan_execute_verify · 并行 · 2/8 人 · 1 个成员已停用",
      ]);

      const body = await teams.detail({ ...PROFILE, itemId: "demo-team" });
      // 插在名单与运行之间：先看名单，再看谁派不出去，最后看跑过什么。
      expect(body.sections.map((section) => section.id)).toEqual(["org", "members", "suspensions", "runs"]);
      const section = sectionOf(body, "suspensions") as { title: string; kind: string; lines: string[] };
      expect(section.title).toBe("停用的成员");
      expect(section.kind).toBe("lines");
      expect(section.lines).toEqual([
        "已停用：lane_code 的 xiaoma —— 派活会被拒（在灵魂档案面板上「启用这份档案」就恢复，记忆与聊天记录一个字节都没动）",
        CLOSING,
      ]);
    } finally {
      clearSuspension("小马");
    }
  });

  it("状态位读不动就如实报，不当成「没停用」，列表上也不乱标", async () => {
    writeSuspension("小马", "broken");
    try {
      const { teams } = viewsOf(fakeHost());
      const list = await teams.list(PROFILE);
      expect(list.find((item) => item.id === "demo-team")!.summary).toBe("plan_execute_verify · 并行 · 2/8 人");

      const body = await teams.detail({ ...PROFILE, itemId: "demo-team" });
      const section = sectionOf(body, "suspensions") as { lines: string[] };
      expect(section.lines).toEqual([
        "小马（xiaoma）：读不出停用状态（停用状态损坏）——这一处不算「没停用」。",
        CLOSING,
      ]);
    } finally {
      clearSuspension("小马");
    }
  });

  it("名单里的人不在登记表里也报出来：派活时才发现就晚了", async () => {
    const ghost: TeamDocument = {
      ...TEAM,
      members: [{ laneId: "lane_front", agentId: "ghost", role: "coder", dependsOn: [] }],
    };
    const host = fakeHost({
      async loadTeam(teamId) {
        return teamId === TEAM.id ? ghost : undefined;
      },
    });
    const { teams } = viewsOf(host);
    const body = await teams.detail({ ...PROFILE, itemId: "demo-team" });
    const section = sectionOf(body, "suspensions") as { lines: string[] };
    expect(section.lines[0]).toBe("读不出停用状态：lane_front 的 ghost（登记表里没有这份档案）——这一处不算「没停用」。");
  });

  it("整张登记表读不动：照样出这一节，把「读不出来」摆出来", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "void-legion-broken-"));
    const root = resolveVoidDataRoot({ dshHome: home, profile: "broken" });
    mkdirSync(root, { recursive: true });
    // agents 是个文件：读登记表当场就炸，绝不能让面板显示成「没人停用」。
    writeFileSync(path.join(root, "agents"), "not a directory", "utf8");
    try {
      const { teams } = viewsOf(fakeHost({ dataRoot: root }));
      const body = await teams.detail({ home, name: "broken", itemId: "demo-team" });
      const section = sectionOf(body, "suspensions") as { lines: string[] };
      expect(section.lines).toHaveLength(4);
      expect(section.lines[0]).toContain("lane_code 的 xiaoma（登记表里没有这份档案）");
      expect(section.lines[1]).toContain("lane_verify 的 xiaohong（登记表里没有这份档案）");
      expect(section.lines[2]).toMatch(/^档案登记表读不动：/);
      expect(section.lines[2]).toContain("这一处不算「没停用」。");
      expect(section.lines[3]).toBe(CLOSING);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("没人停用也没有读不动的，这一节根本不出现", async () => {
    const { teams } = viewsOf(fakeHost());
    const body = await teams.detail({ ...PROFILE, itemId: "demo-team" });
    expect(body.sections.map((section) => section.id)).toEqual(["org", "members", "runs"]);
    // 空名单的队伍也一样：没话就不占地方。
    const empty = viewsOf(fakeHost({
      async loadTeam(teamId) {
        return teamId === OTHER_TEAM.id ? OTHER_TEAM : undefined;
      },
    })).teams;
    const emptyBody = await empty.detail({ ...PROFILE, itemId: OTHER_TEAM.id });
    expect(emptyBody.sections.map((section) => section.id)).toEqual(["org", "members", "runs"]);
  });
});
