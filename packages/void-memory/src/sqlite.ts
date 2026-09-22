import { MemoryStore } from "./star/store.js";
import type { Context } from "@deepseek-ai/cordis";
import { VoidMemoryLegacy, type LegacyMemorySearchResult } from "./service.js";

export interface VoidMemorySqliteConfig {
  path?: string;
}

let chunkSeq = 0;

function nextChunkId(): string {
  chunkSeq += 1;
  return `void-chunk-${Date.now()}-${chunkSeq}`;
}

/**
 * 旧 provider：包装完整的 Star belldandy-memory MemoryStore 快照（FTS5 +
 * sqlite-vec + experience/tree/task 表）。它没有执行身份，因此只登记
 * `voidMemoryLegacy`，供隔离的旧 profile 使用；新记忆一律走
 * `@void/void-memory/provider`。
 */
export class VoidMemorySqlite extends VoidMemoryLegacy {
  private readonly memoryStore: MemoryStore;

  constructor(ctx: Context, config: VoidMemorySqliteConfig = {}) {
    super(ctx);
    // VOID_* namespace: data dir independent of DSH_HOME / ~/.star_sanctuary.
    const path = config.path ?? process.env.VOID_MEMORY_PATH ?? ":memory:";
    this.memoryStore = new MemoryStore(path);
  }

  store(content: string, embedding?: Float32Array): string {
    const id = nextChunkId();
    this.memoryStore.upsertChunk({
      id,
      sourcePath: "void",
      sourceType: "manual",
      memoryType: "core",
      content,
    });
    if (embedding !== undefined) {
      this.memoryStore.upsertChunkVector(id, Array.from(embedding), "void-model");
    }
    return id;
  }

  search(query: string, k: number): LegacyMemorySearchResult[] {
    return this.memoryStore.searchKeyword(query, k).map(toResult);
  }

  searchByVector(embedding: Float32Array, k: number): LegacyMemorySearchResult[] {
    return this.memoryStore.searchVector(Array.from(embedding), k).map(toResult);
  }

  ingest(content: string): number {
    const chunks = content
      .split(/\n\s*\n/)
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.length > 0);
    chunks.forEach((chunk) => {
      this.memoryStore.upsertChunk({
        id: nextChunkId(),
        sourcePath: "ingest",
        sourceType: "manual",
        memoryType: "core",
        content: chunk,
      });
    });
    return chunks.length;
  }
}

function toResult(result: { id: string; content?: string; snippet: string; score: number }): LegacyMemorySearchResult {
  return {
    id: result.id,
    content: result.content ?? result.snippet,
    score: result.score,
  };
}

export default VoidMemorySqlite;
