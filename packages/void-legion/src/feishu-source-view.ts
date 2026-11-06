/**
 * 飞书来源面板视图（B8-2）：只读摘要 + 启停 / observe-live / 同步名单 / 测试账号。
 *
 * 与 GitHub 来源视图分开：两边 config 形状不同（仓库 vs 群规则），硬塞一个视图
 * 只会让字段互相解释不清。设置页会同时列出两个「外部来源」视图。
 *
 * @module @void/void-legion/feishu-source-view
 */
import type { ViewBody, ViewField, ViewItem, ViewProfile, ViewSource, ViewTextSection } from "./detail-view.js";
import type { FeishuSourceSnapshot } from "./feishu-source.js";

export const FEISHU_VIEW_ID = "void-legion:feishu-source";

export interface FeishuSourceViewHost {
  readSnapshot(): Promise<FeishuSourceSnapshot | undefined>;
  setMode(mode: "observe" | "live", expectedRevision: number): Promise<FeishuSourceSnapshot>;
  setEnabled(enabled: boolean, expectedRevision: number): Promise<FeishuSourceSnapshot>;
  syncAllowed(chatId: string, expectedRevision: number): Promise<FeishuSourceSnapshot>;
  testAuth(): Promise<{ botOpenId: string }>;
}

function summaryOf(snapshot: FeishuSourceSnapshot): string {
  const today = snapshot.today;
  return `${snapshot.state} · ${snapshot.runtime.mode} · 今日 观察${today.observed} / 派发${today.dispatched} / 过滤${today.filtered} / 丢弃${today.dropped}`;
}

function bodyOf(snapshot: FeishuSourceSnapshot, note?: string): ViewBody {
  const config = snapshot.config;
  const fields: ViewField[] = [
    { key: "state", label: "状态", value: snapshot.state, readOnly: true, help: snapshot.reason },
    { key: "mode", label: "执行模式", value: snapshot.runtime.mode, readOnly: true, help: "observe 只记账；live 才派活。" },
    { key: "today", label: "今日", value: summaryOf(snapshot), readOnly: true },
    { key: "botOpenId", label: "机器人 open_id", value: snapshot.runtime.botOpenId ?? "（setup 未完成）", readOnly: true },
    { key: "lastEventAt", label: "最近事件", value: snapshot.runtime.lastEventAt ?? "—", readOnly: true },
    { key: "failures", label: "连续失败", value: snapshot.runtime.consecutiveFailures, readOnly: true },
    { key: "lastError", label: "最近错误", value: snapshot.runtime.lastError ?? null, readOnly: true },
    { key: "lastDeliveryError", label: "最近回写错误", value: snapshot.runtime.lastDeliveryError ?? null, readOnly: true },
  ];
  const chats = Object.entries(config.chats).map(([chatId, rule]) => `${chatId}=${rule}`).join(" ");
  const sections: ViewTextSection[] = [
    {
      id: "config",
      title: "来源配置（只读）",
      kind: "table",
      columns: ["项", "值"],
      rows: [
        ["队伍", config.teamId],
        ["appId 变量名", config.appIdEnv],
        ["appSecret 变量名", config.appSecretEnv],
        ["允许名单", config.allowed.length === 0 ? "空（谁都不能下单）" : config.allowed.join(", ")],
        ["bots", config.bots.length === 0 ? "空（所有 bot 都不接）" : config.bots.join(", ")],
        ["群规则", chats === "" ? "（没有配置群）" : chats],
        ["私聊规则", config.direct],
        ["工作区", config.workspace ?? "（宿主当前目录）"],
      ],
    },
    {
      id: "ledger",
      title: "来源账本（最近 20 条）",
      kind: "table",
      columns: ["时间", "结果", "渠道", "发起人", "run / 事件", "说明"],
      rows: [...snapshot.runtime.entries].reverse().slice(0, 20).map((entry) => [
        entry.at,
        entry.outcome,
        entry.channel ?? "—",
        entry.requester ?? "—",
        entry.runId ?? entry.eventId ?? "—",
        entry.reason ?? entry.detail ?? "—",
      ]),
    },
  ];
  return {
    title: "外部来源 · 飞书",
    markdown: note ?? "来源配置在 `<数据根>/legion/sources/feishu.json`；第一期只做状态、账本与开关，不做配置表单。",
    revision: snapshot.revision,
    fields,
    sections,
    actions: [
      ...(snapshot.runtime.status === "off"
        ? [{ id: "source-on", label: "启用来源", hint: "重新建立 WS 长连接；仍按当前 mode 决定是否执行。" }]
        : [
            { id: "source-off", label: "停用来源", hint: "断开 WS；已派出的 run 不受影响。", danger: true },
            snapshot.runtime.mode === "live"
              ? { id: "source-observe", label: "切到观察（只记账）", hint: "事件只记账，不建 run、不启子代理。" }
              : { id: "source-live", label: "切到执行（live）", hint: "按 allowed/群规则判定后真的派活。" },
          ]),
      {
        id: "sync-allowed",
        label: "从群同步允许名单",
        hint: "调飞书群成员接口，把成员 open_id 写进 allowed；机器人不在群里或被限流时会报错。",
        args: [{ key: "chatId", label: "群 chat_id", value: null }],
      },
      { id: "test-auth", label: "测试机器人", hint: "只校验 app 凭据与 bot info，不改状态。" },
    ],
  };
}

export function createFeishuSourceView(host: () => FeishuSourceViewHost | undefined): ViewSource {
  const requireHost = (): FeishuSourceViewHost => {
    const service = host();
    if (service === undefined) throw new Error("飞书来源服务没装上，外部来源视图不可用");
    return service;
  };
  const requireSnapshot = async (): Promise<FeishuSourceSnapshot> => {
    const snapshot = await requireHost().readSnapshot();
    if (snapshot === undefined) throw new Error("飞书来源还没配置：先建 <数据根>/legion/sources/feishu.json");
    return snapshot;
  };
  return {
    id: FEISHU_VIEW_ID,
    title: "外部来源（飞书）",
    requireOrigin: true,
    async list(_profile: ViewProfile): Promise<readonly ViewItem[]> {
      const snapshot = await requireHost().readSnapshot();
      if (snapshot === undefined) return [];
      return [{ id: "feishu", title: "飞书", summary: summaryOf(snapshot), meta: `修订 ${snapshot.revision}` }];
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
        case "sync-allowed": {
          const chatId = input.args.chatId;
          if (typeof chatId !== "string" || chatId.trim() === "") throw new Error("同步名单需要一个 chat_id");
          return bodyOf(await service.syncAllowed(chatId.trim(), expectedRevision), "已把群成员写进 allowed；下一条事件起生效。");
        }
        case "test-auth": {
          const auth = await service.testAuth();
          return bodyOf(await requireSnapshot(), `机器人 open_id：${auth.botOpenId}。`);
        }
        default:
          throw new Error(`飞书来源不认识这个动作: ${input.actionId}`);
      }
    },
  };
}
