/**
 * 外部来源的统一面板（B8）：一个「外部来源」页签里同时列 GitHub 与飞书，
 * 点哪一行就打开哪个来源的详情；配置项直接在详情里改并保存。
 *
 * 与旧的两份只读视图的区别：
 * - 两个来源合并成一个列表，不再在设置页出现两个「外部来源」；
 * - config 的核心字段改成可编辑输入栏（repo/teamId/凭据变量名/名单/会话规则），
 *   保存走 `ViewSource.save`，服务侧用同一份 fail-closed 解析器复核；
 * - token/app secret 仍然只存变量名，界面上不出现密钥值。
 *
 * @module @void/void-legion/source-panel
 */
import type {
  ViewBody,
  ViewField,
  ViewItem,
  ViewProfile,
  ViewSource,
  ViewTextSection,
} from "./detail-view.js";
import {
  createExternalSourceDocument,
  defaultExternalSourceConfig,
  externalSourceSnapshotOf,
  type ExternalSourceConfig,
  type ExternalSourceSnapshot,
} from "./external-source.js";
import {
  createFeishuSourceDocument,
  defaultFeishuSourceConfig,
  feishuSourceSnapshotOf,
  type FeishuSourceConfig,
  type FeishuSourceSnapshot,
} from "./feishu-source.js";
import type { Context } from "@deepseek-ai/cordis";

export const SOURCE_PANEL_ID = "void-legion:sources";

export interface GitHubSourcePanelApi {
  readSnapshot(): Promise<ExternalSourceSnapshot | undefined>;
  saveConfig(config: ExternalSourceConfig, expectedRevision: number): Promise<ExternalSourceSnapshot>;
  setMode(mode: "observe" | "live", expectedRevision: number): Promise<ExternalSourceSnapshot>;
  setEnabled(enabled: boolean, expectedRevision: number): Promise<ExternalSourceSnapshot>;
  pollNow(): Promise<unknown>;
  testAuth(): Promise<{ login: string; canPush: boolean }>;
}

export interface FeishuSourcePanelApi {
  readSnapshot(): Promise<FeishuSourceSnapshot | undefined>;
  saveConfig(config: FeishuSourceConfig, expectedRevision: number): Promise<FeishuSourceSnapshot>;
  setMode(mode: "observe" | "live", expectedRevision: number): Promise<FeishuSourceSnapshot>;
  setEnabled(enabled: boolean, expectedRevision: number): Promise<FeishuSourceSnapshot>;
  syncAllowed(chatId: string, expectedRevision: number): Promise<FeishuSourceSnapshot>;
  testAuth(): Promise<{ botOpenId: string }>;
}

export type CombinedSourceHost = {
  github?: GitHubSourcePanelApi | undefined;
  feishu?: FeishuSourcePanelApi | undefined;
};

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function listText(values: readonly string[]): string {
  return values.join(", ");
}

function parseList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : text(value).split(/[,，\s]+/u);
  return raw
    .map((item) => String(item).trim())
    .filter((item) => item !== "");
}

function parseNumber(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(text(value).trim());
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function summaryBase(state: string, mode: string, today: { observed: number; dispatched: number; filtered: number; dropped: number }): string {
  return `${state} · ${mode} · 今日 观察${today.observed} / 派发${today.dispatched} / 过滤${today.filtered} / 丢弃${today.dropped}`;
}

/**
 * 未配置时的占位快照：详情要能画出一份可编辑的空表，保存时由服务创建文件。
 *
 * 不能复用「读不到快照就报错」的路径——那会让全新 profile 永远打不开第一份配置。
 */
function unconfiguredGithubSnapshot(): ExternalSourceSnapshot {
  return externalSourceSnapshotOf(createExternalSourceDocument({
    config: defaultExternalSourceConfig({ repo: "", teamId: "" }),
  }));
}

function unconfiguredFeishuSnapshot(): FeishuSourceSnapshot {
  return feishuSourceSnapshotOf(createFeishuSourceDocument({
    config: defaultFeishuSourceConfig({ teamId: "" }),
  }));
}

function githubFields(snapshot: ExternalSourceSnapshot): ViewField[] {
  const config = snapshot.config;
  return [
    { key: "repo", label: "仓库", value: config.repo, help: "owner/name；只服务一个仓库。" },
    { key: "teamId", label: "队伍", value: config.teamId, help: "外部触发派到哪支队伍。" },
    { key: "intervalMs", label: "轮询间隔(ms)", value: config.intervalMs, help: "默认 60000；最小 10000。" },
    { key: "allowed", label: "允许名单", value: listText(config.allowed), help: "逗号分隔的 GitHub 登录名；留空 = 谁都不能下单。" },
    { key: "bots", label: "bots", value: listText(config.bots), help: "逗号分隔；留空 = 所有 bot 都不接。" },
    { key: "ghConfigDir", label: "gh 配置目录", value: config.ghConfigDir ?? "", help: "Agent 账号的独立 GH_CONFIG_DIR；空 = 当前 gh 身份（不推荐）。" },
    { key: "tokenEnv", label: "token 变量名", value: config.tokenEnv ?? "", help: "只写变量名；值从宿主环境读，不落库。" },
    { key: "workspace", label: "工作区", value: config.workspace ?? "", help: "派活父会话的 cwd；空 = 宿主当前目录。" },
  ];
}

function feishuFields(snapshot: FeishuSourceSnapshot): ViewField[] {
  const config = snapshot.config;
  return [
    { key: "appIdEnv", label: "appId 变量名", value: config.appIdEnv, help: "只写变量名，不写 app id 值。" },
    { key: "appSecretEnv", label: "appSecret 变量名", value: config.appSecretEnv, help: "只写变量名；密钥值从宿主环境读。" },
    { key: "teamId", label: "队伍", value: config.teamId },
    { key: "allowed", label: "允许名单", value: listText(config.allowed), help: "逗号分隔的 open_id/user_id；留空 = 谁都不能下单。" },
    { key: "bots", label: "bots", value: listText(config.bots), help: "逗号分隔；留空 = 所有 bot 都不接。" },
    { key: "chats", label: "群规则", value: Object.entries(config.chats).map(([id, rule]) => `${id}=${rule}`).join(", "), help: "chat_id=mentions/all/none，逗号分隔；未列出的群按 none。" },
    { key: "direct", label: "私聊规则", value: config.direct, help: "mentions / all / none。" },
    { key: "workspace", label: "工作区", value: config.workspace ?? "" },
    { key: "domain", label: "domain", value: config.domain ?? "", help: "空 = 飞书官方 open.feishu.cn。" },
  ];
}

function readOnlySections(snapshot: ExternalSourceSnapshot | FeishuSourceSnapshot, kind: "github" | "feishu"): ViewTextSection[] {
  const config = snapshot.config;
  if (kind === "github") {
    const github = config as ExternalSourceConfig;
    return [{
      id: "advanced",
      title: "高级项（只读，仍可手改文件）",
      kind: "table",
      columns: ["项", "值"],
      rows: [
        ["接收范围", Object.entries(github.receive).map(([key, value]) => `${key}=${value ? "接收" : "不接收"}`).join(" ")],
        ["准入", Object.entries(github.admission).map(([key, value]) => `${key}=${value}`).join(" ")],
        ["上下文页数", String(github.admissionContextMaxPages)],
        ["上下文超时(ms)", String(github.admissionContextTimeoutMs)],
      ],
    }];
  }
  const feishu = config as FeishuSourceConfig;
  return [{
    id: "advanced",
    title: "高级项（只读，仍可手改文件）",
    kind: "table",
    columns: ["项", "值"],
    rows: [
      ["appId 变量名", feishu.appIdEnv],
      ["appSecret 变量名", feishu.appSecretEnv],
      ["已配置群数", String(Object.keys(feishu.chats).length)],
    ],
  }];
}

function ledger(snapshot: ExternalSourceSnapshot | FeishuSourceSnapshot): ViewTextSection {
  return {
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
  };
}

function githubBody(snapshot: ExternalSourceSnapshot, note?: string, unconfigured = false): ViewBody {
  return {
    title: "外部来源 · GitHub",
    markdown: note ?? (unconfigured
      ? "还没配置：填好下面的字段后点「保存」会创建 github.json；status=off，不会启动轮询。"
      : "改完输入栏点「保存」；保存会 bump 修订号并重新校验。status=off 时保存不会启动轮询。"),
    revision: snapshot.revision,
    fields: [
      { key: "state", label: "状态", value: snapshot.state, readOnly: true, help: snapshot.reason },
      { key: "mode", label: "执行模式", value: snapshot.runtime.mode, readOnly: true, help: "observe 只记账；live 才派活。" },
      { key: "today", label: "今日", value: summaryBase(snapshot.state, snapshot.runtime.mode, snapshot.today), readOnly: true },
      ...githubFields(snapshot),
      { key: "lastPollAt", label: "最近轮询", value: snapshot.runtime.lastPollAt ?? "—", readOnly: true },
      { key: "lastError", label: "最近错误", value: snapshot.runtime.lastError ?? null, readOnly: true },
    ],
    sections: [...readOnlySections(snapshot, "github"), ledger(snapshot)],
    actions: unconfigured ? [] : [
      ...(snapshot.runtime.status === "off"
        ? [{ id: "source-on", label: "启用来源", hint: "保存后再点；会重新做 gh setup。" }]
        : [
            { id: "source-off", label: "停用来源", hint: "停止轮询；已派出的 run 不受影响。", danger: true },
            snapshot.runtime.mode === "live"
              ? { id: "source-observe", label: "切到观察（只记账）", hint: "不建 run、不启子代理。" }
              : { id: "source-live", label: "切到执行（live）", hint: "按 allowed/admission 判定后真的派活。" },
          ]),
      { id: "poll-now", label: "立即轮询", hint: "跑一轮并写回状态。" },
      { id: "test-auth", label: "测试账号", hint: "校验 gh 账号与仓库 push 权限，不改状态。" },
    ],
  };
}

function feishuBody(snapshot: FeishuSourceSnapshot, note?: string, unconfigured = false): ViewBody {
  return {
    title: "外部来源 · 飞书",
    markdown: note ?? (unconfigured
      ? "还没配置：填好下面的字段后点「保存」会创建 feishu.json；status=off，不会连 WS。"
      : "改完输入栏点「保存」；保存会 bump 修订号。status=off 时保存不会连 WS。"),
    revision: snapshot.revision,
    fields: [
      { key: "state", label: "状态", value: snapshot.state, readOnly: true, help: snapshot.reason },
      { key: "mode", label: "执行模式", value: snapshot.runtime.mode, readOnly: true, help: "observe 只记账；live 才派活。" },
      { key: "today", label: "今日", value: summaryBase(snapshot.state, snapshot.runtime.mode, snapshot.today), readOnly: true },
      ...feishuFields(snapshot),
      { key: "botOpenId", label: "机器人 open_id", value: snapshot.runtime.botOpenId ?? "（setup 未完成）", readOnly: true },
      { key: "lastError", label: "最近错误", value: snapshot.runtime.lastError ?? null, readOnly: true },
    ],
    sections: [...readOnlySections(snapshot, "feishu"), ledger(snapshot)],
    actions: unconfigured ? [] : [
      ...(snapshot.runtime.status === "off"
        ? [{ id: "source-on", label: "启用来源", hint: "保存后再点；会重新建 WS 连接。" }]
        : [
            { id: "source-off", label: "停用来源", hint: "断开 WS；已派出的 run 不受影响。", danger: true },
            snapshot.runtime.mode === "live"
              ? { id: "source-observe", label: "切到观察（只记账）", hint: "事件只记账，不建 run。" }
              : { id: "source-live", label: "切到执行（live）", hint: "按 allowed/群规则判定后真的派活。" },
          ]),
      { id: "sync-allowed", label: "从群同步允许名单", hint: "调群成员接口写 allowed；机器人要在群里。", args: [{ key: "chatId", label: "群 chat_id", value: null }] },
      { id: "test-auth", label: "测试机器人", hint: "只校验凭据与 bot info，不改状态。" },
    ],
  };
}

function requireRevision(input: { expectedRevision?: number | string | undefined }, fallback: number): number {
  return typeof input.expectedRevision === "number" ? input.expectedRevision : fallback;
}

function requireSnapshot<T>(snapshot: T | undefined, label: string): T {
  if (snapshot === undefined) throw new Error(`${label}来源还没配置`);
  return snapshot;
}

function githubConfigFromChanges(current: ExternalSourceConfig, changes: Readonly<Record<string, unknown>>): ExternalSourceConfig {
  return {
    ...current,
    ...(changes.repo === undefined ? {} : { repo: text(changes.repo) }),
    ...(changes.teamId === undefined ? {} : { teamId: text(changes.teamId) }),
    ...(changes.intervalMs === undefined ? {} : { intervalMs: parseNumber(changes.intervalMs, current.intervalMs) }),
    ...(changes.allowed === undefined ? {} : { allowed: parseList(changes.allowed) }),
    ...(changes.bots === undefined ? {} : { bots: parseList(changes.bots) }),
    ...(changes.ghConfigDir === undefined ? {} : { ghConfigDir: text(changes.ghConfigDir) }),
    ...(changes.tokenEnv === undefined ? {} : { tokenEnv: text(changes.tokenEnv) }),
    ...(changes.workspace === undefined ? {} : { workspace: text(changes.workspace) }),
  };
}

function feishuConfigFromChanges(current: FeishuSourceConfig, changes: Readonly<Record<string, unknown>>): FeishuSourceConfig {
  const chats: Record<string, "mentions" | "all" | "none"> = { ...current.chats };
  if (changes.chats !== undefined) {
    for (const key of Object.keys(chats)) delete chats[key];
    for (const pair of text(changes.chats).split(/[,，]/u)) {
      const [chatId, rule] = pair.split("=");
      if (chatId === undefined || rule === undefined) continue;
      const trimmed = rule.trim();
      if (trimmed === "mentions" || trimmed === "all" || trimmed === "none") {
        chats[chatId.trim()] = trimmed;
      }
    }
  }
  const direct = text(changes.direct, current.direct);
  return {
    ...current,
    ...(changes.appIdEnv === undefined ? {} : { appIdEnv: text(changes.appIdEnv) }),
    ...(changes.appSecretEnv === undefined ? {} : { appSecretEnv: text(changes.appSecretEnv) }),
    ...(changes.teamId === undefined ? {} : { teamId: text(changes.teamId) }),
    ...(changes.allowed === undefined ? {} : { allowed: parseList(changes.allowed) }),
    ...(changes.bots === undefined ? {} : { bots: parseList(changes.bots) }),
    chats,
    ...(direct === "mentions" || direct === "all" || direct === "none" ? { direct } : {}),
    ...(changes.workspace === undefined ? {} : { workspace: text(changes.workspace) }),
    ...(changes.domain === undefined ? {} : { domain: text(changes.domain) }),
  };
}

export function createCombinedSourceView(host: () => CombinedSourceHost): ViewSource {
  const requireHost = (): CombinedSourceHost => host();
  const githubApi = (): GitHubSourcePanelApi => {
    const api = requireHost().github;
    if (api === undefined) throw new Error("GitHub 来源服务没装上");
    return api;
  };
  const feishuApi = (): FeishuSourcePanelApi => {
    const api = requireHost().feishu;
    if (api === undefined) throw new Error("飞书来源服务没装上");
    return api;
  };
  const snapshots = async () => {
    const service = requireHost();
    const [github, feishu] = await Promise.all([
      service.github?.readSnapshot() ?? Promise.resolve(undefined),
      service.feishu?.readSnapshot() ?? Promise.resolve(undefined),
    ]);
    return { github, feishu };
  };
  return {
    id: SOURCE_PANEL_ID,
    title: "外部来源",
    requireOrigin: true,
    async list(_profile: ViewProfile): Promise<readonly ViewItem[]> {
      const { github, feishu } = await snapshots();
      const service = requireHost();
      // 行是否存在看「来源服务装没装上」，不看「配置文件在不在」：
      // 全新 profile 也必须能点开第一份配置，否则编辑/保存就成了死路。
      const items: ViewItem[] = [];
      if (service.github !== undefined) {
        items.push(github === undefined
          ? { id: "github", title: "GitHub", summary: "还没配置", meta: "点开填写" }
          : { id: "github", title: "GitHub", summary: summaryBase(github.state, github.runtime.mode, github.today), meta: `修订 ${github.revision}` });
      }
      if (service.feishu !== undefined) {
        items.push(feishu === undefined
          ? { id: "feishu", title: "飞书", summary: "还没配置", meta: "点开填写" }
          : { id: "feishu", title: "飞书", summary: summaryBase(feishu.state, feishu.runtime.mode, feishu.today), meta: `修订 ${feishu.revision}` });
      }
      return items;
    },
    async detail(input: ViewProfile & { itemId: string }): Promise<ViewBody> {
      if (input.itemId === "github") {
        const snapshot = await githubApi().readSnapshot();
        return githubBody(snapshot ?? unconfiguredGithubSnapshot(), undefined, snapshot === undefined);
      }
      if (input.itemId === "feishu") {
        const snapshot = await feishuApi().readSnapshot();
        return feishuBody(snapshot ?? unconfiguredFeishuSnapshot(), undefined, snapshot === undefined);
      }
      throw new Error(`没有这个外部来源: ${input.itemId}`);
    },
    async save(input): Promise<ViewBody> {
      if (input.itemId === "github") {
        const api = githubApi();
        const snapshot = await api.readSnapshot();
        const current = snapshot?.config ?? defaultExternalSourceConfig({ repo: "", teamId: "" });
        const saved = await api.saveConfig(githubConfigFromChanges(current, input.changes), requireRevision(input, snapshot?.revision ?? 0));
        return githubBody(saved, snapshot === undefined
          ? "已创建 GitHub 来源配置（status=off）；下一步可点「启用来源」。"
          : "已保存 GitHub 来源配置；下一步可点「启用来源」。");
      }
      if (input.itemId === "feishu") {
        const api = feishuApi();
        const snapshot = await api.readSnapshot();
        const current = snapshot?.config ?? defaultFeishuSourceConfig({ teamId: "" });
        const saved = await api.saveConfig(feishuConfigFromChanges(current, input.changes), requireRevision(input, snapshot?.revision ?? 0));
        return feishuBody(saved, snapshot === undefined
          ? "已创建飞书来源配置（status=off）；下一步可点「启用来源」。"
          : "已保存飞书来源配置；下一步可点「启用来源」。");
      }
      throw new Error(`没有这个外部来源: ${input.itemId}`);
    },
    async act(input): Promise<ViewBody> {
      if (input.itemId === "github") {
        const api = githubApi();
        const snapshot = requireSnapshot(await api.readSnapshot(), "GitHub ");
        const revision = requireRevision(input, snapshot.revision);
        switch (input.actionId) {
          case "source-off": return githubBody(await api.setEnabled(false, revision));
          case "source-on": return githubBody(await api.setEnabled(true, revision));
          case "source-observe": return githubBody(await api.setMode("observe", revision));
          case "source-live": return githubBody(await api.setMode("live", revision));
          case "poll-now":
            await api.pollNow();
            return githubBody(requireSnapshot(await api.readSnapshot(), "GitHub "), "已触发一轮轮询；结果见账本与状态。");
          case "test-auth": {
            const auth = await api.testAuth();
            return githubBody(requireSnapshot(await api.readSnapshot(), "GitHub "), `账号 ${auth.login}${auth.canPush ? " 对该仓库有 push 权限。" : " 对该仓库没有 push 权限，live 会被拒绝。"}`);
          }
          default: throw new Error(`GitHub 来源不认识这个动作: ${input.actionId}`);
        }
      }
      if (input.itemId === "feishu") {
        const api = feishuApi();
        const snapshot = requireSnapshot(await api.readSnapshot(), "飞书");
        const revision = requireRevision(input, snapshot.revision);
        switch (input.actionId) {
          case "source-off": return feishuBody(await api.setEnabled(false, revision));
          case "source-on": return feishuBody(await api.setEnabled(true, revision));
          case "source-observe": return feishuBody(await api.setMode("observe", revision));
          case "source-live": return feishuBody(await api.setMode("live", revision));
          case "sync-allowed": {
            const chatId = input.args.chatId;
            if (typeof chatId !== "string" || chatId.trim() === "") throw new Error("同步名单需要一个 chat_id");
            return feishuBody(await api.syncAllowed(chatId.trim(), revision), "已把群成员写进 allowed；下一条事件起生效。");
          }
          case "test-auth": {
            const auth = await api.testAuth();
            return feishuBody(requireSnapshot(await api.readSnapshot(), "飞书"), `机器人 open_id：${auth.botOpenId}。`);
          }
          default: throw new Error(`飞书来源不认识这个动作: ${input.actionId}`);
        }
      }
      throw new Error(`没有这个外部来源: ${input.itemId}`);
    },
  };
}
/** 入口面板的结构契约（结构性重述，避免跨包类型依赖）。 */
interface DetailHost {
  registerDetail(source: ViewSource): () => void;
}

export const name = "void-legion-source-panel";
export const inject = ["voidSuite"];

/**
 * 统一外部来源页签：等两个来源服务都就绪后登记**一个**视图。
 * 任一来源服务没装上就不登记（而不是只显示半页）。
 */
export function apply(ctx: Context): void {
  ctx.inject(["voidSuite", "voidGitHubSource", "voidFeishuSource"], (panelCtx) => {
    const suite = panelCtx.get("voidSuite") as DetailHost | undefined;
    if (suite === undefined || typeof suite.registerDetail !== "function") return;
    const github = panelCtx.get("voidGitHubSource") as GitHubSourcePanelApi | undefined;
    const feishu = panelCtx.get("voidFeishuSource") as FeishuSourcePanelApi | undefined;
    if (github === undefined || feishu === undefined) return;
    panelCtx.effect(
      () => suite.registerDetail(createCombinedSourceView(() => ({ github, feishu }))),
      "void-legion: detail view void-legion:sources",
    );
  });
}

export default apply;