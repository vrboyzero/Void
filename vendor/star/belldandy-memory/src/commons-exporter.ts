import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { DreamObsidianMirrorOptions } from "./dream-types.js";
import type { MemoryCategory, MemoryType } from "./types.js";

const DEFAULT_COMMONS_ROOT_DIR = "Star Sanctuary";

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function truncateText(value: unknown, maxLength = 200): string | undefined {
  const normalized = normalizeText(value)?.replace(/\s+/g, " ");
  if (!normalized) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 3))}...` : normalized;
}

function sanitizeSegment(value: unknown, fallback: string): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function normalizeRelativeSegments(value?: string): string[] {
  const normalized = normalizeText(value) ?? DEFAULT_COMMONS_ROOT_DIR;
  return normalized
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter((segment) => Boolean(segment) && segment !== "." && segment !== "..");
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

function toYamlString(value: unknown): string {
  return JSON.stringify(String(value ?? ""));
}

function toMarkdownLinkPath(fromPath: string, targetPath: string): string {
  return path.relative(path.dirname(fromPath), targetPath).replace(/\\/g, "/");
}

async function atomicWriteText(targetPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, targetPath);
}

async function removeIfExists(targetPath: string): Promise<void> {
  await fs.rm(targetPath, { force: true }).catch(() => undefined);
}

export type CommonsExportStatus = "approved" | "active" | "revoked";

export interface CommonsExportItem {
  sharedChunkId: string;
  sourceAgentId: string;
  sourceChunkId: string;
  sourcePath: string;
  sharedStatus: CommonsExportStatus;
  sharedReviewedAt?: string;
  reviewerAgentId?: string;
  decisionNote?: string;
  reason?: string;
  category?: MemoryCategory;
  memoryType?: MemoryType;
  topic?: string;
  summary?: string;
  snippet: string;
  content?: string;
  updatedAt?: string;
}

export interface CommonsExportResult {
  rootPath: string;
  commonsPath: string;
  indexPath: string;
  approvedCount: number;
  revokedCount: number;
  agentPageCount: number;
  noteCount: number;
  notePaths: string[];
}

type ResolvedCommonsPaths = {
  vaultPath: string;
  rootPath: string;
  commonsPath: string;
  agentsDirPath: string;
  approvedDirPath: string;
  revokedDirPath: string;
  indexPath: string;
};

function resolveCommonsPaths(mirror: DreamObsidianMirrorOptions): ResolvedCommonsPaths {
  const vaultPath = normalizeText(mirror.vaultPath);
  if (!vaultPath) {
    throw new Error("missing Obsidian vault path");
  }
  const vaultRoot = path.resolve(vaultPath);
  const rootSegments = normalizeRelativeSegments(mirror.rootDir);
  const rootPath = ensureInsideRoot(vaultRoot, path.join(vaultRoot, ...rootSegments), "Commons root path");
  const commonsPath = ensureInsideRoot(vaultRoot, path.join(rootPath, "Commons"), "Commons path");
  const agentsDirPath = ensureInsideRoot(vaultRoot, path.join(commonsPath, "Agents"), "Commons agents path");
  const approvedDirPath = ensureInsideRoot(vaultRoot, path.join(commonsPath, "Shared-Memory", "approved"), "Commons approved path");
  const revokedDirPath = ensureInsideRoot(vaultRoot, path.join(commonsPath, "Shared-Memory", "revoked"), "Commons revoked path");
  const indexPath = ensureInsideRoot(vaultRoot, path.join(commonsPath, "INDEX.md"), "Commons index path");
  return {
    vaultPath: vaultRoot,
    rootPath,
    commonsPath,
    agentsDirPath,
    approvedDirPath,
    revokedDirPath,
    indexPath,
  };
}

function buildNoteBaseName(item: CommonsExportItem): string {
  return `${sanitizeSegment(item.sourceAgentId, "agent")}--${sanitizeSegment(item.sharedChunkId, "shared-memory")}.md`;
}

function buildNotePath(input: {
  paths: ResolvedCommonsPaths;
  item: CommonsExportItem;
  status: "approved" | "revoked";
}): string {
  const fileName = buildNoteBaseName(input.item);
  const dirPath = input.status === "approved" ? input.paths.approvedDirPath : input.paths.revokedDirPath;
  return ensureInsideRoot(input.paths.vaultPath, path.join(dirPath, fileName), "Commons note path");
}

function renderCommonsNote(item: CommonsExportItem): string {
  const lines = [
    "---",
    "source: star-sanctuary",
    "source_scope: shared",
    `source_agent_id: ${toYamlString(item.sourceAgentId)}`,
    `shared_status: ${toYamlString(item.sharedStatus)}`,
    `shared_reviewed_at: ${toYamlString(item.sharedReviewedAt ?? "-")}`,
    `shared_chunk_id: ${toYamlString(item.sharedChunkId)}`,
    `source_chunk_id: ${toYamlString(item.sourceChunkId)}`,
    `source_path: ${toYamlString(item.sourcePath)}`,
    `category: ${toYamlString(item.category ?? "other")}`,
    `memory_type: ${toYamlString(item.memoryType ?? "other")}`,
    `topic: ${toYamlString(item.topic ?? "-")}`,
    "---",
    "",
    "# Shared Memory Export",
    "",
    `- Source Agent: ${item.sourceAgentId}`,
    `- Shared Status: ${item.sharedStatus}`,
    `- Reviewed At: ${item.sharedReviewedAt ?? "-"}`,
    `- Reviewer: ${item.reviewerAgentId ?? "-"}`,
    `- Source Path: ${item.sourcePath}`,
    `- Reason: ${item.reason ?? "-"}`,
    "",
    "## Summary",
    "",
    item.summary || item.snippet || "暂无",
    "",
    "## Content",
    "",
    item.content || item.snippet || "暂无",
    "",
    "## Review Note",
    "",
    item.decisionNote || "-",
    "",
  ];
  return lines.join("\n");
}

function renderAgentPage(input: {
  agentId: string;
  items: CommonsExportItem[];
  agentPagePath: string;
  paths: ResolvedCommonsPaths;
  generatedAt: string;
}): string {
  const lines = [
    `# Commons Agent View · ${input.agentId}`,
    "",
    `- Generated At: ${input.generatedAt}`,
    `- Approved Shared Memory Count: ${input.items.length}`,
    "",
    "| Reviewed At | Category | Summary | File |",
    "| --- | --- | --- | --- |",
  ];

  for (const item of input.items) {
    const notePath = buildNotePath({
      paths: input.paths,
      item,
      status: "approved",
    });
    const rel = toMarkdownLinkPath(input.agentPagePath, notePath);
    lines.push(`| ${item.sharedReviewedAt ?? item.updatedAt ?? "-"} | ${item.category ?? "-"} | ${truncateText(item.summary ?? item.snippet, 120) ?? "-"} | [note](${rel}) |`);
  }

  lines.push("");
  return lines.join("\n");
}

function renderCommonsIndex(input: {
  approvedItems: CommonsExportItem[];
  revokedItems: CommonsExportItem[];
  agentIds: string[];
  paths: ResolvedCommonsPaths;
  generatedAt: string;
}): string {
  const lines = [
    "# Commons",
    "",
    `- Generated At: ${input.generatedAt}`,
    `- Approved Shared Memory Count: ${input.approvedItems.length}`,
    `- Revoked Mirror Count: ${input.revokedItems.length}`,
    "",
    "## Agents",
    "",
  ];

  for (const agentId of input.agentIds) {
    const pagePath = ensureInsideRoot(
      input.paths.vaultPath,
      path.join(input.paths.agentsDirPath, `${sanitizeSegment(agentId, "agent")}.md`),
      "Commons agent page path",
    );
    const rel = toMarkdownLinkPath(input.paths.indexPath, pagePath);
    const count = input.approvedItems.filter((item) => item.sourceAgentId === agentId).length;
    lines.push(`- [${agentId}](${rel}) (${count})`);
  }

  lines.push("");
  lines.push("## Approved Shared Memory");
  lines.push("");
  lines.push("| Agent | Reviewed At | Category | Summary | File |");
  lines.push("| --- | --- | --- | --- | --- |");

  for (const item of input.approvedItems) {
    const notePath = buildNotePath({
      paths: input.paths,
      item,
      status: "approved",
    });
    const rel = toMarkdownLinkPath(input.paths.indexPath, notePath);
    lines.push(`| ${item.sourceAgentId} | ${item.sharedReviewedAt ?? item.updatedAt ?? "-"} | ${item.category ?? "-"} | ${truncateText(item.summary ?? item.snippet, 120) ?? "-"} | [note](${rel}) |`);
  }

  lines.push("");
  return lines.join("\n");
}

export async function writeObsidianCommonsExport(input: {
  mirror?: DreamObsidianMirrorOptions;
  approvedItems: CommonsExportItem[];
  revokedItems: CommonsExportItem[];
  agentIds?: string[];
  now?: () => Date;
}): Promise<CommonsExportResult> {
  if (input.mirror?.enabled !== true) {
    throw new Error("Commons export is disabled");
  }

  const paths = resolveCommonsPaths(input.mirror);
  const generatedAt = (input.now ?? (() => new Date()))().toISOString();
  const approvedItems = [...input.approvedItems].sort((a, b) => Date.parse(b.sharedReviewedAt ?? b.updatedAt ?? "") - Date.parse(a.sharedReviewedAt ?? a.updatedAt ?? ""));
  const revokedItems = [...input.revokedItems].sort((a, b) => Date.parse(b.sharedReviewedAt ?? b.updatedAt ?? "") - Date.parse(a.sharedReviewedAt ?? a.updatedAt ?? ""));
  const notePaths: string[] = [];

  for (const item of approvedItems) {
    const notePath = buildNotePath({
      paths,
      item,
      status: "approved",
    });
    const revokedPath = buildNotePath({
      paths,
      item,
      status: "revoked",
    });
    await removeIfExists(revokedPath);
    await atomicWriteText(notePath, renderCommonsNote(item));
    notePaths.push(notePath);
  }

  for (const item of revokedItems) {
    const notePath = buildNotePath({
      paths,
      item,
      status: "revoked",
    });
    const approvedPath = buildNotePath({
      paths,
      item,
      status: "approved",
    });
    await removeIfExists(approvedPath);
    await atomicWriteText(notePath, renderCommonsNote(item));
    notePaths.push(notePath);
  }

  const agentIds = [...new Set((input.agentIds ?? approvedItems.map((item) => item.sourceAgentId)).map((item) => sanitizeSegment(item, "agent")))];
  for (const agentId of agentIds) {
    const sourceAgentId = (input.agentIds ?? approvedItems.map((item) => item.sourceAgentId)).find((item) => sanitizeSegment(item, "agent") === agentId) ?? agentId;
    const items = approvedItems.filter((item) => sanitizeSegment(item.sourceAgentId, "agent") === agentId);
    const agentPagePath = ensureInsideRoot(
      paths.vaultPath,
      path.join(paths.agentsDirPath, `${agentId}.md`),
      "Commons agent page path",
    );
    await atomicWriteText(agentPagePath, renderAgentPage({
      agentId: sourceAgentId,
      items,
      agentPagePath,
      paths,
      generatedAt,
    }));
  }

  await atomicWriteText(paths.indexPath, renderCommonsIndex({
    approvedItems,
    revokedItems,
    agentIds: (input.agentIds ?? approvedItems.map((item) => item.sourceAgentId)).filter((item, index, array) => array.indexOf(item) === index),
    paths,
    generatedAt,
  }));

  return {
    rootPath: paths.rootPath,
    commonsPath: paths.commonsPath,
    indexPath: paths.indexPath,
    approvedCount: approvedItems.length,
    revokedCount: revokedItems.length,
    agentPageCount: agentIds.length,
    noteCount: notePaths.length,
    notePaths,
  };
}
