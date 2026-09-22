import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import MemoryLibraryService from "../src/memory-service.js";

describe("voidMemoryLibrary（面板门面）", () => {
  it("有数据根时数据根就是配置里那个", () => {
    const dataDir = path.resolve("/data/void");
    const service = new MemoryLibraryService(new Context(), { dataDir });
    expect(service.dataRoot).toBe(dataDir);
  });

  it("没配数据根也照常加载，用到才报错：方法与工具一样是 reject，不是同步抛", async () => {
    // profile 给空串 = 明确「没配档案名」，与 DSH_PROFILE 未设同义（不依赖测试进程的环境）。
    const service = new MemoryLibraryService(new Context(), { profile: "" });
    expect(service.dataRoot).toBeUndefined();
    await expect(service.listAgents()).rejects.toThrow(/人格记忆没有数据根，无法读写记忆/);
    await expect(service.list()).rejects.toThrow(/人格记忆没有数据根/);
  });
});
