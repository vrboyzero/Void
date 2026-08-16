import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { MemorySearchFilter, MemoryType, MemoryVisibility } from "./types.js";

export type MemoryDedupChunkSnapshot = {
    id: string;
    sourcePath: string;
    sourceType: string;
    memoryType?: MemoryType;
    visibility?: MemoryVisibility;
    startLine?: number;
    endLine?: number;
    content: string;
    createdAt?: string;
    updatedAt?: string;
    taskLinkCount?: number;
};

export type MemoryExactDedupPreviewItem = {
    id: string;
    sourcePath: string;
    sourceType: string;
    memoryType?: MemoryType;
    visibility?: MemoryVisibility;
    startLine?: number;
    endLine?: number;
    createdAt?: string;
    updatedAt?: string;
    taskLinkCount: number;
    normalizedHash: string;
    normalizedChars: number;
    preview: string;
    sourceIndexing?: MemoryDedupSourceIndexInfo;
};

export type MemoryDedupSourceIndexScope =
    | "workspace_sessions"
    | "state_memory_root"
    | "state_memory_file"
    | "team_memory_root"
    | "team_memory_file"
    | "additional_root"
    | "additional_file"
    | "external";

export type MemoryDedupSourceIndexInfo = {
    reindexable: boolean;
    scope: MemoryDedupSourceIndexScope;
    matchedPath?: string | null;
};

export type MemoryDedupGroupSourceIndexSummary = {
    reindexableSourcePathCount: number;
    nonReindexableSourcePathCount: number;
    allAffectedSourcePathsReindexable: boolean;
    anyAffectedSourcePathReindexable: boolean;
    scopes: MemoryDedupSourceIndexScope[];
};

export type MemoryDedupGovernanceSuggestedAction = "review" | "keep" | "archive";

export type MemoryDedupGovernanceRiskLevel = "low" | "medium" | "high";

export type MemoryDedupGovernanceSignal =
    | "mixed_reindexable"
    | "shared_visibility"
    | "task_linked"
    | "all_reindexable"
    | "non_reindexable_only"
    | "indexing_unknown";

export type MemoryExactDedupGovernanceGroup = {
    suggestedAction: MemoryDedupGovernanceSuggestedAction;
    riskLevel: MemoryDedupGovernanceRiskLevel;
    reviewRequired: boolean;
    rationale: string;
    signals: MemoryDedupGovernanceSignal[];
};

export type MemoryExactDedupPreviewGroup = {
    normalizedHash: string;
    normalizedChars: number;
    groupSize: number;
    keep: MemoryExactDedupPreviewItem;
    remove: MemoryExactDedupPreviewItem[];
    affectedSourcePaths: string[];
    affectedTaskLinkCount: number;
    preview: string;
    sourceIndexing?: MemoryDedupGroupSourceIndexSummary;
    governance?: MemoryExactDedupGovernanceGroup;
};

export type MemoryExactDedupPreviewObservability = {
    beforeChunkCount: number;
    estimatedAfterChunkCount: number;
    pageCount: number;
    freelistCount: number;
};

export type MemoryDedupSourceIndexSummary = {
    reindexableSourcePathCount: number;
    nonReindexableSourcePathCount: number;
    duplicateGroupsWithReindexableSources: number;
    duplicateGroupsWithOnlyNonReindexableSources: number;
};

export type MemoryExactDedupGovernanceSummary = {
    headline: string;
    groupCount: number;
    suggestedReviewGroupCount: number;
    suggestedKeepGroupCount: number;
    suggestedArchiveGroupCount: number;
    taskLinkedGroupCount: number;
    mixedSourceGroupCount: number;
    nonReindexableOnlyGroupCount: number;
    topSuggestedGroups: MemoryExactDedupPreviewGroup[];
};

export type MemoryExactDedupPreviewReport = {
    mode: "dry_run";
    strategy: "hash_only_exact";
    normalization: "trimmed_lf";
    filter?: MemorySearchFilter;
    totals: {
        scannedChunks: number;
        uniqueNormalizedHashes: number;
        duplicateGroups: number;
        duplicateChunks: number;
        removableChunks: number;
        affectedSourcePaths: number;
        affectedTaskLinkCount: number;
    };
    groupLimit: number;
    truncated: boolean;
    groups: MemoryExactDedupPreviewGroup[];
    observability?: MemoryExactDedupPreviewObservability;
    sourceIndexingSummary?: MemoryDedupSourceIndexSummary;
    governance?: MemoryExactDedupGovernanceSummary;
};

export type MemoryExactDedupApplyOptions = {
    backupRootDir: string;
    maxGroups?: number;
    runId?: string;
};

export type MemoryExactDedupApplyResult = {
    mode: "apply";
    strategy: "hash_only_exact";
    normalization: "trimmed_lf";
    filter?: MemorySearchFilter;
    runId: string;
    backupPath: string;
    totals: {
        scannedChunks: number;
        duplicateGroups: number;
        duplicateChunks: number;
        removedChunks: number;
        relinkedTaskMemoryLinks: number;
        keptChunks: number;
    };
    observability?: {
        beforeChunkCount: number;
        afterChunkCount: number;
        beforePageCount: number;
        afterPageCount: number;
        beforeFreelistCount: number;
        afterFreelistCount: number;
    };
    groups: Array<{
        normalizedHash: string;
        keepChunkId: string;
        removedChunkIds: string[];
        relinkedTaskMemoryLinks: number;
    }>;
};

const DEFAULT_GROUP_LIMIT = 50;
const MAX_PREVIEW_CHARS = 160;

export function normalizeChunkContentForExactDedup(content: string): string {
    return String(content ?? "")
        .replace(/^\uFEFF/, "")
        .replace(/\r\n?/g, "\n")
        .trim();
}

export function buildMemoryExactDedupPreviewReport(input: {
    chunks: MemoryDedupChunkSnapshot[];
    filter?: MemorySearchFilter;
    maxGroups?: number;
}): MemoryExactDedupPreviewReport {
    const chunks = Array.isArray(input.chunks) ? input.chunks : [];
    const groupLimit = normalizeGroupLimit(input.maxGroups);
    const duplicateGroups = buildDuplicateGroups(chunks);

    const allAffectedSourcePaths = new Set<string>();
    let duplicateChunks = 0;
    let removableChunks = 0;
    let affectedTaskLinkCount = 0;
    for (const group of duplicateGroups) {
        duplicateChunks += group.groupSize;
        removableChunks += group.remove.length;
        affectedTaskLinkCount += group.affectedTaskLinkCount;
        for (const sourcePath of group.affectedSourcePaths) {
            allAffectedSourcePaths.add(sourcePath);
        }
    }

    const uniqueNormalizedHashes = new Set<string>();
    for (const chunk of chunks) {
        uniqueNormalizedHashes.add(hashNormalizedContent(normalizeChunkContentForExactDedup(chunk.content)));
    }

    return {
        mode: "dry_run",
        strategy: "hash_only_exact",
        normalization: "trimmed_lf",
        ...(input.filter ? { filter: input.filter } : {}),
        totals: {
            scannedChunks: chunks.length,
            uniqueNormalizedHashes: uniqueNormalizedHashes.size,
            duplicateGroups: duplicateGroups.length,
            duplicateChunks,
            removableChunks,
            affectedSourcePaths: allAffectedSourcePaths.size,
            affectedTaskLinkCount,
        },
        groupLimit,
        truncated: duplicateGroups.length > groupLimit,
        groups: duplicateGroups.slice(0, groupLimit),
    };
}

export function buildMemoryExactDedupApplyPlan(input: {
    chunks: MemoryDedupChunkSnapshot[];
    filter?: MemorySearchFilter;
    maxGroups?: number;
}): {
    report: MemoryExactDedupPreviewReport;
    operations: Array<{
        normalizedHash: string;
        keepChunkId: string;
        removeChunkIds: string[];
    }>;
} {
    const report = buildMemoryExactDedupPreviewReport(input);
    return {
        report,
        operations: report.groups.map((group) => ({
            normalizedHash: group.normalizedHash,
            keepChunkId: group.keep.id,
            removeChunkIds: group.remove.map((item) => item.id),
        })),
    };
}

export function ensureMemoryDedupBackupFile(input: {
    dbPath: string;
    backupRootDir: string;
    runId?: string;
}): {
    runId: string;
    backupPath: string;
} {
    const sourcePath = path.resolve(input.dbPath);
    const runId = normalizeRunId(input.runId);
    const backupDir = path.resolve(input.backupRootDir);
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `memory-dedup-${runId}.sqlite`);
    fs.copyFileSync(sourcePath, backupPath, fs.constants.COPYFILE_EXCL);
    return {
        runId,
        backupPath,
    };
}

function buildDuplicateGroups(chunks: MemoryDedupChunkSnapshot[]): MemoryExactDedupPreviewGroup[] {
    const grouped = new Map<string, MemoryDedupChunkSnapshot[]>();

    for (const chunk of chunks) {
        const normalized = normalizeChunkContentForExactDedup(chunk.content);
        const hash = hashNormalizedContent(normalized);
        const bucket = grouped.get(hash);
        if (bucket) {
            bucket.push(chunk);
        } else {
            grouped.set(hash, [chunk]);
        }
    }

    return [...grouped.entries()]
        .map(([normalizedHash, items]) => ({ normalizedHash, items }))
        .filter((group) => group.items.length > 1)
        .map((group) => toPreviewGroup(group.normalizedHash, group.items))
        .sort(comparePreviewGroups);
}

function toPreviewGroup(normalizedHash: string, items: MemoryDedupChunkSnapshot[]): MemoryExactDedupPreviewGroup {
    const normalized = normalizeChunkContentForExactDedup(items[0]?.content ?? "");
    const sorted = [...items].sort(compareChunkKeepPriority);
    const keep = toPreviewItem(sorted[0], normalizedHash, normalized);
    const remove = sorted.slice(1).map((item) => toPreviewItem(item, normalizedHash, normalized));
    const affectedSourcePaths = [...new Set(sorted.map((item) => item.sourcePath).filter((item) => Boolean(item)))].sort();
    return {
        normalizedHash,
        normalizedChars: normalized.length,
        groupSize: sorted.length,
        keep,
        remove,
        affectedSourcePaths,
        affectedTaskLinkCount: remove.reduce((sum, item) => sum + item.taskLinkCount, 0),
        preview: buildPreview(normalized),
    };
}

function toPreviewItem(
    item: MemoryDedupChunkSnapshot | undefined,
    normalizedHash: string,
    normalized: string,
): MemoryExactDedupPreviewItem {
    const taskLinkCount = typeof item?.taskLinkCount === "number" && Number.isFinite(item.taskLinkCount)
        ? Math.max(0, Math.floor(item.taskLinkCount))
        : 0;
    return {
        id: String(item?.id ?? ""),
        sourcePath: String(item?.sourcePath ?? ""),
        sourceType: String(item?.sourceType ?? ""),
        memoryType: item?.memoryType,
        visibility: item?.visibility,
        startLine: item?.startLine,
        endLine: item?.endLine,
        createdAt: item?.createdAt,
        updatedAt: item?.updatedAt,
        taskLinkCount,
        normalizedHash,
        normalizedChars: normalized.length,
        preview: buildPreview(normalized),
    };
}

function buildPreview(content: string): string {
    const singleLine = content.replace(/\s+/g, " ").trim();
    if (singleLine.length <= MAX_PREVIEW_CHARS) {
        return singleLine;
    }
    return `${singleLine.slice(0, MAX_PREVIEW_CHARS - 1)}…`;
}

function compareChunkKeepPriority(left: MemoryDedupChunkSnapshot, right: MemoryDedupChunkSnapshot): number {
    const leftLinks = typeof left.taskLinkCount === "number" && Number.isFinite(left.taskLinkCount) ? left.taskLinkCount : 0;
    const rightLinks = typeof right.taskLinkCount === "number" && Number.isFinite(right.taskLinkCount) ? right.taskLinkCount : 0;
    if (leftLinks !== rightLinks) {
        return rightLinks - leftLinks;
    }

    const leftCreated = parseTimestamp(left.createdAt ?? left.updatedAt);
    const rightCreated = parseTimestamp(right.createdAt ?? right.updatedAt);
    if (leftCreated !== rightCreated) {
        return leftCreated - rightCreated;
    }

    const sourceCompare = String(left.sourcePath ?? "").localeCompare(String(right.sourcePath ?? ""));
    if (sourceCompare !== 0) {
        return sourceCompare;
    }

    return String(left.id ?? "").localeCompare(String(right.id ?? ""));
}

function comparePreviewGroups(left: MemoryExactDedupPreviewGroup, right: MemoryExactDedupPreviewGroup): number {
    if (left.remove.length !== right.remove.length) {
        return right.remove.length - left.remove.length;
    }
    if (left.affectedTaskLinkCount !== right.affectedTaskLinkCount) {
        return right.affectedTaskLinkCount - left.affectedTaskLinkCount;
    }
    return left.keep.id.localeCompare(right.keep.id);
}

function parseTimestamp(value: string | undefined): number {
    const parsed = Date.parse(String(value ?? ""));
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function normalizeGroupLimit(value: number | undefined): number {
    if (!Number.isFinite(value)) return DEFAULT_GROUP_LIMIT;
    return Math.max(1, Math.min(500, Math.floor(value as number)));
}

function normalizeRunId(value: string | undefined): string {
    const trimmed = String(value ?? "").trim();
    if (trimmed) {
        return trimmed.replace(/[^a-zA-Z0-9_-]+/g, "_");
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `run-${stamp}`;
}

function hashNormalizedContent(content: string): string {
    return createHash("sha256").update(content).digest("hex");
}
