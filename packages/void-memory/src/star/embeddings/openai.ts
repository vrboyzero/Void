import type { EmbeddingProvider, EmbeddingRequestContext, EmbeddingVector } from "./index.js";
import OpenAI from "openai";
import type { Fetch as OpenAIFetch } from "openai/core";
import {
    createOpenAIEmbeddingFetch,
    type OpenAIEmbeddingOutboundRequestPolicy,
} from "./openai-embedding-transport.js";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

export interface OpenAIEmbeddingOptions {
    apiKey?: string;
    baseURL?: string;
    model?: string;
    dimension?: number;
    /**
     * Task-aware embedding 前缀。
     * 对于支持 task 参数的模型（如 Jina、BGE-M3），可配置 query/passage 前缀以提升检索相关性。
     * 例如 BGE 系列: queryPrefix="query: ", passagePrefix="passage: "
     * OpenAI 原生模型无需配置（留空即可）。
     */
    queryPrefix?: string;
    passagePrefix?: string;
    outboundRequestPolicy?: OpenAIEmbeddingOutboundRequestPolicy;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
    private openai: OpenAI;
    readonly modelName: string;
    readonly dimension: number | undefined;
    readonly discoverDimensionFromResponse: boolean;
    private queryPrefix: string;
    private passagePrefix: string;

    constructor(options: OpenAIEmbeddingOptions = {}) {
        const baseURL = options.baseURL || process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL;
        this.openai = new OpenAI({
            apiKey: options.apiKey || process.env.OPENAI_API_KEY,
            baseURL,
            fetch: createOpenAIEmbeddingFetch({
                baseURL,
                outboundRequestPolicy: options.outboundRequestPolicy,
            }) as unknown as OpenAIFetch,
        });
        this.modelName = options.model || "text-embedding-3-small";
        // text-embedding-3-small default is 1536, but can be scaled down. 3-large is 3072.
        // OpenAI-compatible models may have provider-specific dimensions. Only declare the
        // OpenAI text-embedding-3 default; otherwise let MemoryManager derive it from a real response.
        this.dimension = this.modelName.includes("text-embedding-3")
            ? options.dimension || 1536
            : options.dimension;
        this.discoverDimensionFromResponse = this.dimension === undefined;
        this.queryPrefix = options.queryPrefix ?? "";
        this.passagePrefix = options.passagePrefix ?? "";

        console.log(`[Embedding] Initialized OpenAI provider with model: ${this.modelName}${this.queryPrefix ? ` (task-aware)` : ""}`);
    }

    async embed(text: string, context?: EmbeddingRequestContext): Promise<EmbeddingVector> {
        return this.embedQuery(text, context);
    }

    async embedQuery(text: string, context?: EmbeddingRequestContext): Promise<EmbeddingVector> {
        const input = this.queryPrefix ? this.queryPrefix + text : text;
        const response = await this.openai.embeddings.create({
            model: this.modelName,
            input,
            dimensions: this.modelName.includes("text-embedding-3") ? this.dimension : undefined,
        }, context?.signal ? { signal: context.signal } : undefined);
        return response.data[0].embedding;
    }

    async embedPassage(text: string, context?: EmbeddingRequestContext): Promise<EmbeddingVector> {
        const input = this.passagePrefix ? this.passagePrefix + text : text;
        const response = await this.openai.embeddings.create({
            model: this.modelName,
            input,
            dimensions: this.modelName.includes("text-embedding-3") ? this.dimension : undefined,
        }, context?.signal ? { signal: context.signal } : undefined);
        return response.data[0].embedding;
    }

    async embedBatch(texts: string[], context?: EmbeddingRequestContext): Promise<EmbeddingVector[]> {
        // embedBatch 用于索引，默认使用 passage 前缀
        const inputs = this.passagePrefix
            ? texts.map(t => this.passagePrefix + t)
            : texts;
        const response = await this.openai.embeddings.create({
            model: this.modelName,
            input: inputs,
            dimensions: this.modelName.includes("text-embedding-3") ? this.dimension : undefined,
        }, context?.signal ? { signal: context.signal } : undefined);
        return response.data.map(d => d.embedding);
    }
}
