import type { Context } from "@deepseek-ai/cordis";
import { dataRootOptions } from "@void/void-soul";
import { resolveDataRoot } from "./actor.js";
import { AgentMemoryStore, agentMemoryRoot, assertAgentId, type MemoryListResult, type MemoryDocumentView, type MemoryRetractResult, type MemorySearchResult, type MemoryTarget, type MemoryWriteResult } from "./agent-store.js";
import { resolveIndexPath } from "./documents.js";
import { MemoryIndexStore } from "./index-store.js";
import { assertMemoryPathInside } from "./paths.js";
import { VoidMemory, type AgentMemoryHandle, type MemoryActorBinding } from "./service.js";

export interface VoidMemoryFilesConfig {
  /** 显式数据根（绝对路径）。给了就不再解析 DSH_HOME / profile。 */
  dataDir?: string | undefined;
  dshHome?: string | undefined;
  profile?: string | undefined;
  now?: (() => Date) | undefined;
}

/**
 * 新 provider：每份档案一个 Markdown 记忆仓（`MEMORY.md` + `memory/<日期>/<id>.md`）
 * 加一个只服务于检索的 `memory.sqlite`。
 *
 * 它不导入 `src/star/` 的任何东西，也不接受任意 `agentId`/路径入参：
 * 句柄只由 `forAgent(binding)` 产生，根目录由数据根 + 已校验的档案 id 拼出。
 * 索引按需打开、有界缓存，卸载时统一关句柄。
 */
export class VoidMemoryFiles extends VoidMemory {
  private readonly dataDir: string;
  private readonly now: () => Date;
  private readonly stores = new Map<string, AgentMemoryStore>();
  private readonly indexes = new Map<string, MemoryIndexStore>();

  constructor(ctx: Context, config: VoidMemoryFilesConfig = {}) {
    super(ctx);
    this.dataDir = resolveDataDir(ctx, config);
    this.now = config.now ?? (() => new Date());
    ctx.effect(() => () => this.close(), "void-memory: close indexes");
  }

  get dataRoot(): string {
    return this.dataDir;
  }

  forAgent(binding: MemoryActorBinding): AgentMemoryHandle {
    if (binding === null || typeof binding !== "object") {
      throw new Error("记忆访问缺少执行身份，已拒绝");
    }
    assertAgentId(binding.agentId);
    return new BoundAgentMemory(this.storeFor(binding.agentId), binding);
  }

  /** 关闭所有已打开的索引句柄。重复调用安全。 */
  close(): void {
    for (const index of this.indexes.values()) {
      try {
        index.close();
      } catch {
        // 关闭失败不掩盖卸载流程；句柄由进程退出兜底回收。
      }
    }
    this.indexes.clear();
    this.stores.clear();
  }

  private storeFor(agentId: string): AgentMemoryStore {
    const cached = this.stores.get(agentId);
    if (cached !== undefined) return cached;
    const store = new AgentMemoryStore({
      root: agentMemoryRoot(this.dataDir, agentId),
      dataRoot: this.dataDir,
      agentId,
      index: this.indexFor(agentId),
      now: this.now,
    });
    this.stores.set(agentId, store);
    return store;
  }

  private indexFor(agentId: string): MemoryIndexStore {
    const cached = this.indexes.get(agentId);
    if (cached !== undefined) return cached;
    // 索引句柄在这里同步打开，所以路径也要在这里先过一遍守卫（看穿链接）。
    const index = MemoryIndexStore.open({
      path: assertMemoryPathInside(this.dataDir, resolveIndexPath(agentMemoryRoot(this.dataDir, agentId)), "记忆索引"),
      agentId,
    });
    this.indexes.set(agentId, index);
    return index;
  }
}

/**
 * 把一个档案的记忆仓绑到一个具体执行身份上：写入自动记下来源与来源会话，
 * 但仓储本身按档案共享（同一档案的并发写入仍然串行）。
 */
class BoundAgentMemory implements AgentMemoryHandle {
  constructor(
    private readonly inner: AgentMemoryStore,
    private readonly binding: MemoryActorBinding,
  ) {}

  get agentId(): string {
    return this.inner.agentId;
  }

  search(input: { query: string; k?: number }): Promise<MemorySearchResult[]> {
    return this.inner.search(input);
  }

  read(target: MemoryTarget): Promise<MemoryDocumentView> {
    return this.inner.read(target);
  }

  list(input: { limit?: number; cursor?: string } = {}): Promise<MemoryListResult> {
    return this.inner.list(input);
  }

  write(input: { body: string; target?: "entry" | "long-term"; date?: string }): Promise<MemoryWriteResult> {
    return this.inner.write({
      ...input,
      ...(this.binding.source === undefined ? {} : { source: this.binding.source }),
      ...(this.binding.sessionId === undefined ? {} : { session: this.binding.sessionId }),
    });
  }

  update(input: { target: MemoryTarget; body: string; expectedRevision: number }): Promise<MemoryWriteResult> {
    return this.inner.update(input);
  }

  retract(input: { target: MemoryTarget; expectedRevision?: number }): Promise<MemoryRetractResult> {
    return this.inner.retract(input);
  }
}

function resolveDataDir(ctx: Context, config: VoidMemoryFilesConfig): string {
  return resolveDataRoot(dataRootOptions(ctx, config));
}

export default VoidMemoryFiles;
