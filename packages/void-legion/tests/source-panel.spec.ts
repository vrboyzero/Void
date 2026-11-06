/**
 * 统一外部来源页签（B8）：GitHub 与飞书合成一页，配置项可编辑并保存。
 *
 * 这里只测视图契约与「界面输入 → 服务调用」的转换；真正的写盘校验在
 * source-github / source-feishu 的仓库测试里。
 */
import { describe, expect, it, vi } from "vitest";
import {
  createExternalSourceDocument,
  defaultExternalSourceConfig,
  externalSourceSnapshotOf,
  type ExternalSourceConfig,
  type ExternalSourceSnapshot,
} from "../src/external-source.js";
import {
  createFeishuSourceDocument,
  defaultFeishuSourceConfig,
  feishuSourceSnapshotOf,
  type FeishuSourceConfig,
  type FeishuSourceSnapshot,
} from "../src/feishu-source.js";
import {
  SOURCE_PANEL_ID,
  createCombinedSourceView,
  type CombinedSourceHost,
  type FeishuSourcePanelApi,
  type GitHubSourcePanelApi,
} from "../src/source-panel.js";

const profile = { home: "h", name: "p" };

function githubSnapshot(overrides: Partial<ExternalSourceConfig> = {}): ExternalSourceSnapshot {
  const config = {
    ...defaultExternalSourceConfig({
      repo: "acme/widgets",
      teamId: "alpha",
      allowed: ["octocat"],
      bots: ["dependabot[bot]"],
      ghConfigDir: "C:/gh",
      tokenEnv: "GH_TOKEN",
      workspace: "C:/work",
    }),
    ...overrides,
  };
  return externalSourceSnapshotOf(createExternalSourceDocument({ config }));
}

function feishuSnapshot(overrides: Partial<FeishuSourceConfig> = {}): FeishuSourceSnapshot {
  const config = {
    ...defaultFeishuSourceConfig({
      teamId: "alpha",
      allowed: ["ou_1"],
      bots: ["cli_1"],
      chats: { oc_1: "mentions" },
      direct: "all",
      workspace: "C:/work",
      domain: "https://open.feishu.cn",
    }),
    ...overrides,
  };
  return feishuSourceSnapshotOf(createFeishuSourceDocument({ config }));
}

function githubApi(snapshot: ExternalSourceSnapshot | undefined) {
  const calls = { save: [] as Array<{ config: ExternalSourceConfig; revision: number }> };
  const api: GitHubSourcePanelApi = {
    readSnapshot: vi.fn(async () => snapshot),
    saveConfig: vi.fn(async (config, revision) => {
      calls.save.push({ config, revision });
      return githubSnapshot(config);
    }),
    setMode: vi.fn(async () => githubSnapshot()),
    setEnabled: vi.fn(async () => githubSnapshot()),
    pollNow: vi.fn(async () => ({ polled: true })),
    testAuth: vi.fn(async () => ({ login: "octocat", canPush: true })),
  };
  return { api, calls };
}

function feishuApi(snapshot: FeishuSourceSnapshot | undefined) {
  const calls = { save: [] as Array<{ config: FeishuSourceConfig; revision: number }>, sync: [] as string[] };
  const api: FeishuSourcePanelApi = {
    readSnapshot: vi.fn(async () => snapshot),
    saveConfig: vi.fn(async (config, revision) => {
      calls.save.push({ config, revision });
      return feishuSnapshot(config);
    }),
    setMode: vi.fn(async () => feishuSnapshot()),
    setEnabled: vi.fn(async () => feishuSnapshot()),
    syncAllowed: vi.fn(async (chatId) => {
      calls.sync.push(chatId);
      return feishuSnapshot();
    }),
    testAuth: vi.fn(async () => ({ botOpenId: "ou_bot" })),
  };
  return { api, calls };
}

describe("统一外部来源视图", () => {
  it("是「外部来源」页签：需要浏览器来源、可保存", () => {
    const view = createCombinedSourceView(() => ({}));
    expect(SOURCE_PANEL_ID).toBe("void-legion:sources");
    expect(view.id).toBe(SOURCE_PANEL_ID);
    expect(view.title).toBe("外部来源");
    expect(view.requireOrigin).toBe(true);
    expect(typeof view.save).toBe("function");
  });

  it("列表先 GitHub 后飞书；服务装上但还没配置时也要列出两行", async () => {
    const both = createCombinedSourceView(() => ({ github: githubApi(githubSnapshot()).api, feishu: feishuApi(feishuSnapshot()).api }));
    expect((await both.list(profile)).map((item) => item.id)).toEqual(["github", "feishu"]);

    const unconfigured = createCombinedSourceView(() => ({ github: githubApi(undefined).api, feishu: feishuApi(undefined).api }));
    const rows = await unconfigured.list(profile);
    expect(rows.map((item) => item.id)).toEqual(["github", "feishu"]);
    expect(rows.map((item) => item.summary)).toEqual(["还没配置", "还没配置"]);

    const onlyFeishu = createCombinedSourceView(() => ({ feishu: feishuApi(feishuSnapshot()).api }));
    expect((await onlyFeishu.list(profile)).map((item) => item.id)).toEqual(["feishu"]);

    const onlyGithub = createCombinedSourceView(() => ({ github: githubApi(githubSnapshot()).api }));
    expect((await onlyGithub.list(profile)).map((item) => item.id)).toEqual(["github"]);

    const none = createCombinedSourceView(() => ({}));
    expect(await none.list(profile)).toEqual([]);
  });

  it("GitHub 详情：核心配置可编辑，状态只读", async () => {
    const view = createCombinedSourceView(() => ({ github: githubApi(githubSnapshot()).api }));
    const body = await view.detail({ ...profile, itemId: "github" });
    expect(body.title).toContain("GitHub");
    const fields = new Map(body.fields.map((field) => [field.key, field]));
    expect(fields.get("repo")?.value).toBe("acme/widgets");
    expect(fields.get("repo")?.readOnly).toBeFalsy();
    expect(fields.get("teamId")?.value).toBe("alpha");
    expect(fields.get("allowed")?.value).toBe("octocat");
    expect(fields.get("state")?.readOnly).toBe(true);
    expect(body.actions?.map((action) => action.id)).toEqual(
      expect.arrayContaining(["source-off", "poll-now", "test-auth"]),
    );

    // 停用状态给的是「启用来源」，而不是再给一次停用。
    const offDoc = createExternalSourceDocument({ config: githubSnapshot().config });
    offDoc.runtime.status = "off";
    const offView = createCombinedSourceView(() => ({
      github: githubApi(externalSourceSnapshotOf(offDoc)).api,
    }));
    const offBody = await offView.detail({ ...profile, itemId: "github" });
    expect(offBody.actions?.map((action) => action.id)).toContain("source-on");
    expect(offBody.actions?.map((action) => action.id)).not.toContain("source-off");
  });

  it("飞书详情：群规则以 chat_id=rule 展示，凭据只出现变量名", async () => {
    const view = createCombinedSourceView(() => ({ feishu: feishuApi(feishuSnapshot()).api }));
    const body = await view.detail({ ...profile, itemId: "feishu" });
    const fields = new Map(body.fields.map((field) => [field.key, field]));
    expect(fields.get("chats")?.value).toBe("oc_1=mentions");
    expect(fields.get("appIdEnv")?.value).toBe("VOID_FEISHU_APP_ID");
    expect(fields.get("appSecretEnv")?.value).toBe("VOID_FEISHU_APP_SECRET");
    expect(fields.get("appSecretEnv")?.help).toContain("变量名");
  });

  it("保存 GitHub：名单/数字/变量名按界面输入转换后交给服务", async () => {
    const { api, calls } = githubApi(githubSnapshot());
    const view = createCombinedSourceView(() => ({ github: api }));
    const body = await view.save?.({
      ...profile,
      itemId: "github",
      expectedRevision: 7,
      changes: { repo: "acme/widgets2", allowed: "alice, bob", bots: "", intervalMs: "30000" },
    });
    expect(calls.save).toHaveLength(1);
    expect(calls.save[0]?.revision).toBe(7);
    const sent = calls.save[0]?.config as ExternalSourceConfig;
    expect(sent.repo).toBe("acme/widgets2");
    expect(sent.allowed).toEqual(["alice", "bob"]);
    expect(sent.bots).toEqual([]);
    expect(sent.intervalMs).toBe(30000);
    expect(body?.markdown).toContain("已保存");
  });

  it("保存飞书：群规则解析成记录，非法规则被丢弃", async () => {
    const { api, calls } = feishuApi(feishuSnapshot());
    const view = createCombinedSourceView(() => ({ feishu: api }));
    await view.save?.({
      ...profile,
      itemId: "feishu",
      expectedRevision: 3,
      changes: { chats: "oc_2=all，oc_3=bogus, oc_4 = none", direct: "mentions", appIdEnv: "MY_APP_ID" },
    });
    const sent = calls.save[0]?.config as FeishuSourceConfig;
    expect(calls.save[0]?.revision).toBe(3);
    expect(sent.chats).toEqual({ oc_2: "all", oc_4: "none" });
    expect(sent.direct).toBe("mentions");
    expect(sent.appIdEnv).toBe("MY_APP_ID");
  });

  it("还没配置时详情给空表、保存用默认值创建，不报错也不给动作", async () => {
    const { api, calls } = githubApi(undefined);
    const view = createCombinedSourceView(() => ({ github: api }));
    const body = await view.detail({ ...profile, itemId: "github" });
    expect(body.revision).toBe(0);
    expect(body.markdown).toContain("还没配置");
    expect(body.actions).toEqual([]);
    const fields = new Map(body.fields.map((field) => [field.key, field]));
    expect(fields.get("repo")?.readOnly).toBeFalsy();

    const saved = await view.save?.({
      ...profile,
      itemId: "github",
      expectedRevision: 0,
      changes: { repo: "acme/widgets", teamId: "alpha" },
    });
    expect(calls.save).toHaveLength(1);
    expect(calls.save[0]?.revision).toBe(0);
    expect(calls.save[0]?.config.repo).toBe("acme/widgets");
    expect(calls.save[0]?.config.teamId).toBe("alpha");
    expect(saved?.markdown).toContain("已创建");
  });

  it("飞书还没配置时同样给空表并可创建", async () => {
    const { api, calls } = feishuApi(undefined);
    const view = createCombinedSourceView(() => ({ feishu: api }));
    const body = await view.detail({ ...profile, itemId: "feishu" });
    expect(body.revision).toBe(0);
    expect(body.actions).toEqual([]);
    await view.save?.({
      ...profile,
      itemId: "feishu",
      expectedRevision: 0,
      changes: { teamId: "alpha", chats: "oc_1=mentions" },
    });
    expect(calls.save[0]?.revision).toBe(0);
    expect(calls.save[0]?.config.teamId).toBe("alpha");
    expect(calls.save[0]?.config.chats).toEqual({ oc_1: "mentions" });
  });

  it("动作走服务：启停、切模式、立即轮询、测试账号", async () => {
    const { api } = githubApi(githubSnapshot());
    const view = createCombinedSourceView(() => ({ github: api }));
    const act = async (actionId: string) => view.act?.({ ...profile, itemId: "github", actionId, args: {}, expectedRevision: 2 });
    await act("source-on");
    expect(api.setEnabled).toHaveBeenCalledWith(true, 2);
    await act("source-off");
    expect(api.setEnabled).toHaveBeenCalledWith(false, 2);
    await act("source-observe");
    expect(api.setMode).toHaveBeenCalledWith("observe", 2);
    await act("source-live");
    expect(api.setMode).toHaveBeenCalledWith("live", 2);
    const polled = await act("poll-now");
    expect(api.pollNow).toHaveBeenCalledTimes(1);
    expect(polled?.markdown).toContain("轮询");
    const tested = await act("test-auth");
    expect(tested?.markdown).toContain("octocat");
  });

  it("飞书同步名单需要 chat_id；不认识的动作/来源明确报错", async () => {
    const { api, calls } = feishuApi(feishuSnapshot());
    const view = createCombinedSourceView(() => ({ feishu: api }));
    await expect(
      view.act?.({ ...profile, itemId: "feishu", actionId: "sync-allowed", args: {} }),
    ).rejects.toThrow("chat_id");
    await view.act?.({ ...profile, itemId: "feishu", actionId: "sync-allowed", args: { chatId: " oc_1 " } });
    expect(calls.sync).toEqual(["oc_1"]);
    await expect(
      view.act?.({ ...profile, itemId: "feishu", actionId: "nope", args: {} }),
    ).rejects.toThrow("不认识这个动作");
    await expect(
      view.act?.({ ...profile, itemId: "gitlab", actionId: "nope", args: {} }),
    ).rejects.toThrow("没有这个外部来源");
  });

  it("服务没装上时给出可诊断的错误，而不是静默空页", async () => {
    const view = createCombinedSourceView(() => ({}) as CombinedSourceHost);
    await expect(view.detail({ ...profile, itemId: "github" })).rejects.toThrow("GitHub 来源服务没装上");
    await expect(view.detail({ ...profile, itemId: "feishu" })).rejects.toThrow("飞书来源服务没装上");
  });
});
