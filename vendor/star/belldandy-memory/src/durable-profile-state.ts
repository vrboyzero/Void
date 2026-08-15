import type { ProfileStateSourceRef, ProfileStateValue } from "./profile-state-types.js";

export type DurableProfileStateCandidate = {
  type?: string;
  category?: string;
  candidateType?: string;
  content: string;
  reason?: string;
  profilePath?: string;
  profileValue?: unknown;
};

export type DurableProfileStatePatch = {
  path: string;
  value: ProfileStateValue;
  confidence: number;
  reason?: string;
  sourceRefs: ProfileStateSourceRef[];
  content: string;
};

export type DurableProfileStatePlan = {
  patches: DurableProfileStatePatch[];
  rejected: Array<{
    code: "path_not_allowed" | "candidate_type_not_allowed" | "category_not_allowed" | "value_invalid";
    path?: string;
    content: string;
  }>;
};

type DurableProfilePathRule = {
  allowedCandidateTypes: string[];
  allowedCategories: string[];
  maxStringLength: number;
  confidence: number;
  normalizeValue: (value: unknown) => ProfileStateValue | undefined;
};

const STRING_PATH_RULES: Record<string, DurableProfilePathRule> = {
  "identity.name": {
    allowedCandidateTypes: ["user"],
    allowedCategories: ["fact", "entity", "preference"],
    maxStringLength: 48,
    confidence: 0.98,
    normalizeValue: (value) => normalizeStringValue(value, 48),
  },
  "identity.avatar": {
    allowedCandidateTypes: ["user"],
    allowedCategories: ["fact", "entity", "preference"],
    maxStringLength: 24,
    confidence: 0.92,
    normalizeValue: (value) => normalizeStringValue(value, 24),
  },
  "preferences.language": {
    allowedCandidateTypes: ["user", "feedback"],
    allowedCategories: ["preference", "fact"],
    maxStringLength: 32,
    confidence: 0.9,
    normalizeValue: (value) => normalizeStringValue(value, 32),
  },
  "preferences.communication_style": {
    allowedCandidateTypes: ["user", "feedback"],
    allowedCategories: ["preference", "experience"],
    maxStringLength: 160,
    confidence: 0.88,
    normalizeValue: (value) => normalizeStringValue(value, 160),
  },
  "preferences.response_style": {
    allowedCandidateTypes: ["user", "feedback"],
    allowedCategories: ["preference", "experience"],
    maxStringLength: 160,
    confidence: 0.9,
    normalizeValue: (value) => normalizeStringValue(value, 160),
  },
  "preferences.format_preference": {
    allowedCandidateTypes: ["user", "feedback"],
    allowedCategories: ["preference", "experience"],
    maxStringLength: 160,
    confidence: 0.88,
    normalizeValue: (value) => normalizeStringValue(value, 160),
  },
  "workstyle.execution_preference": {
    allowedCandidateTypes: ["user", "feedback"],
    allowedCategories: ["preference", "experience"],
    maxStringLength: 160,
    confidence: 0.88,
    normalizeValue: (value) => normalizeStringValue(value, 160),
  },
  "workstyle.planning_preference": {
    allowedCandidateTypes: ["user", "feedback"],
    allowedCategories: ["preference", "experience"],
    maxStringLength: 160,
    confidence: 0.88,
    normalizeValue: (value) => normalizeStringValue(value, 160),
  },
} as const;

const DURABLE_PROFILE_STATE_ALLOWED_PATHS = Object.keys(STRING_PATH_RULES);

export const DURABLE_PROFILE_STATE_PROMPT_BLOCK = `如果某条记忆属于低风险用户画像字段，可额外输出 profilePath 与 profileValue，用于更新 canonical profile state。
只允许以下 profilePath：
- identity.name
- identity.avatar
- preferences.language
- preferences.communication_style
- preferences.response_style
- preferences.format_preference
- workstyle.execution_preference
- workstyle.planning_preference

profileValue 必须是简短 canonical value，不要把整句 content 原样重复进去。
只有在用户明确表达且适合自动写入低风险画像字段时，才输出 profilePath/profileValue；否则省略这两个字段。`;

export function buildDurableProfileStatePlan(input: {
  items: DurableProfileStateCandidate[];
  sourceConversationId: string;
  sourceLabel: string;
}): DurableProfileStatePlan {
  const patchesByPath = new Map<string, DurableProfileStatePatch>();
  const rejected: DurableProfileStatePlan["rejected"] = [];

  for (const item of input.items) {
    const profilePath = normalizeProfilePath(item.profilePath);
    if (!profilePath) {
      continue;
    }

    const rule = STRING_PATH_RULES[profilePath];
    if (!rule) {
      rejected.push({
        code: "path_not_allowed",
        path: profilePath,
        content: item.content,
      });
      continue;
    }

    const candidateType = normalizeLowerString(item.candidateType);
    if (!candidateType || !rule.allowedCandidateTypes.includes(candidateType)) {
      rejected.push({
        code: "candidate_type_not_allowed",
        path: profilePath,
        content: item.content,
      });
      continue;
    }

    const category = normalizeLowerString(item.category);
    if (!category || !rule.allowedCategories.includes(category)) {
      rejected.push({
        code: "category_not_allowed",
        path: profilePath,
        content: item.content,
      });
      continue;
    }

    const normalizedValue = rule.normalizeValue(item.profileValue);
    if (normalizedValue === undefined) {
      rejected.push({
        code: "value_invalid",
        path: profilePath,
        content: item.content,
      });
      continue;
    }

    patchesByPath.set(profilePath, {
      path: profilePath,
      value: normalizedValue,
      confidence: rule.confidence,
      reason: normalizeStringValue(item.reason, 160),
      sourceRefs: [
        {
          kind: "conversation",
          id: input.sourceConversationId,
          note: input.sourceLabel,
          excerpt: normalizeStringValue(item.content, 200),
        },
      ],
      content: item.content,
    });
  }

  return {
    patches: [...patchesByPath.values()],
    rejected,
  };
}

export function isAllowedDurableProfileStatePath(path: string): boolean {
  return DURABLE_PROFILE_STATE_ALLOWED_PATHS.includes(path);
}

function normalizeProfilePath(value: unknown): string | undefined {
  const normalized = normalizeLowerString(value);
  if (!normalized) {
    return undefined;
  }
  return isAllowedDurableProfileStatePath(normalized) ? normalized : normalized;
}

function normalizeLowerString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

function normalizeStringValue(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.slice(0, maxLength);
}
