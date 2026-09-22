import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryDocumentError,
  assertEntryId,
  assertMemoryDate,
  entryDateOf,
  isTemporaryMemoryFile,
  memoryDateOf,
  nextEntryId,
  parseEntryDocument,
  parseLongTermDocument,
  resolveEntryPath,
  resolveLongTermPath,
  resolveRetractedPath,
  serializeEntryDocument,
  serializeLongTermDocument,
  writeFileAtomic,
} from "../src/documents.js";

/** 让 rename 先失败几次：模拟 Windows 上杀毒/索引器短暂按住目标文件。 */
const state = vi.hoisted(() => ({ renameFailures: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (state.renameFailures > 0) {
        state.renameFailures -= 1;
        const error = new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`) as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return await actual.rename(from, to);
    },
  };
});

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "void-memory-docs-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("记忆正文的 id 与路径", () => {
  it("只接受路径安全的条目 id", () => {
    expect(() => assertEntryId("20260922-0001")).not.toThrow();
    for (const bad of ["../../etc/passwd", "..", ".", "a/b", "C:\\temp", "", "AB", "条目一"]) {
      expect(() => assertEntryId(bad)).toThrow(MemoryDocumentError);
    }
  });

  it("日期必须真实存在", () => {
    expect(() => assertMemoryDate("2026-09-22")).not.toThrow();
    expect(() => assertMemoryDate("2026-02-30")).toThrow(MemoryDocumentError);
    expect(() => assertMemoryDate("2026-9-2")).toThrow(MemoryDocumentError);
  });

  it("条目路径始终落在本档案的日记目录内", () => {
    const entryId = "20260922-0001";
    const resolved = resolveEntryPath(root, "2026-09-22", entryId);
    expect(resolved.startsWith(path.resolve(root, "memory"))).toBe(true);
    expect(path.basename(resolved)).toBe("20260922-0001.md");
    expect(() => resolveEntryPath(root, "2026-09-22", "../escape")).toThrow(MemoryDocumentError);
    expect(() => resolveRetractedPath(root, "..\\escape")).toThrow(MemoryDocumentError);
  });

  it("从条目 id 反推日期，非法日期不认", () => {
    expect(entryDateOf("20260922-0001")).toBe("2026-09-22");
    expect(entryDateOf("20261322-0001")).toBeUndefined();
    expect(entryDateOf("hello")).toBeUndefined();
  });

  it("生成可读的日期与条目 id", () => {
    const now = new Date(2026, 8, 22, 10, 30);
    expect(memoryDateOf(now)).toBe("2026-09-22");
    expect(nextEntryId(now, 7)).toBe("20260922-0007");
  });

  it("长期文字与撤回区路径固定", () => {
    expect(resolveLongTermPath(root)).toBe(path.resolve(root, "MEMORY.md"));
    expect(resolveRetractedPath(root, "20260922-0001")).toBe(path.resolve(root, "retracted", "20260922-0001.md"));
  });

  it("临时文件不会被当成记忆体", () => {
    expect(isTemporaryMemoryFile(".MEMORY.md.1.2.tmp")).toBe(true);
    expect(isTemporaryMemoryFile("20260922-0001.md.tmp")).toBe(true);
    expect(isTemporaryMemoryFile("20260922-0001.md")).toBe(false);
  });
});

describe("记忆正文的读写格式", () => {
  it("条目往返保持修订与正文", () => {
    const text = serializeEntryDocument({
      entryId: "20260922-0001",
      date: "2026-09-22",
      createdAt: "2026-09-22T02:00:00.000Z",
      updatedAt: "2026-09-22T03:00:00.000Z",
      revision: 3,
      source: "agent",
      body: "小贝的第一条守则：先看清再动手。\n",
    });
    const parsed = parseEntryDocument(text);
    expect(parsed.entryId).toBe("20260922-0001");
    expect(parsed.date).toBe("2026-09-22");
    expect(parsed.revision).toBe(3);
    expect(parsed.source).toBe("agent");
    expect(parsed.body).toBe("小贝的第一条守则：先看清再动手。\n");
  });

  it("条目缺前置信息时报错，不猜", () => {
    expect(() => parseEntryDocument("只有正文")).toThrow(MemoryDocumentError);
    expect(() => parseEntryDocument("只有正文", "20260922-0001")).toThrow(MemoryDocumentError);
  });

  it("长期文字没有前置信息时按手工编辑处理", () => {
    const parsed = parseLongTermDocument("手写的长期记忆\n第二行\n");
    expect(parsed.revision).toBe(0);
    expect(parsed.body).toBe("手写的长期记忆\n第二行\n");
  });

  it("长期文字带前置信息时读修订", () => {
    const text = serializeLongTermDocument({ revision: 2, updatedAt: "2026-09-22T03:00:00.000Z", body: "长期内容\n" });
    const parsed = parseLongTermDocument(text);
    expect(parsed.revision).toBe(2);
    expect(parsed.updatedAt).toBe("2026-09-22T03:00:00.000Z");
    expect(parsed.body).toBe("长期内容\n");
  });
});

describe("原子写盘", () => {
  it("写完不留临时文件", async () => {
    const target = resolveEntryPath(root, "2026-09-22", "20260922-0001");
    await writeFileAtomic(target, "第一版\n");
    await writeFileAtomic(target, "第二版\n");
    expect(await readFile(target, "utf8")).toBe("第二版\n");
    const names = await readdir(path.dirname(target));
    expect(names).toEqual(["20260922-0001.md"]);
  });

  it("rename 被临时占住（EPERM）会重试，不把整次写入判死", async () => {
    const target = resolveEntryPath(root, "2026-09-22", "20260922-0002");
    state.renameFailures = 2;

    await writeFileAtomic(target, "重试之后写进去了\n");

    expect(await readFile(target, "utf8")).toBe("重试之后写进去了\n");
    expect(state.renameFailures).toBe(0);
    expect(await readdir(path.dirname(target))).toEqual(["20260922-0002.md"]);
  });

  it("EPERM 一直不消失时如实失败，不留半截正文", async () => {
    const target = resolveEntryPath(root, "2026-09-22", "20260922-0003");
    state.renameFailures = 99;
    try {
      await expect(writeFileAtomic(target, "写不进去\n")).rejects.toThrow(/EPERM/);
    } finally {
      state.renameFailures = 0;
    }

    expect(await readdir(path.dirname(target))).toEqual([]);
  });
});
