import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createExternalSourceDocument,
  defaultExternalSourceConfig,
  ExternalSourceRepository,
  externalSeenKey,
  externalSourceSnapshotOf,
  hasSeenExternalEvent,
  MAX_EXTERNAL_SOURCE_ENTRIES,
  parseExternalSourceDocument,
  recordExternalSourceOutcome,
  rememberExternalSeen,
  serializeExternalSourceDocument,
} from "../src/external-source.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function config(overrides: Partial<Parameters<typeof defaultExternalSourceConfig>[0]> = {}) {
  return defaultExternalSourceConfig({ repo: "owner/name", teamId: "alpha", ...overrides });
}

function document() {
  return createExternalSourceDocument({
    config: config(),
    now: new Date("2026-11-06T00:00:00Z"),
  });
}

describe("外部来源契约", () => {
  it("默认全收着：allowed/bots 为空、receive 全 false、mode=observe", () => {
    const doc = document();
    expect(doc.config.allowed).toEqual([]);
    expect(doc.config.bots).toEqual([]);
    expect(doc.config.receive).toEqual({ issues: false, pulls: false, comments: false, ci: false });
    expect(doc.runtime.mode).toBe("observe");
    expect(doc.runtime.status).toBe("setup");
  });

  it("缺 runtime 的手写配置按默认状态补，不猜成 live", () => {
    const parsed = parseExternalSourceDocument(JSON.stringify({
      schemaVersion: 1,
      revision: 0,
      updatedAt: "2026-11-06T00:00:00Z",
      updatedBy: "owner",
      config: config(),
    }));
    expect(parsed.runtime.mode).toBe("observe");
    expect(parsed.runtime.status).toBe("setup");
    expect(parsed.runtime.seen).toEqual([]);
  });

  it("repo / teamId / interval 不合格就拒", () => {
    const base = JSON.parse(serializeExternalSourceDocument(document()));
    expect(() => parseExternalSourceDocument(JSON.stringify({ ...base, config: { ...base.config, repo: "no-slash" } })))
      .toThrow(/config.repo/);
    expect(() => parseExternalSourceDocument(JSON.stringify({ ...base, config: { ...base.config, teamId: "" } })))
      .toThrow(/config.teamId/);
    expect(() => parseExternalSourceDocument(JSON.stringify({ ...base, config: { ...base.config, intervalMs: 100 } })))
      .toThrow(/intervalMs/);
  });

  it("允许列表空也不放宽：快照只给数据，准入判定在轮询层", () => {
    const snapshot = externalSourceSnapshotOf(document());
    expect(snapshot.config.allowed).toEqual([]);
    expect(snapshot.state).toBe("setup");
    expect(snapshot.reason).toContain("setup");
  });

  it("账本按 UTC 日计数，entries 截断，不改 revision", () => {
    let doc = document();
    for (let index = 0; index < MAX_EXTERNAL_SOURCE_ENTRIES + 5; index++) {
      doc = recordExternalSourceOutcome(doc, {
        outcome: "observed",
        channel: "owner/name#1",
        eventId: `notif-${index}`,
      }, new Date("2026-11-06T01:00:00Z"));
    }
    expect(doc.revision).toBe(0);
    expect(doc.runtime.counts["2026-11-06"]?.observed).toBe(MAX_EXTERNAL_SOURCE_ENTRIES + 5);
    expect(doc.runtime.entries).toHaveLength(MAX_EXTERNAL_SOURCE_ENTRIES);
    expect(doc.runtime.entries.at(-1)?.eventId).toBe(`notif-${MAX_EXTERNAL_SOURCE_ENTRIES + 4}`);
  });

  it("去重按通知 id + updatedAt + 评论 id，重复记同一条只保留一份", () => {
    let doc = document();
    const seen = { notificationId: "n1", updatedAt: "2026-11-06T01:00:00Z", commentId: "c1" };
    expect(hasSeenExternalEvent(doc, seen)).toBe(false);
    doc = rememberExternalSeen(doc, seen);
    expect(hasSeenExternalEvent(doc, seen)).toBe(true);
    doc = rememberExternalSeen(doc, seen);
    expect(doc.runtime.seen).toHaveLength(1);
    expect(externalSeenKey(seen)).toContain("n1");
    expect(hasSeenExternalEvent(doc, { ...seen, commentId: "c2" })).toBe(false);
  });

  it("revision 不被账本/状态写入改动；配置写入由上层负责", () => {
    const doc = document();
    const next = recordExternalSourceOutcome(doc, { outcome: "filtered", reason: "没 @" });
    expect(next.revision).toBe(doc.revision);
    expect(next.updatedAt).not.toBe(doc.updatedAt);
  });
});

describe("ExternalSourceRepository", () => {
  it("保存 / 读取往返；坏文件报错；trySnapshot 不抛", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "void-source-"));
    directories.push(dataDir);
    const repo = new ExternalSourceRepository({ dataDir, now: () => new Date("2026-11-06T02:00:00Z") });
    expect(await repo.load()).toBeUndefined();
    await repo.save(document());
    const loaded = await repo.load();
    expect(loaded?.config.repo).toBe("owner/name");
    await writeFile(repo.path, "{坏", "utf8");
    await expect(repo.load()).rejects.toThrow(/外部来源配置损坏/);
    expect(await repo.trySnapshot()).toBeUndefined();
  });

  it("mutate 串行并写回；没有文件时明确拒绝", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "void-source-"));
    directories.push(dataDir);
    const repo = new ExternalSourceRepository({ dataDir });
    await expect(repo.mutate((current) => current)).rejects.toThrow(/还没配置/);
    await repo.save(document());
    const next = await repo.mutate((current) => recordExternalSourceOutcome(current, { outcome: "observed" }));
    expect(next.runtime.counts["2026-11-06"]?.observed).toBe(1);
    expect((await repo.load())?.runtime.counts["2026-11-06"]?.observed).toBe(1);
  });

  it("upsert 允许在没有文件时创建第一份配置，不改 mutate 的 fail-closed 语义", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "void-source-"));
    directories.push(dataDir);
    const repo = new ExternalSourceRepository({ dataDir });
    expect(await repo.load()).toBeUndefined();
    const created = await repo.upsert((current) => {
      expect(current).toBeUndefined();
      return { ...document(), revision: 1 };
    });
    expect(created.revision).toBe(1);
    expect((await repo.load())?.revision).toBe(1);
  });
});
