import { describe, expect, it } from "vitest";
import { resolveVoidDataRoot } from "../src/profile.js";
import { FACET_VIEW_ID, PROFILE_VIEW_ID, apply, createSoulViews, type SoulViewHost } from "../src/detail-view.js";
import type { FacetDetail, FacetSummary, ProfileBodyView, ProfileInspection, ProfileSummary, ProfileSuspension, SessionBindingSummary, SoulBodyHistoryEntry, SuspensionEntry } from "../src/soul-library.js";

const PROFILE = { home: "E:/isolated", name: "web" };
const DATA_ROOT = resolveVoidDataRoot({ dshHome: PROFILE.home, profile: PROFILE.name });

const FACET_MARKDOWN = ["---", "id: facet_dev", "name: 开发专家", "summary: 写代码时用", "---", "", "按小步改，每步都跑测试。", ""].join("\n");

const XIAOBEI: ProfileSummary = {
  id: "xiaobei",
  name: "小贝",
  summary: "主人的贴身助手",
  avatar: undefined,
  owner: "6f1c2f9e-1111-4222-8333-444455556666",
  directoryName: "小贝",
  revision: "hash-1",
  authorityEnabled: true,
  superiors: [],
  subordinates: ["xiaoma"],
  boundSessions: ["s-1"],
  facetId: "facet_dev",
  facetName: "开发专家",
  selectionRevision: 1,
  firstMeeting: "先自我介绍，再问主人怎么称呼。",
  firstMeetingDone: false,
  suspended: false,
};

const FACET: FacetDetail = {
  id: "facet_dev",
  name: "开发专家",
  summary: "写代码时用",
  revision: "hash-2",
  usedBy: ["xiaobei"],
  body: "按小步改，每步都跑测试。\n",
  markdown: FACET_MARKDOWN,
};

const BODY_TEXT = "# 小贝\n\n底线正文。\n";
const BODY_BYTES = Buffer.byteLength(BODY_TEXT, "utf8");

function fakeHost(overrides: Partial<SoulViewHost> = {}) {
  const calls: Array<{ method: string; input: unknown }> = [];
  const profileState: ProfileSummary[] = [{ ...XIAOBEI }];
  const facetState: FacetDetail[] = [{ ...FACET }];
  const bindingState: SessionBindingSummary[] = [{ sessionId: "s-1", profileId: "xiaobei" }];
  const bodyState = new Map<string, ProfileBodyView>([
    ["xiaobei", { profileId: "xiaobei", revision: "hash-1", body: BODY_TEXT, bytes: BODY_BYTES, history: [] }],
  ]);
  /** 留痕里存下的整份正文：修订 → 正文。回滚就从这里取。 */
  const archivedBodies = new Map<string, string>();
  const suspensionState: SuspensionEntry[] = [];
  /** 引用检查与回收范围：详情与停用回执看到的是同一份，别让两处各编一套。 */
  function inspectionOf(target: ProfileSummary): ProfileInspection {
    return {
      references: {
        sessions: [...target.boundSessions],
        teams: [{ teamId: "alpha", kind: "member", laneId: "lane_plan", role: "commander" }],
        unreadableTeams: [],
        superiors: [...target.superiors],
        subordinates: [...target.subordinates],
      },
      reclaimScope: [
        { path: `agents/${target.directoryName}/SOUL.md`, what: "底线正文", action: "move" },
        { path: `agents/${target.id}`, what: "记忆目录", action: "keep" },
      ],
    };
  }
  const host: SoulViewHost = {
    dataRoot: DATA_ROOT,
    async listProfiles() {
      calls.push({ method: "listProfiles", input: undefined });
      return profileState.map((item) => ({ ...item }));
    },
    async createProfile(input) {
      calls.push({ method: "createProfile", input });
      const created: ProfileSummary = {
        ...XIAOBEI,
        id: input.id,
        name: input.name,
        summary: input.summary,
        directoryName: input.directoryName,
        owner: input.owner,
        boundSessions: [],
        facetId: null,
        facetName: null,
        selectionRevision: 0,
        revision: "hash-new",
      };
      profileState.push(created);
      return created;
    },
    async saveProfileDisplayFields(input) {
      calls.push({ method: "saveProfileDisplayFields", input });
      const target = profileState.find((item) => item.id === input.profileId);
      if (!target) throw new Error(`没有这份档案: ${input.profileId}`);
      if ("name" in input.changes) target.name = String(input.changes.name);
      if ("avatar" in input.changes) {
        const avatar = String(input.changes.avatar);
        target.avatar = avatar === "" ? undefined : avatar;
      }
      target.revision = "hash-3";
      return { ...target };
    },
    async setFirstMeetingDone(input) {
      calls.push({ method: "setFirstMeetingDone", input });
      const target = profileState.find((item) => item.id === input.profileId);
      if (!target) throw new Error(`没有这份档案: ${input.profileId}`);
      target.firstMeetingDone = input.done;
      return { ...target };
    },
    async loadProfileBody(profileId) {
      calls.push({ method: "loadProfileBody", input: profileId });
      const found = bodyState.get(profileId);
      if (!found) throw new Error(`没有这份档案: ${profileId}`);
      return { ...found, history: found.history.map((entry) => ({ ...entry })) };
    },
    async saveProfileBody(input) {
      calls.push({ method: "saveProfileBody", input });
      const found = bodyState.get(input.profileId);
      if (!found) throw new Error(`没有这份档案: ${input.profileId}`);
      archivedBodies.set(found.revision, found.body);
      const entry: SoulBodyHistoryEntry = {
        revision: found.revision,
        at: "2026-09-22T00:00:00.000Z",
        action: "save",
        bytes: found.bytes,
        nextRevision: "hash-body-2",
        ...(input.note === undefined ? {} : { note: String(input.note) }),
      };
      found.history = [entry, ...found.history];
      found.body = input.body;
      found.revision = "hash-body-2";
      found.bytes = Buffer.byteLength(input.body, "utf8");
      const target = profileState.find((item) => item.id === input.profileId);
      if (target) target.revision = "hash-body-2";
      return { ...(target ?? XIAOBEI) };
    },
    async restoreProfileBody(input) {
      calls.push({ method: "restoreProfileBody", input });
      const found = bodyState.get(input.profileId);
      if (!found) throw new Error(`没有这份档案: ${input.profileId}`);
      const revision = String(input.revision);
      const text = archivedBodies.get(revision);
      if (text === undefined) throw new Error(`留痕里没有这一版: ${revision}`);
      archivedBodies.set(found.revision, found.body);
      const entry: SoulBodyHistoryEntry = {
        revision: found.revision,
        at: "2026-09-22T00:00:00.000Z",
        action: "restore",
        bytes: found.bytes,
        nextRevision: "hash-body-3",
        sourceRevision: revision,
        ...(input.note === undefined ? {} : { note: String(input.note) }),
      };
      found.history = [entry, ...found.history];
      found.body = text;
      found.revision = "hash-body-3";
      found.bytes = Buffer.byteLength(text, "utf8");
      const target = profileState.find((item) => item.id === input.profileId);
      if (target) target.revision = "hash-body-3";
      return { ...(target ?? XIAOBEI) };
    },
    async setProfileSuspended(input) {
      calls.push({ method: "setProfileSuspended", input });
      const target = profileState.find((item) => item.id === input.profileId);
      if (!target) throw new Error(`没有这份档案: ${input.profileId}`);
      target.suspended = input.suspended;
      const at = "2026-09-23T01:00:00.000Z";
      const entry: SuspensionEntry = {
        profileId: target.id,
        name: target.name,
        directoryName: target.directoryName,
        suspended: input.suspended,
        at,
        ...(input.note === undefined ? {} : { note: String(input.note) }),
      };
      suspensionState.unshift(entry);
      const receipt: ProfileSuspension = {
        profileId: target.id,
        name: target.name,
        suspended: input.suspended,
        at,
        stateFile: `agents/${target.directoryName}/state.json`,
        logFile: "runtime/suspensions.jsonl",
        ...inspectionOf(target),
      };
      return receipt;
    },
    async inspectProfile(profileId) {
      calls.push({ method: "inspectProfile", input: profileId });
      const target = profileState.find((item) => item.id === profileId);
      if (!target) throw new Error(`没有这份档案: ${profileId}`);
      return inspectionOf(target);
    },
    async loadSuspensionHistory(profileId) {
      calls.push({ method: "loadSuspensionHistory", input: profileId });
      return suspensionState.filter((entry) => entry.profileId === profileId).map((entry) => ({ ...entry }));
    },
    async deleteProfile(input) {
      calls.push({ method: "deleteProfile", input });
      const index = profileState.findIndex((item) => item.id === input.profileId);
      if (index < 0) throw new Error(`没有这份档案: ${input.profileId}`);
      const target = profileState[index]!;
      profileState.splice(index, 1);
      return {
        profileId: target.id,
        name: target.name,
        directoryName: target.directoryName,
        archiveDirectory: `agents/${target.directoryName}`,
        memoryDirectory: `agents/${target.id}`,
        movedTo: `trash/2026-09-23T00-00-00-000Z-${target.directoryName}`,
        moved: ["SOUL.md", "state.json", "history"],
        leftBehind: [],
        removedDirectory: true,
        boundSessions: [...target.boundSessions],
        at: "2026-09-23T00:00:00.000Z",
      };
    },
    async listFacets() {
      calls.push({ method: "listFacets", input: undefined });
      return facetState.map(({ body: _body, markdown: _markdown, ...rest }): FacetSummary => ({ ...rest }));
    },
    async loadFacet(facetId) {
      calls.push({ method: "loadFacet", input: facetId });
      const found = facetState.find((item) => item.id === facetId);
      if (!found) throw new Error(`没有这个模组: ${facetId}`);
      return { ...found };
    },
    async saveFacet(input) {
      calls.push({ method: "saveFacet", input });
      const target = facetState.find((item) => item.id === input.facetId);
      if (!target) throw new Error(`没有这个模组: ${input.facetId}`);
      if ("name" in input.changes) target.name = String(input.changes.name);
      if ("summary" in input.changes) target.summary = String(input.changes.summary);
      if ("body" in input.changes) target.body = String(input.changes.body);
      target.revision = "hash-4";
      return { ...target };
    },
    async listBindings() {
      calls.push({ method: "listBindings", input: undefined });
      return bindingState.map((item) => ({ ...item }));
    },
    async bindSession(input) {
      calls.push({ method: "bindSession", input });
      bindingState.push({ sessionId: input.sessionId, profileId: input.profileId });
      return bindingState.map((item) => ({ ...item }));
    },
    async unbindSession(sessionId) {
      calls.push({ method: "unbindSession", input: sessionId });
      const index = bindingState.findIndex((item) => item.sessionId === sessionId);
      if (index < 0) throw new Error(`这个会话没有绑定档案: ${sessionId}`);
      bindingState.splice(index, 1);
      return bindingState.map((item) => ({ ...item }));
    },
    async selectFacet(input) {
      calls.push({ method: "selectFacet", input });
      return {
        profileId: input.profileId,
        facetId: input.facetId,
        name: input.facetId === null ? null : "开发专家",
        selectionRevision: 2,
      };
    },
    ...overrides,
  };
  return { host, calls, profileState, facetState, bindingState, suspensionState };
}

function views(overrides: Partial<SoulViewHost> = {}) {
  const fake = fakeHost(overrides);
  const [profiles, facets] = createSoulViews(() => fake.host);
  return { profiles, facets, ...fake };
}

/** 保存/动作之后视图会重读一遍卡片，所以 `calls.at(-1)` 未必是那次写入。 */
function lastCall(calls: ReadonlyArray<{ method: string; input: unknown }>, method: string) {
  return calls.filter((call) => call.method === method).at(-1);
}

/** 按 id 取一节的正文：节插来插去时，断言不必跟着数位置。 */
function sectionLines(body: { sections: readonly { id: string; lines?: readonly string[] }[] }, id: string): string {
  const found = body.sections.find((item) => item.id === id);
  if (found?.lines === undefined) throw new Error(`没有这一节: ${id}`);
  return found.lines.join("\n");
}

describe("void-soul 业务视图", () => {
  it("档案列表：摘要带 id、角色与绑定会话数，meta 是内容哈希", async () => {
    const { profiles } = views();
    expect(await profiles.list(PROFILE)).toEqual([
      { id: "xiaobei", title: "小贝", summary: "xiaobei · 开发专家 · 1 个会话", meta: "修订 hash-1" },
    ]);
  });

  it("档案详情：身份、主人与权限、绑定、当前角色都在，正文不进面板", async () => {
    const { profiles } = views();
    const body = await profiles.detail({ ...PROFILE, itemId: "xiaobei" });
    expect(body.title).toBe("小贝（xiaobei）");
    expect(body.revision).toBe("hash-1");
    expect(body.sections.map((section) => section.id)).toEqual([
      "identity",
      "authority",
      "suspension",
      "body",
      "history",
      "bindings",
      "references",
      "reclaim",
      "facet",
      "first-meeting",
    ]);
    const identity = sectionLines(body, "identity");
    expect(identity).toContain("档案 id：xiaobei");
    expect(identity).toContain("目录：agents/小贝/SOUL.md");
    // 正文不再「只留在磁盘上」：2026-09-22 定案后它进了可编辑字段，卡片里另有留痕那一节。
    expect(identity).not.toContain("只留在磁盘上");
    expect(body.fields!.find((field) => field.key === "body")!.value).toBe(BODY_TEXT);
    expect(body.fields!.find((field) => field.key === "body")!.kind).toBe("markdown");
    expect(body.markdown).toBeUndefined();
    expect(sectionLines(body, "authority")).toContain("下级：xiaoma");
    expect(sectionLines(body, "authority")).toContain("这个入口能改显示名、头像与底线正文");
    const bodySection = sectionLines(body, "body");
    expect(bodySection).toContain(`当前正文：${BODY_TEXT.length} 字符，修订 hash-1`);
    expect(bodySection).toContain("留痕：0 条");
    expect(bodySection).toContain("还没有改动记录");
    expect(bodySection).toContain("改正文不碰 front matter");
    expect(body.sections.find((section) => section.id === "history")!.lines).toEqual(["还没有留痕：改一次正文，这里就会多一条。"]);
    expect(body.sections.find((section) => section.id === "bindings")!.lines).toEqual(["会话 s-1"]);
    expect(sectionLines(body, "facet")).toContain("开发专家（facet_dev）");
    expect(sectionLines(body, "first-meeting")).toContain("档案里写的引导：先自我介绍，再问主人怎么称呼。");
    expect(sectionLines(body, "first-meeting")).toContain("状态：还没做");
    expect(body.fields!.map((field) => field.key)).toEqual(["name", "avatar", "body", "note", "id", "summary", "owner", "authority", "revision"]);
    expect(body.fields!.filter((field) => field.readOnly !== true).map((field) => field.key)).toEqual(["name", "avatar", "body", "note"]);
    expect(body.actions!.map((action) => action.id)).toEqual([
      "bind-session",
      "unbind-session",
      "restore-body",
      "complete-first-meeting",
      "reset-first-meeting",
      "suspend-profile",
      "delete-profile",
    ]);
  });

  it("首次见面：标完成与重来都只动状态，卡片跟着变，不碰底线正文", async () => {
    const { profiles, calls } = views();
    const done = await profiles.act!({ ...PROFILE, itemId: "xiaobei", actionId: "complete-first-meeting", args: {} });
    expect(lastCall(calls, "setFirstMeetingDone")).toEqual({ method: "setFirstMeetingDone", input: { profileId: "xiaobei", done: true } });
    expect(sectionLines(done, "first-meeting")).toContain("状态：已完成");
    // 这两个动作只写状态位：正文与显示名一个字节都没动，正文那一节的修订还是 hash-1。
    expect(sectionLines(done, "body")).toContain("修订 hash-1");
    expect(done.fields!.filter((field) => field.readOnly !== true).map((field) => field.key)).toEqual(["name", "avatar", "body", "note"]);
    const again = await profiles.act!({ ...PROFILE, itemId: "xiaobei", actionId: "reset-first-meeting", args: {} });
    expect(lastCall(calls, "setFirstMeetingDone")).toEqual({ method: "setFirstMeetingDone", input: { profileId: "xiaobei", done: false } });
    expect(sectionLines(again, "first-meeting")).toContain("状态：还没做");
  });

  it("首次见面：不认识的动作用原话拒绝", async () => {
    const { profiles } = views();
    await expect(profiles.act!({ ...PROFILE, itemId: "xiaobei", actionId: "finish-first-meeting", args: {} })).rejects.toThrow(
      "灵魂详情不认识这个动作: finish-first-meeting",
    );
  });

  it("档案详情：没有这份档案就说没有，不编一个空卡片", async () => {
    const { profiles } = views();
    await expect(profiles.detail({ ...PROFILE, itemId: "nobody" })).rejects.toThrow("没有这份档案: nobody");
  });

  it("改档案：只放显示名与头像，修订原样按哈希带回去", async () => {
    const { profiles, calls } = views();
    const body = await profiles.save!({
      ...PROFILE,
      itemId: "xiaobei",
      expectedRevision: "hash-1",
      changes: { name: "贝贝", avatar: "https://example.com/a.png" },
    });
    expect(lastCall(calls, "saveProfileDisplayFields")).toEqual({
      method: "saveProfileDisplayFields",
      input: {
        profileId: "xiaobei",
        changes: { name: "贝贝", avatar: "https://example.com/a.png" },
        expectedRevision: "hash-1",
      },
    });
    expect(body.title).toBe("贝贝（xiaobei）");
    expect(body.fields!.find((field) => field.key === "avatar")!.value).toBe("https://example.com/a.png");
  });

  it("改档案：不开放的字段、空改动、非哈希修订都拒", async () => {
    const { profiles } = views();
    const base = { ...PROFILE, itemId: "xiaobei", expectedRevision: "hash-1" };
    await expect(profiles.save!({ ...base, changes: { owner: "00000000-0000-4000-8000-000000000000" } })).rejects.toThrow(
      "灵魂档案不接受这个改动: owner",
    );
    await expect(profiles.save!({ ...base, changes: { summary: "换个简介" } })).rejects.toThrow("灵魂档案不接受这个改动: summary");
    await expect(profiles.save!({ ...base, changes: {} })).rejects.toThrow("没有要保存的改动");
    await expect(profiles.save!({ ...base, changes: { name: "贝贝" }, expectedRevision: 3 })).rejects.toThrow("文件修订必须是内容哈希: 3");
  });

  it("改正文：面板送整张表单，正文没动就不写盘", async () => {
    const { profiles, calls } = views();
    await profiles.save!({ ...PROFILE, itemId: "xiaobei", expectedRevision: "hash-1", changes: { name: "贝贝", body: BODY_TEXT } });
    expect(calls.some((call) => call.method === "saveProfileBody")).toBe(false);
    expect(lastCall(calls, "saveProfileDisplayFields")).toEqual({
      method: "saveProfileDisplayFields",
      input: { profileId: "xiaobei", changes: { name: "贝贝" }, expectedRevision: "hash-1" },
    });
  });

  it("改正文：正文动了就先写正文，显示名用写完之后的新修订", async () => {
    const { profiles, calls } = views();
    const next = "# 小贝\n\n换个底线。\n";
    const body = await profiles.save!({
      ...PROFILE,
      itemId: "xiaobei",
      expectedRevision: "hash-1",
      changes: { name: "贝贝", body: next, note: "换口径" },
    });
    expect(lastCall(calls, "saveProfileBody")).toEqual({
      method: "saveProfileBody",
      input: { profileId: "xiaobei", body: next, expectedRevision: "hash-1", note: "换口径" },
    });
    expect(lastCall(calls, "saveProfileDisplayFields")).toEqual({
      method: "saveProfileDisplayFields",
      input: { profileId: "xiaobei", changes: { name: "贝贝" }, expectedRevision: "hash-body-2" },
    });
    expect(body.fields!.find((field) => field.key === "body")!.value).toBe(next);
    expect(sectionLines(body, "body")).toContain("修订 hash-body-2");
    expect(sectionLines(body, "body")).toContain("留痕：1 条");
    expect(sectionLines(body, "history").split("\n")[0]).toContain("改写 · 换掉 hash-1");
    expect(sectionLines(body, "history").split("\n")[0]).toContain("· 换口径");
  });

  it("回滚正文：先写一版再滚回去；带原因，缺修订就拒", async () => {
    const { profiles, calls } = views();
    await profiles.save!({ ...PROFILE, itemId: "xiaobei", expectedRevision: "hash-1", changes: { body: "# 小贝\n\n第二版。\n" } });
    const back = await profiles.act!({ ...PROFILE, itemId: "xiaobei", actionId: "restore-body", args: { revision: "hash-1", note: "改坏了" } });
    expect(lastCall(calls, "restoreProfileBody")).toEqual({
      method: "restoreProfileBody",
      input: { profileId: "xiaobei", revision: "hash-1", expectedRevision: "hash-body-2", note: "改坏了" },
    });
    expect(back.fields!.find((field) => field.key === "body")!.value).toBe(BODY_TEXT);
    expect(sectionLines(back, "history").split("\n")[0]).toContain("回滚到 hash-1");
    expect(sectionLines(back, "history").split("\n")[0]).toContain("· 改坏了");
    await expect(profiles.act!({ ...PROFILE, itemId: "xiaobei", actionId: "restore-body", args: {} })).rejects.toThrow("回滚到哪一版是必填");
    await expect(profiles.act!({ ...PROFILE, itemId: "xiaobei", actionId: "restore-body", args: { revision: "deadbeef" } })).rejects.toThrow(
      "留痕里没有这一版: deadbeef",
    );
  });

  it("绑会话与解绑会话：参数必填，未知动作拒绝", async () => {
    const { profiles, calls, bindingState } = views();
    const bound = await profiles.act!({ ...PROFILE, itemId: "xiaobei", actionId: "bind-session", args: { sessionId: "s-2" } });
    expect(lastCall(calls, "bindSession")).toEqual({ method: "bindSession", input: { profileId: "xiaobei", sessionId: "s-2" } });
    expect(bound.sections.find((section) => section.id === "bindings")!.lines).toEqual(["会话 s-1", "会话 s-2"]);
    await profiles.act!({ ...PROFILE, itemId: "xiaobei", actionId: "unbind-session", args: { sessionId: "s-1" } });
    expect(bindingState.map((item) => item.sessionId)).toEqual(["s-2"]);
    await expect(profiles.act!({ ...PROFILE, itemId: "xiaobei", actionId: "bind-session", args: {} })).rejects.toThrow("会话 id是必填");
    await expect(profiles.act!({ ...PROFILE, itemId: "xiaobei", actionId: "unbind-session", args: { sessionId: "  " } })).rejects.toThrow("会话 id是必填");
    await expect(profiles.act!({ ...PROFILE, itemId: "xiaobei", actionId: "rename", args: {} })).rejects.toThrow("灵魂详情不认识这个动作: rename");
  });

  it("新建档案：四个必填 + 可选主人；缺项与未知动作都拒", async () => {
    const { profiles, calls } = views();
    await profiles.actView!({
      ...PROFILE,
      actionId: "new-profile",
      args: { id: "xiaoma", directoryName: "小码", name: "小码", summary: "干活的", owner: "  " },
    });
    expect(lastCall(calls, "createProfile")).toEqual({
      method: "createProfile",
      input: { id: "xiaoma", directoryName: "小码", name: "小码", summary: "干活的" },
    });
    await expect(
      profiles.actView!({ ...PROFILE, actionId: "new-profile", args: { directoryName: "小码", name: "小码", summary: "x" } }),
    ).rejects.toThrow("档案 id是必填");
    await expect(
      profiles.actView!({ ...PROFILE, actionId: "new-profile", args: { id: "x", directoryName: "小码", name: "x", summary: "x", owner: 7 } }),
    ).rejects.toThrow("主人 UUID必须是文本");
    await expect(profiles.actView!({ ...PROFILE, actionId: "delete-profile", args: {} })).rejects.toThrow(
      "灵魂档案列表不认识这个动作: delete-profile",
    );
    expect(profiles.viewActions!.map((action) => action.id)).toEqual(["new-profile"]);
  });

  it("模组列表与详情：整份 Markdown 交出去当安全文本，正文是可编辑的多行字段", async () => {
    const { facets } = views();
    expect(await facets.list(PROFILE)).toEqual([
      { id: "facet_dev", title: "开发专家", summary: "写代码时用", meta: "修订 hash-2 · 1 个档案在用" },
    ]);
    const body = await facets.detail({ ...PROFILE, itemId: "facet_dev" });
    expect(body.markdown).toBe(FACET_MARKDOWN);
    expect(body.revision).toBe("hash-2");
    expect(body.sections[0]!.lines).toEqual(["档案 xiaobei 正在用"]);
    const text = body.fields!.find((field) => field.key === "body")!;
    expect(text.kind).toBe("markdown");
    expect(text.readOnly).toBeUndefined();
    expect(text.value).toBe("按小步改，每步都跑测试。\n");
    expect(body.fields!.filter((field) => field.readOnly === true).map((field) => field.key)).toEqual(["id", "revision"]);
    expect(body.actions).toBeUndefined();
    await expect(facets.detail({ ...PROFILE, itemId: "nope" })).rejects.toThrow("没有这个模组: nope");
  });

  it("模组没人用时直说没人用", async () => {
    const lonely = fakeHost();
    lonely.facetState[0]!.usedBy = [];
    const [, facets] = createSoulViews(() => lonely.host);
    const body = await facets.detail({ ...PROFILE, itemId: "facet_dev" });
    expect(body.sections[0]!.lines).toEqual(["现在没有档案把这份模组选成角色。"]);
  });

  it("改模组：显示名、简介、正文放行，其余拒绝", async () => {
    const { facets, calls } = views();
    const body = await facets.save!({
      ...PROFILE,
      itemId: "facet_dev",
      expectedRevision: "hash-2",
      changes: { summary: "改代码时用", body: "先写测试。\n" },
    });
    expect(lastCall(calls, "saveFacet")).toEqual({
      method: "saveFacet",
      input: { facetId: "facet_dev", changes: { summary: "改代码时用", body: "先写测试。\n" }, expectedRevision: "hash-2" },
    });
    expect(body.title).toBe("开发专家（facet_dev）");
    expect(body.fields!.find((field) => field.key === "body")!.value).toBe("先写测试。\n");
    await expect(
      facets.save!({ ...PROFILE, itemId: "facet_dev", expectedRevision: "hash-2", changes: { id: "facet_other" } }),
    ).rejects.toThrow("模组详情不接受这个改动: id");
    await expect(facets.save!({ ...PROFILE, itemId: "facet_dev", expectedRevision: "hash-2", changes: {} })).rejects.toThrow("没有要保存的改动");
    await expect(facets.save!({ ...PROFILE, itemId: "facet_dev", expectedRevision: "", changes: { name: "x" } })).rejects.toThrow(
      "文件修订必须是内容哈希",
    );
  });

  it("指派与清除模组：清除是显式的无角色", async () => {
    const { facets, calls } = views();
    await facets.actView!({ ...PROFILE, actionId: "assign-facet", args: { profileId: "xiaobei", facetId: "facet_dev" } });
    expect(lastCall(calls, "selectFacet")).toEqual({ method: "selectFacet", input: { profileId: "xiaobei", facetId: "facet_dev" } });
    await facets.actView!({ ...PROFILE, actionId: "clear-facet", args: { profileId: "xiaobei" } });
    expect(lastCall(calls, "selectFacet")).toEqual({ method: "selectFacet", input: { profileId: "xiaobei", facetId: null } });
    await expect(facets.actView!({ ...PROFILE, actionId: "assign-facet", args: { profileId: "xiaobei" } })).rejects.toThrow("模组 id是必填");
    await expect(facets.actView!({ ...PROFILE, actionId: "clear-facet", args: {} })).rejects.toThrow("档案 id是必填");
    await expect(facets.actView!({ ...PROFILE, actionId: "reload", args: {} })).rejects.toThrow("模组库列表不认识这个动作: reload");
    expect(facets.viewActions!.map((action) => action.id)).toEqual(["assign-facet", "clear-facet"]);
  });

  it("删档案：危险动作要再敲一遍 id，回执说清删了什么、什么没动、怎么捞回来", async () => {
    const { profiles, calls } = views();
    const body = await profiles.detail({ ...PROFILE, itemId: "xiaobei" });
    const action = body.actions!.find((item) => item.id === "delete-profile")!;
    expect(action.danger).toBe(true);
    expect(action.hint).toContain("要删就再敲一遍 xiaobei");
    expect(action.args!.map((arg) => arg.key)).toEqual(["confirmProfileId", "note"]);

    const receipt = await profiles.act!({
      ...PROFILE,
      itemId: "xiaobei",
      actionId: "delete-profile",
      args: { confirmProfileId: "xiaobei", note: "主人说不用了" },
      expectedRevision: "hash-1",
    });
    expect(lastCall(calls, "deleteProfile")).toEqual({
      method: "deleteProfile",
      input: { profileId: "xiaobei", expectedRevision: "hash-1", note: "主人说不用了" },
    });
    expect(receipt.title).toBe("已删除 小贝（xiaobei）");
    const removed = receipt.sections.find((section) => section.id === "removed")!.lines!.join("\n");
    expect(removed).toContain("档案目录：agents/小贝/");
    expect(removed).toContain("搬走：SOUL.md、state.json、history");
    expect(removed).toContain("trash/deletions.jsonl");
    const kept = receipt.sections.find((section) => section.id === "kept")!.lines!.join("\n");
    expect(kept).toContain("记忆：agents/xiaobei/（MEMORY.md、memory/、memory.sqlite、retracted/）一个字节没动。");
    expect(kept).toContain("聊天记录：dsh 原生的会话流水照旧留着，删档案不删它。");
    expect(kept).toContain("还绑着 1 个会话（s-1）");
    expect(receipt.sections.find((section) => section.id === "restore")!.lines!.join("\n")).toContain("trash/");
    // 这一条已经不在列表里了。
    expect(await profiles.list(PROFILE)).toEqual([]);
  });

  it("删档案：id 敲错就不动手，没给修订就不设栅", async () => {
    const { profiles, calls } = views();
    await expect(
      profiles.act!({ ...PROFILE, itemId: "xiaobei", actionId: "delete-profile", args: { confirmProfileId: "xiaoma" } }),
    ).rejects.toThrow("确认的档案 id 和要删的不是同一份: xiaoma ≠ xiaobei");
    await expect(
      profiles.act!({ ...PROFILE, itemId: "xiaobei", actionId: "delete-profile", args: {} }),
    ).rejects.toThrow("确认用的档案 id是必填");
    expect(lastCall(calls, "deleteProfile")).toBeUndefined();

    await profiles.act!({ ...PROFILE, itemId: "xiaobei", actionId: "delete-profile", args: { confirmProfileId: "xiaobei" } });
    expect(lastCall(calls, "deleteProfile")).toEqual({ method: "deleteProfile", input: { profileId: "xiaobei" } });
  });

  it("停用：列表上标出来，详情多出停用、引用检查与回收范围三节", async () => {
    const fake = fakeHost();
    fake.profileState[0]!.suspended = true;
    const [profiles] = createSoulViews(() => fake.host);
    expect(await profiles.list(PROFILE)).toEqual([
      { id: "xiaobei", title: "小贝（已停用）", summary: "xiaobei · 开发专家 · 1 个会话", meta: "修订 hash-1 · 已停用" },
    ]);
    const body = await profiles.detail({ ...PROFILE, itemId: "xiaobei" });
    const suspension = sectionLines(body, "suspension");
    expect(suspension).toContain("状态：已停用");
    expect(suspension).toContain("只改 state.json 里的一个布尔值");
    expect(suspension).toContain("还没有停用/启用记录。");
    expect(suspension).toContain("留痕：runtime/suspensions.jsonl");
    // 引用检查三处来源都在：绑定会话、军团队伍、组织图。
    const references = sectionLines(body, "references");
    expect(references).toContain("绑定会话：1 个（s-1）");
    expect(references).toContain("alpha 的 lane_plan 当commander");
    expect(references).toContain("组织图：别人写它当上级的 没有；写它当下级的 xiaoma");
    expect(references).toContain("引用只报事实");
    // 回收范围是预览：哪些搬、哪些一个字节都不动，逐条写出来。
    const reclaim = sectionLines(body, "reclaim");
    expect(reclaim).toContain("搬进回收站：agents/小贝/SOUL.md");
    expect(reclaim).toContain("一个字节都不动：agents/xiaobei");
    expect(reclaim).toContain("这是预览");
    // 停用不是危险动作：可逆、不删字节，按错了再按回来就是。
    const resume = body.actions!.find((action) => action.id === "resume-profile")!;
    expect(resume.danger).toBeUndefined();
    expect(resume.args!.map((arg) => arg.key)).toEqual(["note"]);
    expect(body.actions!.some((action) => action.id === "suspend-profile")).toBe(false);
  });

  it("停用：读不了的队伍文件照样报出来，不当成「没有引用」", async () => {
    const fake = fakeHost();
    fake.profileState[0]!.suspended = true;
    const inspection = await fake.host.inspectProfile("xiaobei");
    const [profiles] = createSoulViews(() => ({
      ...fake.host,
      async inspectProfile() {
        return { ...inspection, references: { ...inspection.references, unreadableTeams: [{ file: "legion/teams/beta.json", reason: "不是能读的 JSON", detail: "Unexpected token" }] } };
      },
    }));
    const body = await profiles.detail({ ...PROFILE, itemId: "xiaobei" });
    const references = sectionLines(body, "references");
    expect(references).toContain("读不了的队伍文件：legion/teams/beta.json（不是能读的 JSON：Unexpected token）");
    expect(references).toContain("这一处不算「没有引用」");
  });

  it("停用：面板把原因写进留痕，回执说清改了什么、什么没动", async () => {
    const { profiles, calls, suspensionState } = views();
    const receipt = await profiles.act!({
      ...PROFILE,
      itemId: "xiaobei",
      actionId: "suspend-profile",
      args: { note: "先在旁边看着" },
    });
    expect(lastCall(calls, "setProfileSuspended")).toEqual({
      method: "setProfileSuspended",
      input: { profileId: "xiaobei", suspended: true, note: "先在旁边看着" },
    });
    expect(suspensionState).toEqual([
      { profileId: "xiaobei", name: "小贝", directoryName: "小贝", suspended: true, at: "2026-09-23T01:00:00.000Z", note: "先在旁边看着" },
    ]);
    expect(receipt.title).toBe("已停用 小贝（xiaobei）");
    expect(receipt.sections.map((section) => section.id)).toEqual(["changed", "kept", "references", "reclaim"]);
    const changed = sectionLines(receipt, "changed");
    expect(changed).toContain("状态：已停用");
    expect(changed).toContain("suspended=true");
    expect(changed).toContain("agents/小贝/state.json");
    expect(changed).toContain("runtime/suspensions.jsonl");
    expect(changed).toContain("通知栏");
    const kept = sectionLines(receipt, "kept");
    expect(kept).toContain("一个字节都没动");
    expect(kept).toContain("这不是删除");
    // 卡片跟着变成「已停用」，动作也换成启用那一条，并且留痕进了停用那一节。
    const after = await profiles.detail({ ...PROFILE, itemId: "xiaobei" });
    expect(sectionLines(after, "suspension")).toContain("最近一次：2026-09-23T01:00:00.000Z 由人停用 · 先在旁边看着");
    expect(after.actions!.map((action) => action.id)).toContain("resume-profile");
    expect(after.actions!.some((action) => action.id === "suspend-profile")).toBe(false);
  });

  it("启用：不写原因也放行，回执是启用那一份", async () => {
    const fake = fakeHost();
    fake.profileState[0]!.suspended = true;
    const [profiles] = createSoulViews(() => fake.host);
    const receipt = await profiles.act!({ ...PROFILE, itemId: "xiaobei", actionId: "resume-profile", args: {} });
    expect(lastCall(fake.calls, "setProfileSuspended")).toEqual({ method: "setProfileSuspended", input: { profileId: "xiaobei", suspended: false } });
    expect(receipt.title).toBe("已启用 小贝（xiaobei）");
    const changed = sectionLines(receipt, "changed");
    expect(changed).toContain("状态：启用中");
    expect(changed).toContain("suspended=false");
    expect(changed).toContain("下一轮装配就把底线与角色装回来");
    // 空白的「原因」当作没写，不会在留痕里留一条空备注。
    await profiles.act!({ ...PROFILE, itemId: "xiaobei", actionId: "resume-profile", args: { note: "   " } });
    expect(lastCall(fake.calls, "setProfileSuspended")).toEqual({ method: "setProfileSuspended", input: { profileId: "xiaobei", suspended: false } });
    await expect(profiles.act!({ ...PROFILE, itemId: "nobody", actionId: "suspend-profile", args: {} })).rejects.toThrow("没有这份档案: nobody");
  });

  it("每个操作都核对档案：换一个 profile 就不许串着用", async () => {
    const { profiles, facets } = views();
    const other = { home: "E:/isolated", name: "headless" };
    const mismatch = /业务视图的档案与灵魂数据根不一致/;
    await expect(profiles.list(other)).rejects.toThrow(mismatch);
    await expect(profiles.detail({ ...other, itemId: "xiaobei" })).rejects.toThrow(mismatch);
    await expect(profiles.save!({ ...other, itemId: "xiaobei", expectedRevision: "hash-1", changes: { name: "x" } })).rejects.toThrow(mismatch);
    await expect(profiles.act!({ ...other, itemId: "xiaobei", actionId: "bind-session", args: { sessionId: "s" } })).rejects.toThrow(mismatch);
    await expect(
      profiles.actView!({ ...other, actionId: "new-profile", args: { id: "x", directoryName: "x", name: "x", summary: "x" } }),
    ).rejects.toThrow(mismatch);
    await expect(facets.list(other)).rejects.toThrow(mismatch);
    await expect(facets.detail({ ...other, itemId: "facet_dev" })).rejects.toThrow(mismatch);
    await expect(facets.save!({ ...other, itemId: "facet_dev", expectedRevision: "hash-2", changes: { name: "x" } })).rejects.toThrow(mismatch);
    await expect(facets.actView!({ ...other, actionId: "clear-facet", args: { profileId: "xiaobei" } })).rejects.toThrow(mismatch);
  });

  it("服务没装上或没有数据根时说清楚，不假装能用", async () => {
    const missing = createSoulViews(() => undefined);
    await expect(missing[0].list(PROFILE)).rejects.toThrow("灵魂服务没装上，业务视图不可用");
    await expect(missing[1].list(PROFILE)).rejects.toThrow("灵魂服务没装上，业务视图不可用");
    const { profiles } = views({ dataRoot: undefined });
    await expect(profiles.list(PROFILE)).rejects.toThrow("灵魂没有数据根，业务视图不可用");
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
    const { host } = fakeHost();
    const disposers: Array<() => void> = [];
    const fakeCtx = {
      inject: (_deps: string[], callback: (ctx: unknown) => void) =>
        callback({
          get: (name: string) => (name === "voidSuite" ? suite : host),
          effect: (factory: () => () => void) => {
            disposers.push(factory());
          },
        }),
    };

    apply(fakeCtx as never);
    expect(registered).toEqual([PROFILE_VIEW_ID, FACET_VIEW_ID]);
    for (const dispose of disposers) dispose();
    expect(registered).toEqual([]);
  });
});
