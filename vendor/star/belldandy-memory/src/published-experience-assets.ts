import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  ExperienceCandidate,
  ExperienceCandidateType,
  ExperienceSourceTaskSnapshot,
} from "./experience-types.js";

export type PublishedExperienceAssetRecord = {
  source: "method_asset" | "skill_asset";
  type: ExperienceCandidateType;
  key: string;
  title?: string;
  summary?: string;
  publishedPath: string;
  content: string;
  metadata: {
    name?: string;
    description?: string;
  };
};

export function listPublishedAssets(
  publishStateDir: string,
  type?: ExperienceCandidateType,
): PublishedExperienceAssetRecord[] {
  if (type === "method") {
    return listMethodAssets(publishStateDir);
  }
  if (type === "skill") {
    return listSkillAssets(publishStateDir);
  }
  return [
    ...listMethodAssets(publishStateDir),
    ...listSkillAssets(publishStateDir),
  ];
}

export function buildVirtualCandidateFromPublishedAsset(input: {
  asset: PublishedExperienceAssetRecord;
  now?: string;
}): ExperienceCandidate {
  const now = input.now ?? new Date().toISOString();
  const sourceTaskSnapshot: ExperienceSourceTaskSnapshot = {
    taskId: `published:${input.asset.type}:${input.asset.key}`,
    conversationId: `published:${input.asset.type}:${input.asset.key}`,
    source: "manual",
    status: "success",
    title: input.asset.title,
    objective: input.asset.summary,
    summary: input.asset.summary,
    artifactPaths: [input.asset.publishedPath],
    startedAt: now,
    finishedAt: now,
  };
  return {
    id: buildVirtualCandidateId(input.asset),
    taskId: sourceTaskSnapshot.taskId,
    type: input.asset.type,
    status: "published",
    title: input.asset.title || input.asset.key,
    slug: buildVirtualCandidateSlug(input.asset),
    content: input.asset.content,
    summary: input.asset.summary,
    sourceTaskSnapshot,
    publishedPath: input.asset.publishedPath,
    createdAt: now,
    acceptedAt: now,
    reviewedAt: now,
    metadata: {
      draftOrigin: {
        kind: "published",
      },
      publishedOrigin: {
        assetPath: input.asset.publishedPath,
        assetKey: input.asset.key,
        assetSource: input.asset.source,
      },
    },
  };
}

function buildVirtualCandidateId(asset: PublishedExperienceAssetRecord): string {
  const base = normalizeVirtualIdSegment(asset.key) || asset.type;
  const suffix = createHash("sha1")
    .update(`${asset.source}:${asset.publishedPath}`)
    .digest("hex")
    .slice(0, 10);
  return `virtual:${asset.type}:${base}-${suffix}`;
}

function buildVirtualCandidateSlug(asset: PublishedExperienceAssetRecord): string {
  if (asset.type === "method") {
    return asset.key.replace(/\.md$/i, "");
  }
  return asset.metadata.name || asset.key;
}

function normalizeVirtualIdSegment(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "asset";
}

function listMethodAssets(publishStateDir: string): PublishedExperienceAssetRecord[] {
  const methodsDir = path.join(publishStateDir, "methods");
  if (!fs.existsSync(methodsDir)) {
    return [];
  }

  const entries = fs.readdirSync(methodsDir, { withFileTypes: true });
  const assets: PublishedExperienceAssetRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
      continue;
    }
    const filePath = path.join(methodsDir, entry.name);
    const raw = safeReadUtf8(filePath);
    const parsed = parseMethodAsset(raw);
    assets.push({
      source: "method_asset",
      type: "method",
      key: entry.name,
      title: parsed.title,
      summary: parsed.summary,
      publishedPath: filePath,
      content: raw,
      metadata: {},
    });
  }
  return assets;
}

function listSkillAssets(publishStateDir: string): PublishedExperienceAssetRecord[] {
  const skillsDir = path.join(publishStateDir, "skills");
  if (!fs.existsSync(skillsDir)) {
    return [];
  }

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const assets: PublishedExperienceAssetRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const filePath = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const raw = safeReadUtf8(filePath);
    const parsed = parseSkillAsset(raw);
    assets.push({
      source: "skill_asset",
      type: "skill",
      key: parsed.name || entry.name,
      title: parsed.title || parsed.name || entry.name,
      summary: parsed.description,
      publishedPath: filePath,
      content: raw,
      metadata: {
        name: parsed.name,
        description: parsed.description,
      },
    });
  }
  return assets;
}

function parseMethodAsset(raw: string): { title?: string; summary?: string } {
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const summary = frontmatter
    ? readFrontmatterValue(frontmatter[1], "summary")
    : undefined;
  const body = frontmatter ? raw.slice(frontmatter[0].length) : raw;
  const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return { title, summary };
}

function parseSkillAsset(raw: string): { name?: string; title?: string; description?: string } {
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const content = frontmatter ? raw.slice(frontmatter[0].length) : raw;
  return {
    name: frontmatter ? readFrontmatterValue(frontmatter[1], "name") : undefined,
    description: frontmatter ? readFrontmatterValue(frontmatter[1], "description") : undefined,
    title: content.match(/^#\s+(.+)$/m)?.[1]?.trim(),
  };
}

function readFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*:\\s*(.+)$`, "im");
  const match = frontmatter.match(pattern);
  if (!match) {
    return undefined;
  }
  return stripQuotes(match[1]);
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function safeReadUtf8(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
