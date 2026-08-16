import type { EmbeddingVector } from "./embeddings/index.js";

export type EmbeddingBatchValidation = {
    dimension: number | null;
    receivedCount: number;
    expectedCount: number;
    responseCountMatches: boolean;
    vectors: Array<EmbeddingVector | null>;
    failedCount: number;
};

/**
 * 只接受可安全用于 vec0 表定义的 Provider 维度，避免把异常配置带入存储层。
 */
export function resolveEmbeddingDimension(value: unknown): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
        ? value
        : null;
}

/**
 * Provider 或缓存均可能在运行时违背 TypeScript 契约，写入前必须验证数值边界。
 */
export function isValidEmbeddingVector(
    value: unknown,
    expectedDimension: number,
): value is EmbeddingVector {
    return Array.isArray(value)
        && value.length === expectedDimension
        && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

/**
 * 保留位置对齐的有效结果，同时显式标记缺项、错维度和非有限数值。
 */
export function validateEmbeddingBatchResponse(
    response: unknown,
    expectedCount: number,
    expectedDimension?: number,
): EmbeddingBatchValidation {
    const rawVectors = Array.isArray(response) ? response : [];
    const resolvedDimension = resolveEmbeddingDimension(expectedDimension)
        ?? rawVectors.find((entry): entry is EmbeddingVector => (
            Array.isArray(entry)
            && entry.length > 0
            && entry.every((value) => typeof value === "number" && Number.isFinite(value))
        ))?.length
        ?? null;
    const dimension = resolveEmbeddingDimension(resolvedDimension);
    const responseCountMatches = rawVectors.length === expectedCount;
    const vectors = Array.from({ length: expectedCount }, (_, index) => (
        responseCountMatches
        && dimension !== null
        && isValidEmbeddingVector(rawVectors[index], dimension)
            ? rawVectors[index]
            : null
    ));

    return {
        dimension,
        receivedCount: rawVectors.length,
        expectedCount,
        responseCountMatches,
        vectors,
        failedCount: vectors.filter((vector) => vector === null).length,
    };
}
