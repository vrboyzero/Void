import { afterEach, describe, expect, it, vi } from "vitest";
import { postDetailAction, postFacetSelection, postJson, VOID_REQUEST_HEADER } from "../src/client/api.js";

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

/**
 * `postJson` 的契约是「**不抛**，把失败收成 `{ ok: false, error }`」。
 *
 * 这条契约是面板上所有改动类按钮的底座：任何一处让它破掉，调用方那边就成了
 * 「点了没反应」——没有错误、没有提示、也没有重试。
 */
describe("void-entry 改动类请求", () => {
  it("成功时只回 { ok: true }，不回服务端的载荷", async () => {
    stubFetch({ ok: true, detail: { title: "不该被带出来" } });
    expect(await postJson("/void/api/detail", { op: "act" })).toEqual({ ok: true });
  });

  it("带上同源标记与 JSON 内容类型", async () => {
    const calls = stubFetch({ ok: true });
    await postJson("/void/api/detail", { op: "act" });

    const init = calls[0]!.init!;
    expect(calls[0]!.url).toBe("/void/api/detail");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)[VOID_REQUEST_HEADER]).toBe("1");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ op: "act" });
  });

  it("服务端写明了原因就用它的原文，不换成 HTTP 码", async () => {
    stubFetch({ error: "队伍 demo 的修订已经变了，请重读后再改" }, false, 409);
    expect(await postJson("/void/api/detail", {})).toEqual({
      ok: false,
      error: "队伍 demo 的修订已经变了，请重读后再改",
    });
  });

  it("服务端没说原因时退回 HTTP 码", async () => {
    stubFetch({}, false, 500);
    expect(await postJson("/void/api/detail", {})).toEqual({ ok: false, error: "HTTP 500" });
  });

  it("响应体读不出来时按 HTTP 状态定成败：200 仍算成功", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    }));
    // 改动类请求的成败看状态码，不依赖响应体：服务端已经收下了这次写入，
    // 因为末尾没给 JSON 就报「失败」会让人重复提交一次。
    expect(await postJson("/void/api/detail", {})).toEqual({ ok: true });
  });

  it("**连不上时回 { ok: false }，不往外抛**", async () => {
    // 这是这条契约里最要紧的一半：网络层失败不是 HTTP 错误码，`fetch` 会**拒绝**。
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(postJson("/void/api/detail", {})).resolves.toMatchObject({ ok: false });
  });

  it("连不上时把底层原文带出来，好和服务端拒绝区分开", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("connection reset by peer");
    });
    const outcome = await postJson("/void/api/detail", {});
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/connection reset by peer/);
  });
});

describe("void-entry 改动类请求：具体端点", () => {
  it("详情动作打到 /void/api/detail", async () => {
    const calls = stubFetch({ ok: true });
    await postDetailAction({ view: "void-legion:teams", op: "act" });
    expect(calls[0]!.url).toBe("/void/api/detail");
  });

  it("切角色打到 /void/api/facet-selection，并且带上必填的修订号", async () => {
    // `expectedRevision` 是乐观锁，省略会回 400、传错会回 409——不能为了省事放宽它。
    const calls = stubFetch({ ok: true });
    await postFacetSelection({ agentId: "belldandy", facetId: null, expectedRevision: 7 });

    expect(calls[0]!.url).toBe("/void/api/facet-selection");
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
      agentId: "belldandy",
      facetId: null,
      expectedRevision: 7,
    });
  });

  it("切角色失败时同样不抛，把原因带回来", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(postFacetSelection({ agentId: "belldandy", facetId: null, expectedRevision: 7 })).resolves.toMatchObject({
      ok: false,
    });
  });
});
