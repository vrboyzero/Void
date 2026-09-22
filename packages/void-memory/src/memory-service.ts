/**
 * `voidMemoryLibrary` 的真服务：**人类管理入口**（虚空面板）读写记忆的门面。
 *
 * 与 `voidMemory` 分开是有意的：那个服务只认执行身份（会话绑定），写给模型工具用，
 * 工具缺会话就拒绝；这个只认数据根，给人看的视图用，**不发布任何工具**，也不碰会话绑定
 * ——§16.1 的「记忆详情」由人来操作，操作范围服从 14.1 的推荐矩阵（正文可改、撤回显式）。
 *
 * @module @void/void-memory/src/memory-service
 */
import type { Context } from "@deepseek-ai/cordis";
import { Service } from "@deepseek-ai/cordis";
import { dataRootOptions, SoulProfileError, tryResolveVoidDataRoot } from "@void/void-soul";
import {
  MemoryLibrary,
  type MemoryItemDetail,
  type MemoryLibraryList,
  type MemorySearchHit,
} from "./memory-library.js";

export interface MemoryLibraryConfig {
  /** 显式数据根（绝对路径）。给了就不再解析 DSH_HOME / profile。 */
  dataDir?: string | undefined;
  dshHome?: string | undefined;
  profile?: string | undefined;
  /** 测试用的时钟覆盖。 */
  now?: (() => Date) | undefined;
}

export class MemoryLibraryService extends Service {
  private readonly library: MemoryLibrary | undefined;

  constructor(ctx: Context, config: MemoryLibraryConfig = {}) {
    super(ctx, "voidMemoryLibrary");
    const dataDir = tryResolveVoidDataRoot(dataRootOptions(ctx, config));
    this.library = dataDir === undefined
      ? undefined
      : new MemoryLibrary({ dataDir, ...(config.now === undefined ? {} : { now: config.now }) });
    // 面板可能开过索引连接（只在 memory.sqlite 已存在时开）：插件卸载时关掉，
    // 免得 WAL 句柄留在那儿挡住别人。
    ctx.effect(() => () => this.library?.close(), "void-memory: close panel indexes");
  }

  /** 本服务实际使用的数据根；没配好时为 undefined（此时照常加载，用到才报错）。 */
  get dataRoot(): string | undefined {
    return this.library?.dataRoot;
  }

  /** 没配数据根时抛一句看得懂的错，而不是让整个插件树加载失败（见 13.1 与 profile.ts）。 */
  private requireLibrary(): MemoryLibrary {
    const library = this.library;
    if (library === undefined) {
      throw new SoulProfileError("人格记忆没有数据根，无法读写记忆：需要配置 dataDir，或同时提供 profile（DSH_PROFILE）与 dshHome（DSH_HOME）");
    }
    return library;
  }

  async listAgents(): Promise<string[]> {
    return this.requireLibrary().listAgents();
  }

  async list(input: { limit?: number } = {}): Promise<MemoryLibraryList> {
    return this.requireLibrary().list(input);
  }

  async search(input: { query: string; k?: number }): Promise<{ hits: MemorySearchHit[]; notes: readonly string[] }> {
    return this.requireLibrary().search(input);
  }

  async read(itemId: string): Promise<MemoryItemDetail> {
    return this.requireLibrary().read(itemId);
  }

  async save(input: { itemId: string; body: string; expectedRevision: number }): Promise<MemoryItemDetail> {
    return this.requireLibrary().save(input);
  }

  async retract(input: { itemId: string; expectedRevision?: number }): Promise<{ itemId: string; recoveredPath: string; revision: number; warning?: string }> {
    return this.requireLibrary().retract(input);
  }
}

export default MemoryLibraryService;
