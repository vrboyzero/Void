import { describe, expect, it } from "vitest";
import { createRefusalNotifications, REFUSAL_RING_SIZE, SoulRefusalLog } from "../src/refusals.js";

describe("SoulRefusalLog", () => {
  it("记一条拒绝：id 形如 <会话>#<序号>、级别是危险、原文与会话都在", () => {
    const log = new SoulRefusalLog();
    const item = log.record({ sessionId: "s1", reason: "说明书超出本次上下文预算，已拒绝发送：SOUL 200 字", at: new Date("2026-09-22T20:00:00Z") });
    expect(item).toMatchObject({
      id: "s1#1",
      title: "灵魂没装进模型（会话 s1）",
      summary: "说明书超出本次上下文预算，已拒绝发送：SOUL 200 字",
      at: "2026-09-22T20:00:00.000Z",
      level: "danger",
      meta: { 会话: "s1" },
      read: false,
    });
    expect(log.list().map((entry) => entry.id)).toEqual(["s1#1"]);
  });

  it("同一个会话连续拒绝也不重号，新的排在最前面", () => {
    const log = new SoulRefusalLog();
    log.record({ sessionId: "s1", reason: "第一次" });
    log.record({ sessionId: "s1", reason: "第二次" });
    log.record({ sessionId: "s2", reason: "别的会话" });
    expect(log.list().map((entry) => entry.id)).toEqual(["s2#3", "s1#2", "s1#1"]);
  });

  it("标记已读：只算真标到的，已读的还留在列表里", () => {
    const log = new SoulRefusalLog();
    log.record({ sessionId: "s1", reason: "a" });
    log.record({ sessionId: "s1", reason: "b" });
    expect(log.markRead(["s1#1"])).toBe(1);
    // 再标一次不算；不认识的 id 也不算。
    expect(log.markRead(["s1#1", "不存在#9"])).toBe(0);
    expect(log.list().map((entry) => entry.read)).toEqual([false, true]);
  });

  it(`只留最近 ${REFUSAL_RING_SIZE} 条：挤掉的最老那条不再能标记已读`, () => {
    const log = new SoulRefusalLog();
    for (let index = 1; index <= REFUSAL_RING_SIZE + 5; index += 1) {
      log.record({ sessionId: "s1", reason: `第 ${index} 次` });
    }
    expect(log.size).toBe(REFUSAL_RING_SIZE);
    const items = log.list();
    expect(items[0]?.id).toBe(`s1#${REFUSAL_RING_SIZE + 5}`);
    expect(items.at(-1)?.id).toBe("s1#6");
    expect(log.markRead(["s1#1"])).toBe(0);
  });
});

describe("createRefusalNotifications", () => {
  it("空列表时说清什么时候会有，并说明只活在本次进程里", async () => {
    const source = createRefusalNotifications(new SoulRefusalLog());
    expect(source.id).toBe("void-soul:refusals");
    expect(source.title).toBe("灵魂未生效");
    const listed = await source.list();
    expect(listed.items).toEqual([]);
    expect(listed.note).toMatch(/还没有拒绝过/);
  });

  it("能查到档案就把标题写成档案名，查不到就只报会话——两种都要出得来", async () => {
    const log = new SoulRefusalLog();
    log.record({ sessionId: "s1", reason: "超出预算" });
    log.record({ sessionId: "s2", reason: "变量没值" });
    const source = createRefusalNotifications(log, async (sessionId) => (sessionId === "s1" ? { profileId: "xiaobei" } : undefined));
    const listed = await source.list();
    expect(listed.items[0]).toMatchObject({ id: "s2#2", title: "灵魂没装进模型（会话 s2）", meta: { 会话: "s2" } });
    expect(listed.items[1]).toMatchObject({ id: "s1#1", title: "档案 xiaobei 的说明书没装进模型", meta: { 会话: "s1", 档案: "xiaobei" } });
    expect(listed.note).toMatch(/最近 50 条/);
  });

  it("查档案名自己出错时照旧出通知，不把原始拒绝盖掉", async () => {
    const log = new SoulRefusalLog();
    log.record({ sessionId: "s1", reason: "超出预算" });
    const source = createRefusalNotifications(log, async () => { throw new Error("绑定表读不了"); });
    const listed = await source.list();
    expect(listed.items[0]).toMatchObject({ title: "灵魂没装进模型（会话 s1）", summary: "超出预算" });
  });

  it("标记已读走仓库，回真正标到的条数", async () => {
    const log = new SoulRefusalLog();
    log.record({ sessionId: "s1", reason: "a" });
    const source = createRefusalNotifications(log);
    await expect(source.markRead?.(["s1#1"])).resolves.toBe(1);
    await expect(source.markRead?.(["s1#1"])).resolves.toBe(0);
  });
});
