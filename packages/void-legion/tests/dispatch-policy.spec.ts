import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DispatchPolicyConflictError,
  DispatchPolicyRepository,
  MAX_POLICY_GRANTS,
  activePolicyGrants,
  dispatchDenialReason,
  dispatchPolicySnapshotOf,
  emptyDispatchPolicySnapshot,
  normalizeDispatchPolicyAllowlist,
  normalizePolicyExpiry,
  parseDispatchPolicyDocument,
  policyEditDenialReason,
  requirePolicyEditGrant,
  serializeDispatchPolicyDocument,
  type DispatchPolicyDocument,
  type DispatchPolicyGrant,
  type DispatchPolicySnapshot,
} from "../src/dispatch-policy.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "void-legion-policy-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

const NOW = new Date("2026-11-06T10:00:00.000Z");

function grant(overrides: Partial<DispatchPolicyGrant> = {}): DispatchPolicyGrant {
  return {
    grantId: "grant-1",
    grantedBy: "owner",
    agentId: "xiaobei",
    scope: { source: "internal", lists: ["dispatch"] },
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

function document(overrides: Partial<DispatchPolicyDocument> = {}): DispatchPolicyDocument {
  return {
    schemaVersion: 1,
    revision: 2,
    updatedAt: NOW.toISOString(),
    updatedBy: "owner",
    mode: "agent",
    allowlist: ["xiaobei", "xiaoma"],
    grants: [grant()],
    history: [
      {
        at: NOW.toISOString(),
        action: "save",
        actor: "owner",
        detail: "加入 xiaobei、xiaoma",
      },
    ],
    ...overrides,
  };
}

function snapshot(overrides: Partial<DispatchPolicySnapshot> = {}): DispatchPolicySnapshot {
  return { ...dispatchPolicySnapshotOf(document()), ...overrides };
}

describe("派活名单的落盘格式", () => {
  it("序列化再解析原样回来", () => {
    const source = document();
    expect(parseDispatchPolicyDocument(serializeDispatchPolicyDocument(source))).toEqual(source);
  });

  it("版本、mode、名单形状、重复项、授权范围与时间都严格校验", () => {
    const parse = (value: unknown) => parseDispatchPolicyDocument(JSON.stringify(value));

    expect(() => parse({ ...document(), schemaVersion: 2 })).toThrow(/不支持的派活名单版本/);
    expect(() => parse({ ...document(), mode: "everyone" })).toThrow(/mode 不认识/);
    expect(() => parse({ ...document(), allowlist: ["xiaobei", "xiaobei"] })).toThrow(/重复/);
    expect(() => parse({ ...document(), allowlist: ["小贝"] })).toThrow(/档案 id 不合法/);
    expect(() => parse({ ...document(), grants: [grant(), grant()] })).toThrow(/重复 grantId/);
    expect(() => parse({ ...document(), grants: [grant({ grantedBy: "agent" as never })] })).toThrow(/只认 owner/);
    expect(() => parse({ ...document(), grants: [grant({ scope: { source: "github" as never, lists: ["dispatch"] } })] }))
      .toThrow(/scope.source 只认 internal/);
    expect(() => parse({ ...document(), grants: [grant({ scope: { source: "internal", lists: ["other" as never] } })] }))
      .toThrow(/scope.lists 只认 dispatch/);
    expect(() => parse({ ...document(), grants: [grant({ expiresAt: "不是时间" })] })).toThrow(/不是合法时间/);
    expect(() => parse({ ...document(), history: [{ at: NOW.toISOString(), action: "delete", actor: "owner", detail: "x" }] }))
      .toThrow(/action 不认识/);
    expect(() => parseDispatchPolicyDocument("不是 JSON")).toThrow(/不是合法 JSON/);
  });
});

describe("名单判定：只收窄，且默认 fail-closed", () => {
  it("没配置 / 空名单都拒绝，理由分得清", () => {
    expect(dispatchDenialReason({ policy: emptyDispatchPolicySnapshot(), actorId: "xiaobei" }))
      .toMatch(/还没配置/);
    expect(dispatchDenialReason({
      policy: dispatchPolicySnapshotOf(document({ allowlist: [] })),
      actorId: "xiaobei",
    })).toMatch(/名单为空/);
  });

  it("名单里没有这个人就点名拒绝；有就放行（另外两道权威照旧判）", () => {
    const policy = dispatchPolicySnapshotOf(document());
    expect(dispatchDenialReason({ policy, actorId: "xiaobei" })).toBeUndefined();
    expect(dispatchDenialReason({ policy, actorId: "dagon" })).toMatch(/派活名单里没有 dagon/);
  });

  it("名单只能收窄：把档案放进名单不会让它绕过身份/队伍判定（这里只验证名单本身放行）", () => {
    const allowed = dispatchPolicySnapshotOf(document({ allowlist: ["dagon"] }));
    expect(dispatchDenialReason({ policy: allowed, actorId: "dagon" })).toBeUndefined();
    // 名单不含 xiaobei 时，即使它是队伍负责人也过不了这一关。
    expect(dispatchDenialReason({ policy: allowed, actorId: "xiaobei" })).toMatch(/没有 xiaobei/);
  });
});

describe("改名单授权：默认主人，授权要有效且范围匹配", () => {
  it("mode 是 owner 时 Agent 改不了；有有效授权才放行", () => {
    const ownerMode = snapshot({ mode: "owner" });
    expect(policyEditDenialReason({ policy: ownerMode, actorId: "xiaobei", now: NOW }))
      .toMatch(/只有主人/);

    const agentMode = snapshot();
    expect(policyEditDenialReason({ policy: agentMode, actorId: "xiaobei", now: NOW })).toBeUndefined();
    expect(requirePolicyEditGrant(agentMode, "xiaobei", NOW).grantId).toBe("grant-1");
    expect(policyEditDenialReason({ policy: agentMode, actorId: "xiaoma", now: NOW }))
      .toMatch(/没有有效的改名单授权/);
  });

  it("过期、已撤销、范围不匹配的授权都不算数", () => {
    const expired = snapshot({ grants: [grant({ expiresAt: "2026-11-06T09:00:00.000Z" })] });
    expect(policyEditDenialReason({ policy: expired, actorId: "xiaobei", now: NOW }))
      .toMatch(/没有有效的改名单授权/);

    const revoked = snapshot({ grants: [grant({ revokedAt: NOW.toISOString() })] });
    expect(policyEditDenialReason({ policy: revoked, actorId: "xiaobei", now: NOW }))
      .toMatch(/没有有效的改名单授权/);

    const wrongScope = snapshot({
      grants: [grant({ scope: { source: "internal", lists: [] as never } })],
    });
    expect(activePolicyGrants(wrongScope, NOW)).toEqual([]);
    expect(policyEditDenialReason({ policy: wrongScope, actorId: "xiaobei", now: NOW }))
      .toMatch(/没有有效的改名单授权/);
  });

  it("没有有效授权时放开开关会被拒绝（不能先发通行证再定门禁）", async () => {
    const root = await tempRoot();
    const repo = new DispatchPolicyRepository({ dataDir: root, now: () => NOW });
    await repo.saveAllowlist({ allowlist: ["xiaobei"], expectedRevision: 0 });
    await expect(repo.setMode({ mode: "agent", expectedRevision: 1 })).rejects.toThrow(/没有有效授权/);
  });
});

describe("名单规范化", () => {
  it("去空行、去首尾空白、去重", () => {
    expect(normalizeDispatchPolicyAllowlist([" xiaobei ", "", "xiaobei", "xiaoma"])).toEqual(["xiaobei", "xiaoma"]);
  });

  it("非法档案 id 直接拒绝", () => {
    expect(() => normalizeDispatchPolicyAllowlist(["小贝"])).toThrow(/档案 id 不合法/);
  });

  it("到期时间留空 = 不过期；过去的时间拒绝；合法时间归一成 ISO", () => {
    expect(normalizePolicyExpiry("", NOW)).toBeUndefined();
    expect(normalizePolicyExpiry("   ", NOW)).toBeUndefined();
    expect(() => normalizePolicyExpiry("2026-11-06T09:00:00.000Z", NOW)).toThrow(/必须晚于现在/);
    expect(normalizePolicyExpiry("2026-12-31T23:59:59+08:00", NOW)).toBe("2026-12-31T15:59:59.000Z");
  });
});

describe("名单仓库：修订锁、授权、留痕与重启后可读", () => {
  it("没保存过时是 configured:false、revision 0", async () => {
    const root = await tempRoot();
    const repo = new DispatchPolicyRepository({ dataDir: root, now: () => NOW });
    await expect(repo.snapshot()).resolves.toEqual(emptyDispatchPolicySnapshot());
  });

  it("第一次保存 revision 1，重启后还在，旧修订再保存会被 409 挡住", async () => {
    const root = await tempRoot();
    let sequence = 0;
    const repo = new DispatchPolicyRepository({
      dataDir: root,
      now: () => NOW,
      newGrantId: () => `grant-test-${++sequence}`,
    });
    const saved = await repo.saveAllowlist({ allowlist: ["xiaobei"], expectedRevision: 0 });
    expect(saved).toMatchObject({ configured: true, revision: 1, allowlist: ["xiaobei"], mode: "owner" });
    expect(saved.history.at(-1)).toMatchObject({ action: "save", actor: "owner" });

    // 重启：新实例读回同一份。
    const restarted = new DispatchPolicyRepository({ dataDir: root });
    await expect(restarted.snapshot()).resolves.toMatchObject({ revision: 1, allowlist: ["xiaobei"] });

    await expect(repo.saveAllowlist({ allowlist: ["xiaoma"], expectedRevision: 0 }))
      .rejects.toBeInstanceOf(DispatchPolicyConflictError);
    // 失败的那次没有写盘。
    await expect(restarted.snapshot()).resolves.toMatchObject({ revision: 1, allowlist: ["xiaobei"] });
  });

  it("授权：记录主人、范围、到期；同一 Agent 不能叠两份有效授权", async () => {
    const root = await tempRoot();
    let sequence = 0;
    const repo = new DispatchPolicyRepository({
      dataDir: root,
      now: () => NOW,
      newGrantId: () => `grant-test-${++sequence}`,
    });
    await repo.saveAllowlist({ allowlist: ["xiaobei"], expectedRevision: 0 });
    const granted = await repo.grant({ agentId: "xiaobei", expiresAt: "2026-12-31T00:00:00.000Z", expectedRevision: 1 });
    expect(granted.mode).toBe("agent");
    expect(granted.grants[0]).toMatchObject({
      grantId: "grant-test-1",
      grantedBy: "owner",
      agentId: "xiaobei",
      scope: { source: "internal", lists: ["dispatch"] },
      expiresAt: "2026-12-31T00:00:00.000Z",
    });
    expect(granted.history.at(-1)).toMatchObject({ action: "grant", actor: "owner", grantId: "grant-test-1" });

    await expect(repo.grant({ agentId: "xiaobei", expectedRevision: 2 })).rejects.toThrow(/已经有一份有效授权/);
    await expect(repo.grant({ agentId: "xiaoma", expiresAt: "2026-11-01T00:00:00.000Z", expectedRevision: 2 }))
      .rejects.toThrow(/必须晚于现在/);
  });

  it("授权记录满了只裁最老的已撤销记录，不动有效授权", async () => {
    const root = await tempRoot();
    const repo = new DispatchPolicyRepository({
      dataDir: root,
      now: () => NOW,
      newGrantId: () => "grant-new",
    });
    await repo.saveAllowlist({ allowlist: ["xiaobei"], expectedRevision: 0 });
    const saved = (await repo.load())!;
    const revoked = Array.from({ length: MAX_POLICY_GRANTS }, (_, index) =>
      grant({ grantId: `grant-old-${index}`, revokedAt: NOW.toISOString() }));
    await mkdir(path.join(root, "legion"), { recursive: true });
    await writeFile(repo.filePath, serializeDispatchPolicyDocument({
      ...saved,
      revision: 2,
      mode: "owner",
      grants: revoked,
    }), "utf8");

    const granted = await repo.grant({ agentId: "xiaobei", expectedRevision: 2 });
    expect(granted.grants).toHaveLength(MAX_POLICY_GRANTS);
    expect(granted.grants.some((item) => item.grantId === "grant-old-0")).toBe(false);
    expect(granted.grants.some((item) => item.grantId === "grant-new")).toBe(true);
  });

  it("过期授权也计入上限，但会被清理；不会写出解析器读不进的 65 份", async () => {
    const root = await tempRoot();
    const repo = new DispatchPolicyRepository({
      dataDir: root,
      now: () => NOW,
      newGrantId: () => "grant-new",
    });
    await repo.saveAllowlist({ allowlist: ["xiaobei"], expectedRevision: 0 });
    const saved = (await repo.load())!;
    const expired = Array.from({ length: MAX_POLICY_GRANTS }, (_, index) =>
      grant({
        grantId: `grant-expired-${index}`,
        agentId: `agent-${index}`,
        expiresAt: "2026-11-01T00:00:00.000Z",
      }));
    await mkdir(path.join(root, "legion"), { recursive: true });
    await writeFile(repo.filePath, serializeDispatchPolicyDocument({
      ...saved,
      revision: 2,
      mode: "owner",
      grants: expired,
    }), "utf8");

    const granted = await repo.grant({ agentId: "xiaobei", expectedRevision: 2 });
    expect(granted.grants).toHaveLength(MAX_POLICY_GRANTS);
    expect(granted.grants.some((item) => item.grantId === "grant-expired-0")).toBe(false);
    // 关键：新写出的文件必须仍然读得回来（旧实现会写出 65 份、下次 load 直接损坏）。
    await expect(new DispatchPolicyRepository({ dataDir: root }).snapshot())
      .resolves.toMatchObject({ revision: 3, mode: "agent" });
  });

  it("Agent 改名单：有效授权才放行，留痕写明 agent:<id> 与 grantId", async () => {
    const root = await tempRoot();
    let sequence = 0;
    const repo = new DispatchPolicyRepository({
      dataDir: root,
      now: () => NOW,
      newGrantId: () => `grant-test-${++sequence}`,
    });
    await repo.saveAllowlist({ allowlist: ["xiaobei"], expectedRevision: 0 });
    const granted = await repo.grant({ agentId: "xiaobei", expectedRevision: 1 });
    const grantId = granted.grants[0]!.grantId;

    const added = await repo.mutateAsAgent({ actorId: "xiaobei", action: "add", agentId: "dagon" });
    expect(added).toMatchObject({ changed: true, grantId });
    expect(added.snapshot.allowlist).toEqual(["xiaobei", "dagon"]);
    expect(added.snapshot.history.at(-1)).toMatchObject({ actor: "agent:xiaobei", grantId, action: "save" });

    // 没有授权的 Agent 一律拒绝，且不改盘。
    await expect(repo.mutateAsAgent({ actorId: "xiaoma", action: "add", agentId: "xiaoma" }))
      .rejects.toThrow(/没有有效的改名单授权/);
    await expect(repo.mutateAsAgent({ actorId: "xiaobei", action: "remove", agentId: "nobody" }))
      .resolves.toMatchObject({ changed: false });
  });

  it("撤销最后一份有效授权时，开关自动回落到「只有主人」", async () => {
    const root = await tempRoot();
    let sequence = 0;
    const repo = new DispatchPolicyRepository({
      dataDir: root,
      now: () => NOW,
      newGrantId: () => `grant-test-${++sequence}`,
    });
    await repo.saveAllowlist({ allowlist: ["xiaobei"], expectedRevision: 0 });
    const granted = await repo.grant({ agentId: "xiaobei", expectedRevision: 1 });
    const grantId = granted.grants[0]!.grantId;

    const revoked = await repo.revoke({ grantId, expectedRevision: granted.revision });
    expect(revoked.mode).toBe("owner");
    expect(revoked.grants[0]?.revokedAt).toBe(NOW.toISOString());
    expect(revoked.history.at(-1)).toMatchObject({ action: "revoke", grantId });
    await expect(repo.revoke({ grantId, expectedRevision: revoked.revision })).rejects.toThrow(/已经撤销/);
    await expect(repo.mutateAsAgent({ actorId: "xiaobei", action: "add", agentId: "dagon" }))
      .rejects.toThrow(/只有主人|没有有效/);
  });

  it("过期之后授权不再生效（时间由仓库注入，不靠系统时钟）", async () => {
    const root = await tempRoot();
    let current = new Date("2026-11-06T10:00:00.000Z");
    const repo = new DispatchPolicyRepository({
      dataDir: root,
      now: () => current,
      newGrantId: () => "grant-short",
    });
    await repo.saveAllowlist({ allowlist: ["xiaobei"], expectedRevision: 0 });
    await repo.grant({ agentId: "xiaobei", expiresAt: "2026-11-06T11:00:00.000Z", expectedRevision: 1 });
    current = new Date("2026-11-06T12:00:00.000Z");
    await expect(repo.mutateAsAgent({ actorId: "xiaobei", action: "add", agentId: "dagon" }))
      .rejects.toThrow(/没有有效的改名单授权/);
  });

  it("同一进程内并发改名单不会互相覆盖（队列把读改写串起来）", async () => {
    const root = await tempRoot();
    let sequence = 0;
    const repo = new DispatchPolicyRepository({
      dataDir: root,
      now: () => NOW,
      newGrantId: () => `grant-test-${++sequence}`,
    });
    await repo.saveAllowlist({ allowlist: [], expectedRevision: 0 });
    await repo.grant({ agentId: "xiaobei", expectedRevision: 1 });
    const [a, b] = await Promise.all([
      repo.mutateAsAgent({ actorId: "xiaobei", action: "add", agentId: "xiaoma" }),
      repo.mutateAsAgent({ actorId: "xiaobei", action: "add", agentId: "xiaohong" }),
    ]);
    expect(a.changed).toBe(true);
    expect(b.changed).toBe(true);
    const final = await repo.snapshot();
    expect(final.revision).toBe(4);
    expect(final.allowlist.sort()).toEqual(["xiaohong", "xiaoma"]);
  });

  it("损坏的文件拒绝读取（fail-closed），空名单允许保存但派活被拒", async () => {
    const root = await tempRoot();
    const repo = new DispatchPolicyRepository({ dataDir: root, now: () => NOW });
    await repo.saveAllowlist({ allowlist: ["xiaobei"], expectedRevision: 0 });
    const file = repo.filePath;
    expect(await readFile(file, "utf8")).toContain("\"allowlist\"");

    const emptied = await repo.saveAllowlist({ allowlist: [], expectedRevision: 1 });
    expect(emptied).toMatchObject({ configured: true, revision: 2, allowlist: [] });
    expect(dispatchDenialReason({ policy: emptied, actorId: "xiaobei" })).toMatch(/名单为空/);

    await writeFile(file, "{ 坏掉的 JSON", "utf8");
    const broken = new DispatchPolicyRepository({ dataDir: root, now: () => NOW });
    await expect(broken.snapshot()).rejects.toThrow(/派活名单损坏/);
  });
});
