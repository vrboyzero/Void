import { afterEach, describe, expect, it, vi } from "vitest";
import { bootControl, disposeContexts } from "./support/boot.js";
import { FakeSettings } from "./support/fake-settings.js";

/**
 * P6g 的组合面验收：军团终态投递必须**响应式**挂载、**实时**读开关。
 *
 * 控制面不认识军团——它只订阅 `legion/run-terminal`，那条事件由军团服务发出。这里用真
 * Loader 把控制面装起来，再在运行中把 `voidTeam` 服务放进去（军团先装、后装、卸掉、甚至
 * 根本没装，控制面都要能活），验证四件事：
 *
 * 1. 开关打开时，军团终态走**同一个** webhook（同一地址、同一密钥），投递结果回写军团自己
 *    的通知存储，控制面账本不参与；
 * 2. 开关是实时读的：关着时一个字都不发，面板里打开后**下一次**终态就发，不用重启；
 * 3. 军团在但没数据根（没有通知存储）时，适配器安静地不挂；
 * 4. 完全没有军团时插件照常激活——这正是不能把 `voidTeam` 写进插件级 inject 的原因。
 */

const SECRET_ENV = "VOID_DSH_CONTROL_SPEC_LEGION_SECRET";
const NAMESPACE = "dsh-agent-control";
const WEBHOOK = "https://hooks.example.test/void";

interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

function stubFetch(): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({
      url: String(url),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: String(init.body),
    });
    return { ok: true, status: 200 };
  });
  return sent;
}

/** Spin the event loop until the predicate holds (or give up, letting the assertion fail). */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let tick = 0; tick < 200 && !predicate(); tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** Let the service provision reach the plugin's `ctx.inject` reaction. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setTimeout(resolve, 1));
}

function terminalEvent(eventId = "run-1#1") {
  const runId = eventId.split("#")[0]!;
  return {
    eventId,
    runId,
    teamId: "team-a",
    status: "completed",
    finishedAt: "2026-03-01T00:00:00.000Z",
    counts: { total: 1, completed: 1 },
    resultRef: `legion/runs/${runId}.json`,
  };
}

interface FakeLegion {
  readonly patches: Array<{ eventId: string; patch: Record<string, unknown> }>;
  readonly service: unknown;
  listCalls: number;
}

function fakeLegion(withStore = true): FakeLegion {
  const patches: Array<{ eventId: string; patch: Record<string, unknown> }> = [];
  const legion: FakeLegion = {
    patches,
    listCalls: 0,
    service: {
      notifications: withStore
        ? {
            async list() {
              legion.listCalls += 1;
              return [];
            },
            async markDelivery(eventId: string, patch: Record<string, unknown>) {
              patches.push({ eventId, patch });
              return true;
            },
          }
        : undefined,
    },
  };
  return legion;
}

function attach(ctx: Awaited<ReturnType<typeof bootControl>>, service: unknown): void {
  ctx.provide("voidTeam", service as unknown as Parameters<typeof ctx.provide>[1]);
}

const CALLBACK = { enabled: true, url: WEBHOOK, secretEnv: SECRET_ENV };

afterEach(async () => {
  await disposeContexts();
  vi.unstubAllGlobals();
  delete process.env[SECRET_ENV];
});

describe("composition: legion run-terminal delivery", () => {
  it("sends a legion terminal state through the shared webhook and records the outcome", async () => {
    process.env[SECRET_ENV] = "s3cret";
    const sent = stubFetch();
    const ctx = await bootControl({ config: { callback: { ...CALLBACK, includeLegionRuns: true } } });

    const legion = fakeLegion();
    attach(ctx, legion.service);
    // `start()` runs on mount, so a list() call is proof the adapter attached.
    await waitFor(() => legion.listCalls > 0);
    expect(legion.listCalls).toBe(1);

    ctx.emit("legion/run-terminal", terminalEvent());
    await waitFor(() => sent.length > 0);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(WEBHOOK);
    // deliveryId 就是军团 eventId：接收端据此幂等。
    expect(sent[0]!.headers["x-dsh-control-delivery"]).toBe("run-1#1");
    expect(sent[0]!.headers["x-dsh-control-event"]).toBe("completed");
    expect(JSON.parse(sent[0]!.body).resultRef).toBe("legion/runs/run-1.json");

    await waitFor(() => legion.patches.length > 0);
    expect(legion.patches).toHaveLength(1);
    expect(legion.patches[0]!.eventId).toBe("run-1#1");
    expect(legion.patches[0]!.patch).toEqual({ attempts: 1, deliveredAt: expect.any(String) });
  });

  it("follows the panel switch without a restart", async () => {
    process.env[SECRET_ENV] = "s3cret";
    const sent = stubFetch();
    const settings = new FakeSettings();
    const ctx = await bootControl({
      settings,
      config: { callback: { ...CALLBACK, includeLegionRuns: false } },
    });

    const legion = fakeLegion();
    attach(ctx, legion.service);
    // 适配器无条件挂载（开关只决定发不发），所以 list() 调用就是「挂上了」的证据。
    await waitFor(() => legion.listCalls > 0);
    expect(legion.listCalls).toBe(1);

    ctx.emit("legion/run-terminal", terminalEvent());
    await settle();
    expect(sent).toHaveLength(0);
    expect(legion.patches).toHaveLength(0);

    // 面板把整份 callback 写进设置（顶层整体替换，正是面板提示里警告的那件事）。
    settings.update(NAMESPACE, { callback: { ...CALLBACK, includeLegionRuns: true } });
    ctx.emit("legion/run-terminal", terminalEvent("run-2#1"));
    await waitFor(() => sent.length > 0);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers["x-dsh-control-delivery"]).toBe("run-2#1");
  });

  it("stays off when the legion service publishes no notification store", async () => {
    process.env[SECRET_ENV] = "s3cret";
    const sent = stubFetch();
    const ctx = await bootControl({ config: { callback: { ...CALLBACK, includeLegionRuns: true } } });

    // 军团没配数据根：没有那份落盘文件，也就没有地方记投递结果。
    attach(ctx, fakeLegion(false).service);
    await settle();

    ctx.emit("legion/run-terminal", terminalEvent());
    await settle();
    expect(sent).toHaveLength(0);
    // 插件本身照常激活。
    expect(ctx.get("voidDshControl")).toBeDefined();
  });

  it("activates without legion at all", async () => {
    process.env[SECRET_ENV] = "s3cret";
    const sent = stubFetch();
    const ctx = await bootControl({ config: { callback: { ...CALLBACK, includeLegionRuns: true } } });

    await settle();
    expect(ctx.get("voidDshControl")).toBeDefined();
    expect(sent).toHaveLength(0);
  });
});
