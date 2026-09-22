import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VOID_REQUEST_HEADER,
  actDetailItem,
  actView,
  cellChange,
  cellDraftKey,
  cellText,
  dirtyChanges,
  loadDetailItem,
  loadDetailList,
  saveDetailItem,
  sessionLinkAt,
  shownFieldValue,
  type DetailBody,
  type DetailRowsSection,
  type DetailTextSection,
} from "../src/client/details.js";

const BODY: DetailBody = {
  title: "demo-team",
  revision: 3,
  sections: [],
  fields: [
    { key: "memberLimit", label: "人数上限", value: 8 },
    { key: "maxConcurrentTasks", label: "并发上限", value: 4, readOnly: true },
    { key: "sharedGoal", label: "共同目标", value: null },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(payload: unknown, ok = true, status = 200): Array<{ url: string; init: RequestInit | undefined }> {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok, status, json: async () => payload };
  });
  return calls;
}

describe("void-entry detail client", () => {
  it("shows the draft while editing and the read value otherwise", () => {
    const field = BODY.fields![0]!;
    expect(shownFieldValue(field, {})).toBe("8");
    expect(shownFieldValue(field, { memberLimit: "5" })).toBe("5");
    expect(shownFieldValue(BODY.fields![2]!, {})).toBe("");
  });

  it("submits only the fields that really changed, and only editable ones", () => {
    expect(dirtyChanges(BODY, {})).toEqual({});
    // 改成同样的值不算改动。
    expect(dirtyChanges(BODY, { memberLimit: "8" })).toEqual({});
    // 数字字段交上去是数字，不是字符串——host 侧只收整数。
    expect(dirtyChanges(BODY, { memberLimit: "5" })).toEqual({ memberLimit: 5 });
    // 只读字段改了也不提交：它们是组合入口决定的，改了不生效。
    expect(dirtyChanges(BODY, { maxConcurrentTasks: "2" })).toEqual({});
    // 空值字段改成文本。
    expect(dirtyChanges(BODY, { sharedGoal: "把活干完" })).toEqual({ sharedGoal: "把活干完" });
  });

  it("keeps a non-numeric entry as text instead of sending NaN", () => {
    // 交上去一个 NaN 会让 host 侧报「必须是整数」，但用户看到的是自己刚敲的字——
    // 原因会指向 host 的校验，而不是「这个框里现在不是数字」。
    expect(dirtyChanges(BODY, { memberLimit: "五" })).toEqual({ memberLimit: "五" });
    expect(dirtyChanges(BODY, { memberLimit: "" })).toEqual({ memberLimit: "" });
  });

  it("turns only the cells the server marked into session links", () => {
    const section: DetailTextSection = {
      id: "tasks",
      title: "任务",
      kind: "table",
      columns: ["任务", "子会话"],
      rows: [
        ["lane_code", "child-1"],
        ["lane_verify", "—"],
      ],
      sessionLinks: { "0:1": "child-1", "1:1": "" },
    };
    expect(sessionLinkAt(section, 0, 0)).toBeUndefined();
    expect(sessionLinkAt(section, 0, 1)).toBe("child-1");
    // 空串当作没给：服务端不该给空链接，给了也不能变成一个点不动的按钮。
    expect(sessionLinkAt(section, 1, 1)).toBeUndefined();
    // 老服务端不给这个字段：整张表照旧是纯文本。
    expect(sessionLinkAt({ ...section, sessionLinks: undefined }, 0, 1)).toBeUndefined();
  });

  it("treats a markdown body as one string, line breaks and all", () => {
    const body: DetailBody = {
      title: "开发专家",
      revision: "hash-2",
      sections: [],
      fields: [{ key: "body", label: "正文", value: "旧正文\n第二行\n", kind: "markdown" }],
    };
    expect(shownFieldValue(body.fields![0]!, {})).toBe("旧正文\n第二行\n");
    expect(dirtyChanges(body, { body: "新正文\n\n多一段\n" })).toEqual({ body: "新正文\n\n多一段\n" });
    // 一字不改就不提交；尾随换行也算改动——正文是逐字节比的。
    expect(dirtyChanges(body, { body: "旧正文\n第二行\n" })).toEqual({});
    expect(dirtyChanges(body, { body: "旧正文\n第二行" })).toEqual({ body: "旧正文\n第二行" });
    // 修订是文件内容哈希，字符串一样能当栅。
    expect(body.revision).toBe("hash-2");
  });

  it("reads the list and one item from the view route", async () => {
    const calls = stubFetch({ view: "void-legion:teams", title: "军团队伍", items: [] });
    expect(await loadDetailList("void-legion:teams")).toEqual({ ok: true, value: { title: "军团队伍", items: [], actions: [] } });
    expect(calls[0]!.url).toBe("/void/api/detail?view=void-legion%3Ateams");

    const itemCalls = stubFetch({ view: "void-legion:teams", detail: BODY });
    expect(await loadDetailItem("void-legion:teams", "demo-team")).toEqual({ ok: true, value: { detail: BODY } });
    expect(itemCalls[0]!.url).toBe("/void/api/detail?view=void-legion%3Ateams&itemId=demo-team");
    // 读请求不带改动头：它不是改动。
    expect(itemCalls[0]!.init).toBeUndefined();
  });

  it("asks the view for a filtered list and keeps its note and search declaration", async () => {
    const calls = stubFetch({
      view: "void-memory:memory",
      title: "人格记忆",
      items: [{ id: "xiaobei/20260922-0001", title: "一条" }],
      query: "小贝",
      note: "每个档案最多列出最近 20 条，更早的用检索找",
      search: { label: "检索记忆", hint: "只查索引，不全量扫描" },
    });
    const outcome = await loadDetailList("void-memory:memory", "小贝");
    expect(calls[0]!.url).toBe("/void/api/detail?view=void-memory%3Amemory&q=%E5%B0%8F%E8%B4%9D");
    expect(outcome).toEqual({
      ok: true,
      value: {
        title: "人格记忆",
        items: [{ id: "xiaobei/20260922-0001", title: "一条" }],
        actions: [],
        search: { label: "检索记忆", hint: "只查索引，不全量扫描" },
        note: "每个档案最多列出最近 20 条，更早的用检索找",
      },
    });
  });

  it("adds no query parameter when there is nothing to search for", async () => {
    const plain = stubFetch({ view: "void-legion:teams", title: "军团队伍", items: [] });
    expect(await loadDetailList("void-legion:teams")).toEqual({
      ok: true,
      value: { title: "军团队伍", items: [], actions: [] },
    });
    // 空串按「没检索」处理：请求里带上 `q=` 会让视图以为有人在检索一个空词。
    expect(await loadDetailList("void-legion:teams", "")).toEqual({
      ok: true,
      value: { title: "军团队伍", items: [], actions: [] },
    });
    expect(plain.map((call) => call.url)).toEqual([
      "/void/api/detail?view=void-legion%3Ateams",
      "/void/api/detail?view=void-legion%3Ateams",
    ]);
  });

  it("sends the same-origin marker and the revision gate when saving", async () => {
    const calls = stubFetch({ ok: true, view: "void-legion:teams", detail: BODY });
    await saveDetailItem("void-legion:teams", "demo-team", 3, { memberLimit: 5 });

    const init = calls[0]!.init!;
    expect(calls[0]!.url).toBe("/void/api/detail");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)[VOID_REQUEST_HEADER]).toBe("1");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      view: "void-legion:teams",
      itemId: "demo-team",
      op: "save",
      expectedRevision: 3,
      changes: { memberLimit: 5 },
    });
  });

  it("sends an action with its args, and drops the empty ones", async () => {
    const calls = stubFetch({ ok: true, view: "void-legion:runs", detail: BODY });
    await actDetailItem("void-legion:runs", "demo-team-1", "cancel-lane", { laneId: "lane_code" });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      view: "void-legion:runs",
      itemId: "demo-team-1",
      op: "act",
      actionId: "cancel-lane",
      args: { laneId: "lane_code" },
    });
  });

  it("carries the server's reason back instead of a bare status code", async () => {
    stubFetch({ ok: false, error: "队伍配置已被其他保存更新（期望修订 3，实际 4），请重读后再改" }, false, 409);
    expect(await saveDetailItem("void-legion:teams", "demo-team", 3, { memberLimit: 5 })).toEqual({
      ok: false,
      message: "队伍配置已被其他保存更新（期望修订 3，实际 4），请重读后再改",
    });

    stubFetch({}, false, 403);
    expect(await loadDetailList("void-legion:teams")).toEqual({ ok: false, message: "HTTP 403" });
  });

  it("passes a string revision through unchanged", async () => {
    const calls = stubFetch({ ok: true, view: "void-soul:facets", detail: BODY });
    await saveDetailItem("void-soul:facets", "demo", "hash-1", { body: "新正文" });
    expect(JSON.parse(calls[0]!.init!.body as string).expectedRevision).toBe("hash-1");
  });

  it("carries the revision gate on an action too, and omits it when there is none", async () => {
    const calls = stubFetch({ ok: true, view: "void-legion:teams", detail: BODY });
    // 删除这类动作也要栅：面板带的是打开这一条时读到的修订。
    await actDetailItem("void-legion:teams", "demo-team", "delete-team", { confirmTeamId: "demo-team" }, 3);
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      view: "void-legion:teams",
      itemId: "demo-team",
      op: "act",
      actionId: "delete-team",
      args: { confirmTeamId: "demo-team" },
      expectedRevision: 3,
    });

    // 没给就是没栅：不能凭空造一个 0 出来，那会变成「我认为它还没被保存过」。
    await actDetailItem("void-legion:runs", "demo-team-1", "cancel-run", {});
    expect(JSON.parse(calls[1]!.init!.body as string)).not.toHaveProperty("expectedRevision");
  });

  it("posts a view-level action without an item id", async () => {
    const calls = stubFetch({ ok: true, view: "void-legion:teams", scope: "view" });
    expect(await actView("void-legion:teams", "new-team", { teamId: "demo" })).toEqual({ ok: true, value: null });
    const init = calls[0]!.init!;
    expect((init.headers as Record<string, string>)[VOID_REQUEST_HEADER]).toBe("1");
    expect(JSON.parse(init.body as string)).toEqual({
      view: "void-legion:teams",
      op: "act",
      actionId: "new-team",
      args: { teamId: "demo" },
    });
  });
});

describe("void-entry editable row tables", () => {
  const ROWS: DetailRowsSection = {
    id: "members",
    title: "成员",
    kind: "rows",
    key: "members",
    editable: true,
    columns: [
      { key: "laneId", label: "lane" },
      { key: "reportsTo", label: "汇报", type: "list" },
      { key: "writes", label: "写文件", type: "boolean" },
      { key: "stage", label: "阶段", type: "number" },
    ],
    rows: [{ laneId: "lane_code", reportsTo: ["xiaobei"], writes: true }],
  };
  const BODY_WITH_ROWS: DetailBody = {
    title: "demo-team",
    revision: 3,
    sections: [
      ROWS,
      { id: "readonly", title: "只读", kind: "rows", columns: [{ key: "laneId", label: "lane" }], rows: [{ laneId: "lane_x" }] },
    ],
  };

  it("renders cell values the way the editor shows them", () => {
    expect(cellText(undefined, { key: "x", label: "x" })).toBe("");
    expect(cellText(["a", "b"], { key: "x", label: "x", type: "list" })).toBe("a，b");
    expect(cellText(true, { key: "x", label: "x", type: "boolean" })).toBe("是");
    expect(cellText(false, { key: "x", label: "x", type: "boolean" })).toBe("否");
    expect(cellText(3, { key: "x", label: "x", type: "number" })).toBe("3");
  });

  it("turns a cell draft back into the value the host expects", () => {
    expect(cellChange({ key: "x", label: "x" }, "  随便写  ")).toBe("  随便写  ");
    expect(cellChange({ key: "x", label: "x", type: "list" }, "a, b、c")).toEqual(["a", "b", "c"]);
    expect(cellChange({ key: "x", label: "x", type: "list" }, "")).toEqual([]);
    expect(cellChange({ key: "x", label: "x", type: "boolean" }, "否")).toBe(false);
    expect(cellChange({ key: "x", label: "x", type: "boolean" }, "true")).toBe(true);
    // 认不出来的布尔值原样交上去：host 会说清「必须是布尔值」，比面板自己猜一个值强。
    expect(cellChange({ key: "x", label: "x", type: "boolean" }, "也许")).toBe("也许");
    expect(cellChange({ key: "x", label: "x", type: "number" }, "5")).toBe(5);
    expect(cellChange({ key: "x", label: "x", type: "number" }, "五")).toBe("五");
  });

  it("submits the whole row table only when a cell really changed", () => {
    expect(dirtyChanges(BODY_WITH_ROWS, {})).toEqual({});
    // 改成同样的值不算改动。
    expect(dirtyChanges(BODY_WITH_ROWS, { [cellDraftKey("members", 0, "laneId")]: "lane_code" })).toEqual({});
    // 改一格就整组替换：行表格是一组同形对象，逐格打补丁会把顺序与删除表达错。
    expect(dirtyChanges(BODY_WITH_ROWS, { [cellDraftKey("members", 0, "laneId")]: "lane_main" })).toEqual({
      members: [{ laneId: "lane_main", reportsTo: ["xiaobei"], writes: true }],
    });
    expect(dirtyChanges(BODY_WITH_ROWS, { [cellDraftKey("members", 0, "reportsTo")]: "xiaobei，xiaoma" })).toEqual({
      members: [{ laneId: "lane_code", reportsTo: ["xiaobei", "xiaoma"], writes: true }],
    });
    expect(dirtyChanges(BODY_WITH_ROWS, { [cellDraftKey("members", 0, "writes")]: "否" })).toEqual({
      members: [{ laneId: "lane_code", reportsTo: ["xiaobei"], writes: false }],
    });
    expect(dirtyChanges(BODY_WITH_ROWS, { [cellDraftKey("members", 0, "stage")]: "2" })).toEqual({
      members: [{ laneId: "lane_code", reportsTo: ["xiaobei"], writes: true, stage: 2 }],
    });
    // 只读行表格（没有 key）永不提交。
    expect(dirtyChanges(BODY_WITH_ROWS, { [cellDraftKey("readonly", 0, "laneId")]: "lane_y" })).toEqual({});
  });

  it("clears a field with an empty cell, but keeps an empty list as a real value", () => {
    expect(dirtyChanges(BODY_WITH_ROWS, { [cellDraftKey("members", 0, "laneId")]: "" })).toEqual({
      members: [{ reportsTo: ["xiaobei"], writes: true }],
    });
    // 空列表是明确的意思（「没有上下级」），不是「没填」。
    expect(dirtyChanges(BODY_WITH_ROWS, { [cellDraftKey("members", 0, "reportsTo")]: "" })).toEqual({
      members: [{ laneId: "lane_code", reportsTo: [], writes: true }],
    });
  });

  it("appends the rows the user added, and drops the ones left blank", () => {
    expect(dirtyChanges(BODY_WITH_ROWS, { [cellDraftKey("members", 1, "laneId")]: "lane_verify" }, { members: 1 })).toEqual({
      members: [
        { laneId: "lane_code", reportsTo: ["xiaobei"], writes: true },
        { laneId: "lane_verify" },
      ],
    });
    // 点了「加一行」又一格没填：不该凭空多出一条成员。
    expect(dirtyChanges(BODY_WITH_ROWS, {}, { members: 1 })).toEqual({});
  });
});
