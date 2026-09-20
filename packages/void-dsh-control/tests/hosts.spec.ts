import { describe, expect, it } from "vitest";
import { createHostPorts } from "../src/hosts.js";

/**
 * 记录每次 `sessionController.create()` 收到的参数，并按 rc.2 宿主的真实契约校验。
 *
 * 宿主明确要求 `workspaceId` 与 `cwd` **二选一**；同时传两者会抛
 * `dsh-control/host-unavailable`。真机 M2 就是这么失败的，所以这里把契约本身也模拟出来，
 * 而不是只断言「参数长什么样」——前者能挡住实现改回旧写法，后者不能。
 *
 * @returns 参数记录与被 `as never` 收窄的假 ctx。
 */
function fakeHost(): { requests: Array<Record<string, unknown>>; ctx: never } {
  const requests: Array<Record<string, unknown>> = [];
  const ctx = {
    sessionController: {
      async create(request: Record<string, unknown>) {
        requests.push(request);
        if (request.workspaceId !== undefined && request.cwd !== undefined) {
          throw new Error("session.create accepts workspaceId or cwd, not both");
        }
        return { sessionId: "session-created" };
      },
    },
  } as never;
  return { requests, ctx };
}

describe("host port adapter: Session creation contract", () => {
  it("sends either workspaceId or cwd, never both, to the DSH controller", async () => {
    const { requests, ctx } = fakeHost();

    await expect(
      createHostPorts(ctx).createSession({ workspaceId: "workspace-1", cwd: "E:/work/app" }),
    ).resolves.toEqual({ sessionId: "session-created" });
    expect(requests).toEqual([{ workspaceId: "workspace-1" }]);
  });

  it("prefers workspaceId, because a Workspace already carries its cwd", async () => {
    // 两者都给时选稳定的那个身份，而不是路径——路径会变，workspaceId 不会。
    const { requests, ctx } = fakeHost();
    await createHostPorts(ctx).createSession({ workspaceId: "workspace-1", cwd: "E:/work/app" });
    expect(requests[0]).toHaveProperty("workspaceId", "workspace-1");
    expect(requests[0]).not.toHaveProperty("cwd");
  });

  it("still accepts a bare cwd, for callers with no registered Workspace", async () => {
    // 这条分支是 `workspaceId` 缺失时的**正常**路径，不是兜底——修 M2 时不能顺手把它丢了。
    const { requests, ctx } = fakeHost();
    await expect(createHostPorts(ctx).createSession({ cwd: "E:/work/app" })).resolves.toEqual({
      sessionId: "session-created",
    });
    expect(requests).toEqual([{ cwd: "E:/work/app" }]);
  });

  it("omits both selectors rather than sending undefined placeholders", async () => {
    // 传 `{ workspaceId: undefined }` 与不传是两回事：前者在有些实现里仍算「提供了该字段」。
    const { requests, ctx } = fakeHost();
    await createHostPorts(ctx).createSession({});
    expect(requests).toEqual([{}]);
  });

  it("passes agentPreset through alongside whichever selector is used", async () => {
    const { requests, ctx } = fakeHost();
    await createHostPorts(ctx).createSession({ workspaceId: "workspace-1", agentPreset: "standard" });
    expect(requests).toEqual([{ workspaceId: "workspace-1", agentPreset: "standard" }]);
  });
});
