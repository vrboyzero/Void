export type StableTopicAliasResolution = {
  canonicalKey: string;
  normalizedKey: string;
};

const TOPIC_ALIAS_SUFFIXES = new Set([
  "outline",
  "summary",
  "summaries",
  "notes",
  "note",
  "recap",
  "final",
  "draft",
  "checklist",
  "plan",
  "review",
  "memory",
  "digest",
  "session",
  "transcript",
  "report",
  "result",
  "results",
  "status",
  "update",
  "rollout",
]);

export function resolveStableTopicAlias(value: unknown): StableTopicAliasResolution | null {
  const normalizedKey = normalizeStableTopicAliasKey(value);
  if (!normalizedKey) {
    return null;
  }
  const canonicalKey = canonicalizeStableTopicAliasKey(normalizedKey);
  return {
    canonicalKey,
    normalizedKey,
  };
}

export function normalizeStableTopicAliasKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\\/]+/g, "-")
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9\-\u4e00-\u9fa5]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || undefined;
}

export function canonicalizeStableTopicAliasKey(value: string): string {
  const parts = value
    .split("-")
    .map((item) => item.trim())
    .filter(Boolean);
  let end = parts.length;
  while (end > 1 && TOPIC_ALIAS_SUFFIXES.has(parts[end - 1]!.toLowerCase())) {
    end -= 1;
  }
  const collapsed = collapseDuplicateTokens(parts.slice(0, end));
  return collapsed.join("-") || value;
}

function collapseDuplicateTokens(parts: string[]): string[] {
  const result: string[] = [];
  for (const part of parts) {
    if (result[result.length - 1] === part) {
      continue;
    }
    result.push(part);
  }
  return result;
}
