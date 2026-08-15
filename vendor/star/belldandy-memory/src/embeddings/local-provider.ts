import type { EmbeddingModel, FlagEmbedding } from "fastembed";
import { EmbeddingProvider, type EmbeddingRequestContext } from "./index.js";
import { AuthenticationError, RateLimitError } from "../types.js";

const FASTEMBED_MODEL_ALIASES: Record<string, string> = {
    // 兼容项目文档与旧配置使用的 Hugging Face 仓库名。
    "BAAI/bge-small-en-v1.5": "fast-bge-small-en-v1.5",
};

const SUPPORTED_FASTEMBED_MODELS = [
    "fast-all-MiniLM-L6-v2",
    "fast-bge-base-en",
    "fast-bge-base-en-v1.5",
    "fast-bge-small-en",
    "fast-bge-small-en-v1.5",
    "fast-bge-small-zh-v1.5",
    "fast-multilingual-e5-large",
] as const;

export const DEFAULT_LOCAL_EMBEDDING_MODEL = "fast-bge-small-en-v1.5";

type StandardFastembedModel = Exclude<EmbeddingModel, EmbeddingModel.CUSTOM>;

function resolveFastembedModel(modelName: string): StandardFastembedModel {
    const requestedModel = modelName.trim();
    const resolvedModel = FASTEMBED_MODEL_ALIASES[requestedModel] ?? requestedModel;
    if (!(SUPPORTED_FASTEMBED_MODELS as readonly string[]).includes(resolvedModel)) {
        throw new Error(
            `Unsupported local embedding model "${modelName}" for Fastembed 2. `
            + `Supported models: ${SUPPORTED_FASTEMBED_MODELS.join(", ")}`,
        );
    }
    return resolvedModel as StandardFastembedModel;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
    private model: FlagEmbedding | null = null;
    readonly modelName: string;
    readonly cacheDir?: string;
    private initPromise: Promise<void> | null = null;

    constructor(modelName: string = DEFAULT_LOCAL_EMBEDDING_MODEL, cacheDir?: string) {
        this.modelName = modelName;
        this.cacheDir = cacheDir;
    }

    private async init() {
        if (this.model) return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = (async () => {
            try {
                const fastembedModel = resolveFastembedModel(this.modelName);
                if (this.cacheDir) {
                    const fs = await import("node:fs/promises");
                    // Fastembed 会把已存在的模型子目录视为完整缓存，因此这里只准备缓存根目录。
                    await fs.mkdir(this.cacheDir, { recursive: true });
                }

                const { FlagEmbedding } = await import("fastembed");
                this.model = await FlagEmbedding.init({
                    model: fastembedModel,
                    cacheDir: this.cacheDir
                });
                console.log(`[LocalEmbedding] Initialized model: ${this.modelName} in ${this.cacheDir || "default cache"}`);
            } catch (err) {
                if (err instanceof Error && /Cannot find package 'fastembed'|Cannot find module 'fastembed'/.test(err.message)) {
                    throw new Error(
                        "Local embedding provider requires optional dependency 'fastembed'. Rebuild with optional native dependencies enabled.",
                    );
                }
                console.error(`[LocalEmbedding] Failed to initialize model ${this.modelName}:`, err);
                throw err;
            } finally {
                this.initPromise = null;
            }
        })();

        return this.initPromise;
    }

    async embed(text: string, context?: EmbeddingRequestContext): Promise<number[]> {
        context?.signal?.throwIfAborted();
        await this.init();
        context?.signal?.throwIfAborted();
        if (!this.model) throw new Error("Model not initialized");

        // fastembed returns a Generator of embeddings
        // embed function accepts string or string[]
        const embeddingsGenerator = this.model.embed([text]);
        const embeddings = [];
        for await (const batch of embeddingsGenerator) {
            context?.signal?.throwIfAborted();
            embeddings.push(...batch);
        }

        if (embeddings.length === 0) {
            throw new Error("Failed to generate embedding");
        }

        return Array.from(embeddings[0]);
    }

    async embedBatch(texts: string[], context?: EmbeddingRequestContext): Promise<number[][]> {
        context?.signal?.throwIfAborted();
        await this.init();
        context?.signal?.throwIfAborted();
        if (!this.model) throw new Error("Model not initialized");

        const embeddingsGenerator = this.model.embed(texts);
        const allEmbeddings: number[][] = [];

        for await (const batch of embeddingsGenerator) {
            context?.signal?.throwIfAborted();
            // batch is Float32Array[]
            for (const vec of batch) {
                allEmbeddings.push(Array.from(vec));
            }
        }

        return allEmbeddings;
    }
}
