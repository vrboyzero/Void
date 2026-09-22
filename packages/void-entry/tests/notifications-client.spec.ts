import { afterEach, describe, expect, it, vi } from "vitest";
import { VOID_REQUEST_HEADER } from "../src/client/details.js";
import { loadNotifications, markNotificationsRead } from "../src/client/notifications.js";

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

describe("void-entry notification client", () => {
  it("reads the feed and tolerates a partial payload", async () => {
    const calls = stubFetch({ items: [{ id: "a#1", source: "s", sourceTitle: "来源", title: "跑完了", at: "2026-09-22T08:00:00.000Z" }] });
    const outcome = await loadNotifications();

    expect(calls[0]!.url).toBe("/void/api/notifications");
    expect(calls[0]!.init?.method).toBeUndefined();
    expect(outcome).toEqual({
      ok: true,
      value: {
        items: [{ id: "a#1", source: "s", sourceTitle: "来源", title: "跑完了", at: "2026-09-22T08:00:00.000Z" }],
        // 缺字段按「没有」处理：少画一条总比整栏崩掉强。
        unread: 0,
        sources: [],
        notes: [],
      },
    });
  });

  it("passes the host's error text through instead of a bare status", async () => {
    stubFetch({ error: "通知来源 坏来源（broken:one）读不出来：索引打不开" }, false, 500);
    const outcome = await loadNotifications();
    expect(outcome).toEqual({ ok: false, message: "通知来源 坏来源（broken:one）读不出来：索引打不开" });
  });

  it("falls back to the HTTP status when the body is not JSON", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("not json");
      },
    }));
    expect(await loadNotifications()).toEqual({ ok: false, message: "HTTP 502" });
  });

  it("marks items read with the same-origin header and the source's own ids", async () => {
    const calls = stubFetch({ ok: true, source: "void-legion:runs", requested: 2, marked: 2 });
    const outcome = await markNotificationsRead("void-legion:runs", ["run#1", "run#2"]);

    const init = calls[0]!.init!;
    expect(calls[0]!.url).toBe("/void/api/notifications");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect((init.headers as Record<string, string>)[VOID_REQUEST_HEADER]).toBe("1");
    expect(JSON.parse(String(init.body))).toEqual({ op: "read", source: "void-legion:runs", ids: ["run#1", "run#2"] });
    expect(outcome).toEqual({ ok: true, value: { ok: true, source: "void-legion:runs", requested: 2, marked: 2 } });
  });

  it("reports a refused mark-read instead of pretending it worked", async () => {
    stubFetch({ error: "这个通知来源不支持标记已读: void-memory:notes" }, false, 400);
    expect(await markNotificationsRead("void-memory:notes", ["m#1"])).toEqual({
      ok: false,
      message: "这个通知来源不支持标记已读: void-memory:notes",
    });
  });
});
