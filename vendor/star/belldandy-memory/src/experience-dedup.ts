import type {
  ExperienceCandidate,
  ExperienceCandidateType,
  ExperienceDedupDecision,
  ExperienceDedupMatch,
} from "./experience-types.js";
import { listPublishedAssets } from "./published-experience-assets.js";
import { MemoryStore } from "./store.js";

export type EvaluateExperienceDedupInput = {
  store: MemoryStore;
  publishStateDir: string;
  type: ExperienceCandidateType;
  taskId: string;
  title: string;
  slug: string;
  summary?: string;
};

export type EvaluateExperienceDedupResult = {
  decision: ExperienceDedupDecision;
  exactMatch?: ExperienceDedupMatch;
  similarMatches: ExperienceDedupMatch[];
};

export function evaluateExperienceDedup(input: EvaluateExperienceDedupInput): EvaluateExperienceDedupResult {
  const currentTitle = normalizeExperienceText(input.title);
  const currentSlug = normalizeExperienceKey(input.slug);
  const currentSummary = normalizeExperienceText(input.summary);
  const currentComposite = buildCompositeText(input.title, input.slug, input.summary);

  const exactCandidate = findExactCandidateMatch(input, currentTitle, currentSlug);
  if (exactCandidate) {
    return {
      decision: "duplicate_existing",
      exactMatch: exactCandidate,
      similarMatches: [],
    };
  }

  const similarMatches = collectSimilarMatches(input, currentComposite, currentTitle, currentSlug);
  return {
    decision: similarMatches.length > 0 ? "similar_existing" : "new_candidate",
    similarMatches,
  };
}

function findExactCandidateMatch(
  input: EvaluateExperienceDedupInput,
  normalizedTitle: string,
  normalizedSlug: string,
): ExperienceDedupMatch | undefined {
  const candidates = input.store.listExperienceCandidates(500, { type: input.type });
  for (const candidate of candidates) {
    if (candidate.taskId === input.taskId || candidate.status === "rejected") {
      continue;
    }

    const candidateTitle = normalizeExperienceText(candidate.title);
    const candidateSlug = normalizeExperienceKey(candidate.slug);
    if (
      (normalizedSlug && candidateSlug === normalizedSlug)
      || (normalizedTitle && candidateTitle === normalizedTitle)
    ) {
      return toCandidateMatch(candidate, 1);
    }
  }
  return undefined;
}

function collectSimilarMatches(
  input: EvaluateExperienceDedupInput,
  currentComposite: string,
  normalizedTitle: string,
  normalizedSlug: string,
): ExperienceDedupMatch[] {
  const matches: ExperienceDedupMatch[] = [];
  const seen = new Set<string>();
  const candidates = input.store.listExperienceCandidates(500, { type: input.type });

  for (const candidate of candidates) {
    if (candidate.taskId === input.taskId) {
      continue;
    }
    const score = computeSimilarityScore(
      currentComposite,
      buildCompositeText(candidate.title, candidate.slug, candidate.summary),
      normalizedTitle,
      normalizeExperienceText(candidate.title),
      normalizedSlug,
      normalizeExperienceKey(candidate.slug),
    );
    if (score < 0.55) {
      continue;
    }
    const match = toCandidateMatch(candidate, score);
    const signature = `${match.source}:${match.candidateId ?? match.key}`;
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    matches.push(match);
  }

  for (const asset of listPublishedAssets(input.publishStateDir, input.type)) {
    const score = computeSimilarityScore(
      currentComposite,
      buildCompositeText(asset.title, asset.key, asset.summary),
      normalizedTitle,
      normalizeExperienceText(asset.title),
      normalizedSlug,
      normalizeExperienceKey(asset.key),
    );
    if (score < 0.55) {
      continue;
    }
    const match: ExperienceDedupMatch = {
      source: asset.source,
      assetType: input.type,
      key: asset.key,
      title: asset.title,
      summary: asset.summary,
      publishedPath: asset.publishedPath,
      score,
    };
    const signature = `${match.source}:${match.key}`;
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    matches.push(match);
  }

  return matches
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 5);
}

function toCandidateMatch(candidate: ExperienceCandidate, score?: number): ExperienceDedupMatch {
  return {
    source: "candidate",
    assetType: candidate.type,
    key: candidate.slug,
    title: candidate.title,
    summary: candidate.summary,
    candidateId: candidate.id,
    candidateStatus: candidate.status,
    publishedPath: candidate.publishedPath,
    score,
  };
}

function buildCompositeText(title?: string, key?: string, summary?: string): string {
  return normalizeExperienceText([title, key, summary].filter(Boolean).join(" "));
}

function normalizeExperienceKey(value: string | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/\/skill\.md$/i, "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeExperienceText(value: string | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function computeSimilarityScore(
  currentComposite: string,
  targetComposite: string,
  currentTitle: string,
  targetTitle: string,
  currentKey: string,
  targetKey: string,
): number {
  if (!currentComposite || !targetComposite) {
    return 0;
  }
  if ((currentKey && currentKey === targetKey) || (currentTitle && currentTitle === targetTitle)) {
    return 1;
  }

  const tokenScore = jaccardScore(tokenize(currentComposite), tokenize(targetComposite));
  const textScore = diceScore(compactText(currentComposite), compactText(targetComposite));
  return Math.max(tokenScore, textScore);
}

function tokenize(value: string): string[] {
  return value.match(/[a-z0-9]+|[\u4e00-\u9fff]/g) ?? [];
}

function jaccardScore(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...leftSet, ...rightSet]).size;
  return union > 0 ? intersection / union : 0;
}

function diceScore(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }
  if (left === right) {
    return 1;
  }
  const leftBigrams = buildBigrams(left);
  const rightBigrams = buildBigrams(right);
  if (leftBigrams.length === 0 || rightBigrams.length === 0) {
    return 0;
  }
  const rightCounts = new Map<string, number>();
  for (const item of rightBigrams) {
    rightCounts.set(item, (rightCounts.get(item) ?? 0) + 1);
  }
  let overlap = 0;
  for (const item of leftBigrams) {
    const count = rightCounts.get(item) ?? 0;
    if (count > 0) {
      overlap += 1;
      rightCounts.set(item, count - 1);
    }
  }
  return (2 * overlap) / (leftBigrams.length + rightBigrams.length);
}

function buildBigrams(value: string): string[] {
  if (value.length < 2) {
    return [value];
  }
  const bigrams: string[] = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    bigrams.push(value.slice(index, index + 2));
  }
  return bigrams;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, "");
}

