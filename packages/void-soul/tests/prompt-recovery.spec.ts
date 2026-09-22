import { describe, expect, it } from "vitest";
import {
  assembleSessionId,
  createAttachRetry,
  installFrozenSectionRecovery,
  registerFrozenAttachDisposal,
  syncFrozenSections,
  type AssembleHookHost,
  type AssembleNext,
  type AssembledSection,
  type FrozenAttach,
  type FrozenAttachRegistry,
  type FrozenSection,
  type PromptAssembly,
} from "../src/prompt-recovery.js";

/**
 * 装配补段与热更新：宿主不等 `agent/created` 的监听器，第一条请求可能赶在读盘之前；段一旦
 * 注册在 Agent 身上，宿主每轮都拿那一份旧的来装配，所以正文改了得在这里换。
 *
 * 这些用例钉住的是「等 + 对齐」两件事：等这次挂载落定（`pending`），把快照里的段对齐到
 * 当前这一份（同名的换正文、不该装的摘掉、缺的插到人设段之后）。真机那一次的表现见文档 13.1。
 */

const SOUL: FrozenSection = { name: "void:soul", order: 1, text: "底线正文" };
const FACET: FrozenSection = { name: "void:facet", order: 2, text: "本次模组" };

/** 收下监听器，并能按宿主的调用方式（`(assembly, context, next)`）跑一次装配。 */
function fakeHost(): {
  host: AssembleHookHost;
  assemble: (assembly: PromptAssembly, context: unknown, next?: AssembleNext) => Promise<PromptAssembly>;
} {
  let listener: ((assembly: PromptAssembly, context: unknown, next: AssembleNext) => Promise<PromptAssembly>) | undefined;
  return {
    host: {
      on(_name, value) {
        listener = value;
        return () => {
          listener = undefined;
        };
      },
    },
    assemble(assembly, context, next) {
      if (listener === undefined) throw new Error("监听器没挂上");
      // 宿主自己的链尾是 `() => Promise.resolve(assembly)`；链上没有别人时就是这个。
      return listener(assembly, context, next ?? (() => Promise.resolve(assembly)));
    },
  };
}

/** 宿主的装配快照：它自己算好的段。 */
function snapshot(...names: string[]): PromptAssembly {
  return { sections: names.map((name) => ({ name, text: `${name} 的正文` })), variables: { cwd: "E:/x" } };
}

function names(sections: readonly AssembledSection[]): string[] {
  return sections.map((section) => section.name);
}

describe("syncFrozenSections：把快照对齐到这一轮该装的那一份", () => {
  it("紧跟 deployment:persona-prefix", () => {
    const out = syncFrozenSections(snapshot("harness:identity", "deployment:persona-prefix", "plan:policy").sections, [SOUL, FACET]);
    expect(names(out)).toEqual(["harness:identity", "deployment:persona-prefix", "void:soul", "void:facet", "plan:policy"]);
    expect(out[2]?.text).toBe("底线正文");
  });

  it("没有 deployment:persona-prefix 就跟在 harness:identity 之后", () => {
    const out = syncFrozenSections(snapshot("harness:identity", "plan:policy").sections, [SOUL]);
    expect(names(out)).toEqual(["harness:identity", "void:soul", "plan:policy"]);
  });

  it("两个锚点都没有就插到头（宁可早，也不丢）", () => {
    const out = syncFrozenSections(snapshot("plan:policy").sections, [SOUL]);
    expect(names(out)).toEqual(["void:soul", "plan:policy"]);
  });

  it("同名段换成本轮正文：正文刚被改过时，这一次请求就得用新的", () => {
    const edited: FrozenSection = { name: "void:soul", order: 1, text: "底线正文（改过）" };
    const out = syncFrozenSections(snapshot("deployment:persona-prefix", "void:soul").sections, [edited]);
    expect(names(out)).toEqual(["deployment:persona-prefix", "void:soul"]);
    expect(out[1]?.text).toBe("底线正文（改过）");
  });

  it("本轮不装的自己的段就摘掉（模组被清掉、引导标成已完成、会话被解绑）", () => {
    const out = syncFrozenSections(
      snapshot("deployment:persona-prefix", "void:soul", "void:facet", "plan:policy").sections,
      [SOUL],
      ["void:soul", "void:facet", "void:first-meeting"],
    );
    expect(names(out)).toEqual(["deployment:persona-prefix", "void:soul", "plan:policy"]);
  });

  it("别人的段一律不动：名单外的同名段不归我们管", () => {
    const out = syncFrozenSections(snapshot("void:soul", "plan:policy").sections, [], ["void:facet"]);
    expect(names(out)).toEqual(["void:soul", "plan:policy"]);
    expect(out[0]?.text).toBe("void:soul 的正文");
  });

  it("空快照也照插", () => {
    expect(names(syncFrozenSections([], [SOUL]))).toEqual(["void:soul"]);
  });
});

describe("assembleSessionId：认不出会话就不插手", () => {
  it("读 context.agent.id", () => {
    expect(assembleSessionId({ agent: { id: "s1" }, scope: {} })).toBe("s1");
  });

  it("没有 agent、id 不是字符串、空串一律 undefined", () => {
    expect(assembleSessionId(undefined)).toBeUndefined();
    expect(assembleSessionId({})).toBeUndefined();
    expect(assembleSessionId({ agent: {} })).toBeUndefined();
    expect(assembleSessionId({ agent: { id: 7 } })).toBeUndefined();
    expect(assembleSessionId({ agent: { id: "" } })).toBeUndefined();
  });
});

describe("installFrozenSectionRecovery：等挂载落定再补段", () => {
  it("还没读完盘就装配：等它落定，把段补进快照", async () => {
    const { host, assemble } = fakeHost();
    const registry: FrozenAttachRegistry = new Map();
    installFrozenSectionRecovery(host, registry);

    const sections: FrozenSection[] = [];
    const record: FrozenAttach = { sections };
    registry.set("s1", record);
    let released: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    record.pending = gate.then(() => {
      sections.push(SOUL, FACET);
      record.pending = undefined;
    });

    const started = assemble(snapshot("harness:identity", "deployment:persona-prefix"), { agent: { id: "s1" } });
    // 挂载还没落定，装配就停在那儿等——不是拿到半截就走。
    released?.();
    const out = await started;
    expect(names(out.sections)).toEqual(["harness:identity", "deployment:persona-prefix", "void:soul", "void:facet"]);
    // 宿主的其它字段原样带回去。
    expect(out.variables).toEqual({ cwd: "E:/x" });
  });

  it("用掉就删：第二次装配不再补（段已经登记在 Agent 身上了）", async () => {
    const { host, assemble } = fakeHost();
    const registry: FrozenAttachRegistry = new Map();
    installFrozenSectionRecovery(host, registry);
    registry.set("s1", { sections: [SOUL] });

    const first = await assemble(snapshot("deployment:persona-prefix"), { agent: { id: "s1" } });
    expect(names(first.sections)).toEqual(["deployment:persona-prefix", "void:soul"]);
    expect(registry.has("s1")).toBe(false);
    const second = await assemble(snapshot("deployment:persona-prefix"), { agent: { id: "s1" } });
    expect(names(second.sections)).toEqual(["deployment:persona-prefix"]);
  });

  it("没绑定的会话（挂载成功但一段没装）不动快照", async () => {
    const { host, assemble } = fakeHost();
    const registry: FrozenAttachRegistry = new Map();
    installFrozenSectionRecovery(host, registry);
    registry.set("s1", { sections: [] });

    const out = await assemble(snapshot("deployment:persona-prefix"), { agent: { id: "s1" } });
    expect(names(out.sections)).toEqual(["deployment:persona-prefix"]);
    expect(registry.has("s1")).toBe(false);
  });

  it("挂载失败（读盘炸了）不连累装配", async () => {
    const { host, assemble } = fakeHost();
    const registry: FrozenAttachRegistry = new Map();
    installFrozenSectionRecovery(host, registry);
    registry.set("s1", { sections: [], pending: Promise.reject(new Error("读盘炸了")) });

    const out = await assemble(snapshot("harness:identity"), { agent: { id: "s1" } });
    expect(names(out.sections)).toEqual(["harness:identity"]);
  });

  it("认不出会话就原样返回，但仍然放行链上的下一环", async () => {
    const { host, assemble } = fakeHost();
    const registry: FrozenAttachRegistry = new Map();
    installFrozenSectionRecovery(host, registry);
    registry.set("s1", { sections: [SOUL] });

    let reached = false;
    const out = await assemble(snapshot("harness:identity"), {}, async () => {
      reached = true;
      return snapshot("harness:identity");
    });
    expect(names(out.sections)).toEqual(["harness:identity"]);
    expect(reached).toBe(true);
    // `s1` 还在表里：别的会话的装配不该把它消耗掉。
    expect(registry.has("s1")).toBe(true);
  });

  it("返回的撤销函数把监听器摘掉", () => {
    const { host, assemble } = fakeHost();
    const dispose = installFrozenSectionRecovery(host, new Map());
    dispose();
    expect(() => assemble(snapshot("harness:identity"), { agent: { id: "s1" } })).toThrow("监听器没挂上");
  });
});

describe("installFrozenSectionRecovery：每轮重算（13.3 第 2 条热更新）", () => {
  /** 会重算的记录：每一轮装配都问一次 `refresh`。 */
  function refreshable(current: () => Promise<readonly FrozenSection[]>): FrozenAttach {
    return { sections: [SOUL], owned: ["void:soul", "void:facet", "void:first-meeting"], refresh: current };
  }

  it("同会话第二次装配拿到的是新正文，记录留在表里", async () => {
    const { host, assemble } = fakeHost();
    const registry: FrozenAttachRegistry = new Map();
    installFrozenSectionRecovery(host, registry);
    let text = "底线正文";
    let calls = 0;
    registry.set("s1", refreshable(async () => {
      calls += 1;
      return [{ name: "void:soul", order: 1, text }];
    }));

    const first = await assemble(snapshot("deployment:persona-prefix", "void:soul"), { agent: { id: "s1" } });
    expect(first.sections[1]?.text).toBe("底线正文");
    text = "底线正文（改过）";
    const second = await assemble(snapshot("deployment:persona-prefix", "void:soul"), { agent: { id: "s1" } });
    expect(second.sections[1]?.text).toBe("底线正文（改过）");
    expect(calls).toBe(2);
    // 还在跑就还留着：下一轮装配还要重算。
    expect(registry.has("s1")).toBe(true);
  });

  it("这一轮不装了就摘掉（会话被解绑：回空数组）", async () => {
    const { host, assemble } = fakeHost();
    const registry: FrozenAttachRegistry = new Map();
    installFrozenSectionRecovery(host, registry);
    registry.set("s1", refreshable(async () => []));

    const out = await assemble(snapshot("deployment:persona-prefix", "void:soul", "void:facet", "plan:policy"), { agent: { id: "s1" } });
    expect(names(out.sections)).toEqual(["deployment:persona-prefix", "plan:policy"]);
  });

  it("重算失败沿用上一份，不把装配搞崩", async () => {
    const { host, assemble } = fakeHost();
    const registry: FrozenAttachRegistry = new Map();
    installFrozenSectionRecovery(host, registry);
    registry.set("s1", refreshable(async () => {
      throw new Error("读盘炸了");
    }));

    const out = await assemble(snapshot("deployment:persona-prefix", "void:soul"), { agent: { id: "s1" } });
    expect(names(out.sections)).toEqual(["deployment:persona-prefix", "void:soul"]);
    expect(out.sections[1]?.text).toBe("底线正文");
  });

  it("先等挂载落定，再重算：第一次装配也不会拿到半截", async () => {
    const { host, assemble } = fakeHost();
    const registry: FrozenAttachRegistry = new Map();
    installFrozenSectionRecovery(host, registry);
    const sections: FrozenSection[] = [];
    let released: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    const record: FrozenAttach = {
      sections,
      owned: ["void:soul"],
      refresh: async () => [{ name: "void:soul", order: 1, text: "落定后的正文" }],
    };
    record.pending = gate.then(() => {
      sections.push(SOUL);
      record.pending = undefined;
    });
    registry.set("s1", record);

    const started = assemble(snapshot("deployment:persona-prefix"), { agent: { id: "s1" } });
    released?.();
    const out = await started;
    expect(out.sections[1]?.text).toBe("落定后的正文");
  });
});

describe("registerFrozenAttachDisposal：会话结束就收尾", () => {
  function fakeEvents(): {
    events: { on(name: "agent/disposed", listener: (payload: { agent: { id: string } }) => void): () => void };
    dispose: (payload: unknown) => void;
  } {
    let listener: ((payload: { agent: { id: string } }) => void) | undefined;
    return {
      events: {
        on(_name, value) {
          listener = value;
          return () => {
            listener = undefined;
          };
        },
      },
      dispose(payload) {
        if (listener === undefined) throw new Error("监听器没挂上");
        listener(payload as { agent: { id: string } });
      },
    };
  }

  it("agent/disposed 把那条记录删掉，别人的不动", () => {
    const { events, dispose } = fakeEvents();
    const registry: FrozenAttachRegistry = new Map([["s1", { sections: [SOUL] }], ["s2", { sections: [SOUL] }]]);
    registerFrozenAttachDisposal(events, registry);
    dispose({ agent: { id: "s1" } });
    expect(registry.has("s1")).toBe(false);
    expect(registry.has("s2")).toBe(true);
  });

  it("载荷不完整也不抛错（诊断面不该把宿主的事件链搞崩）", () => {
    const { events, dispose } = fakeEvents();
    const registry: FrozenAttachRegistry = new Map([["s1", { sections: [SOUL] }]]);
    registerFrozenAttachDisposal(events, registry);
    expect(() => dispose({})).not.toThrow();
    expect(() => dispose({ agent: { id: 7 } })).not.toThrow();
    expect(registry.has("s1")).toBe(true);
  });
});

/**
 * 挂载失败之后的下一轮再试：拒绝文案写着「请把文件另存为 UTF-8 再试」，那就得真能再试——
 * 文件坏了时第一次挂载失败，人修好之后同一个会话该当场自愈，而不是非换会话或重启宿主不可。
 * 真机那一次的表现见 A5（会话 `session-void-nonutf8-b`：坏 SOUL.md 被拒 → 系统提示 1827 字无灵魂段）。
 */
describe("createAttachRetry：挂载失败之后下一轮再试", () => {
  it("试成了就把段交出去（同一个会话自愈）", async () => {
    const sections: FrozenSection[] = [];
    let broken = true;
    const retry = createAttachRetry({
      attempt: async () => {
        if (broken) throw new Error("档案 小贝 的 SOUL.md 不是有效的 UTF-8 文本");
        sections.push(SOUL);
      },
      sections,
      onRefused: () => undefined,
      firstReason: "档案 小贝 的 SOUL.md 不是有效的 UTF-8 文本",
    });
    expect(await retry()).toEqual([]);
    broken = false;
    expect(await retry()).toEqual([SOUL]);
  });

  it("同一条原因只报一次，原因变了再报（第一次那条已经报过了）", async () => {
    const refused: string[] = [];
    let reason = "不是有效的 UTF-8 文本";
    const retry = createAttachRetry({
      attempt: async () => {
        throw new Error(reason);
      },
      sections: [],
      onRefused: (error) => refused.push(String(error)),
      firstReason: "不是有效的 UTF-8 文本",
    });
    await retry();
    await retry();
    expect(refused).toEqual([]);
    reason = "太大，拒绝读入";
    await retry();
    await retry();
    expect(refused).toEqual(["Error: 太大，拒绝读入"]);
  });

  it("试成之后又坏，照样再报（成功把上一次的原因清掉）", async () => {
    const refused: string[] = [];
    let broken = false;
    const retry = createAttachRetry({
      attempt: async () => {
        if (broken) throw new Error("太大，拒绝读入");
      },
      sections: [],
      onRefused: (error) => refused.push(String(error)),
      firstReason: "不是有效的 UTF-8 文本",
    });
    await retry();
    expect(refused).toEqual([]);
    broken = true;
    await retry();
    expect(refused).toEqual(["Error: 太大，拒绝读入"]);
  });

  it("瀑布这一侧：修好之后的下一次装配就把段补上", async () => {
    const { host, assemble } = fakeHost();
    const sections: FrozenSection[] = [];
    const refused: string[] = [];
    let broken = true;
    const record: FrozenAttach = { sections, owned: ["void:soul"] };
    const registry: FrozenAttachRegistry = new Map([["s1", record]]);
    installFrozenSectionRecovery(host, registry);
    record.refresh = createAttachRetry({
      attempt: async () => {
        if (broken) throw new Error("档案 小贝 的 SOUL.md 不是有效的 UTF-8 文本");
        sections.push(SOUL);
      },
      sections,
      onRefused: (error) => refused.push(String(error)),
      firstReason: "档案 小贝 的 SOUL.md 不是有效的 UTF-8 文本",
    });

    const before = await assemble(snapshot("deployment:persona-prefix"), { agent: { id: "s1" } });
    expect(names(before.sections)).toEqual(["deployment:persona-prefix"]);
    // 同一个会话、同一条原因：不重复报（第一次那条由外层报过了）
    expect(refused).toEqual([]);

    broken = false;
    const after = await assemble(snapshot("deployment:persona-prefix"), { agent: { id: "s1" } });
    expect(names(after.sections)).toEqual(["deployment:persona-prefix", "void:soul"]);
    expect(after.sections[1]?.text).toBe("底线正文");
  });
});
