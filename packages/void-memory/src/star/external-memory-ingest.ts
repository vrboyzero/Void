import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { readUtf8FileBounded } from "./bounded-index-file.js";
import { Chunker } from "./chunker.js";
import type { MemoryChunk } from "./types.js";
import type { MemorySourceInventoryConfiguredSource } from "./memory-source-inventory.js";

export type ExternalMemoryIngestAdapter = "obsidian_markdown_directory_v1" | "markdown_file_v1";
export type ExternalMemoryIngestFileStatus = "eligible" | "skipped";
export type ExternalMemoryIngestRescanState = "new" | "changed" | "unchanged";
export type ExternalMemoryIngestScanTruncationReason =
  | "max_depth_exceeded"
  | "max_files_exceeded"
  | "unreadable_directory"
  | "symlink_not_allowed"
  | "path_outside_root";

export type ExternalMemoryIngestLimits = {
  maxDepth: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxChunks: number;
};

export type ExternalMemoryIngestPathIdentity = {
  realPath: string;
  device: string;
  inode: string;
};

export type ExternalMemoryIngestPreviewOptions = {
  limits?: Partial<ExternalMemoryIngestLimits>;
};

const MEBIBYTE = 1024 * 1024;

/** 外部目录是用户可配置输入，默认值同时限制扫描深度、内存读取和写入放大。 */
export const DEFAULT_EXTERNAL_MEMORY_INGEST_LIMITS: ExternalMemoryIngestLimits = {
  maxDepth: 32,
  maxFiles: 10_000,
  maxFileBytes: 16 * MEBIBYTE,
  maxTotalBytes: 256 * MEBIBYTE,
  maxChunks: 100_000,
};

export type ExternalMemoryIngestFileManifest = {
  path: string;
  realPath?: string;
  identity?: ExternalMemoryIngestPathIdentity;
  relativePath: string;
  size: number;
  mtime: string;
  estimatedChunks: number;
  contentHash: string;
  sourceType: "file";
  memoryType: "other";
  status: ExternalMemoryIngestFileStatus;
  rescanState?: ExternalMemoryIngestRescanState;
  previousContentHash?: string;
  previousChunkCount?: number;
  skipReason?: string;
};

export type ExternalMemoryIngestStaleFile = {
  path: string;
  relativePath: string;
  previousChunkCount: number;
  previousContentHash?: string;
  reason: "missing_from_preview";
};

export type ExternalMemoryIngestExistingFile = {
  path: string;
  relativePath?: string;
  contentHash?: string;
  chunkCount?: number;
};

export type ExternalMemoryIngestPreview = {
  adapter: ExternalMemoryIngestAdapter;
  generatedAt: string;
  source: MemorySourceInventoryConfiguredSource;
  sourceId: string;
  sourceLabel: string;
  sourceClass: MemorySourceInventoryConfiguredSource["sourceClass"];
  scope: NonNullable<MemorySourceInventoryConfiguredSource["scope"]>;
  storage: "external";
  rootPath: string;
  rootRealPath?: string;
  rootIdentity?: ExternalMemoryIngestPathIdentity;
  limits?: ExternalMemoryIngestLimits;
  scan?: {
    complete: boolean;
    truncationReasons: ExternalMemoryIngestScanTruncationReason[];
  };
  totalFiles: number;
  eligibleFiles: number;
  skippedFiles: number;
  estimatedChunks: number;
  estimatedBytes: number;
  fileManifest: ExternalMemoryIngestFileManifest[];
  skipReasons: Array<{ path: string; reason: string }>;
  rescan: {
    mode: "initial" | "rescan";
    previousFileCount: number;
    newFileCount: number;
    changedFileCount: number;
    unchangedFileCount: number;
    staleFileCount: number;
    staleFiles: ExternalMemoryIngestStaleFile[];
  };
};

export type ExternalMemoryIngestApplyResult = {
  appliedAt: string;
  source: MemorySourceInventoryConfiguredSource;
  sourceId: string;
  importedFileCount: number;
  importedChunkCount: number;
  skippedFiles: Array<{ path: string; reason: string }>;
  chunksBySourcePath: Array<{ sourcePath: string; chunks: MemoryChunk[] }>;
  staleFilesRemoved: number;
  staleChunksRemoved: number;
};

const OBSIDIAN_MARKDOWN_ADAPTER: ExternalMemoryIngestAdapter = "obsidian_markdown_directory_v1";
const MARKDOWN_FILE_ADAPTER: ExternalMemoryIngestAdapter = "markdown_file_v1";

export async function previewObsidianMarkdownDirectoryIngest(
  source: MemorySourceInventoryConfiguredSource,
  options: ExternalMemoryIngestPreviewOptions = {},
): Promise<ExternalMemoryIngestPreview> {
  const rootPath = normalizeRootPath(source.rootPath);
  const limits = normalizeExternalMemoryIngestLimits(options.limits);
  const root = await resolveExternalIngestRoot(rootPath);
  const discovery = await listMarkdownFiles(root, limits);
  return await previewMarkdownExternalIngest(source, {
    adapter: OBSIDIAN_MARKDOWN_ADAPTER,
    root,
    files: discovery.files,
    limits,
    scan: discovery.scan,
    discoverySkipReasons: discovery.skipReasons,
  });
}

export async function previewMarkdownFileIngest(
  source: MemorySourceInventoryConfiguredSource,
  options: ExternalMemoryIngestPreviewOptions = {},
): Promise<ExternalMemoryIngestPreview> {
  const filePath = normalizeFilePath(source.filePath);
  const limits = normalizeExternalMemoryIngestLimits(options.limits);
  const root = await resolveExternalIngestRoot(path.dirname(filePath));
  return await previewMarkdownExternalIngest(source, {
    adapter: MARKDOWN_FILE_ADAPTER,
    root,
    files: [filePath],
    limits,
    scan: {
      complete: true,
      truncationReasons: [],
    },
    discoverySkipReasons: [],
  });
}

export async function materializeObsidianMarkdownChunks(
  preview: ExternalMemoryIngestPreview,
  options: {
    appliedAt: string;
    reportId: string;
  },
): Promise<ExternalMemoryIngestApplyResult> {
  const chunker = new Chunker();
  const limits = normalizeExternalMemoryIngestLimits(preview.limits);
  const root = await resolveExternalIngestRoot(preview.rootPath);
  if (
    (preview.rootIdentity && !sameExternalIngestPathIdentity(preview.rootIdentity, root.identity))
    || (!preview.rootIdentity && preview.rootRealPath && !sameCanonicalPath(preview.rootRealPath, root.realPath))
  ) {
    throw new Error("external ingest root changed since preview.");
  }
  const chunksBySourcePath: Array<{ sourcePath: string; chunks: MemoryChunk[] }> = [];
  const skippedFiles: Array<{ path: string; reason: string }> = [];
  let importedFileCount = 0;
  let importedChunkCount = 0;
  let materializedBytes = 0;
  const externalSourceType = preview.adapter === MARKDOWN_FILE_ADAPTER
    ? "external_markdown_file"
    : "external_obsidian_markdown";

  for (const file of preview.fileManifest) {
    if (file.status !== "eligible") {
      skippedFiles.push({
        path: file.path,
        reason: file.skipReason || "not_eligible",
      });
      continue;
    }
    try {
      const inspection = await inspectExternalIngestFile(root, file.path);
      if (!inspection.ok) {
        throw new ExternalIngestSnapshotError(file.path);
      }
      if (
        (file.identity && !sameExternalIngestPathIdentity(file.identity, inspection.identity))
        || (!file.identity && file.realPath && !sameCanonicalPath(file.realPath, inspection.realPath))
      ) {
        throw new ExternalIngestSnapshotError(file.path);
      }
      if (inspection.size > limits.maxFileBytes) {
        throw new ExternalIngestSnapshotError(file.path);
      }
      if (materializedBytes + inspection.size > limits.maxTotalBytes) {
        throw new ExternalIngestSnapshotError(file.path);
      }

      const read = await readUtf8FileBounded(inspection.realPath, limits.maxFileBytes);
      if (read.status !== "ok") {
        throw new ExternalIngestSnapshotError(file.path);
      }
      // 读取期间若路径被替换，重新确认它仍是 preview 认可的同一 canonical 文件。
      const verifiedInspection = await inspectExternalIngestFile(root, file.path);
      if (
        !verifiedInspection.ok
        || !sameExternalIngestPathIdentity(inspection.identity, verifiedInspection.identity)
      ) {
        throw new ExternalIngestSnapshotError(file.path);
      }

      const content = read.content;
      if (hashExternalContent(content) !== file.contentHash) {
        throw new ExternalIngestSnapshotError(file.path);
      }
      const chunkTexts = chunker.splitText(content);
      if (chunkTexts.length <= 0) {
        throw new ExternalIngestSnapshotError(file.path);
      }
      if (importedChunkCount + chunkTexts.length > limits.maxChunks) {
        throw new ExternalIngestSnapshotError(file.path);
      }
      const baseId = createHash("md5").update(file.path).digest("hex");
      const chunks = chunkTexts.map((chunkContent, index) => ({
        id: `${baseId}_${index}`,
        sourcePath: file.path,
        sourceType: file.sourceType,
        memoryType: file.memoryType,
        content: chunkContent,
        metadata: {
          file_hash: file.contentHash,
          file_mtime: file.mtime,
          chunk_index: index,
          total_chunks: chunkTexts.length,
          memoryTree: {
            externalSourceId: preview.sourceId,
            externalSourceLabel: preview.sourceLabel,
            ingestAdapter: preview.adapter,
            externalSourceType,
            ingestedByReportId: options.reportId,
            ingestAppliedAt: options.appliedAt,
          },
        },
      } satisfies MemoryChunk));
      chunksBySourcePath.push({
        sourcePath: file.path,
        chunks,
      });
      importedFileCount += 1;
      importedChunkCount += chunks.length;
      materializedBytes += read.bytesRead;
    } catch (error) {
      if (error instanceof ExternalIngestSnapshotError) {
        throw error;
      }
      throw new ExternalIngestSnapshotError(file.path);
    }
  }

  return {
    appliedAt: options.appliedAt,
    source: preview.source,
    sourceId: preview.sourceId,
    importedFileCount,
    importedChunkCount,
    skippedFiles,
    chunksBySourcePath,
    staleFilesRemoved: 0,
    staleChunksRemoved: 0,
  };
}

class ExternalIngestSnapshotError extends Error {
  constructor(filePath: string) {
    super(`external ingest snapshot changed since preview: ${filePath}`);
    this.name = "ExternalIngestSnapshotError";
  }
}

export function annotateExternalIngestPreviewRescan(
  preview: ExternalMemoryIngestPreview,
  existingFiles: ExternalMemoryIngestExistingFile[],
): ExternalMemoryIngestPreview {
  const previousByPath = new Map(existingFiles.map((item) => [item.path, item] as const));
  const nextManifest = preview.fileManifest.map((item) => {
    const existing = previousByPath.get(item.path);
    // 已观察到但被预算或安全策略拒绝的文件不是“缺失文件”，不能触发 stale 删除。
    previousByPath.delete(item.path);
    if (item.status !== "eligible") {
      return item;
    }
    const rescanState: ExternalMemoryIngestRescanState = !existing
      ? "new"
      : existing.contentHash && existing.contentHash === item.contentHash
        ? "unchanged"
        : "changed";
    return {
      ...item,
      rescanState,
      ...(existing?.contentHash ? { previousContentHash: existing.contentHash } : {}),
      ...(existing ? { previousChunkCount: existing.chunkCount ?? 0 } : {}),
    };
  });
  const staleFiles = preview.scan?.complete === false
    ? []
    : Array.from(previousByPath.values())
      .sort((left, right) => left.path.localeCompare(right.path, "en-US"))
      .map((item) => ({
        path: item.path,
        relativePath: item.relativePath || path.basename(item.path),
        previousChunkCount: item.chunkCount ?? 0,
        previousContentHash: item.contentHash,
        reason: "missing_from_preview" as const,
      }));
  return {
    ...preview,
    fileManifest: nextManifest,
    rescan: {
      mode: existingFiles.length > 0 ? "rescan" : "initial",
      previousFileCount: existingFiles.length,
      newFileCount: nextManifest.filter((item) => item.rescanState === "new").length,
      changedFileCount: nextManifest.filter((item) => item.rescanState === "changed").length,
      unchangedFileCount: nextManifest.filter((item) => item.rescanState === "unchanged").length,
      staleFileCount: staleFiles.length,
      staleFiles,
    },
  };
}

function normalizeRootPath(rootPath?: string): string {
  const normalized = typeof rootPath === "string" ? rootPath.trim() : "";
  if (!normalized) {
    throw new Error("configured external ingest requires a non-empty rootPath.");
  }
  return path.resolve(normalized);
}

function normalizeFilePath(filePath?: string): string {
  const normalized = typeof filePath === "string" ? filePath.trim() : "";
  if (!normalized) {
    throw new Error("configured external ingest requires a non-empty filePath.");
  }
  return path.resolve(normalized);
}

type CanonicalExternalIngestRoot = {
  path: string;
  realPath: string;
  identity: ExternalMemoryIngestPathIdentity;
};

type ExternalIngestFileInspection =
  | {
    ok: true;
    realPath: string;
    identity: ExternalMemoryIngestPathIdentity;
    size: number;
    mtime: string;
  }
  | {
    ok: false;
    reason: string;
  };

type MarkdownFileDiscovery = {
  files: string[];
  skipReasons: Array<{ path: string; reason: string }>;
  scan: NonNullable<ExternalMemoryIngestPreview["scan"]>;
};

async function resolveExternalIngestRoot(rootPath: string): Promise<CanonicalExternalIngestRoot> {
  const normalizedPath = path.resolve(rootPath);
  const realPath = await fs.realpath(normalizedPath).catch(() => "");
  const stat = realPath ? await fs.stat(realPath).catch(() => null) : null;
  if (!stat || !stat.isDirectory()) {
    throw new Error(`configured external rootPath is not a readable directory: ${normalizedPath}`);
  }
  return {
    path: normalizedPath,
    realPath,
    identity: createExternalIngestPathIdentity(realPath, stat),
  };
}

async function inspectExternalIngestFile(
  root: CanonicalExternalIngestRoot,
  filePath: string,
): Promise<ExternalIngestFileInspection> {
  const normalizedPath = path.resolve(filePath);
  if (!isPathWithinRoot(root.path, normalizedPath)) {
    return { ok: false, reason: "path_outside_root" };
  }

  const linkStat = await fs.lstat(normalizedPath).catch(() => null);
  if (!linkStat) {
    return { ok: false, reason: "read_failed" };
  }
  if (linkStat.isSymbolicLink()) {
    return { ok: false, reason: "symlink_not_allowed" };
  }
  if (!linkStat.isFile()) {
    return { ok: false, reason: "not_a_file" };
  }

  const realPath = await fs.realpath(normalizedPath).catch(() => "");
  if (!realPath) {
    return { ok: false, reason: "read_failed" };
  }
  if (!isPathWithinRoot(root.realPath, realPath)) {
    return { ok: false, reason: "path_outside_root" };
  }

  const stat = await fs.stat(realPath).catch(() => null);
  if (!stat || !stat.isFile()) {
    return { ok: false, reason: "not_a_file" };
  }
  return {
    ok: true,
    realPath,
    identity: createExternalIngestPathIdentity(realPath, stat),
    size: stat.size,
    mtime: stat.mtime.toISOString(),
  };
}

async function listMarkdownFiles(
  root: CanonicalExternalIngestRoot,
  limits: ExternalMemoryIngestLimits,
): Promise<MarkdownFileDiscovery> {
  const files: string[] = [];
  const skipReasons: Array<{ path: string; reason: string }> = [];
  const truncationReasons = new Set<ExternalMemoryIngestScanTruncationReason>();
  let complete = true;
  let stopped = false;

  const markIncomplete = (reason: ExternalMemoryIngestScanTruncationReason, itemPath: string) => {
    complete = false;
    truncationReasons.add(reason);
    skipReasons.push({ path: itemPath, reason });
  };

  const visitDirectory = async (currentDir: string, depth: number): Promise<void> => {
    if (stopped) return;
    const currentRealPath = await fs.realpath(currentDir).catch(() => "");
    if (!currentRealPath || !isPathWithinRoot(root.realPath, currentRealPath)) {
      markIncomplete("path_outside_root", currentDir);
      return;
    }
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => null);
    if (!entries) {
      markIncomplete("unreadable_directory", currentDir);
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
    for (const entry of entries) {
      if (stopped) return;
      if (entry.name === ".obsidian" || entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      const linkStat = await fs.lstat(fullPath).catch(() => null);
      if (!linkStat) {
        markIncomplete("unreadable_directory", fullPath);
        continue;
      }
      if (linkStat.isSymbolicLink()) {
        // 链接目录可能隐藏任意数量的 Markdown；不把未展开内容误判为 stale。
        markIncomplete("symlink_not_allowed", fullPath);
        continue;
      }
      const entryDepth = depth + 1;
      if (linkStat.isDirectory()) {
        if (entryDepth >= limits.maxDepth) {
          markIncomplete("max_depth_exceeded", fullPath);
          continue;
        }
        const realPath = await fs.realpath(fullPath).catch(() => "");
        if (!realPath || !isPathWithinRoot(root.realPath, realPath)) {
          markIncomplete("path_outside_root", fullPath);
          continue;
        }
        await visitDirectory(fullPath, entryDepth);
        continue;
      }
      if (!linkStat.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
        continue;
      }
      if (entryDepth > limits.maxDepth) {
        markIncomplete("max_depth_exceeded", fullPath);
        continue;
      }
      if (files.length >= limits.maxFiles) {
        markIncomplete("max_files_exceeded", fullPath);
        stopped = true;
        return;
      }
      files.push(fullPath);
    }
  };

  await visitDirectory(root.path, 0);
  files.sort((left, right) => left.localeCompare(right, "en-US"));
  return {
    files,
    skipReasons,
    scan: {
      complete,
      truncationReasons: [...truncationReasons],
    },
  };
}

function hashExternalContent(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

async function previewMarkdownExternalIngest(
  source: MemorySourceInventoryConfiguredSource,
  input: {
    adapter: ExternalMemoryIngestAdapter;
    root: CanonicalExternalIngestRoot;
    files: string[];
    limits: ExternalMemoryIngestLimits;
    scan: NonNullable<ExternalMemoryIngestPreview["scan"]>;
    discoverySkipReasons: Array<{ path: string; reason: string }>;
  },
): Promise<ExternalMemoryIngestPreview> {
  const sourceLabel = source.label.trim();
  const sourceId = buildConfiguredExternalSourceId(source, 1);
  const generatedAt = new Date().toISOString();
  const chunker = new Chunker();
  const fileManifest: ExternalMemoryIngestFileManifest[] = [];
  const skipReasons = [...input.discoverySkipReasons];
  let estimatedChunks = 0;
  let estimatedBytes = 0;

  for (const filePath of input.files) {
    const relativePath = toRelativeExternalPath(input.root.path, filePath);
    const inspection = await inspectExternalIngestFile(input.root, filePath);
    if (!inspection.ok) {
      fileManifest.push(createSkippedFileManifest({
        filePath,
        relativePath,
        generatedAt,
        reason: inspection.reason,
      }));
      skipReasons.push({ path: filePath, reason: inspection.reason });
      continue;
    }
    if (inspection.size > input.limits.maxFileBytes) {
      fileManifest.push(createSkippedFileManifest({
        filePath,
        relativePath,
        generatedAt,
        reason: "max_file_bytes_exceeded",
        inspection,
      }));
      skipReasons.push({ path: filePath, reason: "max_file_bytes_exceeded" });
      continue;
    }
    if (estimatedBytes + inspection.size > input.limits.maxTotalBytes) {
      fileManifest.push(createSkippedFileManifest({
        filePath,
        relativePath,
        generatedAt,
        reason: "max_total_bytes_exceeded",
        inspection,
      }));
      skipReasons.push({ path: filePath, reason: "max_total_bytes_exceeded" });
      continue;
    }

    try {
      const read = await readUtf8FileBounded(inspection.realPath, input.limits.maxFileBytes);
      if (read.status !== "ok") {
        fileManifest.push(createSkippedFileManifest({
          filePath,
          relativePath,
          generatedAt,
          reason: "max_file_bytes_exceeded",
          inspection,
        }));
        skipReasons.push({ path: filePath, reason: "max_file_bytes_exceeded" });
        continue;
      }
      const content = read.content;
      if (!content.trim()) {
        fileManifest.push(createSkippedFileManifest({
          filePath,
          relativePath,
          generatedAt,
          reason: "empty_content",
          inspection,
          contentHash: hashExternalContent(content),
        }));
        skipReasons.push({ path: filePath, reason: "empty_content" });
        continue;
      }
      const chunks = chunker.splitText(content);
      if (chunks.length <= 0) {
        fileManifest.push(createSkippedFileManifest({
          filePath,
          relativePath,
          generatedAt,
          reason: "empty_content",
          inspection,
          contentHash: hashExternalContent(content),
        }));
        skipReasons.push({ path: filePath, reason: "empty_content" });
        continue;
      }
      if (estimatedChunks + chunks.length > input.limits.maxChunks) {
        fileManifest.push(createSkippedFileManifest({
          filePath,
          relativePath,
          generatedAt,
          reason: "max_chunks_exceeded",
          inspection,
          contentHash: hashExternalContent(content),
        }));
        skipReasons.push({ path: filePath, reason: "max_chunks_exceeded" });
        continue;
      }

      estimatedChunks += chunks.length;
      estimatedBytes += read.bytesRead;
      fileManifest.push({
        path: filePath,
        realPath: inspection.realPath,
        identity: inspection.identity,
        relativePath,
        size: inspection.size,
        mtime: inspection.mtime,
        estimatedChunks: chunks.length,
        contentHash: hashExternalContent(content),
        sourceType: "file",
        memoryType: "other",
        status: "eligible",
      });
    } catch {
      fileManifest.push(createSkippedFileManifest({
        filePath,
        relativePath,
        generatedAt,
        reason: "read_failed",
        inspection,
      }));
      skipReasons.push({ path: filePath, reason: "read_failed" });
    }
  }

  const eligibleFiles = fileManifest.filter((item) => item.status === "eligible").length;
  return {
    adapter: input.adapter,
    generatedAt,
    source,
    sourceId,
    sourceLabel,
    sourceClass: source.sourceClass,
    scope: source.scope ?? "private",
    storage: "external",
    rootPath: input.root.path,
    rootRealPath: input.root.realPath,
    rootIdentity: input.root.identity,
    limits: input.limits,
    scan: input.scan,
    totalFiles: fileManifest.length,
    eligibleFiles,
    skippedFiles: skipReasons.length,
    estimatedChunks,
    estimatedBytes,
    fileManifest,
    skipReasons,
    rescan: {
      mode: "initial",
      previousFileCount: 0,
      newFileCount: eligibleFiles,
      changedFileCount: 0,
      unchangedFileCount: 0,
      staleFileCount: 0,
      staleFiles: [],
    },
  };
}

function createSkippedFileManifest(input: {
  filePath: string;
  relativePath: string;
  generatedAt: string;
  reason: string;
  inspection?: Extract<ExternalIngestFileInspection, { ok: true }>;
  contentHash?: string;
}): ExternalMemoryIngestFileManifest {
  return {
    path: input.filePath,
    ...(input.inspection ? { realPath: input.inspection.realPath } : {}),
    ...(input.inspection ? { identity: input.inspection.identity } : {}),
    relativePath: input.relativePath,
    size: input.inspection?.size ?? 0,
    mtime: input.inspection?.mtime ?? input.generatedAt,
    estimatedChunks: 0,
    contentHash: input.contentHash ?? "",
    sourceType: "file",
    memoryType: "other",
    status: "skipped",
    skipReason: input.reason,
  };
}

function normalizeExternalMemoryIngestLimits(
  input?: Partial<ExternalMemoryIngestLimits>,
): ExternalMemoryIngestLimits {
  return {
    maxDepth: normalizeLimit(input?.maxDepth, DEFAULT_EXTERNAL_MEMORY_INGEST_LIMITS.maxDepth, 0),
    maxFiles: normalizeLimit(input?.maxFiles, DEFAULT_EXTERNAL_MEMORY_INGEST_LIMITS.maxFiles, 1),
    maxFileBytes: normalizeLimit(input?.maxFileBytes, DEFAULT_EXTERNAL_MEMORY_INGEST_LIMITS.maxFileBytes, 1),
    maxTotalBytes: normalizeLimit(input?.maxTotalBytes, DEFAULT_EXTERNAL_MEMORY_INGEST_LIMITS.maxTotalBytes, 1),
    maxChunks: normalizeLimit(input?.maxChunks, DEFAULT_EXTERNAL_MEMORY_INGEST_LIMITS.maxChunks, 1),
  };
}

function normalizeLimit(value: unknown, fallback: number, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.floor(value));
}

function toRelativeExternalPath(rootPath: string, filePath: string): string {
  return path.relative(rootPath, filePath).replace(/\\/g, "/") || path.basename(filePath);
}

function isPathWithinRoot(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function sameCanonicalPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function createExternalIngestPathIdentity(
  realPath: string,
  stat: { dev: number; ino: number },
): ExternalMemoryIngestPathIdentity {
  return {
    realPath,
    device: String(stat.dev),
    inode: String(stat.ino),
  };
}

function sameExternalIngestPathIdentity(
  left: ExternalMemoryIngestPathIdentity,
  right: ExternalMemoryIngestPathIdentity,
): boolean {
  return sameCanonicalPath(left.realPath, right.realPath)
    && left.device === right.device
    && left.inode === right.inode;
}

function buildConfiguredExternalSourceId(
  source: MemorySourceInventoryConfiguredSource,
  index: number,
): string {
  const explicitId = typeof source.id === "string" ? source.id.trim() : "";
  if (explicitId) {
    return explicitId;
  }
  const label = source.label.trim() || `configured-source-${index}`;
  return `configured:${sanitizeIdentifier(label)}:${index}`;
}

function sanitizeIdentifier(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "configured-source";
}
