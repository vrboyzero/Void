import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomic } from "../src/atomic-file.js";

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

const directories: string[] = [];

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "void-atomic-file-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("writeFileAtomic", () => {
  it("同一个目标文件并发写入：不串行就会写出坏 JSON，最后落盘的是最后一次调用", async () => {
    const directory = await makeDirectory();
    const target = path.join(directory, "run.json");

    // 每一份都是合法 JSON，但长度不同——互相踩就会拼出「合法 JSON 后面还跟着东西」。
    const payloads = Array.from({ length: 24 }, (_, index) =>
      JSON.stringify({ index, filler: "x".repeat(index * 37) }),
    );
    await Promise.all(payloads.map((payload) => writeFileAtomic(target, payload)));

    const written = await readFile(target, "utf8");
    // 坏文件会在这里抛：Unexpected non-whitespace character after JSON。
    expect(() => JSON.parse(written)).not.toThrow();
    // 并发 rename 的完成顺序不保证等于调用顺序，所以这里要求的是「链上最后一次」。
    expect(JSON.parse(written)).toEqual(JSON.parse(payloads.at(-1)!));
  });

  it("不同目标文件互不影响，目录自动创建", async () => {
    const directory = await makeDirectory();
    const first = path.join(directory, "nested", "a.json");
    const second = path.join(directory, "nested", "b.json");
    await Promise.all([
      writeFileAtomic(first, "{\"who\":\"a\"}"),
      writeFileAtomic(second, "{\"who\":\"b\"}"),
    ]);
    expect(JSON.parse(await readFile(first, "utf8"))).toEqual({ who: "a" });
    expect(JSON.parse(await readFile(second, "utf8"))).toEqual({ who: "b" });
  });

  it("写失败时把错误抛出去，并清掉自己的临时文件", async () => {
    const directory = await makeDirectory();
    // 目标位置是个非空目录：rename 一定失败（Windows 与 POSIX 都不允许）。
    const target = path.join(directory, "occupied");
    await writeFileAtomic(path.join(target, "keep.json"), "{}");

    await expect(writeFileAtomic(target, "{}")).rejects.toThrow();

    const leftovers = (await readdir(directory)).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("rename 被临时占住（EPERM）会重试，不把整次写入判死", async () => {
    const directory = await makeDirectory();
    const target = path.join(directory, "retry.json");
    state.renameFailures = 2;

    await writeFileAtomic(target, "{\"ok\":true}");

    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ ok: true });
    expect(state.renameFailures).toBe(0);
  });

  it("EPERM 一直不消失时如实失败，并清掉自己的临时文件", async () => {
    const directory = await makeDirectory();
    const target = path.join(directory, "always-busy.json");
    state.renameFailures = 99;
    try {
      await expect(writeFileAtomic(target, "{}")).rejects.toThrow(/EPERM/);
    } finally {
      state.renameFailures = 0;
    }

    const leftovers = (await readdir(directory)).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});
