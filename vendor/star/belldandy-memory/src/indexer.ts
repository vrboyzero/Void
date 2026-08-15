import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as chokidar from "chokidar";
import { MemoryStore } from "./store.js";
import { Chunker, type ChunkOptions } from "./chunker.js";
import type { MemoryChunk, MemoryType } from "./types.js";
import { extractTextFromSessionContent } from "./session-loader.js";
import { readUtf8FileBounded } from "./bounded-index-file.js";
import {
    IndexCoordinator,
    type IndexWatchEvent,
    type IndexWatchEventKind,
} from "./index-coordinator.js";

export interface IndexerOptions {
    extensions?: string[];
    chunkOptions?: ChunkOptions;
    ignorePatterns?: string[];
    watch?: boolean;
    watchDebounceMs?: number;
    watchMaxPendingPaths?: number;
    watchMaxConcurrentEvents?: number;
    watchCloseDrainTimeoutMs?: number;
    maxFileBytes?: number;
    maxRunBytes?: number;
    verboseWatchEvents?: boolean;
}

export type IndexRunBudget = {
    maxBytes: number;
    consumedBytes: number;
    visitedFiles: number;
    skipFiles: number;
    exhausted: boolean;
    nextCursor: number | null;
};

export type IndexRunResult = {
    consumedBytes: number;
    visitedFiles: number;
    deferred: boolean;
};

function normalizeByteLimit(value: number | undefined, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return fallback;
    }
    return Math.max(1, Math.floor(value));
}

export function resolveWatchEventCoalesceMs(watchDebounceMs?: number): number {
    const debounceMs = typeof watchDebounceMs === "number" && Number.isFinite(watchDebounceMs)
        ? watchDebounceMs
        : 1000;
    return Math.min(200, Math.max(25, Math.floor(debounceMs / 4)));
}

export function resolveVerboseWatchEvents(option?: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
    if (typeof option === "boolean") {
        return option;
    }
    const raw = env.BELLDANDY_MEMORY_INDEXER_VERBOSE_WATCH;
    if (typeof raw !== "string") {
        return false;
    }
    return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export class MemoryIndexer {
    private store: MemoryStore;
    private chunker: Chunker;
    private options: Required<IndexerOptions>;
    private watcher: chokidar.FSWatcher | null = null;
    private watchRoots: string[] = [];
    private readonly watchCoordinator: IndexCoordinator;
    private readonly ownsWatchCoordinator: boolean;
    private watchStopped = false;
    private stopped = false;
    private fullScanCursor = 0;

    constructor(store: MemoryStore, options: IndexerOptions = {}, watchCoordinator?: IndexCoordinator) {
        this.store = store;
        this.chunker = new Chunker(options.chunkOptions);
        this.options = {
            extensions: options.extensions ?? [".md", ".txt", ".jsonl"],
            chunkOptions: options.chunkOptions ?? {},
            ignorePatterns: options.ignorePatterns ?? ["node_modules", ".git", "dist", "build", ".star_sanctuary", ".belldandy"],
            watch: options.watch ?? false,
            watchDebounceMs: options.watchDebounceMs ?? 1000,
            watchMaxPendingPaths: options.watchMaxPendingPaths ?? 1_024,
            watchMaxConcurrentEvents: options.watchMaxConcurrentEvents ?? 4,
            watchCloseDrainTimeoutMs: options.watchCloseDrainTimeoutMs ?? 5_000,
            maxFileBytes: normalizeByteLimit(options.maxFileBytes, 16 * 1024 * 1024),
            maxRunBytes: normalizeByteLimit(options.maxRunBytes, 256 * 1024 * 1024),
            verboseWatchEvents: resolveVerboseWatchEvents(options.verboseWatchEvents),
        };
        this.ownsWatchCoordinator = !watchCoordinator;
        this.watchCoordinator = watchCoordinator ?? new IndexCoordinator({
            runFullScan: async () => {},
            processWatchEvent: (event, signal) => this.processWatchEvent(event, signal),
            watchCoalesceMs: resolveWatchEventCoalesceMs(this.options.watchDebounceMs),
            maxPendingWatchPaths: this.options.watchMaxPendingPaths,
            maxConcurrentWatchEvents: this.options.watchMaxConcurrentEvents,
            closeDrainTimeoutMs: this.options.watchCloseDrainTimeoutMs,
            onWatchError: (event, error) => {
                console.error(`[WatcherFlushError] ${event.sourcePath}`, error);
            },
        });
    }

    beginFullScan(): IndexRunBudget {
        return {
            maxBytes: Math.max(1, Math.floor(this.options.maxRunBytes)),
            consumedBytes: 0,
            visitedFiles: 0,
            skipFiles: this.fullScanCursor,
            exhausted: false,
            nextCursor: null,
        };
    }

    finishFullScan(budget: IndexRunBudget): IndexRunResult {
        this.fullScanCursor = budget.exhausted && budget.nextCursor !== null
            ? budget.nextCursor
            : 0;
        return {
            consumedBytes: budget.consumedBytes,
            visitedFiles: budget.visitedFiles,
            deferred: budget.exhausted,
        };
    }

    /** 索引指定目录（递归） */
    async indexDirectory(
        dirPath: string,
        scanRoot = dirPath,
        signal?: AbortSignal,
        runBudget?: IndexRunBudget,
    ): Promise<void> {
        if (this.stopped || signal?.aborted) {
            return;
        }

        let entries: Dirent[];
        try {
            entries = await fs.readdir(dirPath, { withFileTypes: true });
        } catch (err) {
            const code = (err as NodeJS.ErrnoException | undefined)?.code;
            if (this.stopped || signal?.aborted || code === "ENOENT") {
                return;
            }
            throw err;
        }

        if (this.stopped || signal?.aborted) {
            return;
        }
        // full-scan cursor 依赖稳定 ordinal；不要使用平台未承诺顺序的原始 readdir 结果。
        entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

        for (const entry of entries) {
            if (this.stopped || signal?.aborted) {
                return;
            }
            const fullPath = path.join(dirPath, entry.name);

            if (this.shouldIgnore(fullPath, scanRoot)) {
                continue;
            }

            if (entry.isDirectory()) {
                await this.indexDirectory(fullPath, scanRoot, signal, runBudget);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (this.options.extensions.includes(ext)) {
                    await this.indexFile(fullPath, signal, runBudget);
                }
            }
        }
    }

    /** 索引单个文件 */
    async indexFile(filePath: string, signal?: AbortSignal, runBudget?: IndexRunBudget): Promise<void> {
        if (this.stopped || signal?.aborted) {
            return;
        }
        const runOrdinal = runBudget?.visitedFiles ?? -1;
        if (runBudget) {
            runBudget.visitedFiles += 1;
            if (runOrdinal < runBudget.skipFiles || runBudget.exhausted) {
                return;
            }
        }
        try {
            const stats = await fs.stat(filePath);
            if (this.stopped || signal?.aborted) {
                return;
            }
            const maxFileBytes = this.options.maxFileBytes;
            if (stats.size > maxFileBytes) {
                return;
            }
            let readLimit = maxFileBytes;
            if (runBudget) {
                const remainingBytes = runBudget.maxBytes - runBudget.consumedBytes;
                if (stats.size > remainingBytes) {
                    runBudget.exhausted = true;
                    runBudget.nextCursor = runOrdinal;
                    return;
                }
                readLimit = Math.min(readLimit, remainingBytes);
            }
            const mtime = stats.mtime.toISOString();
            const ext = path.extname(filePath).toLowerCase();
            const fileMeta = this.store.getFileMetadata(filePath);
            let loaded = null as { content: string; memoryType: MemoryType; bytesRead: number } | null;

            // 增量判定优先看 mtime；若 mtime 未前进或发生回拨，再回退到内容 hash 校验。
            // 这样既保留了大多数场景下的轻量快速路径，也能兜住测试里这类“内容变了但 mtime 不可靠”的情况。
            if (fileMeta?.metadata?.file_mtime) {
                const previousMtime = new Date(String(fileMeta.metadata.file_mtime));
                if (Number.isFinite(previousMtime.getTime()) && previousMtime < stats.mtime) {
                    // 文件 mtime 确认变新，继续重建索引，不需要额外 hash 校验。
                } else {
                    loaded = await loadIndexableContent(filePath, ext, readLimit, signal);
                    if (!loaded) {
                        this.markRunBudgetReadOverflow(runBudget, runOrdinal, readLimit);
                        return;
                    }
                    if (this.stopped || signal?.aborted) {
                        return;
                    }
                    const nextHash = computeContentHash(loaded.content);
                    if (nextHash === fileMeta.metadata?.file_hash) {
                        return;
                    }
                }
            }

            if (!loaded) {
                loaded = await loadIndexableContent(filePath, ext, readLimit, signal);
                if (!loaded) {
                    this.markRunBudgetReadOverflow(runBudget, runOrdinal, readLimit);
                    return;
                }
                if (this.stopped || signal?.aborted) {
                    return;
                }
            }
            if (runBudget) {
                runBudget.consumedBytes += loaded.bytesRead;
            }
            const { content, memoryType } = loaded;

            if (!content.trim()) return;

            const chunksStr = this.chunker.splitText(content);
            const fileHash = computeContentHash(content);

            const baseId = crypto.createHash("md5").update(filePath).digest("hex");

            // Phase M-1: 推断元数据
            const channel = inferChannelFromPath(filePath, ext);
            const tsDate = inferTsDateFromPath(filePath, mtime);
            const agentId = this.store.getSourceAgentId(filePath) ?? undefined;
            const sourceVisibility = this.store.getSourceVisibility(filePath) ?? undefined;
            const chunks: MemoryChunk[] = [];

            for (let i = 0; i < chunksStr.length; i++) {
                const chunkContent = chunksStr[i];
                const chunkId = `${baseId}_${i}`;
                chunks.push({
                    id: chunkId,
                    sourcePath: filePath,
                    sourceType: ext === ".jsonl" ? "session" : "file",
                    memoryType: memoryType,
                    content: chunkContent,
                    channel,
                    tsDate,
                    agentId,
                    visibility: this.store.getChunkVisibility(chunkId) ?? sourceVisibility,
                    metadata: {
                        file_mtime: mtime, // 存入文件的实际修改时间
                        file_hash: fileHash,
                        chunk_index: i,
                        total_chunks: chunksStr.length
                    }
                });
            }

            // 使用单事务替换同一 source 的索引内容，避免先删后写的中间态暴露给查询方。
            if (this.stopped || signal?.aborted) {
                return;
            }
            this.store.replaceSourceChunks(filePath, chunks);

            // 更新全局索引时间
            this.store.updateLastIndexedAt();

        } catch (err) {
            const code = (err as NodeJS.ErrnoException | undefined)?.code;
            if (this.stopped || signal?.aborted || code === "ENOENT" || code === "ABORT_ERR") {
                return;
            }
            console.error(`Failed to index file: ${filePath}`, err);
        }
    }

    private markRunBudgetReadOverflow(
        runBudget: IndexRunBudget | undefined,
        runOrdinal: number,
        readLimit: number,
    ): void {
        if (!runBudget || readLimit >= this.options.maxFileBytes) {
            return;
        }
        runBudget.consumedBytes = runBudget.maxBytes;
        runBudget.exhausted = true;
        runBudget.nextCursor = runOrdinal;
    }
    /** 停止监听 */
    async stopWatching(): Promise<void> {
        this.watchStopped = true;
        this.watchCoordinator.stopAcceptingWatchEvents();
        if (this.watcher) {
            await this.watcher.close();
            this.watcher = null;
        }
        if (this.ownsWatchCoordinator) {
            await this.watchCoordinator.close();
        }
    }

    /** Manager 在 coordinator drain 后调用，阻止任何迟到的索引提交。 */
    async close(): Promise<void> {
        await this.stopWatching();
        this.stopped = true;
    }

    /** 启动目录监听（支持单目录或多目录） */
    async startWatching(dirPaths: string | string[]): Promise<void> {
        if (this.stopped || this.watchStopped || !this.options.watch) return;
        if (this.watcher) return;

        const paths = Array.isArray(dirPaths) ? dirPaths : [dirPaths];
        this.watchRoots = paths.map((item) => path.resolve(item));
        console.log(`[MemoryIndexer] Starting watch on: ${paths.join(", ")}`);

        this.watcher = chokidar.watch(paths, {
            ignored: (pathStr: string) => {
                return this.shouldIgnore(pathStr, this.watchRoots);
            },
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: this.options.watchDebounceMs,
                pollInterval: 100
            }
        });

        const handleFile = (filePath: string) => {
            const ext = path.extname(filePath).toLowerCase();
            if (this.options.extensions.includes(ext)) {
                this.scheduleWatchEvent(filePath, "upsert");
            }
        };

        const handleRemove = (filePath: string) => {
            const ext = path.extname(filePath).toLowerCase();
            if (this.options.extensions.includes(ext)) {
                this.scheduleWatchEvent(filePath, "remove");
            }
        };

        this.watcher
            .on("add", handleFile)
            .on("change", handleFile)
            .on("unlink", handleRemove)
            .on("error", error => console.error(`[WatcherError] ${error}`));
    }

    private shouldIgnore(targetPath: string, roots: string | string[]): boolean {
        const candidateRoots = (Array.isArray(roots) ? roots : [roots])
            .map((item) => path.resolve(item));
        const resolvedTarget = path.resolve(targetPath);

        for (const root of candidateRoots) {
            const relative = this.toRelativePath(root, resolvedTarget);
            if (relative !== null && this.matchesIgnorePattern(relative)) {
                return true;
            }
        }

        return false;
    }

    private toRelativePath(rootPath: string, targetPath: string): string | null {
        const relative = path.relative(rootPath, targetPath);
        if (!relative) return "";
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
            return null;
        }
        return relative;
    }

    private matchesIgnorePattern(targetPath: string): boolean {
        const targetSegments = normalizePathSegments(targetPath);
        if (targetSegments.length === 0) {
            return false;
        }

        return this.options.ignorePatterns.some((pattern) => {
            const patternSegments = normalizePathSegments(pattern);
            if (patternSegments.length === 0) return false;

            if (patternSegments.length === 1) {
                return targetSegments.includes(patternSegments[0]);
            }

            for (let i = 0; i <= targetSegments.length - patternSegments.length; i++) {
                let matched = true;
                for (let j = 0; j < patternSegments.length; j++) {
                    if (targetSegments[i + j] !== patternSegments[j]) {
                        matched = false;
                        break;
                    }
                }
                if (matched) return true;
            }

            return false;
        });
    }

    private scheduleWatchEvent(filePath: string, kind: IndexWatchEventKind): void {
        const resolvedPath = path.resolve(filePath);
        this.watchCoordinator.enqueueWatchEvent(resolvedPath, kind);
    }

    async processWatchEvent(event: IndexWatchEvent, signal?: AbortSignal): Promise<void> {
        if (this.stopped || signal?.aborted) {
            return;
        }
        const { sourcePath: filePath, kind } = event;
        if (this.options.verboseWatchEvents) {
            console.log(kind === "remove" ? `[FileRemoved] ${filePath}` : `[FileChanged] ${filePath}`);
        }
        try {
            if (kind === "remove") {
                if (!signal?.aborted) {
                    this.store.deleteBySource(filePath);
                }
                return;
            }
            await this.indexFile(filePath, signal);
        } catch (error) {
            if (this.stopped
                || signal?.aborted
                || (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
                return;
            }
            throw error;
        }
    }
}

// ========== Phase M-1: 元数据推断 ==========

/** 从文件路径推断来源渠道 */
function inferChannelFromPath(filePath: string, ext: string): string | undefined {
    const lower = filePath.toLowerCase().replace(/\\/g, "/");
    if (ext === ".jsonl" || lower.includes("/sessions/")) {
        if (lower.includes("feishu") || lower.includes("lark")) return "feishu";
        return "webchat";
    }
    if (lower.includes("heartbeat")) return "heartbeat";
    return undefined;
}

/** 从文件路径或 mtime 推断日期 */
function inferTsDateFromPath(filePath: string, mtime: string): string | undefined {
    // 优先从文件名提取：memory/YYYY-MM-DD.md 或 sessions/YYYY-MM-DD_xxx.jsonl
    const dateMatch = filePath.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) return dateMatch[1];

    // 从文件 mtime 推断
    try {
        return new Date(mtime).toISOString().slice(0, 10);
    } catch {
        return undefined;
    }
}

function normalizePathSegments(input: string): string[] {
    return String(input ?? "")
        .replace(/\\/g, "/")
        .split("/")
        .map((segment) => segment.trim().toLowerCase())
        .filter(Boolean);
}

async function loadIndexableContent(
    filePath: string,
    ext: string,
    maxBytes: number,
    signal?: AbortSignal,
): Promise<{ content: string; memoryType: MemoryType; bytesRead: number } | null> {
    const loaded = await readUtf8FileBounded(filePath, maxBytes, signal);
    if (loaded.status === "too_large") {
        return null;
    }
    const content = ext === ".jsonl"
        ? extractTextFromSessionContent(loaded.content)
        : loaded.content;
    if (ext === ".jsonl") {
        return { content, memoryType: "session", bytesRead: loaded.bytesRead };
    }
    const fileName = path.basename(filePath);
    const parentDir = path.basename(path.dirname(filePath));
    const normalizedPath = filePath.replace(/\\/g, "/").toLowerCase();

    let memoryType: MemoryType = "other";
    if (fileName === "MEMORY.md" || fileName === "memory.md") {
        memoryType = "core";
    } else if (fileName === "DREAM.md" || fileName === "dream.md") {
        memoryType = "dream_index";
    } else if ((/(^|\/)dreams\/.+\.md$/).test(normalizedPath)) {
        memoryType = "dream_note";
    } else if (parentDir === "memory" && /^\d{4}-\d{2}-\d{2}\.md$/.test(fileName)) {
        memoryType = "daily";
    }

    return { content, memoryType, bytesRead: loaded.bytesRead };
}

function computeContentHash(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
}
