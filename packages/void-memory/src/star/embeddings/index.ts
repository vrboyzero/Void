export type EmbeddingVector = number[];

export type EmbeddingRequestContext = {
    /** 调用方取消或内部 deadline 已触发时中止底层请求。 */
    signal?: AbortSignal;
    /** 可选的绝对 Unix epoch deadline，供第三方 Provider 建立自己的请求超时。 */
    deadlineMs?: number;
};

/**
 * Memory runtime 唯一的 embedding Provider 契约。
 * 包根 `@belldandy/memory` 直接导出此类型，避免 class 与 public type 使用不同的 batch 语义。
 */
export interface EmbeddingProvider {
    embed(text: string, context?: EmbeddingRequestContext): Promise<EmbeddingVector>;
    embedBatch(texts: string[], context?: EmbeddingRequestContext): Promise<EmbeddingVector[]>;
    /**
     * Task-aware embedding: 用于检索查询（retrieval.query）。
     * 对支持 task 参数的模型（Jina、BGE-M3 等），会使用 query 前缀/task 以提升检索相关性。
     * 不实现时回退到 embed()。
     */
    embedQuery?(text: string, context?: EmbeddingRequestContext): Promise<EmbeddingVector>;
    /**
     * Task-aware embedding: 用于文档/段落索引（retrieval.passage）。
     * 不实现时回退到 embed()。
     */
    embedPassage?(text: string, context?: EmbeddingRequestContext): Promise<EmbeddingVector>;
    /** 可选 metadata，不携带密钥或请求正文。 */
    readonly dimension?: number;
    /** Provider 的维度由首个真实响应协商，而不是由静态 metadata 声明。 */
    readonly discoverDimensionFromResponse?: boolean;
    readonly modelName?: string;
}

/** @deprecated 使用 `EmbeddingProvider`。 */
export type EmbeddingModel = EmbeddingProvider;

export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
    if (a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function vectorToBuffer(vector: EmbeddingVector): Buffer {
    return Buffer.from(new Float32Array(vector).buffer);
}

export function vectorFromBuffer(buffer: Buffer): EmbeddingVector {
    return Array.from(new Float32Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength / 4
    ));
}
