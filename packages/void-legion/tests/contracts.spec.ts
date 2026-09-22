import { describe, expect, it } from "vitest";
import {
  assertLaneId,
  assertMemberLimit,
  assertTeamId,
  countTeamMembers,
  createTeamDocument,
  DEFAULT_MEMBER_LIMIT,
  LEGION_SCHEMA_VERSION,
  LegionRosterError,
  LegionSchemaError,
  parseTeamDocument,
  serializeTeamDocument,
  teamDocumentOf,
  teamMetadataOf,
} from "../src/contracts.js";
import type { DelegationTeamMember } from "../src/team.js";

const roster: DelegationTeamMember[] = [
  { laneId: "lane_plan", agentId: "xiaobei", role: "researcher", mayDirect: ["lane_code"] },
  { laneId: "lane_code", agentId: "xiaoma", role: "coder", dependsOn: ["lane_plan"] },
];

describe("legion contracts", () => {
  it("round-trips a team document through serialize/parse", () => {
    const document = createTeamDocument({
      id: "legion-demo",
      mode: "plan_execute_verify",
      members: roster,
      sharedGoal: "prove the seam",
      managerAgentId: "xiaobei",
      now: new Date("2026-09-22T00:00:00.000Z"),
    });
    expect(document.schemaVersion).toBe(LEGION_SCHEMA_VERSION);
    expect(document.schedule).toBe("parallel");
    expect(document.memberLimit).toBe(DEFAULT_MEMBER_LIMIT);

    const parsed = parseTeamDocument(serializeTeamDocument(document));
    expect(parsed).toEqual(document);
    // 名字是业务词汇，不该被当成执行语义：mode 是 plan_execute_verify，调度仍是 parallel。
    expect(parsed.mode).toBe("plan_execute_verify");
    expect(parsed.schedule).toBe("parallel");
  });

  // §17.2：不支持的版本要明确报错，不猜、不按默认值补齐后放行。
  it("refuses an unsupported schemaVersion instead of guessing", () => {
    const text = JSON.stringify({ schemaVersion: 2, id: "legion-demo" });
    expect(() => parseTeamDocument(text)).toThrow(LegionSchemaError);
    expect(() => parseTeamDocument(text)).toThrow(/不支持的队伍配置版本: 2（本版本只认 1）/);
    expect(() => parseTeamDocument("{}")).toThrow(/缺少 schemaVersion/);
    expect(() => parseTeamDocument("not json")).toThrow(/不是合法 JSON/);
  });

  it("rejects a document whose members are malformed", () => {
    const base = { schemaVersion: 1, id: "legion-demo", mode: "parallel_subtasks", memberLimit: 8, revision: 0, updatedAt: "2026-09-22T00:00:00.000Z" };
    expect(() => parseTeamDocument(JSON.stringify({ ...base, members: [{ laneId: "lane_a", role: "wizard" }] }))).toThrow(/role 不认识: wizard/);
    expect(() => parseTeamDocument(JSON.stringify({ ...base, members: [{ laneId: "lane_a", dependsOn: [7] }] }))).toThrow(/必须是非空字符串数组/);
    expect(() => parseTeamDocument(JSON.stringify({ ...base, members: [{ laneId: "lane_a", stage: 0 }] }))).toThrow(/stage 必须从 1 开始/);
    expect(() => parseTeamDocument(JSON.stringify({ ...base, mode: "nope", members: [] }))).toThrow(/不认识的队伍模式: nope/);
  });

  it("validates ids and member limits with actionable messages", () => {
    expect(() => assertTeamId("..")).toThrow(LegionRosterError);
    expect(() => assertTeamId("ab")).toThrow(/3–64 位/);
    expect(() => assertTeamId("legion-demo")).not.toThrow();
    // lane id 沿用 Star 的下划线风格。
    expect(() => assertLaneId("lane_plan")).not.toThrow();
    expect(() => assertLaneId("lane/plan")).toThrow(/lane id 不合法/);
    expect(() => assertMemberLimit(0)).toThrow(/人数上限不合法: 0/);
    expect(() => assertMemberLimit(65)).toThrow(/人数上限不合法: 65/);
    expect(() => assertMemberLimit(1.5)).toThrow(/人数上限不合法/);
  });

  // §15.2：计数包含指挥者与临时成员，按 agentId 去重。
  it("counts members by distinct agentId, not by lane", () => {
    expect(countTeamMembers(roster)).toBe(2);
    // 同一档案占两个 lane 只算一个人，否则上限会被 lane 数量虚增。
    expect(countTeamMembers([...roster, { laneId: "lane_review", agentId: "xiaobei" }])).toBe(2);
    // 没写 agentId 的成员各算一个。
    expect(countTeamMembers([{ laneId: "lane_x" }, { laneId: "lane_y" }])).toBe(2);
  });

  it("carries schedule and memberLimit between document and runtime metadata", () => {
    const document = createTeamDocument({ id: "legion-demo", mode: "research_grid", members: roster, schedule: "staged", memberLimit: 4 });
    const metadata = teamMetadataOf(document);
    expect(metadata.schedule).toBe("staged");
    expect(metadata.memberLimit).toBe(4);
    // 回程也要带上，否则保存一次就把调度和上限丢了。
    const back = teamDocumentOf(metadata, { revision: 7 });
    expect(back.schedule).toBe("staged");
    expect(back.memberLimit).toBe(4);
    expect(back.revision).toBe(7);
    expect(back.members).toEqual(roster);
  });
});
