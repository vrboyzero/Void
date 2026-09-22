import { describe, expect, it } from "vitest";
import { laneOrder, LegionPlanError, orderLanes, validateTeamPlan } from "../src/plan-validator.js";
import type { DelegationTeamMember } from "../src/team.js";

const plan = (members: readonly DelegationTeamMember[], memberLimit = 8, schedule: "parallel" | "sequential" | "staged" = "parallel") =>
  validateTeamPlan({ members, memberLimit, schedule });

describe("legion plan validator", () => {
  it("orders lanes by dependsOn and returns a stable order for independent lanes", () => {
    expect(
      orderLanes([
        { laneId: "lane_verify", dependsOn: ["lane_code"] },
        { laneId: "lane_plan" },
        { laneId: "lane_code", dependsOn: ["lane_plan"] },
      ]),
    ).toEqual(["lane_plan", "lane_code", "lane_verify"]);
    expect(orderLanes([{ laneId: "lane_a" }, { laneId: "lane_b" }])).toEqual(["lane_a", "lane_b"]);
  });

  // §19.1 定级「高，fix_now」：旧实现遇到未知依赖直接 continue，任务静默漏跑。
  it("rejects an unknown dependency instead of silently dropping the edge", () => {
    expect(() => plan([{ laneId: "lane_a" }, { laneId: "lane_b", dependsOn: ["lane_missing"] }])).toThrow(
      /成员 lane_b 的依赖不在名单里: lane_missing/,
    );
    // 宽松模式保留旧行为，但它不在派活路径上。
    expect(laneOrder([{ laneId: "lane_a" }, { laneId: "lane_b", dependsOn: ["lane_missing"] }], { strict: false })).toEqual([
      "lane_a",
      "lane_b",
    ]);
  });

  it("rejects dependency cycles and names the cycle", () => {
    expect(() => plan([{ laneId: "lane_a", dependsOn: ["lane_b"] }, { laneId: "lane_b", dependsOn: ["lane_a"] }])).toThrow(
      /成员依赖成环: lane_a → lane_b → lane_a/,
    );
    expect(() => plan([{ laneId: "lane_a", dependsOn: ["lane_a"] }])).toThrow(/依赖指向自己/);
  });

  it("rejects unknown members in the authority edges too", () => {
    expect(() => plan([{ laneId: "lane_a", reportsTo: ["lane_ghost"] }])).toThrow(/成员 lane_a 的汇报对象不在名单里: lane_ghost/);
    expect(() => plan([{ laneId: "lane_a", mayDirect: ["lane_ghost"] }])).toThrow(/成员 lane_a 的指挥许可不在名单里: lane_ghost/);
    expect(() => plan([{ laneId: "lane_a", handoffTo: ["lane_ghost"] }])).toThrow(/成员 lane_a 的交接对象不在名单里: lane_ghost/);
    expect(() => plan([{ laneId: "lane_a", reportsTo: ["lane_a"] }])).toThrow(/汇报对象指向自己/);
  });

  it("rejects duplicate lane ids, empty rosters and over-limit rosters", () => {
    expect(() => plan([])).toThrow(/队伍没有成员，拒绝派活/);
    expect(() => plan([{ laneId: "lane_a" }, { laneId: "lane_a" }])).toThrow(/成员 lane id 重复: lane_a/);
    expect(() => plan([{ laneId: "lane_a", agentId: "x" }, { laneId: "lane_b", agentId: "y" }, { laneId: "lane_c", agentId: "z" }], 2)).toThrow(
      /队伍人数超出上限: 3 > 2/,
    );
    // 同一个档案占两个 lane 只算一个人：上限 2 时 2 个档案 + 1 条重复 lane 仍然放行。
    expect(
      plan([{ laneId: "lane_a", agentId: "x" }, { laneId: "lane_b", agentId: "x" }, { laneId: "lane_c", agentId: "y" }], 2),
    ).toHaveLength(3);
  });

  it("enforces the staged schedule's stage numbers in both directions", () => {
    expect(() => plan([{ laneId: "lane_a" }], 8, "staged")).toThrow(/分阶段调度要求每个成员写明阶段号，成员 lane_a 没写/);
    expect(plan([{ laneId: "lane_a", stage: 1 }], 8, "staged")).toHaveLength(1);
    // 写了阶段号但不是分阶段调度 → 拒绝，不留「写了但不生效」的字段。
    expect(() => plan([{ laneId: "lane_a", stage: 1 }], 8, "parallel")).toThrow(/阶段号不会生效/);
  });

  it("reports the first concrete problem rather than a generic failure", () => {
    const error = (() => {
      try {
        plan([{ laneId: "lane_a", dependsOn: ["lane_ghost"] }]);
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(LegionPlanError);
    expect((error as Error).name).toBe("LegionPlanError");
  });
});
