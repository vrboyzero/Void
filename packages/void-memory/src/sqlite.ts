import { MemoryStore } from "@void/star-belldandy-memory";
import type { Context } from "@deepseek-ai/cordis";
import { VoidMemory, type MemorySearchResult } from "./service.js";

export interface VoidMemorySqliteConfig {
  path?: string;
}

let chunkSeq = 0;

function nextChunkId(): string {
  chunkSeq += 1;
  return `void-chunk-${Date.now()}-${chunkSeq}`;
}

/**
 * Provider: wraps the full Star belldandy-memory MemoryStore snapshot (FTS5 +
 * sqlite-vec + experience/tree/task schema), exposing the minimal knowledge
 * seam surface. The richer MemoryStore API (dream/tree/experience) stays
 * reachable for later stages.
 */
export class VoidMemorySqlite extends VoidMemory {
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

  search(query: string, k: number): MemorySearchResult[] {
    return this.memoryStore.searchKeyword(query, k).map(toResult);
  }

  searchByVector(embedding: Float32Array, k: number): MemorySearchResult[] {
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

function toResult(result: { id: string; content?: string; snippet: string; score: number }): MemorySearchResult {
  return {
    id: result.id,
    content: result.content ?? result.snippet,
    score: result.score,
  };
}

export default VoidMemorySqlite;
