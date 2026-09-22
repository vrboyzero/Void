import { describe, expect, it } from "vitest";
import { createVoidWidgetsService } from "../../void-entry/src/client/widgets.ts";
import { assertPromptRenderable, beginPrompt, describeAppliedRecord, describeFacetVersions, describePending, facetVersionWidget, markFirstMeeting, measurePromptText, parseFacetCard, parseFacetState, recordAppliedPrompt, replaceSavedFacet, selectFacet, setSuspended, snapshotPrompt, suspendedReason } from "../src/index.js";

const cardText = "---\nid: dev\nname: 开发专家\nsummary: 写代码\n---\n# 开发\n";

function cards() {
  const map = new Map();
  const card = parseFacetCard(cardText, map);
  map.set(card.id, card);
  return map;
}

describe("prompt guard", () => {
  it("允许三个已知变量，拒绝未知变量和超预算", () => {
    const variables = new Set(["provider", "model", "cwd"]);
    expect(() => assertPromptRenderable({ soul: "目录 {{cwd}}", facet: null, facetId: null, selectionRevision: 0 }, { variables, maxCharacters: 100 })).not.toThrow();
    expect(() => assertPromptRenderable({ soul: "{{secret}}", facet: null, facetId: null, selectionRevision: 0 }, { variables, maxCharacters: 100 })).toThrow(/未知说明书变量/);
    expect(() => assertPromptRenderable({ soul: "太长", facet: null, facetId: null, selectionRevision: 0 }, { variables, maxCharacters: 1 })).toThrow(/超出本次上下文预算/);
  });

  it("给了取值就拦「有名字但没值」，不把宿主的报错留到组装时", () => {
    const variables = new Set(["provider", "model", "cwd"]);
    const snapshot = { soul: "你在 {{model}} 上跑，目录 {{cwd}}", facet: null, facetId: null, selectionRevision: 0 };
    expect(() =>
      assertPromptRenderable(snapshot, { variables, maxCharacters: 100, values: { provider: "deepseek", model: "deepseek-chat", cwd: "E:\\proj" } }),
    ).not.toThrow();
    let message = "";
    try {
      assertPromptRenderable(snapshot, { variables, maxCharacters: 100, values: { provider: "deepseek", model: undefined, cwd: "E:\\proj" } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("{{model}}");
    expect(message).toContain("AgentOptions.model");
    expect(message).toContain('prompt variable "{{model}}" has no value for this assembly');
    expect(message).toContain("整个 Agent 起不来");
    expect(message).toContain("把 {{model}} 从 SOUL 与模组里去掉");
    // cwd 的取值出处与另外两个不同，文案要跟着变。
    expect(() =>
      assertPromptRenderable({ soul: "目录 {{cwd}}", facet: null, facetId: null, selectionRevision: 0 }, { variables, maxCharacters: 100, values: { cwd: undefined } }),
    ).toThrow(/会话头的 cwd/);
    // 不传 values 时只查名字（保存与预览路径就是这么用的）。
    expect(() => assertPromptRenderable(snapshot, { variables, maxCharacters: 100 })).not.toThrow();
  });

  it("拒绝信息带实际字数、预算与出处，并给出补救方向", () => {
    const snapshot = { soul: "底线".repeat(10), facet: "模组".repeat(5), facetId: "dev", selectionRevision: 3 };
    expect(measurePromptText(snapshot)).toEqual({ soulCharacters: 20, facetCharacters: 10, firstMeetingCharacters: 0, totalCharacters: 31 });
    let message = "";
    try {
      assertPromptRenderable(snapshot, { variables: new Set(["provider", "model", "cwd"]), maxCharacters: 31 - 6, budgetSource: "context-window" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("SOUL 20 字");
    expect(message).toContain("模组 10 字");
    expect(message).toContain("= 31 字");
    expect(message).toContain("预算 25 字");
    expect(message).toContain("超出 6 字");
    expect(message).toContain("（预算来自 context-window）");
    expect(message).toContain("不会截断内容");
  });

  it("模组缺席时那个换行也算进长度，量法与送进模型的文本一致", () => {
    expect(measurePromptText({ soul: "底线", facet: null, facetId: null, selectionRevision: 0 })).toEqual({
      soulCharacters: 2, facetCharacters: 0, firstMeetingCharacters: 0, totalCharacters: 3,
    });
    expect(() => assertPromptRenderable({ soul: "底线", facet: null, facetId: null, selectionRevision: 0 }, { variables: new Set(["provider", "model", "cwd"]), maxCharacters: 2 })).toThrow(/超出 1 字/);
  });

  it("首次见面引导也算进预算，拒绝信息里单独列出它", () => {
    const snapshot = { soul: "底线".repeat(5), facet: null, facetId: null, selectionRevision: 0 };
    expect(measurePromptText(snapshot, "先自我介绍")).toEqual({
      soulCharacters: 10, facetCharacters: 0, firstMeetingCharacters: 5, totalCharacters: 16,
    });
    let message = "";
    try {
      assertPromptRenderable(snapshot, { variables: new Set(["provider", "model", "cwd"]), maxCharacters: 15, firstMeeting: "先自我介绍" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("+ 首次见面 5 字");
    expect(message).toContain("= 16 字");
    expect(message).toContain("超出 1 字");
    // 没有引导时不留一个恒为 0 的加数，免得人以为自己漏看了什么。
    let plain = "";
    try {
      assertPromptRenderable(snapshot, { variables: new Set(["provider", "model", "cwd"]), maxCharacters: 10 });
    } catch (error) {
      plain = (error as Error).message;
    }
    expect(plain).not.toContain("首次见面");
    // 引导里的变量与 SOUL 走同一条白名单：宿主组装时同样会为它抛错。
    expect(() =>
      assertPromptRenderable(snapshot, { variables: new Set(["provider", "model", "cwd"]), maxCharacters: 1000, firstMeeting: "看看 {{secret}}" }),
    ).toThrow(/未知说明书变量: secret/);
  });
});

describe("facet selection", () => {
  it("空状态是显式无模组，不回退", () => {
    const state = parseFacetState(undefined);
    expect(snapshotPrompt({ soulBody: "底线", state, cards: cards() })).toEqual({
      soul: "底线", facet: null, facetId: null, selectionRevision: 0,
    });
  });

  it("选择后下一次快照才使用新角色，另一个选择不受影响", () => {
    const library = cards();
    const saved = selectFacet({ state: parseFacetState(undefined), cards: library, facetId: "dev", expectedRevision: 0 });
    const before = snapshotPrompt({ soulBody: "底线A", state: parseFacetState(undefined), cards: library });
    const after = snapshotPrompt({ soulBody: "底线A", state: saved, cards: library });
    const other = snapshotPrompt({ soulBody: "底线B", state: parseFacetState(undefined), cards: library });
    expect(before.facet).toBeNull();
    expect(after.facet).toBe("# 开发\n");
    expect(other.soul).toBe("底线B");
    expect(other.facetId).toBeNull();
  });

  it("进行中的请求保持旧角色，已保存的选择单独更新", () => {
    const library = cards();
    const started = beginPrompt({ soulBody: "底线A", state: parseFacetState(undefined), cards: library });
    const saved = selectFacet({ state: parseFacetState(undefined), cards: library, facetId: "dev", expectedRevision: 0 });
    const during = replaceSavedFacet({ current: started, soulBody: "底线A", state: saved, cards: library });
    expect(during.applied?.facetId).toBeNull();
    expect(during.saved.facetId).toBe("dev");
    const next = beginPrompt({ soulBody: "底线A", state: saved, cards: library });
    expect(next.applied?.facet).toBe("# 开发\n");
    const view = describeFacetVersions({ current: during, cards: library });
    expect(view.saved).toMatchObject({ facetId: "dev", name: "开发专家", summary: "写代码", pending: true });
    expect(view.applied).toMatchObject({ facetId: null, name: null, pending: false });
    const widget = facetVersionWidget(view);
    expect(widget.lines).toEqual(["已保存：开发专家（写代码），待下一次请求生效", "本次生效：无模组"]);
    const widgets = createVoidWidgetsService();
    const dispose = widgets.registerWidget({ ...widget, component: widget.lines });
    expect(widgets.getWidgets().map((item) => item.id)).toEqual(["void-soul:facet-version"]);
    expect(() => widgets.registerWidget({ ...widget, component: widget.lines })).toThrow(/already registered/);
    dispose();
  });

  it("丢失、冲突和重复 id 都拒绝", () => {
    const library = cards();
    const selected = selectFacet({ state: parseFacetState(undefined), cards: library, facetId: "dev", expectedRevision: 0 });
    expect(() => selectFacet({ state: selected, cards: library, facetId: null, expectedRevision: 0 })).toThrow(/重试/);
    expect(() => selectFacet({ state: parseFacetState(undefined), cards: library, facetId: "missing", expectedRevision: 0 })).toThrow(/不存在/);
    expect(() => snapshotPrompt({ soulBody: "底线", state: { ...selected, activeFacetId: "gone" }, cards: library })).toThrow(/丢失/);
    expect(() => parseFacetCard(cardText, library)).toThrow(/重复/);
  });

  it("首次见面状态：老状态文件缺字段算没做过，坏值报错，标完成不动角色选择", () => {
    // 老状态文件（写它的版本还没有引导）里没有这个字段，缺了就是「还没引导过」。
    const legacy = parseFacetState('{"schemaVersion":1,"activeFacetId":"dev","selectionRevision":4}');
    expect(legacy).toEqual({ schemaVersion: 1, activeFacetId: "dev", selectionRevision: 4, firstMeetingDone: false, suspended: false });
    expect(parseFacetState(undefined).firstMeetingDone).toBe(false);
    expect(() => parseFacetState('{"schemaVersion":1,"activeFacetId":null,"selectionRevision":0,"firstMeetingDone":"是"}')).toThrow(/首次见面状态损坏/);

    const done = markFirstMeeting({ state: legacy, done: true });
    expect(done).toEqual({ schemaVersion: 1, activeFacetId: "dev", selectionRevision: 4, firstMeetingDone: true, suspended: false });
    expect(markFirstMeeting({ state: done, done: false }).firstMeetingDone).toBe(false);

    // 标完成不是换角色：修订号不动，别人的角色选择不会因此撞冲突，重选角色也不会把引导打回未完成。
    const reselected = selectFacet({ state: done, cards: cards(), facetId: null, expectedRevision: 4 });
    expect(reselected).toEqual({ schemaVersion: 1, activeFacetId: null, selectionRevision: 5, firstMeetingDone: true, suspended: false });
  });

  it("停用状态：老状态文件缺字段算启用，坏值报错，换角色与标完成都不改这个位", () => {
    // 老状态文件（写它的版本还没有停用）里没有这个字段，缺了就是「启用中」。
    const legacy = parseFacetState('{"schemaVersion":1,"activeFacetId":"dev","selectionRevision":4,"firstMeetingDone":true}');
    expect(legacy.suspended).toBe(false);
    expect(parseFacetState(undefined).suspended).toBe(false);
    expect(() => parseFacetState('{"schemaVersion":1,"activeFacetId":null,"selectionRevision":0,"suspended":"是"}')).toThrow(/停用状态损坏/);
    // 只认真正的布尔：数字、字符串都不算（与首次见面的口径一致，宁可报错也不猜）。
    expect(() => parseFacetState('{"schemaVersion":1,"activeFacetId":null,"selectionRevision":0,"suspended":1}')).toThrow(/停用状态损坏/);

    const suspended = setSuspended({ state: legacy, suspended: true });
    expect(suspended).toEqual({ schemaVersion: 1, activeFacetId: "dev", selectionRevision: 4, firstMeetingDone: true, suspended: true });
    // 停用不是换角色：修订号不动（停用位不进 selectionRevision，别人的角色选择不会因此撞冲突）。
    expect(suspended.selectionRevision).toBe(legacy.selectionRevision);
    // 停用期间换角色、标完成都不把这个位弄丢。
    const switched = selectFacet({ state: suspended, cards: cards(), facetId: null, expectedRevision: 4 });
    expect(switched).toMatchObject({ activeFacetId: null, selectionRevision: 5, suspended: true });
    expect(markFirstMeeting({ state: suspended, done: false })).toMatchObject({ firstMeetingDone: false, suspended: true });
    // 再启用回来，还是同一条路。
    expect(setSuspended({ state: switched, suspended: false }).suspended).toBe(false);
  });

  it("停用的拒绝理由说清是哪条路被拒，并指回面板", () => {
    expect(suspendedReason("xiaobei", "进入模型")).toBe("档案已停用，拒绝进入模型: xiaobei（在面板上「启用这份档案」就恢复，记忆与聊天记录一个字节都没动）");
    expect(suspendedReason("xiaobei", "派活")).toContain("拒绝派活");
  });
});

describe("applied prompt（面板的「本次生效」）", () => {
  it("只比选择修订不够：正文改了也算没生效，并且说得出改的是哪一层", () => {
    const applied = { soul: "底线", facet: "# 开发\n", facetId: "dev", selectionRevision: 2 };
    expect(describePending(applied, applied)).toBeNull();
    // 换了角色：修订号动。
    expect(describePending({ ...applied, selectionRevision: 3 }, applied)).toBe("selection");
    // 同一个角色、只改了模组正文：修订号不动，可装进去的字变了。
    expect(describePending({ ...applied, facet: "# 开发 v2\n" }, applied)).toBe("facet-body");
    // 只改了底线正文。
    expect(describePending({ ...applied, soul: "底线 v2" }, applied)).toBe("soul-body");
    // 没发过请求就没有「没生效」这回事。
    expect(describePending(applied, null)).toBeNull();
  });

  it("正文改动在面板上说得清，并且点明下面那行还是改前那份", () => {
    const library = cards();
    const started = beginPrompt({ soulBody: "底线A", state: parseFacetState(undefined), cards: library });
    const selected = selectFacet({ state: parseFacetState(undefined), cards: library, facetId: "dev", expectedRevision: 0 });
    const first = beginPrompt({ soulBody: "底线A", state: selected, cards: library });
    // 人类把模组正文改了（选择没动），下一次请求之前：已保存的那份变了，装进模型的还是旧正文。
    const edited = new Map(library);
    const card = edited.get("dev");
    if (!card) throw new Error("测试数据缺 dev 模组");
    edited.set("dev", { ...card, body: "# 开发 v2\n" });
    const after = replaceSavedFacet({ current: first, soulBody: "底线A", state: selected, cards: edited });
    const view = describeFacetVersions({ current: after, cards: edited });
    expect(view.saved).toMatchObject({ pending: true, pendingReason: "facet-body" });
    expect(facetVersionWidget(view).lines).toEqual([
      "已保存：开发专家（写代码），模组正文已改，待下一次请求生效",
      "本次生效：开发专家（写代码）（还是改前那份）",
    ]);
    // 改底线正文同理，只是文案换一层。
    const soulAfter = replaceSavedFacet({ current: first, soulBody: "底线A v2", state: selected, cards: library });
    const soulView = describeFacetVersions({ current: soulAfter, cards: library });
    expect(soulView.saved).toMatchObject({ pending: true, pendingReason: "soul-body" });
    expect(facetVersionWidget(soulView).lines[0]).toBe("已保存：开发专家（写代码），底线正文已改，待下一次请求生效");
    // 什么都没改：两行都是干净的，没有多余尾巴。
    const clean = describeFacetVersions({ current: first, cards: library });
    expect(clean.saved).toMatchObject({ pending: false, pendingReason: null });
    expect(facetVersionWidget(clean).lines).toEqual(["已保存：开发专家（写代码）", "本次生效：开发专家（写代码）"]);
    // 只是换角色时不加「还是改前那份」——下面那行显示的就是上一个角色，名字本身已经说清了。
    expect(facetVersionWidget(describeFacetVersions({ current: started, cards: library })).lines[1]).toBe("本次生效：无模组");
  });

  it("请求那一刻把卡片显示信息抄下来：模组后来改名或删掉，面板照实说那次用的是什么", () => {
    const library = cards();
    const snapshot = snapshotPrompt({ soulBody: "底线A", state: parseFacetState(undefined), cards: library });
    const record = recordAppliedPrompt({ snapshot, cards: library });
    expect(record).toEqual({ snapshot, facetName: null, facetSummary: null });
    expect(describeAppliedRecord(record)).toEqual({
      kind: "applied",
      facetId: null,
      name: null,
      summary: null,
      selectionRevision: 0,
      pending: false,
      pendingReason: null,
    });
    // 选了角色再记一次：显示信息取自当时那张卡片。
    const selected = selectFacet({ state: parseFacetState(undefined), cards: library, facetId: "dev", expectedRevision: 0 });
    const withFacet = recordAppliedPrompt({ snapshot: snapshotPrompt({ soulBody: "底线A", state: selected, cards: library }), cards: library });
    expect(withFacet.facetName).toBe("开发专家");
    // 卡片改名、甚至整张删掉：记录里的显示信息不动（不回头看现在的盘，也就不会抛「已丢失的模组」）。
    const renamed = new Map(library);
    const card = renamed.get("dev");
    if (!card) throw new Error("测试数据缺 dev 模组");
    renamed.set("dev", { ...card, frontMatter: { ...card.frontMatter, name: "改过名的角色" } });
    expect(describeAppliedRecord(recordAppliedPrompt({ snapshot: withFacet.snapshot, cards: renamed })).name).toBe("改过名的角色");
    expect(describeAppliedRecord(withFacet)).toMatchObject({ facetId: "dev", name: "开发专家", summary: "写代码" });
    expect(describeAppliedRecord(withFacet).name).toBe("开发专家");
  });
});
