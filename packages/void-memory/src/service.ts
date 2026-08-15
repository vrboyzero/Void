import { Service, type Context } from "@deepseek-ai/cordis";

declare module "@deepseek-ai/cordis" {
  interface Context {
    voidMemory: VoidMemory;
  }
}

export interface MemorySearchResult {
  id: string;
  content: string;
  score: number;
}

/**
 * Service Definition for the Void knowledge seam. Owns `ctx.voidMemory` and
 * the vocabulary; providers implement it (full Star MemoryStore snapshot),
 * consumers (memory_* tools) inject it.
 */
export abstract class VoidMemory extends Service {
  constructor(ctx: Context) {
    super(ctx, "voidMemory");
  }

  /** Write one chunk (optionally with its embedding vector) and return its id. */
  abstract store(content: string, embedding?: Float32Array): string;

  /** Keyword search over FTS5. */
  abstract search(query: string, k: number): MemorySearchResult[];

  /** KNN vector search over sqlite-vec vec0. */
  abstract searchByVector(embedding: Float32Array, k: number): MemorySearchResult[];

  /** Ingest a document (split into chunks + store), returning the chunk count. */
  abstract ingest(content: string): number;
}
