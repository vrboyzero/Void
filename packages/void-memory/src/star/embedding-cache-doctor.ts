import type {
  EmbeddingCacheRetentionPolicy,
  EmbeddingCacheStatus,
} from "./store.js";

export const DEFAULT_EMBEDDING_CACHE_RETENTION: EmbeddingCacheRetentionPolicy = {
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  maxEntries: 10_000,
  maxBytes: 64 * 1024 * 1024,
};

export type EmbeddingCacheDoctorCheck = {
  id: "memory_embedding_cache";
  name: "Memory Embedding Cache";
  status: "pass" | "warn";
  message: string;
  detail: Record<string, unknown>;
};

export type EmbeddingCacheDoctorReport = {
  headline: string;
  summary: {
    entryCount: number;
    totalBytes: number;
    oldestEntryAgeMs?: number;
    retention: Pick<EmbeddingCacheRetentionPolicy, "maxAgeMs" | "maxEntries" | "maxBytes">;
  };
  checks: EmbeddingCacheDoctorCheck[];
};

export function buildEmbeddingCacheDoctorReport(input: {
  cache: EmbeddingCacheStatus;
  retention: EmbeddingCacheRetentionPolicy;
  nowMs?: number;
}): EmbeddingCacheDoctorReport {
  const nowMs = input.nowMs ?? Date.now();
  const oldestEntryAgeMs = resolveOldestEntryAgeMs(input.cache.oldestCreatedAt, nowMs);
  const retention = {
    maxAgeMs: input.retention.maxAgeMs,
    maxEntries: input.retention.maxEntries,
    maxBytes: input.retention.maxBytes,
  };
  const retentionExceeded = input.cache.entryCount > retention.maxEntries
    || input.cache.totalBytes > retention.maxBytes
    || (oldestEntryAgeMs !== undefined && oldestEntryAgeMs > retention.maxAgeMs);
  const headline = `Persistent embedding cache: entries=${input.cache.entryCount}, bytes=${input.cache.totalBytes}, oldestAgeMs=${oldestEntryAgeMs ?? "none"}.`;
  const summary = {
    entryCount: input.cache.entryCount,
    totalBytes: input.cache.totalBytes,
    ...(oldestEntryAgeMs === undefined ? {} : { oldestEntryAgeMs }),
    retention,
  };

  return {
    headline,
    summary,
    checks: [{
      id: "memory_embedding_cache",
      name: "Memory Embedding Cache",
      status: retentionExceeded ? "warn" : "pass",
      message: headline,
      detail: summary,
    }],
  };
}

function resolveOldestEntryAgeMs(oldestCreatedAt: string | undefined, nowMs: number): number | undefined {
  if (!oldestCreatedAt) {
    return undefined;
  }
  const oldestMs = Date.parse(oldestCreatedAt);
  if (!Number.isFinite(oldestMs)) {
    return undefined;
  }
  return Math.max(0, nowMs - oldestMs);
}
