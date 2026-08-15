import type {
  ExperienceCandidate,
  ExperienceSynthesisPreviewItem,
  ExperienceSynthesisPreviewResult,
} from "./experience-types.js";

const SYNTHESIS_SIMILARITY_THRESHOLD = 0.62;
const SAME_FAMILY_THRESHOLD = 0.78;

export function buildExperienceSynthesisPreview(
  seedCandidate: ExperienceCandidate,
  allCandidates: ExperienceCandidate[],
  options: { limit?: number } = {},
): ExperienceSynthesisPreviewResult {
  const limit = Number.isInteger(options.limit) && Number(options.limit) > 0
    ? Number(options.limit)
    : 50;
  const seedComposite = buildCandidateComposite(seedCandidate);
  const seedTitle = normalizeExperienceText(seedCandidate.title);
  const seedSlug = normalizeExperienceKey(seedCandidate.slug);

  const items = (Array.isArray(allCandidates) ? allCandidates : [])
    .filter((candidate) =>
      candidate
      && candidate.type === seedCandidate.type
      && candidate.status === "draft"
      && candidate.metadata?.synthesisConsumed?.consumed !== true
      && candidate.id !== seedCandidate.id,
    )
    .map((candidate) => {
      const baseScore = computeSimilarityScore(
        seedComposite,
        buildCandidateComposite(candidate),
        seedTitle,
        normalizeExperienceText(candidate.title),
        seedSlug,
        normalizeExperienceKey(candidate.slug),
      );
      const score = Math.min(1, baseScore + computeBusinessSignalScore(seedCandidate, candidate));
      if (score < SYNTHESIS_SIMILARITY_THRESHOLD) {
        return null;
      }
      const sourceTaskId = normalizeOptionalString(candidate.sourceTaskSnapshot?.taskId);
      const item: ExperienceSynthesisPreviewItem = {
        candidateId: candidate.id,
        type: candidate.type,
        status: candidate.status,
        title: candidate.title,
        slug: candidate.slug,
        summary: candidate.summary,
        taskId: candidate.taskId,
        sourceTaskId: sourceTaskId || undefined,
        updatedAt: candidate.reviewedAt || candidate.acceptedAt || candidate.rejectedAt || candidate.createdAt,
        score,
        relation: score >= SAME_FAMILY_THRESHOLD ? "same_family" : "similar",
      };
      return item;
    })
    .filter((item): item is ExperienceSynthesisPreviewItem => Boolean(item))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
    })
    .slice(0, limit);

  const taskIds = new Set<string>();
  taskIds.add(normalizeOptionalString(seedCandidate.sourceTaskSnapshot?.taskId) || seedCandidate.taskId);
  for (const item of items) {
    taskIds.add(item.sourceTaskId || item.taskId);
  }

  return {
    seedCandidateId: seedCandidate.id,
    candidateType: seedCandidate.type,
    totalCount: 1 + items.length,
    taskCount: taskIds.size,
    items,
  };
}

export function buildExperienceSynthesisPreviewFromSourceCandidates(
  seedCandidate: ExperienceCandidate,
  sourceCandidates: ExperienceCandidate[],
  options: { limit?: number } = {},
): ExperienceSynthesisPreviewResult {
  const limit = Number.isInteger(options.limit) && Number(options.limit) > 0
    ? Number(options.limit)
    : 50;
  const seedComposite = buildCandidateComposite(seedCandidate);
  const seedTitle = normalizeExperienceText(seedCandidate.title);
  const seedSlug = normalizeExperienceKey(seedCandidate.slug);

  const items: ExperienceSynthesisPreviewItem[] = [];
  for (const candidate of Array.isArray(sourceCandidates) ? sourceCandidates : []) {
    if (
      !candidate
      || candidate.type !== seedCandidate.type
      || candidate.metadata?.synthesisConsumed?.consumed === true
      || candidate.id === seedCandidate.id
    ) {
      continue;
    }
    const baseScore = computeSimilarityScore(
      seedComposite,
      buildCandidateComposite(candidate),
      seedTitle,
      normalizeExperienceText(candidate.title),
      seedSlug,
      normalizeExperienceKey(candidate.slug),
    );
    const score = Math.min(1, baseScore + computeBusinessSignalScore(seedCandidate, candidate));
    if (score < SYNTHESIS_SIMILARITY_THRESHOLD) {
      continue;
    }
    items.push({
      candidateId: candidate.id,
      type: candidate.type,
      status: candidate.status,
      title: candidate.title,
      slug: candidate.slug,
      summary: candidate.summary,
      taskId: candidate.taskId,
      sourceTaskId: normalizeOptionalString(candidate.sourceTaskSnapshot?.taskId) || undefined,
      updatedAt: candidate.reviewedAt || candidate.acceptedAt || candidate.rejectedAt || candidate.createdAt,
      score,
      relation: score >= SAME_FAMILY_THRESHOLD ? "same_family" : "similar",
    });
  }
  items
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
    })
  const limitedItems = items.slice(0, limit);

  const taskIds = new Set<string>();
  taskIds.add(normalizeOptionalString(seedCandidate.sourceTaskSnapshot?.taskId) || seedCandidate.taskId);
  for (const item of limitedItems) {
    taskIds.add(item.sourceTaskId || item.taskId);
  }

  return {
    seedCandidateId: seedCandidate.id,
    candidateType: seedCandidate.type,
    totalCount: 1 + limitedItems.length,
    taskCount: taskIds.size,
    items: limitedItems,
  };
}

function buildCandidateComposite(candidate: ExperienceCandidate): string {
  const snapshot = candidate.sourceTaskSnapshot && typeof candidate.sourceTaskSnapshot === "object"
    ? candidate.sourceTaskSnapshot as unknown as Record<string, unknown>
    : {};
  const toolCalls = Array.isArray(snapshot.toolCalls) ? snapshot.toolCalls : [];
  const artifactSourcePaths = Array.isArray(snapshot.artifactPaths) ? snapshot.artifactPaths : [];
  const toolNames = toolCalls
    .map((item) => (item && typeof item === "object" ? normalizeOptionalString((item as Record<string, unknown>).toolName) : ""))
    .filter(Boolean);
  const artifactPaths = artifactSourcePaths.map((item) => normalizeOptionalString(item)).filter(Boolean);
  return normalizeExperienceText([
    candidate.title,
    candidate.slug,
    candidate.summary,
    truncateText(candidate.content, 1600),
    normalizeOptionalString(snapshot.title),
    normalizeOptionalString(snapshot.objective),
    normalizeOptionalString(snapshot.summary),
    normalizeOptionalString(snapshot.reflection),
    normalizeOptionalString(snapshot.outcome),
    toolNames.join(" "),
    artifactPaths.join(" "),
  ].filter(Boolean).join(" "));
}

function computeBusinessSignalScore(seedCandidate: ExperienceCandidate, candidate: ExperienceCandidate): number {
  const seedSnapshot = seedCandidate.sourceTaskSnapshot && typeof seedCandidate.sourceTaskSnapshot === "object"
    ? seedCandidate.sourceTaskSnapshot as unknown as Record<string, unknown>
    : {};
  const candidateSnapshot = candidate.sourceTaskSnapshot && typeof candidate.sourceTaskSnapshot === "object"
    ? candidate.sourceTaskSnapshot as unknown as Record<string, unknown>
    : {};
  const seedToolNames = new Set(extractToolNames(seedSnapshot));
  const candidateToolNames = new Set(extractToolNames(candidateSnapshot));
  const toolOverlap = intersectCount(seedToolNames, candidateToolNames);
  const objectiveScore = keywordOverlapScore(
    normalizeExperienceText(normalizeOptionalString(seedSnapshot.objective) || normalizeOptionalString(seedSnapshot.summary)),
    normalizeExperienceText(normalizeOptionalString(candidateSnapshot.objective) || normalizeOptionalString(candidateSnapshot.summary)),
  );
  const reflectionScore = keywordOverlapScore(
    normalizeExperienceText(normalizeOptionalString(seedSnapshot.reflection)),
    normalizeExperienceText(normalizeOptionalString(candidateSnapshot.reflection)),
  );
  const generatedParity =
    normalizeOptionalString(seedCandidate.metadata?.draftOrigin?.kind)
    && normalizeOptionalString(seedCandidate.metadata?.draftOrigin?.kind) === normalizeOptionalString(candidate.metadata?.draftOrigin?.kind)
      ? 0.04
      : 0;
  return Math.min(
    0.2,
    (toolOverlap > 0 ? Math.min(0.08, toolOverlap * 0.03) : 0)
      + Math.min(0.05, objectiveScore * 0.1)
      + Math.min(0.03, reflectionScore * 0.06)
      + generatedParity,
  );
}

function extractToolNames(snapshot: Record<string, unknown>): string[] {
  const toolCalls = Array.isArray(snapshot.toolCalls) ? snapshot.toolCalls : [];
  return toolCalls
    .map((item) => (item && typeof item === "object" ? normalizeOptionalString((item as Record<string, unknown>).toolName) : ""))
    .filter(Boolean);
}

function intersectCount(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let count = 0;
  for (const item of left) {
    if (right.has(item)) count += 1;
  }
  return count;
}

function keywordOverlapScore(left: string, right: string): number {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  const intersection = intersectCount(leftTokens, rightTokens);
  const baseline = Math.max(leftTokens.size, rightTokens.size, 1);
  return intersection / baseline;
}

function truncateText(value: string | undefined, maxLength = 1600): string {
  const normalized = normalizeOptionalString(value) || "";
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function normalizeOptionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
