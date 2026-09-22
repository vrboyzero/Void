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
  const directory = await mkdtemp(path.join(tmpdir(), "void-soul-atomic-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("writeFileAtomic", () => {
  it("覆盖写：内容原样落盘，自己的临时文件不留下", async () => {
    const directory = await makeDirectory();
    const target = path.join(directory, "state.json");

    await writeFileAtomic(target, "{\"who\":\"first\"}");
    await writeFileAtomic(target, "{\"who\":\"second\"}");

    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ who: "second" });
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("目录不存在就建出来（第一次写某个档案目录时用得着）", async () => {
    const directory = await makeDirectory();
    const target = path.join(directory, "agents", "小贝", "state.json");

    await writeFileAtomic(target, "{\"schemaVersion\":1}");

    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ schemaVersion: 1 });
  });

  it("同一个目标并发写入不会写出半截：最后落盘的是其中某一次完整内容", async () => {
    const directory = await makeDirectory();
    const target = path.join(directory, "bindings.json");
    const payloads = Array.from({ length: 24 }, (_, index) =>
      JSON.stringify({ index, filler: "x".repeat(index * 37) }),
    );

    await Promise.all(payloads.map((payload) => writeFileAtomic(target, payload)));

    // 灵魂侧不做按目标串行（写入都由人的动作驱动，一次一个），所以这里不承诺「最后一次调用赢」；
    // 承诺的是每一次 rename 都是完整的：读到的永远是某一次调用的全文。
    const written = JSON.parse(await readFile(target, "utf8")) as { index: number };
    expect(payloads.map((payload) => JSON.parse(payload))).toContainEqual(written);
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
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

    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("目标位置用不了时把错误抛出去，并清掉自己的临时文件", async () => {
    const directory = await makeDirectory();
    // 目标是个非空目录：rename 一定失败（Windows 与 POSIX 都不允许）。
    const target = path.join(directory, "occupied");
    await writeFileAtomic(path.join(target, "keep.json"), "{}");

    await expect(writeFileAtomic(target, "{}")).rejects.toThrow();

    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
