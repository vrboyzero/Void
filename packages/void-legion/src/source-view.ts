/**
 * 外部来源（B8）的面板视图：只读摘要 + 主人动作（启停 / observe-live / 立即轮询 / 测试账号）。
 *
 * 第一期不做配置表单：config 仍由 `legion/sources/github.json` 维护，面板负责让人
 * 看见状态、账本与错误，并能把来源停下来。这比「看起来能改、实际写不进去」安全。
 *
 * @module @void/void-legion/source-view
 */
import type {
  ViewBody,
  ViewField,
  ViewItem,
  ViewProfile,
  ViewSource,
  ViewTextSection,
} from "./detail-view.js";
import type { ExternalSourceSnapshot } from "./external-source.js";

export const SOURCE_VIEW_ID = "void-legion:sources";

/** 视图只需要这几个方法；测试拿假服务顶上，不装整个插件。 */
export interface SourceViewHost {
  readSnapshot(): Promise<ExternalSourceSnapshot | undefined>;
  setMode(mode: "observe" | "live", expectedRevision: number): Promise<ExternalSourceSnapshot>;
  setEnabled(enabled: boolean, expectedRevision: number): Promise<ExternalSourceSnapshot>;
  pollNow(): Promise<unknown>;
  testAuth(): Promise<{ login: string; canPush: boolean }>;
}

function sourceSummary(snapshot: ExternalSourceSnapshot): string {
  const today = snapshot.today;
  return `${snapshot.state} · ${snapshot.runtime.mode} · 今日 观察${today.observed} / 派发${today.dispatched} / 过滤${today.filtered} / 丢弃${today.dropped}`;
}

function configSections(snapshot: ExternalSourceSnapshot): ViewTextSection[] {
  const config = snapshot.config;
  const receive = Object.entries(config.receive)
    .map(([key, value]) => `${key}=${value ? "接收" : "不接收"}`)
    .join(" ");
  const admission = Object.entries(config.admission)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return [
    {
      id: "config",
      title: "来源配置（只读）",
      kind: "table",
      columns: ["项", "值"],
      rows: [
        ["仓库", config.repo],
        ["队伍", config.teamId],
        ["轮询间隔", `${config.intervalMs} ms`],
        ["接收范围", receive],
        ["准入", admission],
        ["允许名单", config.allowed.length === 0 ? "空（谁都不能下单）" : config.allowed.join(", ")],
        ["bots", config.bots.length === 0 ? "空（所有 bot 都不接）" : config.bots.join(", ")],
        ["gh 配置目录", config.ghConfigDir === undefined ? "跟随当前 gh 身份（不推荐）" : config.ghConfigDir],
        ["token 变量名", config.tokenEnv ?? "（未配置）"],
        ["工作区", config.workspace ?? "（宿主当前目录）"],
      ],
    },
  ];
}

function ledgerSection(snapshot: ExternalSourceSnapshot): ViewTextSection {
  const rows = [...snapshot.runtime.entries].reverse().slice(0, 20).map((entry) => [
    entry.at,
    entry.outcome,
    entry.channel ?? "—",
    entry.requester ?? "—",
    entry.runId ?? entry.eventId ?? "—",
    entry.reason ?? entry.detail ?? "—",
  ]);
  return {
    id: "ledger",
    title: "来源账本（最近 20 条）",
    kind: "table",
    columns: ["时间", "结果", "渠道", "发起人", "run / 事件", "说明"],
    rows,
  };
}

function bodyOf(snapshot: ExternalSourceSnapshot, note?: string): ViewBody {
  const fields: ViewField[] = [
    { key: "state", label: "状态", value: snapshot.state, readOnly: true, help: snapshot.reason },
    { key: "mode", label: "执行模式", value: snapshot.runtime.mode, readOnly: true, help: "observe 只记账；live 才派活。" },
    { key: "today", label: "今日", value: sourceSummary(snapshot), readOnly: true },
    { key: "agentLogin", label: "来源账号", value: snapshot.runtime.agentLogin ?? "（setup 未完成）", readOnly: true },
    { key: "lastPollAt", label: "最近轮询", value: snapshot.runtime.lastPollAt ?? "—", readOnly: true },
    { key: "nextPollAt", label: "下次轮询", value: snapshot.runtime.nextPollAt ?? "—", readOnly: true },
    { key: "failures", label: "连续失败", value: snapshot.runtime.consecutiveFailures, readOnly: true },
    { key: "lastError", label: "最近错误", value: snapshot.runtime.lastError ?? null, readOnly: true },
    { key: "lastDeliveryError", label: "最近回写错误", value: snapshot.runtime.lastDeliveryError ?? null, readOnly: true },
  ];
  const actions = [
    ...(snapshot.runtime.status === "off"
      ? [{ id: "source-on", label: "启用来源", hint: "启用后重新跑 setup；仍按当前 mode 决定是否执行。" }]
      : [
          { id: "source-off", label: "停用来源", hint: "停止轮询；已派出的 run 不受影响。", danger: true },
          snapshot.runtime.mode === "live"
            ? { id: "source-observe", label: "切到观察（只记账）", hint: "不建 run、不启子代理；切回 live 是显式动作。" }
            : { id: "source-live", label: "切到执行（live）", hint: "按 allowed/admission 判定后真的派活。" },
        ]),
    { id: "poll-now", label: "立即轮询", hint: "跑一轮并写回状态；不会重复排定时器。" },
    { id: "test-auth", label: "测试账号", hint: "只校验 gh 账号与仓库 push 权限，不改状态。" },
  ];
  return {
    title: "外部来源 · GitHub",
    markdown: note ?? "来源配置在 `<数据根>/legion/sources/github.json`；面板第一期只做状态、账本与开关，不做配置表单。",
    revision: snapshot.revision,
    fields,
    sections: [...configSections(snapshot), ledgerSection(snapshot)],
    actions,
  };
}

export function createSourceView(host: () => SourceViewHost | undefined): ViewSource {
  const requireHost = (): SourceViewHost => {
    const service = host();
    if (service === undefined) throw new Error("GitHub 来源服务没装上，外部来源视图不可用");
    return service;
  };
  const requireSnapshot = async (): Promise<ExternalSourceSnapshot> => {
    const snapshot = await requireHost().readSnapshot();
    if (snapshot === undefined) throw new Error("外部来源还没配置：先建 <数据根>/legion/sources/github.json");
    return snapshot;
  };
  return {
    id: SOURCE_VIEW_ID,
    title: "外部来源",
    requireOrigin: true,
    async list(_profile: ViewProfile): Promise<readonly ViewItem[]> {
      const snapshot = await requireHost().readSnapshot();
      if (snapshot === undefined) return [];
      return [{
        id: "github",
        title: "GitHub",
        summary: sourceSummary(snapshot),
        meta: `修订 ${snapshot.revision}`,
      }];
    },
    async detail(_input: ViewProfile & { itemId: string }): Promise<ViewBody> {
      return bodyOf(await requireSnapshot());
    },
    async act(input): Promise<ViewBody> {
      const service = requireHost();
      const snapshot = await requireSnapshot();
      const expectedRevision = typeof input.expectedRevision === "number" ? input.expectedRevision : snapshot.revision;
      switch (input.actionId) {
        case "source-off":
          return bodyOf(await service.setEnabled(false, expectedRevision));
        case "source-on":
          return bodyOf(await service.setEnabled(true, expectedRevision));
        case "source-observe":
          return bodyOf(await service.setMode("observe", expectedRevision));
        case "source-live":
          return bodyOf(await service.setMode("live", expectedRevision));
        case "poll-now":
          await service.pollNow();
          return bodyOf(await requireSnapshot(), "已触发一轮轮询；结果见下面的账本与状态。");
        case "test-auth": {
          const auth = await service.testAuth();
          return bodyOf(
            await requireSnapshot(),
            `账号 ${auth.login}${auth.canPush ? " 对该仓库有 push 权限。" : " 对该仓库没有 push 权限，live 会被拒绝。"}`,
          );
        }
        default:
          throw new Error(`外部来源不认识这个动作: ${input.actionId}`);
      }
    },
  };
}
