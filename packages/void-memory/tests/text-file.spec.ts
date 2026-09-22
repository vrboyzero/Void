import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_MEMORY_TEXT_BYTES, MemoryDocumentError, decodeUtf8Text, readUtf8TextFile } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempFile(bytes: Uint8Array): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "void-memory-text-"));
  roots.push(root);
  const file = path.join(root, "MEMORY.md");
  await writeFile(file, bytes);
  return file;
}

const GOOD = Buffer.from("---\nrevision: 1\n---\n\n小贝喜欢先看日志再看代码。🙂\n", "utf8");

describe("decodeUtf8Text（记忆侧）", () => {
  it("合法 UTF-8 原样解出来", () => {
    expect(decodeUtf8Text(GOOD, "长期记忆正文")).toBe(GOOD.toString("utf8"));
  });

  it("坏字节抛 MemoryDocumentError，消息里有位置与「另存为 UTF-8」", () => {
    const broken = Buffer.concat([Buffer.from("正文\n", "utf8"), Buffer.from([0xc3, 0x28])]);
    let caught: unknown;
    try {
      decodeUtf8Text(broken, "记忆条目正文", "memory/2026-09-22/e1.md");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MemoryDocumentError);
    expect((caught as Error).message).toContain("记忆条目正文 不是有效的 UTF-8 文本: memory/2026-09-22/e1.md");
    expect((caught as Error).message).toContain("另存为 UTF-8");
  });

  it("超大拒绝，边界值放行", () => {
    expect(() => decodeUtf8Text(Buffer.alloc(9), "长期记忆正文", undefined, 8)).toThrow(/太大，拒绝读入/);
    expect(decodeUtf8Text(Buffer.alloc(8, 0x61), "长期记忆正文", undefined, 8)).toHaveLength(8);
  });

  it("默认上限是 8 MiB", () => {
    expect(MAX_MEMORY_TEXT_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe("readUtf8TextFile（记忆侧）", () => {
  it("读得到合法文件；坏文件抛错且带路径", async () => {
    const good = await tempFile(GOOD);
    expect(await readUtf8TextFile(good, "长期记忆正文")).toBe(GOOD.toString("utf8"));
    const bad = await tempFile(Buffer.from([0xff]));
    await expect(readUtf8TextFile(bad, "长期记忆正文")).rejects.toThrow(/不是有效的 UTF-8 文本/);
  });
});
