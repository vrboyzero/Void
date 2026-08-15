import path from "node:path";
import fs from "node:fs/promises";

import { isMemoryPath, listMemoryFiles, normalizeRelPath } from "./memory-files.js";

export const TEAM_SHARED_MEMORY_DIRNAME = "team-memory";
export const TEAM_SHARED_MEMORY_ROOT_RELATIVE_PATH = TEAM_SHARED_MEMORY_DIRNAME;

type SecretRule = {
  id: string;
  label: string;
  source: string;
  flags?: string;
};

export type TeamSharedMemorySecretMatch = {
  ruleId: string;
  label: string;
};

export type TeamSharedMemoryWriteGuardResult =
  | {
    applies: false;
    ok: true;
  }
  | {
    applies: true;
    ok: true;
    normalizedPath: string;
    teamMemoryPath: string;
    absolutePath: string;
    secretMatches: TeamSharedMemorySecretMatch[];
  }
  | {
    applies: true;
    ok: false;
    code: "invalid_team_memory_path" | "secret_detected";
    message: string;
    normalizedPath?: string;
    teamMemoryPath?: string;
    absolutePath?: string;
    secretMatches?: TeamSharedMemorySecretMatch[];
  };

export type TeamSharedMemorySyncPolicy = {
  status: "planned";
  scope: "repo-local-shared-memory";
  deltaSync: {
    enabled: true;
    mode: "checksum-delta";
    summary: string;
  };
  conflictPolicy: {
    mode: "local-write-wins-per-entry";
    maxConflictRetries: number;
    summary: string;
  };
  deletionPolicy: {
    propagatesDeletes: false;
    summary: string;
  };
  suppressionPolicy: {
    enabled: true;
    summary: string;
  };
};

export type TeamSharedMemoryReadinessReport = {
  enabled: boolean;
  available: boolean;
  reasonCodes: string[];
  reasonMessages: string[];
  scope: {
    relativeRoot: string;
    rootPath: string;
    mainMemoryPath: string;
    dailyMemoryDirPath: string;
    fileCount: number;
    hasMainMemory: boolean;
    dailyCount: number;
  };
  secretGuard: {
    enabled: true;
    scanner: "curated-high-confidence";
    ruleCount: number;
    summary: string;
  };
  syncPolicy: TeamSharedMemorySyncPolicy;
};

const ANT_KEY_PREFIX = ["sk", "ant", "api"].join("-");

const SECRET_RULES: SecretRule[] = [
  {
    id: "anthropic-api-key",
    label: "Anthropic API Key",
    source: `\\b(${ANT_KEY_PREFIX}03-[a-zA-Z0-9_\\-]{20,}AA)(?:[\\x60'"\\s;]|\\\\[nr]|$)`,
  },
  {
    id: "anthropic-admin-api-key",
    label: "Anthropic Admin API Key",
    source: "\\b(sk-ant-admin01-[a-zA-Z0-9_\\-]{20,}AA)(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  },
  {
    id: "openai-api-key",
    label: "OpenAI API Key",
    source: "\\b(sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  },
  {
    id: "aws-access-token",
    label: "AWS Access Token",
    source: "\\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\\b",
  },
  {
    id: "github-pat",
    label: "GitHub PAT",
    source: "ghp_[0-9a-zA-Z]{36}",
  },
  {
    id: "github-fine-grained-pat",
    label: "GitHub Fine-grained PAT",
    source: "github_pat_\\w{40,}",
  },
  {
    id: "gitlab-pat",
    label: "GitLab PAT",
    source: "glpat-[\\w-]{20}",
  },
  {
    id: "slack-bot-token",
    label: "Slack Bot Token",
    source: "xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*",
  },
  {
    id: "npm-access-token",
    label: "NPM Access Token",
    source: "\\b(npm_[a-zA-Z0-9]{36})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  },
  {
    id: "private-key",
    label: "Private Key",
    source: "-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\\s\\S-]{64,}?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----",
    flags: "i",
  },
];

let compiledSecretRules: Array<{ id: string; label: string; re: RegExp }> | null = null;

function getCompiledSecretRules(): Array<{ id: string; label: string; re: RegExp }> {
  if (compiledSecretRules === null) {
    compiledSecretRules = SECRET_RULES.map((rule) => ({
      id: rule.id,
      label: rule.label,
      re: new RegExp(rule.source, rule.flags),
    }));
  }
  return compiledSecretRules;
}

function isUnderRoot(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, path.resolve(target));
  return !(relative.startsWith("..") || path.isAbsolute(relative));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function getTeamSharedMemoryRoot(stateDir: string): string {
  return path.join(stateDir, TEAM_SHARED_MEMORY_DIRNAME);
}

export function getTeamSharedMemoryMainFilePath(stateDir: string): string {
  return path.join(getTeamSharedMemoryRoot(stateDir), "MEMORY.md");
}

export function getTeamSharedMemoryDailyDirPath(stateDir: string): string {
  return path.join(getTeamSharedMemoryRoot(stateDir), "memory");
}

export function isTeamSharedMemoryRelativePath(relativePath: string): boolean {
  const normalized = normalizeRelPath(relativePath);
  if (!normalized) return false;
  if (normalized === TEAM_SHARED_MEMORY_ROOT_RELATIVE_PATH) return false;
  if (!normalized.startsWith(`${TEAM_SHARED_MEMORY_ROOT_RELATIVE_PATH}/`)) return false;
  const teamMemoryPath = normalized.slice(`${TEAM_SHARED_MEMORY_ROOT_RELATIVE_PATH}/`.length);
  return isMemoryPath(teamMemoryPath);
}

export function resolveTeamSharedMemoryEntryPath(stateDir: string, relativePath: string): {
  normalizedPath: string;
  teamMemoryPath: string;
  absolutePath: string;
} | null {
  const normalizedPath = normalizeRelPath(relativePath);
  if (!isTeamSharedMemoryRelativePath(normalizedPath)) {
    return null;
  }

  const rootPath = getTeamSharedMemoryRoot(stateDir);
  const teamMemoryPath = normalizedPath.slice(`${TEAM_SHARED_MEMORY_ROOT_RELATIVE_PATH}/`.length);
  const absolutePath = path.resolve(rootPath, teamMemoryPath);
  if (!isUnderRoot(rootPath, absolutePath)) {
    return null;
  }

  return {
    normalizedPath,
    teamMemoryPath,
    absolutePath,
  };
}

export function scanTeamSharedMemorySecrets(content: string): TeamSharedMemorySecretMatch[] {
  const matches: TeamSharedMemorySecretMatch[] = [];
  const seen = new Set<string>();

  for (const rule of getCompiledSecretRules()) {
    if (seen.has(rule.id)) continue;
    if (!rule.re.test(content)) continue;
    seen.add(rule.id);
    matches.push({
      ruleId: rule.id,
      label: rule.label,
    });
  }

  return matches;
}

export function guardTeamSharedMemoryWrite(input: {
  stateDir: string;
  relativePath: string;
  content: string;
}): TeamSharedMemoryWriteGuardResult {
  const resolved = resolveTeamSharedMemoryEntryPath(input.stateDir, input.relativePath);
  if (!resolved) {
    return {
      applies: false,
      ok: true,
    };
  }

  const secretMatches = scanTeamSharedMemorySecrets(input.content);
  if (secretMatches.length > 0) {
    return {
      applies: true,
      ok: false,
      code: "secret_detected",
      message: `共享记忆内容包含潜在敏感信息：${secretMatches.map((item) => item.label).join("、")}。请移除敏感内容后重试。`,
      normalizedPath: resolved.normalizedPath,
      teamMemoryPath: resolved.teamMemoryPath,
      absolutePath: resolved.absolutePath,
      secretMatches,
    };
  }

  return {
    applies: true,
    ok: true,
    normalizedPath: resolved.normalizedPath,
    teamMemoryPath: resolved.teamMemoryPath,
    absolutePath: resolved.absolutePath,
    secretMatches: [],
  };
}

export function buildTeamSharedMemorySyncPolicy(): TeamSharedMemorySyncPolicy {
  return {
    status: "planned",
    scope: "repo-local-shared-memory",
    deltaSync: {
      enabled: true,
      mode: "checksum-delta",
      summary: "If remote sync is enabled later, upload only entries whose checksums differ from the last known remote snapshot.",
    },
    conflictPolicy: {
      mode: "local-write-wins-per-entry",
      maxConflictRetries: 2,
      summary: "On remote conflict, refresh per-entry checksums and retry a local-write-wins delta for changed entries only.",
    },
    deletionPolicy: {
      propagatesDeletes: false,
      summary: "Local deletions should not remove remote entries until explicit delete semantics and auditability are designed.",
    },
    suppressionPolicy: {
      enabled: true,
      summary: "Future watcher-driven sync should suppress retries for permanent failures such as auth, repo identity, or policy rejections.",
    },
  };
}

export async function buildTeamSharedMemoryReadinessReport(input: {
  stateDir: string;
  enabled?: boolean;
}): Promise<TeamSharedMemoryReadinessReport> {
  const enabled = input.enabled === true;
  const rootPath = getTeamSharedMemoryRoot(input.stateDir);
  const exists = await pathExists(rootPath);
  const listed = exists
    ? await listMemoryFiles(rootPath)
    : {
      files: [],
      hasMainMemory: false,
      dailyCount: 0,
    };

  return {
    enabled,
    available: true,
    reasonCodes: enabled ? [] : ["disabled_by_default"],
    reasonMessages: enabled
      ? []
      : ["Team shared memory is disabled by default until multi-user collaboration needs outweigh leakage and conflict risks."],
    scope: {
      relativeRoot: TEAM_SHARED_MEMORY_ROOT_RELATIVE_PATH,
      rootPath,
      mainMemoryPath: getTeamSharedMemoryMainFilePath(input.stateDir),
      dailyMemoryDirPath: getTeamSharedMemoryDailyDirPath(input.stateDir),
      fileCount: listed.files.length,
      hasMainMemory: listed.hasMainMemory,
      dailyCount: listed.dailyCount,
    },
    secretGuard: {
      enabled: true,
      scanner: "curated-high-confidence",
      ruleCount: SECRET_RULES.length,
      summary: "A local high-confidence secret scanner should block writes to shared memory before any future sync path is enabled.",
    },
    syncPolicy: buildTeamSharedMemorySyncPolicy(),
  };
}
