import { describe, expect, it } from "vitest";
import { openSession } from "../src/client/session-jump.js";

/**
 * 跳会话的顺序是有讲究的：子代理会话必须先把它父会话的子代理目录拉出来，
 * 宿主才认得出「这个孩子属于谁」。真机上漏了这一步的表现是
 * 「历史加载失败：subagent Sessions require their durable parent address（session/agent-busy）」——
 * 会话切过去了，但聊天记录读不出来。
 */

interface FakeSummary {
  id?: string;
  parentId?: string;
  origin?: string;
}

function fakeContext(options: {
  byId?: Record<string, FakeSummary>;
  refreshThrows?: boolean;
  address?: unknown;
  hasSessions?: boolean;
  hasWorkspace?: boolean;
  calls: string[];
}) {
  const { calls } = options;
  const sessions =
    options.hasSessions === false
      ? undefined
      : {
          list: { getSnapshot: () => ({ byId: options.byId ?? {} }) },
          refreshSubagents: (parentSessionId: string) => {
            calls.push(`refresh:${parentSessionId}`);
            if (options.refreshThrows === true) throw new Error("目录拉不到");
            return Promise.resolve();
          },
          subagentAddress: () => options.address,
          openSubagent: (address: unknown) => {
            calls.push(`openSubagent:${(address as { childSessionId?: string }).childSessionId ?? "?"}`);
          },
          open: (id: string) => {
            calls.push(`open:${id}`);
          },
        };
  const workspace =
    options.hasWorkspace === false
      ? undefined
      : {
          openSession: (id: string) => {
            calls.push(`workspace:${id}`);
          },
        };
  return {
    get: (name: string) => (name === "sessions" ? sessions : name === "uiWorkspace" ? workspace : undefined),
  } as never;
}

const SUBAGENT_ADDRESS = { kind: "subagent", parentSessionId: "parent-1", childSessionId: "child-1", mode: "continuable" };

describe("跳到原生会话", () => {
  it("子代理会话：先拉父会话的子代理目录，再按直接父地址开", async () => {
    const calls: string[] = [];
    const ctx = fakeContext({
      calls,
      byId: { "child-1": { id: "child-1", origin: "subagent", parentId: "parent-1" } },
      address: SUBAGENT_ADDRESS,
    });
    await expect(openSession(ctx, "child-1")).resolves.toBe(true);
    expect(calls).toEqual(["refresh:parent-1", "openSubagent:child-1"]);
  });

  it("普通会话：不碰子代理目录，直接开", async () => {
    const calls: string[] = [];
    const ctx = fakeContext({ calls, byId: { "session-1": { id: "session-1" } } });
    await expect(openSession(ctx, "session-1")).resolves.toBe(true);
    expect(calls).toEqual(["open:session-1"]);
  });

  it("目录拉不到时退回普通开法：至少把会话切过去", async () => {
    const calls: string[] = [];
    const ctx = fakeContext({
      calls,
      byId: { "child-1": { id: "child-1", origin: "subagent", parentId: "parent-1" } },
      refreshThrows: true,
    });
    await expect(openSession(ctx, "child-1")).resolves.toBe(true);
    expect(calls).toEqual(["refresh:parent-1", "open:child-1"]);
  });

  it("目录里没有这个孩子（取不到地址）时也退回普通开法", async () => {
    const calls: string[] = [];
    const ctx = fakeContext({
      calls,
      byId: { "child-1": { id: "child-1", origin: "subagent", parentId: "parent-1" } },
      address: undefined,
    });
    await expect(openSession(ctx, "child-1")).resolves.toBe(true);
    expect(calls).toEqual(["refresh:parent-1", "open:child-1"]);
  });

  it("没有会话服务时退到 uiWorkspace.openSession", async () => {
    const calls: string[] = [];
    const ctx = fakeContext({ calls, hasSessions: false });
    await expect(openSession(ctx, "session-9")).resolves.toBe(true);
    expect(calls).toEqual(["workspace:session-9"]);
  });

  it("两边都没有时返回 false：面板据此如实说「打不开」，不假装跳了", async () => {
    const calls: string[] = [];
    const ctx = fakeContext({ calls, hasSessions: false, hasWorkspace: false });
    await expect(openSession(ctx, "session-9")).resolves.toBe(false);
    expect(calls).toEqual([]);
  });
});
