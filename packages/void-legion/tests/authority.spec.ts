import { describe, expect, it } from "vitest";
import type { AuthorityProfile } from "@void/void-soul";
import { assertTeamDispatch, findMemberByAgent, LegionAuthorityError, renderOrgChart, teamPermits } from "../src/authority.js";
import type { DelegationTeamMember } from "../src/team.js";

// 身份图：小贝是小马、小叁的上级；小肆是小叁的上级；outsider 与谁都没关系。
const boss: AuthorityProfile = { id: "xiaobei", superiors: [], subordinates: ["xiaoma", "xiaosan"] };
const under: AuthorityProfile = { id: "xiaoma", superiors: ["xiaobei"], subordinates: [] };
const third: AuthorityProfile = { id: "xiaosan", superiors: ["xiaobei", "xiaosi"], subordinates: [] };
const side: AuthorityProfile = { id: "xiaosi", superiors: [], subordinates: ["xiaosan"] };
const outsider: AuthorityProfile = { id: "outsider", superiors: [], subordinates: [] };
const profiles = new Map<string, AuthorityProfile>(
  [boss, under, third, side, outsider].map((profile) => [profile.id, profile]),
);

const roster: DelegationTeamMember[] = [
  { laneId: "lane_lead", agentId: "xiaobei", identityLabel: "小贝", reportsTo: [], mayDirect: ["lane_code"] },
  { laneId: "lane_code", agentId: "xiaoma", identityLabel: "小马", reportsTo: ["lane_lead"], mayDirect: ["lane_lead"] },
  { laneId: "lane_guest", agentId: "outsider", identityLabel: "外援", mayDirect: ["lane_lead"] },
  { laneId: "lane_helper", agentId: "xiaosan", identityLabel: "小叁" },
  { laneId: "lane_side", agentId: "xiaosi", identityLabel: "小肆" },
  { laneId: "lane_unbound" },
];

const snapshot = { members: roster, managerAgentId: "xiaobei" };

describe("legion team authority", () => {
  it("permits dispatch only through the explicit mayDirect edge", () => {
    expect(teamPermits(snapshot, "xiaobei", "lane_code")).toBe(true);
    // reportsTo 是汇报边，不是派活许可边：小马向小贝汇报，不等于他能指挥小叁。
    expect(teamPermits(snapshot, "xiaoma", "lane_helper")).toBe(false);
    expect(teamPermits(snapshot, "xiaosi", "lane_helper")).toBe(false);
    expect(teamPermits(snapshot, "outsider", "lane_code")).toBe(false);
    // 显式写了就放行（哪怕身份上是下级，队伍许可本身是允许的）。
    expect(teamPermits(snapshot, "xiaoma", "lane_lead")).toBe(true);
  });

  it("lets the manager direct the team without an explicit edge", () => {
    expect(teamPermits({ members: roster, managerAgentId: "xiaobei" }, "xiaobei", "lane_unbound")).toBe(true);
    expect(teamPermits(snapshot, "not-a-member", "lane_code")).toBe(false);
  });

  it("passes when both identity and team permit", () => {
    expect(() => assertTeamDispatch({ snapshot, actor: boss, profiles, targetLaneIds: ["lane_code"] })).not.toThrow();
  });

  // P4 退出条件第三条：身份禁止胜过队伍许可。
  it("lets an identity prohibition beat a team permission", () => {
    // 队伍里小马有 mayDirect: lane_lead，但身份上他是下级，不能指挥上级。
    expect(() => assertTeamDispatch({ snapshot, actor: under, profiles, targetLaneIds: ["lane_lead"] })).toThrow(
      /xiaoma 不能指挥 xiaobei/,
    );
    // 未声明关系的陌生主体：默认拒绝，队伍许可再宽也不放行。
    expect(() => assertTeamDispatch({ snapshot, actor: outsider, profiles, targetLaneIds: ["lane_lead"] })).toThrow(
      /outsider 不能指挥 xiaobei/,
    );
  });

  it("rejects a team permission that the identity graph does not grant", () => {
    // 身份上小肆确实是小叁的上级，但队伍没写这条指挥边 → 交集为空，拒绝。
    expect(() => assertTeamDispatch({ snapshot, actor: side, profiles, targetLaneIds: ["lane_helper"] })).toThrow(
      /队伍没有授权 xiaosi 指挥 lane_helper/,
    );
  });

  it("reports why a target could not be dispatched", () => {
    expect(() => assertTeamDispatch({ snapshot, actor: boss, profiles, targetLaneIds: ["lane_ghost"] })).toThrow(
      /派活目标不在本次名单里: lane_ghost/,
    );
    expect(() => assertTeamDispatch({ snapshot, actor: boss, profiles, targetLaneIds: ["lane_unbound"] })).toThrow(
      /派活目标缺少档案 id: lane_unbound/,
    );
    const strangers = { members: [{ laneId: "lane_code", agentId: "nobody" }], managerAgentId: "nobody" };
    expect(() => assertTeamDispatch({ snapshot: strangers, actor: boss, profiles, targetLaneIds: ["lane_code"] })).toThrow(
      /派活目标没有权威档案: nobody/,
    );
  });

  it("checks every target and never partially dispatches", () => {
    expect(() => assertTeamDispatch({ snapshot, actor: boss, profiles, targetLaneIds: ["lane_code", "lane_ghost"] })).toThrow(
      LegionAuthorityError,
    );
  });

  it("finds a member by agent id", () => {
    expect(findMemberByAgent(snapshot, "xiaoma")?.laneId).toBe("lane_code");
    expect(findMemberByAgent(snapshot, "nobody")).toBeUndefined();
  });

  // L12 组织图：汇报边和指挥边分开画，图上不能合并成一条。
  it("renders the org chart with report and command edges kept apart", () => {
    const lines = renderOrgChart({
      id: "legion-demo",
      mode: "plan_execute_verify",
      schedule: "parallel",
      memberLimit: 8,
      managerAgentId: "xiaobei",
      members: roster,
    });
    expect(lines[0]).toBe("队伍 legion-demo（plan_execute_verify · parallel，人数上限 8，当前 6 人）");
    expect(lines[1]).toBe("指挥: xiaobei（lane lane_lead）");
    expect(lines).toContain("- lane_code · 小马 / xiaoma");
    expect(lines).toContain("  汇报: lane_lead");
    expect(lines).toContain("  可指挥: lane_lead");
    expect(lines).toContain("  依赖: 无");
    // 没指定指挥者时也要说清楚，而不是留空。
    expect(renderOrgChart({ id: "legion-x", mode: "parallel_subtasks", schedule: "parallel", memberLimit: 8, members: [] })[1]).toBe(
      "指挥: 未指定",
    );
  });
});
