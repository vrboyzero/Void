import { createHash } from "node:crypto";

import type { EmbeddingVector } from "./embeddings/index.js";

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_MAX_BYTES = 1_024 * 1_024;

export type QueryEmbeddingCacheOptions = {
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  now?: () => number;
};

export type QueryEmbeddingLoadContext = {
  signal: AbortSignal;
};

type QueryEmbeddingCacheEntry = {
  vector: EmbeddingVector;
  bytes: number;
  expiresAt: number;
};

type QueryEmbeddingInFlight = {
  controller: AbortController;
  consumers: number;
  settled: boolean;
  promise: Promise<EmbeddingVector>;
};

export type QueryEmbeddingCacheResolveOptions = {
  signal?: AbortSignal;
  load: (context: QueryEmbeddingLoadContext) => Promise<EmbeddingVector>;
};

/**
 * Query embedding 只在当前 MemoryManager 进程内短暂复用。
 * 索引 chunk 的 SQLite embedding_cache 与这里的查询结果具有不同的生命周期和 key 语义。
 */
export class QueryEmbeddingCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, QueryEmbeddingCacheEntry>();
  private readonly inFlight = new Map<string, QueryEmbeddingInFlight>();
  private bytes = 0;

  constructor(options: QueryEmbeddingCacheOptions = {}) {
    this.ttlMs = normalizePositiveInteger(options.ttlMs, DEFAULT_TTL_MS);
    this.maxEntries = normalizePositiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.maxBytes = normalizePositiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
    this.now = options.now ?? Date.now;
  }

  resolve(key: string, options: QueryEmbeddingCacheResolveOptions): Promise<EmbeddingVector> {
    const cached = this.get(key);
    if (cached) return Promise.resolve(cached);

    let active = this.inFlight.get(key);
    if (!active || active.controller.signal.aborted) {
      active = this.start(key, options.load);
    }
    return this.consume(active, options.signal);
  }

  close(): void {
    this.entries.clear();
    this.bytes = 0;
    for (const active of this.inFlight.values()) {
      active.controller.abort(new DOMException("Query embedding cache is closing.", "AbortError"));
    }
    this.inFlight.clear();
  }

  private start(
    key: string,
    load: QueryEmbeddingCacheResolveOptions["load"],
  ): QueryEmbeddingInFlight {
    const controller = new AbortController();
    let active!: QueryEmbeddingInFlight;
    let loaded: Promise<EmbeddingVector>;
    try {
      loaded = Promise.resolve(load({ signal: controller.signal }));
    } catch (error) {
      loaded = Promise.reject(error);
    }

    active = {
      controller,
      consumers: 0,
      settled: false,
      promise: loaded.then((vector) => {
        if (!controller.signal.aborted && isCacheableVector(vector)) {
          this.set(key, vector);
        }
        return cloneVector(vector);
      }).finally(() => {
        active.settled = true;
        if (this.inFlight.get(key) === active) {
          this.inFlight.delete(key);
        }
      }),
    };
    this.inFlight.set(key, active);
    return active;
  }

  private consume(active: QueryEmbeddingInFlight, signal?: AbortSignal): Promise<EmbeddingVector> {
    if (signal?.aborted) {
      this.abortIfUnused(active);
      return Promise.reject(signal.reason);
    }

    active.consumers += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      signal?.removeEventListener("abort", release);
      active.consumers = Math.max(0, active.consumers - 1);
      this.abortIfUnused(active);
    };
    signal?.addEventListener("abort", release, { once: true });
    return active.promise.finally(release);
  }

  private abortIfUnused(active: QueryEmbeddingInFlight): void {
    if (active.consumers === 0 && !active.settled && !active.controller.signal.aborted) {
      active.controller.abort(new DOMException("All query embedding consumers cancelled.", "AbortError"));
    }
  }

  private get(key: string): EmbeddingVector | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.delete(key, entry);
      return undefined;
    }

    // Map insertion order is the LRU order. A hit becomes the newest entry.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return cloneVector(entry.vector);
  }

  private set(key: string, vector: EmbeddingVector): void {
    const bytes = estimateVectorBytes(vector);
    if (bytes > this.maxBytes) return;

    const existing = this.entries.get(key);
    if (existing) this.delete(key, existing);
    this.entries.set(key, {
      vector: cloneVector(vector),
      bytes,
      expiresAt: this.now() + this.ttlMs,
    });
    this.bytes += bytes;

    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value as [string, QueryEmbeddingCacheEntry] | undefined;
      if (!oldest) break;
      this.delete(oldest[0], oldest[1]);
    }
  }

  private delete(key: string, entry: QueryEmbeddingCacheEntry): void {
    this.entries.delete(key);
    this.bytes = Math.max(0, this.bytes - entry.bytes);
  }
}

/** Query text never enters diagnostics or persistence; only this process-local key uses its hash. */
export function buildQueryEmbeddingCacheKey(input: {
  query: string;
  modelName?: string;
  queryPrefix?: string;
}): string {
  return createHash("sha256")
    .update("memory-query-embedding-v1\0")
    .update(input.modelName ?? "unknown")
    .update("\0")
    .update(input.queryPrefix ?? "")
    .update("\0")
    .update(input.query)
    .digest("hex");
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function isCacheableVector(value: EmbeddingVector): boolean {
  return value.length > 0 && value.every((entry) => Number.isFinite(entry));
}

function estimateVectorBytes(vector: EmbeddingVector): number {
  return vector.length * Float64Array.BYTES_PER_ELEMENT;
}

function cloneVector(vector: EmbeddingVector): EmbeddingVector {
  return [...vector];
}
