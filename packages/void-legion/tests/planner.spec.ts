import { describe, expect, it } from "vitest";
import { LegionPlanError } from "../src/plan-validator.js";
import {
  parseTaskPlan,
  parseTaskPlanValue,
  renderPlanInstruction,
  renderPlanSummary,
  TaskPlanError,
  taskPlanFromRoster,
  taskPlanToRoster,
  validateTaskPlan,
  type TaskPlan,
} from "../src/planner.js";
import type { DelegationTeamMember } from "../src/team.js";

function plan(tasks: TaskPlan["tasks"], goal = "把登录页做出来"): TaskPlan {
  return { goal, tasks };
}

describe("解析任务计划", () => {
  it("读一份完整的自动计划", () => {
    const parsed = parseTaskPlan(
      JSON.stringify({
        goal: "把登录页做出来",
        tasks: [
          { laneId: "lane_plan", agentId: "xiaobei", title: "出方案", brief: "只出方案不写码", stage: 1, modelRef: "fast", writes: false },
          { laneId: "lane_code", agentId: "xiaoma", title: "写实现", dependsOn: ["lane_plan"], stage: 2, workspace: "wt-1" },
        ],
      }),
    );
    expect(parsed.goal).toBe("把登录页做出来");
    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.tasks[0]).toMatchObject({ laneId: "lane_plan", title: "出方案", stage: 1, modelRef: "fast", writes: false });
    expect(parsed.tasks[1]!.dependsOn).toEqual(["lane_plan"]);
  });

  it("不是 JSON / 不是对象都报清楚", () => {
    expect(() => parseTaskPlan("{", "模型输出")).toThrow(/任务计划不是合法 JSON: 模型输出/);
    expect(() => parseTaskPlanValue([], "模型输出")).toThrow(/任务计划必须是对象: 模型输出/);
  });

  it("缺 goal / 空 tasks 都拒绝", () => {
    expect(() => parseTaskPlanValue({ tasks: [{ laneId: "lane_a", title: "干活" }] })).toThrow(/goal 必须是非空字符串/);
    expect(() => parseTaskPlanValue({ goal: "目标", tasks: [] })).toThrow(/没有 tasks，拒绝派活/);
    expect(() => parseTaskPlanValue({ goal: "目标" })).toThrow(/没有 tasks，拒绝派活/);
  });

  it("缺 title 拒绝：没有标题的任务没法验收", () => {
    expect(() => parseTaskPlanValue({ goal: "目标", tasks: [{ laneId: "lane_a" }] })).toThrow(/title 必须是非空字符串/);
    expect(() => parseTaskPlanValue({ goal: "目标", tasks: [{ laneId: "lane_a", title: "  " }] })).toThrow(/title/);
  });

  it("laneId 形状不对拒绝，并指出是第几个", () => {
    expect(() => parseTaskPlanValue({ goal: "目标", tasks: [{ laneId: "Lane A", title: "干活" }] })).toThrow(/lane id 不合法/);
  });

  it("字段类型不对逐项报，不用默认值补齐", () => {
    const base = { goal: "目标", tasks: [{ laneId: "lane_a", title: "干活" }] };
    expect(() => parseTaskPlanValue({ ...base, tasks: [{ laneId: "lane_a", title: "干活", stage: 0 }] })).toThrow(/stage 必须是从 1 开始的整数/);
    expect(() => parseTaskPlanValue({ ...base, tasks: [{ laneId: "lane_a", title: "干活", stage: "1" }] })).toThrow(/stage/);
    expect(() => parseTaskPlanValue({ ...base, tasks: [{ laneId: "lane_a", title: "干活", writes: "no" }] })).toThrow(/writes 必须是布尔值/);
    expect(() => parseTaskPlanValue({ ...base, tasks: [{ laneId: "lane_a", title: "干活", dependsOn: "lane_b" }] })).toThrow(/dependsOn 必须是非空字符串数组/);
    expect(() => parseTaskPlanValue({ ...base, tasks: [{ laneId: "lane_a", title: "干活", dependsOn: [""] }] })).toThrow(/dependsOn/);
    expect(() => parseTaskPlanValue({ ...base, tasks: [{ laneId: "lane_a", title: "干活", modelRef: 7 }] })).toThrow(/modelRef 必须是字符串/);
  });
});

describe("手动计划来自名单", () => {
  it("把队伍配置读成计划，字段不丢", () => {
    const roster: DelegationTeamMember[] = [
      { laneId: "lane_plan", agentId: "xiaobei", scopeSummary: "出方案", stage: 1, writes: false },
      { laneId: "lane_code", agentId: "xiaoma", dependsOn: ["lane_plan"], stage: 2, modelRef: "strong", workspace: "wt-1" },
    ];
    const derived = taskPlanFromRoster(roster, "把登录页做出来");
    expect(derived.goal).toBe("把登录页做出来");
    expect(derived.tasks[0]).toMatchObject({ laneId: "lane_plan", title: "出方案", agentId: "xiaobei", writes: false });
    expect(derived.tasks[1]).toMatchObject({ laneId: "lane_code", modelRef: "strong", workspace: "wt-1" });
    // 读成计划再写回名单，还是同一份东西。
    const back = taskPlanToRoster(derived);
    expect(back.map((member) => member.laneId)).toEqual(roster.map((member) => member.laneId));
    expect(back[1]!.dependsOn).toEqual(["lane_plan"]);
    expect(back[1]!.modelRef).toBe("strong");
  });

  it("没写 scopeSummary 时退回身份标签或 lane id", () => {
    const derived = taskPlanFromRoster([{ laneId: "lane_a", identityLabel: "小贝" }, { laneId: "lane_b" }], "目标");
    expect(derived.tasks.map((task) => task.title)).toEqual(["小贝", "lane_b"]);
  });

  it("title 与 brief 折进 scopeSummary", () => {
    const roster = taskPlanToRoster(plan([{ laneId: "lane_a", title: "写实现", brief: "只改 src" }]));
    expect(roster[0]!.scopeSummary).toBe("写实现——只改 src");
  });
});

describe("验证任务计划", () => {
  const roster = [
    { agentId: "xiaobei", label: "小贝" },
    { agentId: "xiaoma", label: "小马" },
  ];

  it("通过的计划给出拓扑顺序与人数", () => {
    const validated = validateTaskPlan({
      plan: plan([
        { laneId: "lane_code", title: "写实现", dependsOn: ["lane_plan"], agentId: "xiaoma" },
        { laneId: "lane_plan", title: "出方案", agentId: "xiaobei" },
      ]),
      schedule: "parallel",
      memberLimit: 8,
      allowedAgents: roster,
    });
    // 名单保留计划里的书写顺序，order 才是拓扑顺序——两者不是一回事。
    expect(validated.roster.map((item) => item.laneId)).toEqual(["lane_code", "lane_plan"]);
    expect(validated.order).toEqual(["lane_plan", "lane_code"]);
    expect(validated.memberCount).toBe(2);
    expect(validated.roster.find((item) => item.laneId === "lane_plan")!.scopeSummary).toBe("出方案");
  });

  it("lane id 重复拒绝", () => {
    expect(() =>
      validateTaskPlan({
        plan: plan([
          { laneId: "lane_a", title: "一" },
          { laneId: "lane_a", title: "二" },
        ]),
        schedule: "parallel",
        memberLimit: 8,
      }),
    ).toThrow(/lane id 重复: lane_a/);
  });

  it("依赖指向计划外的 lane 拒绝，不当没看见", () => {
    expect(() =>
      validateTaskPlan({
        plan: plan([{ laneId: "lane_a", title: "一", dependsOn: ["lane_ghost"] }]),
        schedule: "parallel",
        memberLimit: 8,
      }),
    ).toThrow(/不在名单里: lane_ghost/);
  });

  it("依赖成环拒绝，并画出环", () => {
    expect(() =>
      validateTaskPlan({
        plan: plan([
          { laneId: "lane_a", title: "一", dependsOn: ["lane_b"] },
          { laneId: "lane_b", title: "二", dependsOn: ["lane_a"] },
        ]),
        schedule: "parallel",
        memberLimit: 8,
      }),
    ).toThrow(/成环/);
  });

  it("用了名单外的档案拒绝", () => {
    expect(() =>
      validateTaskPlan({
        plan: plan([{ laneId: "lane_a", title: "一", agentId: "xiaoma" }]),
        schedule: "parallel",
        memberLimit: 8,
        allowedAgents: [{ agentId: "xiaobei" }],
      }),
    ).toThrow(/lane_a 用了不在名单里的档案: xiaoma/);
  });

  it("用了白名单外的模型路由拒绝", () => {
    expect(() =>
      validateTaskPlan({
        plan: plan([{ laneId: "lane_a", title: "一", modelRef: "cheap" }]),
        schedule: "parallel",
        memberLimit: 8,
        allowedModelRefs: ["fast", "strong"],
      }),
    ).toThrow(/lane_a 用了不允许的模型路由: cheap/);
  });

  it("超人数上限拒绝，且按 agentId 去重", () => {
    const tasks = [
      { laneId: "lane_a", title: "一", agentId: "xiaobei" },
      { laneId: "lane_b", title: "二", agentId: "xiaobei" },
    ];
    expect(validateTaskPlan({ plan: plan(tasks), schedule: "parallel", memberLimit: 1 }).memberCount).toBe(1);
    expect(() =>
      validateTaskPlan({
        plan: plan([...tasks, { laneId: "lane_c", title: "三", agentId: "xiaoma" }]),
        schedule: "parallel",
        memberLimit: 1,
      }),
    ).toThrow(/队伍人数超出上限/);
  });

  it("分阶段调度要求每个任务都有阶段号", () => {
    expect(() =>
      validateTaskPlan({
        plan: plan([{ laneId: "lane_a", title: "一", stage: 1 }, { laneId: "lane_b", title: "二" }]),
        schedule: "staged",
        memberLimit: 8,
      }),
    ).toThrow(/分阶段调度要求每个成员写明阶段号/);
  });

  it("非分阶段调度写了阶段号也拒绝，不静默忽略", () => {
    expect(() =>
      validateTaskPlan({
        plan: plan([{ laneId: "lane_a", title: "一", stage: 1 }]),
        schedule: "parallel",
        memberLimit: 8,
      }),
    ).toThrow(/阶段号不会生效/);
  });

  it("抛的是 LegionPlanError，调用方一处就能接住", () => {
    try {
      validateTaskPlan({ plan: plan([{ laneId: "lane_a", title: "一", dependsOn: ["lane_ghost"] }]), schedule: "parallel", memberLimit: 8 });
      expect.unreachable("应该抛错");
    } catch (error) {
      expect(error).toBeInstanceOf(LegionPlanError);
    }
    try {
      parseTaskPlan("不是 json");
      expect.unreachable("应该抛错");
    } catch (error) {
      expect(error).toBeInstanceOf(LegionPlanError);
      expect(error).toBeInstanceOf(TaskPlanError);
    }
  });

  it("临时成员一起算人数", () => {
    expect(() =>
      validateTaskPlan({
        plan: plan([{ laneId: "lane_a", title: "一", agentId: "xiaobei" }]),
        schedule: "parallel",
        memberLimit: 1,
        temporaryMembers: [{ laneId: "lane_audit", agentId: "auditor" }],
      }),
    ).toThrow(/队伍人数超出上限: 2 > 1/);
  });
});

describe("给自动规划者的说明书", () => {
  it("列人可以挑的人、写明调度规则和人数上限", () => {
    const text = renderPlanInstruction({
      goal: "把登录页做出来",
      agents: [{ agentId: "xiaobei", label: "小贝" }, { agentId: "xiaoma" }],
      schedule: "staged",
      memberLimit: 3,
      allowedModelRefs: ["fast", "strong"],
    });
    expect(text).toContain("目标：把登录页做出来");
    expect(text).toContain("- xiaobei（小贝）");
    expect(text).toContain("- xiaoma");
    expect(text).toContain("最多 3 个人");
    expect(text).toContain("每个任务都必须写 stage");
    expect(text).toContain("modelRef 只能从这些里选：fast / strong");
    expect(text).toContain("只输出 JSON");
  });

  it("并行与顺序各自说清 stage 要不要写", () => {
    const base = { goal: "目标", agents: [], memberLimit: 8 } as const;
    expect(renderPlanInstruction({ ...base, schedule: "parallel" })).toContain("不要写 stage");
    expect(renderPlanInstruction({ ...base, schedule: "sequential" })).toContain("不要写 stage");
    expect(renderPlanInstruction({ ...base, schedule: "staged" })).toContain("都必须写 stage");
    expect(renderPlanInstruction({ ...base, schedule: "parallel" })).toContain("没有可用档案");
    expect(renderPlanInstruction({ ...base, schedule: "parallel" })).toContain("modelRef 可以不写");
  });
});

describe("计划摘要", () => {
  it("给人看的是人话，一行一个任务", () => {
    const text = renderPlanSummary(
      plan([
        { laneId: "lane_plan", title: "出方案", agentId: "xiaobei", stage: 1, writes: false },
        { laneId: "lane_code", title: "写实现", agentId: "xiaoma", stage: 2, dependsOn: ["lane_plan"], modelRef: "strong", workspace: "wt-1" },
      ]),
    );
    expect(text).toContain("目标：把登录页做出来");
    expect(text).toContain("任务 2 个：");
    expect(text).toContain("- lane_plan｜出方案｜档案 xiaobei｜阶段 1｜只读");
    expect(text).toContain("- lane_code｜写实现｜档案 xiaoma｜阶段 2｜依赖 lane_plan｜模型 strong｜工作区 wt-1");
  });
});
