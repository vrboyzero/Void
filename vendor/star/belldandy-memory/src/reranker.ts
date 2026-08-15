/**
 * Phase M-3: 规则重排序 (Rule-based Reranker)
 *
 * 零成本纯计算重排，基于以下信号：
 * - memory_type 权重（core > daily > session > other）
 * - 时间衰减（越新越相关）
 * - 来源多样性惩罚（同一文件的多个 chunk 降权）
 * - MMR 多样性去重（基于向量余弦相似度，跨文件语义去重）
 */

import type { MemorySearchResult, MemoryType } from "./types.js";
import { cosineSimilarity, type EmbeddingVector } from "./embeddings/index.js";

/** 获取 chunk embedding 向量的回调函数 */
export type GetVectorFn = (chunkId: string) => EmbeddingVector | null;
/** 一次读取多个 chunk embedding 向量的可选回调，保留单项回调作为兼容回退。 */
export type GetVectorsFn = (chunkIds: string[]) => ReadonlyMap<string, EmbeddingVector | null>;

export interface RerankerOptions {
  /** core/daily/session/other 的权重乘数 */
  memoryTypeWeights?: Partial<Record<MemoryType, number>>;
  /** 时间衰减半衰期（天数），0 表示不衰减 */
  recencyHalfLifeDays?: number;
  /** 同源惩罚系数（0-1），0 表示不惩罚 */
  diversityPenalty?: number;
  /** 硬截断最低分数，低于此分数的结果直接丢弃（默认 0.15） */
  minScore?: number;
  /** 长度归一化锚点（字符数），0 表示不归一化（默认 500） */
  lengthNormAnchor?: number;
  /** MMR 多样性去重：lambda 参数（0-1），越小越强调多样性，0 表示禁用（默认 0.7） */
  mmrLambda?: number;
  /** MMR 相似度阈值：超过此阈值的结果被视为重复（默认 0.85） */
  mmrSimilarityThreshold?: number;
}

const DEFAULT_TYPE_WEIGHTS: Record<MemoryType, number> = {
  core: 1.3,
  daily: 1.0,
  session: 0.9,
  dream_index: 0.85,
  dream_note: 0.95,
  other: 0.8,
};

const DEFAULT_HALF_LIFE_DAYS = 30;
const DEFAULT_DIVERSITY_PENALTY = 0.15;
const DEFAULT_MIN_SCORE = 0.15;
const DEFAULT_LENGTH_NORM_ANCHOR = 500;
const DEFAULT_MMR_LAMBDA = 0.7;
const DEFAULT_MMR_SIMILARITY_THRESHOLD = 0.85;

export class ResultReranker {
  private typeWeights: Record<MemoryType, number>;
  private halfLifeDays: number;
  private diversityPenalty: number;
  private minScore: number;
  private lengthNormAnchor: number;
  private mmrLambda: number;
  private mmrSimilarityThreshold: number;

  constructor(options: RerankerOptions = {}) {
    this.typeWeights = { ...DEFAULT_TYPE_WEIGHTS, ...options.memoryTypeWeights };
    this.halfLifeDays = options.recencyHalfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
    this.diversityPenalty = options.diversityPenalty ?? DEFAULT_DIVERSITY_PENALTY;
    this.minScore = options.minScore ?? DEFAULT_MIN_SCORE;
    this.lengthNormAnchor = options.lengthNormAnchor ?? DEFAULT_LENGTH_NORM_ANCHOR;
    this.mmrLambda = options.mmrLambda ?? DEFAULT_MMR_LAMBDA;
    this.mmrSimilarityThreshold = options.mmrSimilarityThreshold ?? DEFAULT_MMR_SIMILARITY_THRESHOLD;
  }

  /**
   * 对搜索结果进行规则重排序。
   * 不修改原数组，返回新的排序后数组。
   */
  rerank(
    results: MemorySearchResult[],
    getVector?: GetVectorFn,
    getVectors?: GetVectorsFn,
  ): MemorySearchResult[] {
    if (results.length <= 1) return results;

    const now = Date.now();
    const sourceCount = new Map<string, number>();

    // 先按原始 score 降序排列，确保 diversity penalty 按排名顺序应用
    const sorted = [...results].sort((a, b) => b.score - a.score);

    const reranked = sorted.map((result) => {
      let adjustedScore = result.score;

      // 1. Memory type boost
      const mt = result.memoryType ?? "other";
      adjustedScore *= this.typeWeights[mt] ?? 1.0;

      // 2. Recency decay（指数衰减）
      if (this.halfLifeDays > 0) {
        adjustedScore *= this.computeRecencyFactor(result, now);
      }

      // 3. Diversity penalty（同源降权）
      const source = readSearchResultDiversityKey(result);
      const seen = sourceCount.get(source) ?? 0;
      if (seen > 0) {
        // 每多出现一次，额外乘以 (1 - penalty)
        adjustedScore *= Math.pow(1 - this.diversityPenalty, seen);
      }
      sourceCount.set(source, seen + 1);

      // 4. Length normalization（防止长文本靠关键词密度霸榜）
      if (this.lengthNormAnchor > 0 && result.content) {
        const charLen = result.content.length;
        const normalizedLength = Math.max(charLen, this.lengthNormAnchor) / this.lengthNormAnchor;
        adjustedScore *= 1 / (1 + Math.log2(normalizedLength));
      }

      return { ...result, score: adjustedScore };
    });

    // 5. 硬截断
    const filtered = reranked
      .sort((a, b) => b.score - a.score)
      .filter(r => r.score >= this.minScore);

    // 6. MMR 多样性去重（如果提供了 getVector 回调且 lambda < 1）
    if (getVector && this.mmrLambda < 1 && filtered.length > 1) {
      return this.applyMMR(filtered, getVector, getVectors);
    }

    return filtered;
  }

  /**
   * MMR (Maximal Marginal Relevance) 多样性去重。
   * 贪心选择：每次选择与已选结果最不相似、同时相关性最高的候选。
   */
  private applyMMR(
    results: MemorySearchResult[],
    getVector: GetVectorFn,
    getVectors?: GetVectorsFn,
  ): MemorySearchResult[] {
    if (results.length <= 1) return results;

    // 预加载所有向量（避免重复查询）
    const vectors = getVectors
      ? new Map(getVectors([...new Set(results.map((result) => result.id))]))
      : new Map<string, EmbeddingVector | null>();
    if (!getVectors) {
      for (const r of results) {
        vectors.set(r.id, getVector(r.id));
      }
    }

    const selected: MemorySearchResult[] = [];
    const candidates = [...results];
    const selectedVectors: EmbeddingVector[] = [];

    // 第一个直接选最高分
    const first = candidates.shift()!;
    selected.push(first);
    const firstVec = vectors.get(first.id);
    if (firstVec) selectedVectors.push(firstVec);

    // 贪心选择剩余
    while (candidates.length > 0) {
      let bestIdx = -1;
      let bestMMRScore = -Infinity;

      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const candVec = vectors.get(candidate.id);

        // 计算与已选结果的最大相似度
        let maxSim = 0;
        if (candVec && selectedVectors.length > 0) {
          for (const selVec of selectedVectors) {
            const sim = cosineSimilarity(candVec, selVec);
            if (sim > maxSim) maxSim = sim;
          }
        }

        // 如果相似度超过阈值，直接跳过（视为重复）
        if (maxSim >= this.mmrSimilarityThreshold) {
          continue;
        }

        // MMR 分数 = λ * relevance - (1-λ) * maxSimilarity
        const mmrScore = this.mmrLambda * candidate.score - (1 - this.mmrLambda) * maxSim;

        if (mmrScore > bestMMRScore) {
          bestMMRScore = mmrScore;
          bestIdx = i;
        }
      }

      // 没有合适的候选了
      if (bestIdx === -1) break;

      const chosen = candidates.splice(bestIdx, 1)[0];
      selected.push(chosen);
      const chosenVec = vectors.get(chosen.id);
      if (chosenVec) selectedVectors.push(chosenVec);
    }

    return selected;
  }

  private computeRecencyFactor(result: MemorySearchResult, now: number): number {
    // 尝试从 metadata 中获取日期
    const dateStr = (result.metadata as any)?.ts_date
      || (result.metadata as any)?.file_mtime;

    if (!dateStr) return 1.0; // 无日期信息，不衰减

    try {
      const date = new Date(dateStr);
      const ageDays = (now - date.getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays <= 0) return 1.0;

      // 指数衰减：score * 0.5^(age / halfLife)
      // 但不低于 0.3，避免旧记忆被完全压制
      return Math.max(0.3, Math.pow(0.5, ageDays / this.halfLifeDays));
    } catch {
      return 1.0;
    }
  }
}

function readSearchResultDiversityKey(result: MemorySearchResult): string {
  const familyKey = typeof (result.metadata as any)?.memoryTree?.sourceFamilyKey === "string"
    ? String((result.metadata as any).memoryTree.sourceFamilyKey).trim()
    : "";
  return familyKey || result.sourcePath;
}
