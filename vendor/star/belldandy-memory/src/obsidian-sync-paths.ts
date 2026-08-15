import path from "node:path";

import type { DreamObsidianMirrorOptions } from "./dream-types.js";

export const DEFAULT_DREAM_OBSIDIAN_ROOT_DIR = "Star Sanctuary";

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function sanitizePathSegment(value: unknown, fallback: string): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function sanitizeMarkdownBasename(value: unknown, fallback: string): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function normalizeRelativeSegments(value?: string): string[] {
  const normalized = normalizeText(value) ?? DEFAULT_DREAM_OBSIDIAN_ROOT_DIR;
  return normalized
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter((segment) => Boolean(segment) && segment !== "." && segment !== "..");
}

function normalizeDate(value?: Date | number | string): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return new Date(value.getTime());
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return new Date(parsed);
    }
  }
  return new Date();
}

function isUnderRoot(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const rel = path.relative(resolvedRoot, path.resolve(target));
  return !(rel.startsWith("..") || path.isAbsolute(rel));
}

function ensureInsideRoot(root: string, target: string, label: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!isUnderRoot(resolvedRoot, resolvedTarget)) {
    throw new Error(`${label} escapes Obsidian vault root`);
  }
  return resolvedTarget;
}

export interface ResolveDreamObsidianMirrorPathsInput {
  mirror: DreamObsidianMirrorOptions;
  agentId: string;
  dreamBasename: string;
  occurredAt?: Date | number | string;
}

export interface DreamObsidianMirrorPaths {
  vaultPath: string;
  rootPath: string;
  agentPath: string;
  dreamPath: string;
  indexPath: string;
  relativeDreamPath: string;
  relativeIndexPath: string;
}

export function resolveDreamObsidianMirrorPaths(input: ResolveDreamObsidianMirrorPathsInput): DreamObsidianMirrorPaths {
  const vaultPath = normalizeText(input.mirror.vaultPath);
  if (!vaultPath) {
    throw new Error("missing Obsidian vault path");
  }

  const vaultRoot = path.resolve(vaultPath);
  const rootSegments = normalizeRelativeSegments(input.mirror.rootDir);
  const occurredAt = normalizeDate(input.occurredAt);
  const year = String(occurredAt.getUTCFullYear());
  const month = String(occurredAt.getUTCMonth() + 1).padStart(2, "0");
  const agentId = sanitizePathSegment(input.agentId, "default");
  const dreamBasename = sanitizeMarkdownBasename(input.dreamBasename.replace(/\.md$/i, ""), "dream") + ".md";

  const rootPath = ensureInsideRoot(vaultRoot, path.join(vaultRoot, ...rootSegments), "Obsidian root path");
  const agentPath = ensureInsideRoot(vaultRoot, path.join(rootPath, "Agents", agentId), "Obsidian agent path");
  const dreamPath = ensureInsideRoot(
    vaultRoot,
    path.join(agentPath, "Dreams", year, month, dreamBasename),
    "Obsidian dream note path",
  );
  const indexPath = ensureInsideRoot(vaultRoot, path.join(agentPath, "DREAM.md"), "Obsidian dream index path");

  return {
    vaultPath: vaultRoot,
    rootPath,
    agentPath,
    dreamPath,
    indexPath,
    relativeDreamPath: path.relative(vaultRoot, dreamPath).replace(/\\/g, "/"),
    relativeIndexPath: path.relative(vaultRoot, indexPath).replace(/\\/g, "/"),
  };
}
