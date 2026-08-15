import {
    MemoryStore,
    type TaskSummaryRecord,
} from "./store.js";
import type { SqliteDatabase } from "./index.js";
import {
    MemoryIndexer,
    resolveWatchEventCoalesceMs,
    type IndexerOptions,
} from "./indexer.js";
import { IndexCoordinator } from "./index-coordinator.js";
import { ResultReranker, type RerankerOptions } from "./reranker.js";
import { shouldSkipRetrieval } from "./adaptive-retrieval.js";
import { OpenAIEmbeddingProvider } from "./embeddings/openai.js";
import {
    DEFAULT_LOCAL_EMBEDDING_MODEL,
    LocalEmbeddingProvider,
} from "./embeddings/local-provider.js";
import type { EmbeddingProvider } from "./embeddings/index.js";
import {
    isValidEmbeddingVector,
    resolveEmbeddingDimension,
    validateEmbeddingBatchResponse,
} from "./embedding-sync.js";
import { EmbeddingFailureLedger, type EmbeddingFailureReason } from "./embedding-failure-ledger.js";
import { PendingEmbeddingCandidateCursor } from "./embedding-pending-candidates.js";
import type {
    MemoryCategory,
    MemoryChunk,
    MemoryImportance,
    MemoryIndexStatus,
    MemorySearchFilter,
    MemorySearchOptions,
    MemorySearchRoutingPolicy,
    MemorySearchResult,
} from "./types.js";
import { ExperiencePromoter } from "./experience-promoter.js";
import { buildExperienceSynthesisPreview } from "./experience-synthesis.js";
import { TaskProcessor } from "./task-processor.js";
import { TaskSummarizer } from "./task-summarizer.js";
import { shouldAutoPromoteTaskByPolicy } from "./task-auto-promotion-policy.js";
import { buildTaskDerivedSearchResults } from "./derived-task-retrieval.js";
import { collectDerivedSessionSearchResults } from "./derived-session-retrieval.js";
import {
  buildDeadlineSkippedDerivedRetrievalExecution,
  buildDerivedRetrievalReport,
  hasDerivedRetrievalDeadlinePassed,
  type DerivedRetrievalExecution,
  type DerivedRetrievalReport,
} from "./derived-retrieval-report.js";
import {
    buildDerivedRetrievalDoctorReport,
    createDerivedRetrievalRuntimeSnapshot,
    type DerivedRetrievalDoctorReport,
    type DerivedRetrievalRuntimeSnapshot,
} from "./derived-retrieval-doctor.js";
import {
    buildEmbeddingCacheDoctorReport,
    DEFAULT_EMBEDDING_CACHE_RETENTION,
    type EmbeddingCacheDoctorReport,
} from "./embedding-cache-doctor.js";
import type { SessionArtifactInventoryProvider } from "./session-artifact-inventory.js";
import { buildExperienceDerivedSearchResults } from "./derived-experience-retrieval.js";
import { createMemoryRetrievalRequest } from "./memory-retrieval-deadline.js";
import { buildQueryEmbeddingCacheKey, QueryEmbeddingCache } from "./query-embedding-cache.js";
import { applySearchResultSourceRegistryHints } from "./search-result-source-registry.js";
import {
    buildGlobalMemoryTreeNodes,
    buildProfileMemoryTreeNodes,
    buildTopicMemoryTreeNodes,
    rankMemoryTreeTopicChunks,
} from "./memory-tree-layer-builders.js";
import {
    DURABLE_PROFILE_STATE_PROMPT_BLOCK,
    buildDurableProfileStatePlan,
    type DurableProfileStatePatch,
} from "./durable-profile-state.js";
import type {
    DeleteProfileStateEntryInput,
    ProfileStateEntry,
    ProfileStateEntryFilter,
    ProfileStateEvent,
    ProfileStateEventFilter,
    UpsertProfileStateEntryInput,
} from "./profile-state-types.js";
import {
    buildManagedMemoryTreeNodeCooldownUntilMetaKey,
    buildManagedMemoryTreeNodeFailureCountMetaKey,
    buildManagedMemoryTreeNodeLastErrorMetaKey,
    buildManagedMemoryTreeNodeLastFailureAtMetaKey,
    buildManagedMemoryTreeNodeLastMemorySeqMetaKey,
    buildManagedMemoryTreeNodeLastRebuiltAtMetaKey,
    buildManagedMemoryTreeNodeLastTaskSeqMetaKey,
    buildMemoryTreeLifecycleGovernanceState,
    buildManagedMemoryTreeNodeLifecycleState,
    buildMemoryTreeSourcesCooldownUntilMetaKey,
    buildMemoryTreeSourcesFailureCountMetaKey,
    buildMemoryTreeSourcesLastErrorMetaKey,
    buildMemoryTreeSourcesLastFailureAtMetaKey,
    buildMemoryTreeSourceLifecycleState,
    buildMemoryTreeSourcesLastMemorySeqMetaKey,
    isManagedMemoryTreeNodeKind,
    resolveMemoryTreeLifecycleFailureCooldownMs,
    resolveManagedMemoryTreeNodeKinds,
    type ManagedMemoryTreeNodeKind,
    type MemoryTreeLifecycleGovernanceState,
    type MemoryTreeNodeLifecycleState,
    type MemoryTreeSourceLifecycleState,
} from "./memory-tree-lifecycle.js";
import {
    buildMemoryTreeJobReport,
    type MemoryTreeJobReport,
} from "./memory-tree-job-report.js";
import {
    listMemoryTreeJobLedgerRecords,
    recordMemoryTreeJobLedgerFailure,
    recordMemoryTreeJobLedgerSkip,
    recordMemoryTreeJobLedgerSuccess,
} from "./memory-tree-job-ledger.js";
import { claimMemoryTreeJobRun } from "./memory-tree-job-control.js";
import { MemoryTreeRefreshQueue } from "./memory-tree-refresh-queue.js";
import {
    buildMemoryTreeLifecycleReport,
    type MemoryTreeLifecycleReport,
} from "./memory-tree-lifecycle-report.js";
import {
    applyMemoryTreeNodeRoutingBoost,
    resolveMemoryTreeNodeRoutingPlan,
} from "./memory-tree-node-intent.js";
import { buildMemoryTreeNodeAnswerStrategy, type MemoryTreeNodeAnswerStage } from "./memory-tree-node-answer-sufficiency.js";
import {
    buildMemorySourceInventoryReport,
    type MemorySourceInventoryClass,
    type MemorySourceInventoryConfiguredSource,
    type MemorySourceInventoryItem,
    type MemorySourceInventoryReport,
} from "./memory-source-inventory.js";
import { buildMemorySourceInventoryGovernanceSummary } from "./memory-source-inventory-governance.js";
import {
    buildMemoryExactDedupGovernanceSummary,
    decorateMemoryExactDedupReportWithGovernance,
} from "./memory-dedup-governance.js";
import {
    buildExternalMemoryIngestGovernanceSummary,
    type ExternalMemoryIngestGovernanceIndexedSource,
} from "./external-memory-ingest-governance.js";
import {
    classifyMemorySource,
    isMemorySourceSearchPolicy,
    resolveMemorySourceAdmission,
    resolveMemorySourceIdentity,
} from "./memory-source-registry.js";
import {
    annotateExternalIngestPreviewRescan,
    materializeObsidianMarkdownChunks,
    previewMarkdownFileIngest,
    previewObsidianMarkdownDirectoryIngest,
    type ExternalMemoryIngestPreview,
} from "./external-memory-ingest.js";
import type {
    MemoryTreeScoreListFilter,
    MemoryTreeScoreRecord,
    MemoryTreeScoreRebuildResult,
    MemoryTreeEdgeListFilter,
    MemoryTreeEdgeRecord,
    MemoryTreeNodeKind,
    MemoryTreeNodeDetailResult,
    MemoryTreeNodeListFilter,
    MemoryTreeNodeRebuildResult,
    MemoryTreeNodeRecord,
    MemoryTreeNodeSearchResult,
    MemoryTreeReportApplyResult,
    MemoryTreeReportListFilter,
    MemoryTreeReportPersistResult,
    MemoryTreeReportRecord,
    MemoryTreeReportReviewDecision,
    MemoryTreeReportReviewResult,
    MemoryTreeReportStatus,
    MemoryTreeReportType,
    MemoryTreeSourceListFilter,
    MemoryTreeSourceRecord,
    MemoryTreeSourceRebuildResult,
} from "./memory-tree-types.js";
import {
    BackgroundAbortRegistry,
    BackgroundPauseGate,
    throwIfBackgroundAborted,
} from "./background-job-control.js";
import { renderDurableExtractionMessages } from "./durable-extraction-input.js";
import { requestMemoryChunkSummaryModel } from "./memory-chunk-summary-model-request.js";
import { requestMemoryEvolutionModel } from "./memory-evolution-model-request.js";
import type { MemoryModelPrivacyRuntime } from "./memory-model-privacy.js";
import type {
    TaskActivityRecord,
    TaskConversationStore,
    TaskDerivedDetail,
    TaskMemoryRelation,
    TaskRecord,
    TaskSearchFilter,
    TaskSearchOptions,
    TaskSource,
    TaskToolCallSummary,
} from "./task-types.js";
import type {
    ExperienceAssetType,
    ExperienceCandidate,
    ExperienceCandidateMetadata,
    ExperienceCandidateStats,
    ExperienceCandidateType,
    ExperienceCandidateListFilter,
    ExperiencePromoteResult,
    ExperienceSynthesisPreviewResult,
    ExperienceUsage,
    ExperienceUsageListFilter,
    ExperienceUsageRecordResult,
    ExperienceUsageStats,
    ExperienceUsageVia,
    TaskExperienceDetail,
} from "./experience-types.js";
import {
    appendMethodFilenameRevision,
    buildExperienceMethodFilenameBase,
    validateMethodCandidateDraftForPublish,
} from "./experience-publish-rules.js";
import { appendToTodayMemory } from "./memory-files.js";
import type {
    MemoryDedupGroupSourceIndexSummary,
    MemoryDedupSourceIndexInfo,
    MemoryDedupSourceIndexScope,
    MemoryDedupSourceIndexSummary,
    MemoryExactDedupApplyOptions,
    MemoryExactDedupApplyResult,
    MemoryExactDedupPreviewReport,
} from "./memory-dedup.js";
import {
    buildMemoryVacuumWarnings,
    type MemoryVacuumApplyOptions,
    type MemoryVacuumApplyResult,
    type MemoryVacuumPreviewReport,
} from "./memory-vacuum.js";
import type { DurableExtractionSkipReasonCode } from "./durable-extraction-policy.js";
import { resolveStateDir, resolveWorkspaceStateDir } from "./protocol/index.js";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

const MEMORY_TREE_SCORE_VERSION = "v1_rule_only";
const MEMORY_TREE_SEARCH_RETRIEVAL_WEIGHT = 0.6;
const MEMORY_TREE_SEARCH_GOVERNANCE_WEIGHT = 0.4;
let hasLoggedMissingEmbeddingApiKeyNotice = false;

function logMissingEmbeddingApiKeyNotice(): void {
    if (hasLoggedMissingEmbeddingApiKeyNotice) {
        return;
    }
    hasLoggedMissingEmbeddingApiKeyNotice = true;
    console.log("[MemoryManager] No API key for embedding — vector search disabled. Configure via WebChat settings if needed.");
}

function hasExplicitRemoteEmbeddingConfig(options: MemoryManagerOptions): boolean {
    return options.provider === "openai"
        || (typeof options.openaiModel === "string" && options.openaiModel.trim().length > 0)
        || (typeof options.openaiBaseUrl === "string" && options.openaiBaseUrl.trim().length > 0);
}

// ============================================================================
// Global Registry - Allows sharing MemoryManager across packages
// ============================================================================

let globalMemoryManager: MemoryManager | null = null;
const scopedGlobalMemoryManagersByAgent = new Map<string, MemoryManager>();
const scopedGlobalMemoryManagersByWorkspace = new Map<string, MemoryManager>();
type GlobalMemoryManagerLazyRegistration = {
    resolver: () => MemoryManager | null | undefined;
    options: GlobalMemoryManagerRegistrationOptions;
};
const lazyScopedGlobalMemoryManagersByAgent = new Map<string, GlobalMemoryManagerLazyRegistration>();
const lazyScopedGlobalMemoryManagersByWorkspace = new Map<string, GlobalMemoryManagerLazyRegistration>();

export type GlobalMemoryManagerRegistrationOptions = {
    agentId?: string;
    workspaceRoot?: string;
    isDefault?: boolean;
};

export type GlobalMemoryManagerScope = {
    agentId?: string;
    conversationId?: string;
    workspaceRoot?: string;
};

function normalizeGlobalMemoryAgentId(agentId?: string): string | undefined {
    if (typeof agentId !== "string") return undefined;
    const trimmed = agentId.trim();
    return trimmed ? trimmed : undefined;
}

function normalizeGlobalMemoryWorkspaceRoot(workspaceRoot?: string): string | undefined {
    if (typeof workspaceRoot !== "string") return undefined;
    const trimmed = workspaceRoot.trim();
    return trimmed ? path.resolve(trimmed) : undefined;
}

function parseResidentAgentIdFromConversationId(conversationId?: string): string | undefined {
    if (typeof conversationId !== "string") return undefined;
    const trimmed = conversationId.trim();
    if (!trimmed) return undefined;
    const match = /^agent:([^:]+):/.exec(trimmed);
    return match?.[1];
}

/**
 * Register a MemoryManager instance as the global shared instance.
 * Called by Gateway during startup.
 */
export function registerGlobalMemoryManager(
    manager: MemoryManager,
    options: GlobalMemoryManagerRegistrationOptions = {},
): void {
    registerGlobalMemoryManagerInternal(manager, options);
}

export function registerGlobalMemoryManagerResolver(
    resolver: () => MemoryManager | null | undefined,
    options: GlobalMemoryManagerRegistrationOptions = {},
): void {
    registerGlobalMemoryManagerResolverInternal(resolver, options);
}

/**
 * Get the globally registered MemoryManager instance.
 * Returns null if no instance has been registered.
 */
export function getGlobalMemoryManager(scope?: GlobalMemoryManagerScope): MemoryManager | null {
    const agentId = normalizeGlobalMemoryAgentId(scope?.agentId)
        ?? parseResidentAgentIdFromConversationId(scope?.conversationId);
    if (agentId) {
        const scoped = scopedGlobalMemoryManagersByAgent.get(agentId);
        if (scoped) {
            void scoped.startLazyIndexing();
            return scoped;
        }
        const lazyScoped = lazyScopedGlobalMemoryManagersByAgent.get(agentId);
        if (lazyScoped) {
            const resolved = resolveLazyGlobalMemoryManager(lazyScoped);
            if (resolved) {
                void resolved.startLazyIndexing();
                return resolved;
            }
        }
    }

    const workspaceRoot = normalizeGlobalMemoryWorkspaceRoot(scope?.workspaceRoot);
    if (workspaceRoot) {
        const scoped = scopedGlobalMemoryManagersByWorkspace.get(workspaceRoot);
        if (scoped) {
            void scoped.startLazyIndexing();
            return scoped;
        }
        const lazyScoped = lazyScopedGlobalMemoryManagersByWorkspace.get(workspaceRoot);
        if (lazyScoped) {
            const resolved = resolveLazyGlobalMemoryManager(lazyScoped);
            if (resolved) {
                void resolved.startLazyIndexing();
                return resolved;
            }
        }
    }

    if (globalMemoryManager) {
        void globalMemoryManager.startLazyIndexing();
    }
    return globalMemoryManager;
}

export function listGlobalMemoryManagers(): MemoryManager[] {
    const ordered = [
        globalMemoryManager,
        ...scopedGlobalMemoryManagersByAgent.values(),
        ...scopedGlobalMemoryManagersByWorkspace.values(),
    ].filter((item): item is MemoryManager => Boolean(item));
    return [...new Set(ordered)];
}

export function resetGlobalMemoryManagers(): void {
    globalMemoryManager = null;
    scopedGlobalMemoryManagersByAgent.clear();
    scopedGlobalMemoryManagersByWorkspace.clear();
    lazyScopedGlobalMemoryManagersByAgent.clear();
    lazyScopedGlobalMemoryManagersByWorkspace.clear();
}

function registerGlobalMemoryManagerResolverInternal(
    resolver: () => MemoryManager | null | undefined,
    options: GlobalMemoryManagerRegistrationOptions = {},
): void {
    const entry: GlobalMemoryManagerLazyRegistration = { resolver, options };
    const normalizedAgentId = normalizeGlobalMemoryAgentId(options.agentId);
    const normalizedWorkspaceRoot = normalizeGlobalMemoryWorkspaceRoot(options.workspaceRoot);
    if (normalizedAgentId) {
        lazyScopedGlobalMemoryManagersByAgent.set(normalizedAgentId, entry);
    }
    if (normalizedWorkspaceRoot) {
        lazyScopedGlobalMemoryManagersByWorkspace.set(normalizedWorkspaceRoot, entry);
    }
}

function deleteLazyGlobalMemoryManagerRegistration(options: GlobalMemoryManagerRegistrationOptions = {}): void {
    const normalizedAgentId = normalizeGlobalMemoryAgentId(options.agentId);
    const normalizedWorkspaceRoot = normalizeGlobalMemoryWorkspaceRoot(options.workspaceRoot);
    if (normalizedAgentId) {
        lazyScopedGlobalMemoryManagersByAgent.delete(normalizedAgentId);
    }
    if (normalizedWorkspaceRoot) {
        lazyScopedGlobalMemoryManagersByWorkspace.delete(normalizedWorkspaceRoot);
    }
}

function resolveLazyGlobalMemoryManager(entry: GlobalMemoryManagerLazyRegistration): MemoryManager | null {
    deleteLazyGlobalMemoryManagerRegistration(entry.options);
    const manager = entry.resolver();
    if (!manager) {
        return null;
    }
    registerGlobalMemoryManagerInternal(manager, entry.options);
    return manager;
}

function registerGlobalMemoryManagerInternal(
    manager: MemoryManager,
    options: GlobalMemoryManagerRegistrationOptions = {},
): void {
    deleteLazyGlobalMemoryManagerRegistration(options);
    const normalizedAgentId = normalizeGlobalMemoryAgentId(options.agentId);
    const normalizedWorkspaceRoot = normalizeGlobalMemoryWorkspaceRoot(options.workspaceRoot);
    const hasScopedRegistration = Boolean(normalizedAgentId || normalizedWorkspaceRoot);

    if (!hasScopedRegistration) {
        scopedGlobalMemoryManagersByAgent.clear();
        scopedGlobalMemoryManagersByWorkspace.clear();
    }

    if (options.isDefault === true || !hasScopedRegistration || !globalMemoryManager) {
        globalMemoryManager = manager;
    }
    if (normalizedAgentId) {
        scopedGlobalMemoryManagersByAgent.set(normalizedAgentId, manager);
    }
    if (normalizedWorkspaceRoot) {
        scopedGlobalMemoryManagersByWorkspace.set(normalizedWorkspaceRoot, manager);
    }

    const scopeLabels = [
        normalizedAgentId ? `agent=${normalizedAgentId}` : undefined,
        normalizedWorkspaceRoot ? `workspace=${normalizedWorkspaceRoot}` : undefined,
        options.isDefault === true ? "default=true" : undefined,
    ].filter(Boolean);
    console.log(`[MemoryManager] Registered as global instance${scopeLabels.length > 0 ? ` (${scopeLabels.join(", ")})` : ""}`);
}

export type ExtractConversationMemoriesOptions = {
    markKey?: string;
    sourceConversationId?: string;
    sourceLabel?: string;
    signal?: AbortSignal;
};

export type ConversationMemoryExtractionSupportReasonCode =
    | "manager_unavailable"
    | "gate_disabled"
    | "model_missing"
    | "base_url_missing"
    | "api_key_missing";

export type ConversationMemoryExtractionSupportReason = {
    code: ConversationMemoryExtractionSupportReasonCode;
    message: string;
};

export type ConversationMemoryExtractionSupport = {
    enabled: boolean;
    available: boolean;
    minMessages: number;
    model?: string;
    hasBaseUrl: boolean;
    hasApiKey: boolean;
    reasons: ConversationMemoryExtractionSupportReason[];
};

export type DurableMemoryCandidateType =
    | "user"
    | "feedback"
    | "project"
    | "reference";

export type DurableMemoryRejectionReasonCode =
    | "code_pattern"
    | "file_path"
    | "git_history"
    | "debug_recipe"
    | "policy_rule";

export type DurableMemoryGuidance = {
    policyVersion: string;
    acceptedCandidateTypes: DurableMemoryCandidateType[];
    rejectedContentTypes: Array<{
        code: DurableMemoryRejectionReasonCode;
        message: string;
    }>;
    summary: string;
};

export type ExtractConversationMemoriesResult = {
    count: number;
    acceptedCandidateTypes: DurableMemoryCandidateType[];
    rejectedCount: number;
    rejectedReasons: DurableMemoryRejectionReasonCode[];
    summary: string;
    skipReason?: DurableExtractionSkipReasonCode | string;
};

type ExtractedConversationMemory = {
    type: string;
    content: string;
    category: string;
    candidateType?: DurableMemoryCandidateType;
    reason?: string;
    profilePath?: string;
    profileValue?: unknown;
};

const DURABLE_MEMORY_GUIDANCE: DurableMemoryGuidance = {
    policyVersion: "week9-v1",
    acceptedCandidateTypes: ["user", "feedback", "project", "reference"],
    rejectedContentTypes: [
        { code: "code_pattern", message: "Reject code patterns, architecture snippets, or implementation-shaped content." },
        { code: "file_path", message: "Reject file paths, function names, line references, and project structure details." },
        { code: "git_history", message: "Reject git history, recent diffs, commit references, and transient change logs." },
        { code: "debug_recipe", message: "Reject debugging recipes, shell command playbooks, and short-lived fix procedures." },
        { code: "policy_rule", message: "Reject stable rules already covered by AGENTS.md, CLAUDE.md, README, or other project policy docs." },
    ],
    summary: "Durable extraction should keep only long-lived user/context/project/reference facts and avoid code details, paths, git churn, debugging recipes, and policy docs.",
};

const DURABLE_MEMORY_CATEGORY_TO_CANDIDATE: Record<string, DurableMemoryCandidateType> = {
    preference: "user",
    experience: "feedback",
    fact: "project",
    decision: "project",
    entity: "reference",
};

function normalizeDurableMemoryCandidateType(value: unknown): DurableMemoryCandidateType | undefined {
    switch (value) {
        case "user":
        case "feedback":
        case "project":
        case "reference":
            return value;
        default:
            return undefined;
    }
}

function inferDurableMemoryCandidateType(item: { category?: string; content: string }): DurableMemoryCandidateType {
    const normalizedCategory = typeof item.category === "string" ? item.category.trim().toLowerCase() : "";
    const fromCategory = DURABLE_MEMORY_CATEGORY_TO_CANDIDATE[normalizedCategory];
    if (fromCategory) {
        return fromCategory;
    }
    const content = item.content.trim();
    if (/(反馈|建议|希望|不喜欢|prefer|feedback)/i.test(content)) {
        return "feedback";
    }
    if (/(用户|习惯|偏好|工作方式|长期)/i.test(content)) {
        return "user";
    }
    if (/(项目|约束|决策|阶段|里程碑|依赖|环境)/i.test(content)) {
        return "project";
    }
    return "reference";
}

function detectDurableMemoryRejection(content: string): { code: DurableMemoryRejectionReasonCode; message: string } | undefined {
    if (/[A-Za-z]:\\|(?:^|[\s(])(?:\.{0,2}[\\/])?[\w.-]+(?:[\\/][\w.-]+)+|\b[\w./\\-]+\.(?:ts|tsx|js|jsx|py|go|java|cs|json|md|yaml|yml|sh|ps1|sql)(?::\d+)?\b/.test(content)) {
        return { code: "file_path", message: "Looks like a file path, source location, or project structure detail." };
    }
    if (/\bgit\s+(?:commit|rebase|cherry-pick|merge|reset|checkout|stash|pull|push|log|diff|status)\b/i.test(content)
        || /\bcommit\b.{0,20}\b[0-9a-f]{7,40}\b/i.test(content)
        || /\bPR\s*#\d+\b/i.test(content)) {
        return { code: "git_history", message: "Looks like git history or recent change tracking." };
    }
    if (/\b(?:AGENTS\.md|CLAUDE\.md|README|项目规范|规范文件|coding standard|project policy)\b/i.test(content)) {
        return { code: "policy_rule", message: "Looks like a stable project rule already represented in policy docs." };
    }
    if ((/\b(?:debug|调试|排查|修复|fix|workaround|命令|command)\b/i.test(content))
        && (/[`]/.test(content) || /\b(?:pnpm|npm|yarn|node|python|git|cargo|go|curl|powershell)\b/i.test(content))) {
        return { code: "debug_recipe", message: "Looks like a debugging or command recipe rather than durable context." };
    }
    if (/[`]/.test(content)
        || /\b(?:const|let|var|function|class|interface|type|return|import|export)\b/.test(content)
        || /=>/.test(content)
        || /[{}[\]]/.test(content)) {
        return { code: "code_pattern", message: "Looks like code or implementation detail rather than durable memory." };
    }
    return undefined;
}

function sanitizeExtractionJsonText(raw: string): string {
    return raw
        .replace(/^(?:<think\b[^>]*>[\s\S]*?<\/think>\s*)+/i, "")
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
}

function shouldEnableMiniMaxReasoningSplit(baseUrl: string, model: string): boolean {
    const normalizedBaseUrl = String(baseUrl ?? "").trim().toLowerCase();
    const normalizedModel = String(model ?? "").trim().toLowerCase();
    return normalizedBaseUrl.includes("minimaxi.com") || normalizedModel.startsWith("minimax-");
}

function buildDurableExtractionSummary(input: {
    acceptedCount: number;
    acceptedCandidateTypes: DurableMemoryCandidateType[];
    rejected: Array<{ code: DurableMemoryRejectionReasonCode }>;
}): string {
    const acceptedTypes = [...new Set(input.acceptedCandidateTypes)];
    const rejectedReasons = [...new Set(input.rejected.map((item) => item.code))];
    const parts: string[] = [];
    parts.push(`accepted=${input.acceptedCount}`);
    if (acceptedTypes.length > 0) {
        parts.push(`candidateTypes=${acceptedTypes.join(",")}`);
    }
    if (input.rejected.length > 0) {
        parts.push(`rejected=${input.rejected.length}`);
    }
    if (rejectedReasons.length > 0) {
        parts.push(`rejectedReasons=${rejectedReasons.join(",")}`);
    }
    return parts.join("; ");
}

export type MemorySearchStageTopHit = {
    id: string;
    score: number;
    sourceClass: MemorySourceInventoryClass | "unknown";
};

export type MemorySearchStageSnapshot = {
    count: number;
    topHits: MemorySearchStageTopHit[];
};

export type MemorySearchNodeAssistedHit = {
    nodeId: string;
    kind: MemoryTreeNodeKind;
    score: number;
    chunkCount: number;
    matchReasons: string[];
};

export type MemorySearchNodeAssistedDiagnostics = {
    enabled: boolean;
    policy: MemorySearchRoutingPolicy;
    routeClass?: string;
    routeReasons?: string[];
    routedKinds?: MemoryTreeNodeKind[];
    preferHighLevel?: boolean;
    chunkLimitPerNode?: number;
    answerSufficient?: boolean;
    evidenceExpanded?: boolean;
    evidenceChunkCount?: number;
    highLevelOnly?: boolean;
    selectedNodeIds?: string[];
    nodeHitCount: number;
    injectedChunkCount: number;
    fallbackApplied: boolean;
    returnedMix: {
        nodeBacked: number;
        chunkOnly: number;
    };
    nodeBackedShare: number;
    chunkOnlyShare: number;
    topNodeHits: MemorySearchNodeAssistedHit[];
    treeFreshness?: {
        stale: boolean;
        refreshScheduled: boolean;
        dirtyKinds: ManagedMemoryTreeNodeKind[];
        oldestRebuiltAt?: string;
    };
};

export type MemorySearchDiagnostics = {
    retrievalMode: "explicit" | "implicit";
    limit: number;
    routingPolicy: MemorySearchRoutingPolicy;
    skipped: boolean;
    skipReason?: string;
    deadlineExceeded?: boolean;
    embeddingFallbackReason?: "deadline" | "error";
    deepRetrievalApplied: boolean;
    scoreSignalAppliedCount: number;
    sourceClassMix: Record<string, number>;
    nodeAssisted: MemorySearchNodeAssistedDiagnostics;
    derived?: {
        session: DerivedRetrievalReport;
        task: DerivedRetrievalReport;
        experience: DerivedRetrievalReport;
    };
    stages: {
        raw: MemorySearchStageSnapshot;
        scoreAware: MemorySearchStageSnapshot;
        reranked: MemorySearchStageSnapshot;
        returned: MemorySearchStageSnapshot;
    };
};

export type MemorySearchExecution = {
    items: MemorySearchResult[];
    diagnostics: MemorySearchDiagnostics;
};

export interface MemoryManagerOptions {
    workspaceRoot: string;
    /** Additional directories to index alongside workspaceRoot */
    additionalRoots?: string[];
    /** Additional explicit files to index/watch alongside directories */
    additionalFiles?: string[];
    storePath?: string;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    openaiModel?: string;
    embeddingEnabled?: boolean;
    provider?: "openai" | "local";
    localModel?: string;
    modelsDir?: string;
    indexerOptions?: IndexerOptions;
    embeddingBatchSize?: number;
    rerankerOptions?: RerankerOptions;
    /** L0 摘要层配置 */
    summaryEnabled?: boolean;
    summaryModel?: string;       // 摘要生成用的模型（默认继承 openaiModel）
    summaryBaseUrl?: string;     // 摘要 API base URL（默认继承 openaiBaseUrl）
    summaryApiKey?: string;      // 摘要 API key（默认继承 openaiApiKey）
    summaryBatchSize?: number;   // 每批处理的 chunk 数（默认 5）
    summaryMinContentLength?: number; // 触发摘要的最小内容长度（默认 500）
    /** M-N3: 会话记忆自动提取配置 */
    evolutionEnabled?: boolean;
    evolutionModel?: string;       // 提取用的模型（默认继承 openaiModel）
    evolutionBaseUrl?: string;     // 提取 API base URL（默认继承 openaiBaseUrl）
    evolutionApiKey?: string;      // 提取 API key（默认继承 openaiApiKey）
    evolutionMinMessages?: number; // 触发提取的最少消息数（默认 4）
    evolutionTimeoutMs?: number;   // 单次提取远端调用硬 deadline（默认 120 秒）
    modelPrivacyRuntime?: MemoryModelPrivacyRuntime;
    /** stateDir 用于定位 memory/ 目录写入每日文件 */
    stateDir?: string;
    /** Task-aware Embedding 前缀（用于支持 task 参数的模型如 Jina/BGE） */
    embeddingQueryPrefix?: string;
    embeddingPassagePrefix?: string;
    /** M-N4: 源路径聚合检索 */
    deepRetrievalEnabled?: boolean;
    /** R2: node-assisted retrieval routing */
    nodeAssistedRetrievalEnabled?: boolean;
    /** Task 层总结 */
    taskMemoryEnabled?: boolean;
    taskSummaryEnabled?: boolean;
    taskSummaryModel?: string;
    taskSummaryBaseUrl?: string;
    taskSummaryApiKey?: string;
    taskSummaryMinDurationMs?: number;
    taskSummaryMinToolCalls?: number;
    taskSummaryMinTokenTotal?: number;
    conversationStore?: TaskConversationStore;
    /** Host 按当前 Memory state root 提供的只读 session artifact inventory。 */
    sessionArtifactInventory?: SessionArtifactInventoryProvider;
    /** P5: Task 完成后自动生成经验候选（只落到 experience_candidates） */
    experienceAutoPromotionEnabled?: boolean;
    experienceAutoMethodEnabled?: boolean;
    experienceAutoSkillEnabled?: boolean;
}

export type ContextInjectionMemory = MemorySearchResult & {
    importance: MemoryImportance;
    importanceScore: number;
    rationale: string[];
};

export type RecentTaskSummary = {
    taskId: string;
    title?: string;
    objective?: string;
    summary?: string;
    status: TaskRecord["status"];
    source: TaskRecord["source"];
    finishedAt?: string;
    updatedAt?: string;
    agentId?: string;
    toolNames: string[];
    artifactPaths: string[];
    workRecap?: TaskRecord["workRecap"];
    resumeContext?: TaskRecord["resumeContext"];
};

export type TaskWorkShortcutItem = {
    taskId: string;
    conversationId: string;
    title?: string;
    objective?: string;
    summary?: string;
    status: TaskRecord["status"];
    source: TaskRecord["source"];
    startedAt: string;
    finishedAt?: string;
    updatedAt: string;
    agentId?: string;
    toolNames: string[];
    artifactPaths: string[];
    workRecap?: TaskRecord["workRecap"];
    resumeContext?: TaskRecord["resumeContext"];
    recentActivityTitles: string[];
    matchReasons?: string[];
};

function toRecentTaskSummary(task: TaskSummaryRecord): RecentTaskSummary {
    return {
        taskId: task.id,
        title: task.title,
        objective: task.objective,
        summary: task.summary,
        status: task.status,
        source: task.source,
        finishedAt: task.finishedAt,
        updatedAt: task.updatedAt,
        agentId: task.agentId,
        toolNames: task.toolNames,
        artifactPaths: task.artifactPaths,
        workRecap: task.workRecap,
        resumeContext: task.resumeContext,
    };
}

export class MemoryManager {
    private store: MemoryStore;
    private readonly embeddingFailureLedger: EmbeddingFailureLedger;
    private indexer: MemoryIndexer;
    private indexCoordinator: IndexCoordinator;
    private readonly memoryTreeRefreshQueue: MemoryTreeRefreshQueue;
    private readonly queryEmbeddingCache: QueryEmbeddingCache;
    private reranker: ResultReranker;
    private embeddingProvider: EmbeddingProvider;
    private workspaceRoot: string;
    private additionalRoots: string[];
    private additionalFiles: string[];
    private embeddingBatchSize: number;
    // 后台任务暂停控制（Agent 活跃时暂停，避免抢占 API 并发）
    private readonly backgroundPauseGate = new BackgroundPauseGate();
    private readonly evolutionRequests = new BackgroundAbortRegistry();
    private _summaryRunning = false;
    // L0 摘要层
    private summaryEnabled: boolean;
    private summaryModel: string;
    private summaryBaseUrl: string;
    private summaryApiKey: string;
    private summaryBatchSize: number;
    private summaryMinContentLength: number;
    private readonly inFlightOperations = new Set<Promise<unknown>>();
    private closed = false;
    private closePromise: Promise<void> | null = null;
    // M-N3: 会话记忆自动提取
    private evolutionEnabled: boolean;
    private evolutionModel: string;
    private evolutionBaseUrl: string;
    private evolutionApiKey: string;
    private evolutionMinMessages: number;
    private evolutionTimeoutMs: number;
    private readonly modelPrivacyRuntime?: MemoryModelPrivacyRuntime;
    private stateDir: string;
    /** 用于 embedding 缓存 key / 签名版本化（task-aware embedding） */
    private embeddingQueryPrefix: string;
    private embeddingPassagePrefix: string;
    // M-N4: 源路径聚合检索
    private deepRetrievalEnabled: boolean;
    private nodeAssistedRetrievalEnabled: boolean;
    private taskProcessor: TaskProcessor;
    private experiencePromoter: ExperiencePromoter;
    private experienceAutoPromotionEnabled: boolean;
    private experienceAutoMethodEnabled: boolean;
    private experienceAutoSkillEnabled: boolean;
    private publishStateDir: string;
    private readonly sessionArtifactInventory?: SessionArtifactInventoryProvider;
    private latestDerivedRetrievalSnapshot?: DerivedRetrievalRuntimeSnapshot;

    private logEmbeddingSyncSummary(stats: {
        batchCount: number;
        totalChunks: number;
        writtenChunks: number;
        failedChunks: number;
        cacheHits: number;
        cacheMisses: number;
        apiRequestCount: number;
        apiChunkCount: number;
    }): void {
        if (stats.batchCount <= 0 || stats.totalChunks <= 0) return;
        console.log(
            `[MemoryManager] Embedding sync processed ${stats.totalChunks} chunks in ${stats.batchCount} batch(es): `
            + `selected=${stats.totalChunks}, written=${stats.writtenChunks}, failed=${stats.failedChunks}, `
            + `cacheHits=${stats.cacheHits}, cacheMisses=${stats.cacheMisses}, `
            + `apiRequests=${stats.apiRequestCount}, apiChunks=${stats.apiChunkCount}`,
        );
    }

    constructor(options: MemoryManagerOptions) {
        this.workspaceRoot = options.workspaceRoot;
        this.additionalRoots = options.additionalRoots ?? [];
        this.additionalFiles = options.additionalFiles ?? [];
        this.queryEmbeddingCache = new QueryEmbeddingCache();

        // Default store path: .star_sanctuary/memory.sqlite（带旧目录回退）
        const workspaceStateDir = resolveWorkspaceStateDir(options.workspaceRoot);
        const defaultStorePath = path.join(workspaceStateDir, "memory.sqlite");
        const storePath = options.storePath || defaultStorePath;

        // Ensure dir exists synchronously
        try {
            const dir = path.dirname(storePath);
            mkdirSync(dir, { recursive: true });
        } catch (err) {
            console.warn("Failed to create memory directory:", err);
        }

        this.store = new MemoryStore(storePath);
        this.embeddingFailureLedger = new EmbeddingFailureLedger(this.store.getDbHandleForSharedSchema());

        // Initialize Embedding Provider
        if (options.embeddingEnabled === false) {
            this.embeddingProvider = {
                modelName: "none",
                embed: async () => [],
                embedBatch: async (texts) => texts.map(() => []),
            };
            console.log("[MemoryManager] Embedding disabled by config — using keyword search only.");
        } else if (options.provider === "local") {
            const modelName = options.localModel || DEFAULT_LOCAL_EMBEDDING_MODEL;
            const modelsDir = options.modelsDir || path.join(workspaceStateDir, "models");
            this.embeddingProvider = new LocalEmbeddingProvider(modelName, modelsDir);
            console.log(`[MemoryManager] Using Local Embedding Provider (${modelName})`);
        } else if (options.openaiApiKey) {
            // 仅在 API Key 存在时才初始化 OpenAI Provider，避免 SDK 构造时因缺少 Key 而抛出异常
            this.embeddingProvider = new OpenAIEmbeddingProvider({
                apiKey: options.openaiApiKey,
                baseURL: options.openaiBaseUrl,
                model: options.openaiModel,
                queryPrefix: options.embeddingQueryPrefix,
                passagePrefix: options.embeddingPassagePrefix,
            });
            console.log(`[MemoryManager] Using OpenAI Embedding Provider (${options.openaiModel || "text-embedding-3-small"})`);
        } else {
            // API Key 缺失时使用空 Provider，仅支持关键词检索，不影响正常启动
            this.embeddingProvider = {
                modelName: "none",
                embed: async () => [],
                embedBatch: async (texts) => texts.map(() => []),
            };
            if (hasExplicitRemoteEmbeddingConfig(options)) {
                logMissingEmbeddingApiKeyNotice();
            }
        }

        const indexerOptions = options.indexerOptions ?? {};
        this.indexCoordinator = new IndexCoordinator({
            runFullScan: (signal) => this.runIndexWorkspaceGeneration(signal),
            processWatchEvent: (event, signal) => this.indexer.processWatchEvent(event, signal),
            watchCoalesceMs: resolveWatchEventCoalesceMs(indexerOptions.watchDebounceMs),
            maxPendingWatchPaths: indexerOptions.watchMaxPendingPaths,
            maxConcurrentWatchEvents: indexerOptions.watchMaxConcurrentEvents,
            closeDrainTimeoutMs: indexerOptions.watchCloseDrainTimeoutMs,
            onWatchError: (event, error) => {
                console.error(`[WatcherFlushError] ${event.sourcePath}`, error);
            },
            onFullScanError: (error) => {
                console.error("[MemoryManager] Overflow rescan failed:", error);
            },
        });
        this.memoryTreeRefreshQueue = new MemoryTreeRefreshQueue({
            run: async ({ kinds, nodeLimit, triggerSource }) => {
                if (this.closed) return;
                await this.ensureManagedMemoryTreeFresh({
                    kinds,
                    nodeLimit,
                    rebuildSources: false,
                    triggerSource,
                });
            },
            onError: () => {
                // 失败细节由 lifecycle ledger 保存；请求路径只保留无内容的后台失败提示。
                console.warn("[MemoryManager] Background memory tree refresh failed.");
            },
        });
        this.indexer = new MemoryIndexer(this.store, indexerOptions, this.indexCoordinator);
        this.reranker = new ResultReranker(options.rerankerOptions);
        this.embeddingBatchSize = options.embeddingBatchSize || 10;

        // L0 摘要层配置
        this.summaryEnabled = options.summaryEnabled ?? false;
        this.summaryModel = options.summaryModel || options.openaiModel || "";
        this.summaryBaseUrl = options.summaryBaseUrl || options.openaiBaseUrl || "";
        this.summaryApiKey = options.summaryApiKey || options.openaiApiKey || "";
        this.summaryBatchSize = options.summaryBatchSize ?? 5;
        this.summaryMinContentLength = options.summaryMinContentLength ?? 500;
        this.modelPrivacyRuntime = options.modelPrivacyRuntime;
        if (this.summaryBaseUrl) {
            this.modelPrivacyRuntime?.registerEndpoint("idle_summary", this.summaryBaseUrl);
        }

        // M-N3: 会话记忆自动提取配置
        this.evolutionEnabled = options.evolutionEnabled ?? false;
        this.evolutionModel = options.evolutionModel || options.openaiModel || "";
        this.evolutionBaseUrl = options.evolutionBaseUrl || options.openaiBaseUrl || "";
        this.evolutionApiKey = options.evolutionApiKey || options.openaiApiKey || "";
        this.evolutionMinMessages = options.evolutionMinMessages ?? 4;
        this.evolutionTimeoutMs = typeof options.evolutionTimeoutMs === "number"
            && Number.isFinite(options.evolutionTimeoutMs)
            && options.evolutionTimeoutMs > 0
            ? Math.max(1, Math.floor(options.evolutionTimeoutMs))
            : 120_000;
        if (this.evolutionBaseUrl) {
            this.modelPrivacyRuntime?.registerEndpoint("durable_extraction", this.evolutionBaseUrl);
        }
        this.stateDir = options.stateDir || resolveStateDir(process.env);
        this.publishStateDir = options.stateDir || workspaceStateDir;
        this.sessionArtifactInventory = options.sessionArtifactInventory;
        this.embeddingQueryPrefix = options.embeddingQueryPrefix ?? "";
        this.embeddingPassagePrefix = options.embeddingPassagePrefix ?? "";
        this.deepRetrievalEnabled = options.deepRetrievalEnabled ?? false;
        this.nodeAssistedRetrievalEnabled = options.nodeAssistedRetrievalEnabled ?? false;
        const taskSummarizer = new TaskSummarizer({
            enabled: options.taskSummaryEnabled ?? false,
            model: options.taskSummaryModel,
            baseUrl: options.taskSummaryBaseUrl,
            apiKey: options.taskSummaryApiKey,
        });
        this.taskProcessor = new TaskProcessor(this.store, {
            enabled: options.taskMemoryEnabled ?? false,
            conversationStore: options.conversationStore,
            summarizer: taskSummarizer,
            summaryMinDurationMs: options.taskSummaryMinDurationMs,
            summaryMinToolCalls: options.taskSummaryMinToolCalls,
            summaryMinTokenTotal: options.taskSummaryMinTokenTotal,
        });
        this.experiencePromoter = new ExperiencePromoter(this.store, this.publishStateDir);
        this.experienceAutoPromotionEnabled = options.experienceAutoPromotionEnabled ?? true;
        this.experienceAutoMethodEnabled = options.experienceAutoMethodEnabled ?? true;
        this.experienceAutoSkillEnabled = options.experienceAutoSkillEnabled ?? true;
    }

    /**
     * Index files in the workspace
     */
    indexWorkspace(): Promise<void> {
        if (this.closed) {
            return this.closePromise ?? Promise.resolve();
        }
        return this.indexCoordinator.runFullScan();
    }

    private async runIndexWorkspaceGeneration(signal: AbortSignal): Promise<void> {
        if (this.closed || signal.aborted) return;
        const runBudget = this.indexer.beginFullScan();

        // Index primary workspace root
        await this.indexer.indexDirectory(this.workspaceRoot, this.workspaceRoot, signal, runBudget);
        if (this.closed || signal.aborted) {
            return;
        }

        // Index additional roots (e.g. workspace memory files)
        for (const root of this.additionalRoots) {
            if (this.closed || signal.aborted) {
                return;
            }
            try {
                await this.indexer.indexDirectory(root, root, signal, runBudget);
            } catch (err) {
                const code = (err as NodeJS.ErrnoException | undefined)?.code;
                if (!signal.aborted && code !== "ENOENT") {
                    console.warn(`[MemoryManager] Failed to index additional root ${root}:`, err);
                }
            }
        }

        // Index explicit files (e.g. stateDir/MEMORY.md)
        for (const filePath of this.additionalFiles) {
            if (this.closed || signal.aborted) {
                return;
            }
            try {
                const stats = await fs.stat(filePath);
                if (stats.isFile() && !signal.aborted) {
                    await this.indexer.indexFile(filePath, signal, runBudget);
                }
            } catch (err) {
                const code = (err as NodeJS.ErrnoException | undefined)?.code;
                if (!signal.aborted && code !== "ENOENT") {
                    console.warn(`[MemoryManager] Failed to index additional file ${filePath}:`, err);
                }
            }
        }

        if (this.closed || signal.aborted) {
            return;
        }
        const runResult = this.indexer.finishFullScan(runBudget);
        if (runResult.deferred) {
            console.warn(
                `[MemoryManager] Index byte budget exhausted after ${runResult.consumedBytes} bytes; `
                + "remaining files are deferred to the next full-scan generation.",
            );
        }
        await this.processPendingEmbeddings(signal);
        if (this.closed || signal.aborted) {
            return;
        }

        // L0 摘要不再在启动时自动运行，改由 gateway 空闲定时器触发（runIdleSummaries）

        // Watch all directories for changes
        const allRoots = dedupePaths([this.workspaceRoot, ...this.additionalRoots, ...this.additionalFiles]);
        await this.indexer.startWatching(allRoots);
    }

    /**
     * Start workspace indexing once in the background.
     * Useful for lazy startup paths where the manager should not block first paint.
     */
    startLazyIndexing(): Promise<void> {
        if (this.closed) {
            return this.closePromise ?? Promise.resolve();
        }
        return this.indexCoordinator.runFullScan();
    }

    /**
     * Search memory (Hybrid)
     */
    async search(query: string, limitOrOptions?: number | MemorySearchOptions): Promise<MemorySearchResult[]> {
        return (await this.searchWithDiagnostics(query, limitOrOptions)).items;
    }

    async searchWithDiagnostics(query: string, limitOrOptions?: number | MemorySearchOptions): Promise<MemorySearchExecution> {
        // 兼容旧签名 search(query, limit) 和新签名 search(query, options)
        let limit = 5;
        let filter: MemorySearchFilter | undefined;
        let retrievalMode: MemorySearchOptions["retrievalMode"] = "explicit";
        let routingPolicy: MemorySearchRoutingPolicy = this.nodeAssistedRetrievalEnabled ? "node_assisted" : "chunk_only";
        let includeContent = true;
        let signal: AbortSignal | undefined;
        let deadlineMs: number | undefined;

        if (typeof limitOrOptions === "number") {
            limit = limitOrOptions;
        } else if (limitOrOptions) {
            limit = limitOrOptions.limit ?? 5;
            filter = limitOrOptions.filter;
            retrievalMode = limitOrOptions.retrievalMode ?? "explicit";
            routingPolicy = limitOrOptions.routingPolicy ?? routingPolicy;
            includeContent = limitOrOptions.includeContent !== false;
            signal = limitOrOptions.signal;
            deadlineMs = limitOrOptions.deadlineMs;
        }

        const retrieval = createMemoryRetrievalRequest({ signal, deadlineMs });
        try {
            retrieval.throwIfCallerAborted();

            // 0. 自适应检索：仅对隐式召回生效，显式 memory_search / RPC 不应被跳过
            if (retrievalMode === "implicit" && shouldSkipRetrieval(query)) {
                return {
                    items: [],
                    diagnostics: {
                        retrievalMode,
                        limit,
                        routingPolicy,
                        skipped: true,
                        skipReason: "adaptive_retrieval_guard",
                        deepRetrievalApplied: false,
                        scoreSignalAppliedCount: 0,
                        sourceClassMix: {},
                        nodeAssisted: buildDefaultNodeAssistedDiagnostics(routingPolicy),
                        stages: {
                            raw: buildMemorySearchStageSnapshot([]),
                            scoreAware: buildMemorySearchStageSnapshot([]),
                            reranked: buildMemorySearchStageSnapshot([]),
                            returned: buildMemorySearchStageSnapshot([]),
                        },
                    },
                };
            }

            // 本地关键词和 derived surface 先启动，远端 embedding 超时后仍可稳定降级。
            const derivedTaskResults = this.collectDerivedTaskSearchResults(query, {
                limit,
                filter,
                includeContent,
                deadlineMs,
            });
            const derivedExperienceResults = this.collectDerivedExperienceSearchResults(query, {
                limit,
                filter,
                includeContent,
                deadlineMs,
            });
            const keywordResults = this.store.searchKeyword(query, limit * 4, filter, includeContent);
            const derivedSessionPromise = retrieval.isDeadlineExceeded()
                ? Promise.resolve<DerivedRetrievalExecution>(buildDeadlineSkippedDerivedRetrievalExecution())
                : retrieval.waitFor(collectDerivedSessionSearchResults({
                    sessionArtifactInventory: this.sessionArtifactInventory,
                    query,
                    limit,
                    filter,
                    includeContent,
                    signal: retrieval.signal,
                    deadlineMs,
                })).catch((error: unknown) => {
                    retrieval.throwIfCallerAborted();
                    if (retrieval.isDeadlineExceeded()) {
                        return {
                            items: [],
                            report: buildDerivedRetrievalReport({
                                admitted: true,
                                deadlineExceededAfterCompletion: true,
                            }),
                        };
                    }
                    throw error;
                });

            let embeddingFallbackReason: MemorySearchDiagnostics["embeddingFallbackReason"];
            const embeddingPromise = retrieval.isDeadlineExceeded()
                ? Promise.resolve<number[] | null>(null)
                : retrieval.waitFor(this.queryEmbeddingCache.resolve(buildQueryEmbeddingCacheKey({
                    query,
                    modelName: this.embeddingProvider.modelName,
                    queryPrefix: this.embeddingQueryPrefix,
                }), {
                    signal: retrieval.signal,
                    load: ({ signal: querySignal }) => (
                        this.embeddingProvider.embedQuery
                            ? this.embeddingProvider.embedQuery(query, { signal: querySignal, deadlineMs })
                            : this.embeddingProvider.embed(query, { signal: querySignal, deadlineMs })
                    ),
                })).catch((error: unknown) => {
                    retrieval.throwIfCallerAborted();
                    if (retrieval.isDeadlineExceeded()) {
                        embeddingFallbackReason = "deadline";
                        return null;
                    }
                    console.warn("Embedding failed; using keyword-only memory retrieval.");
                    embeddingFallbackReason = "error";
                    return null;
                });
            if (retrieval.isDeadlineExceeded()) {
                embeddingFallbackReason = "deadline";
            }

            const [candidateQueryVec, derivedSessionExecution] = await Promise.all([
                embeddingPromise,
                derivedSessionPromise,
            ]);
            retrieval.throwIfCallerAborted();
            const deadlineExceeded = retrieval.isDeadlineExceeded();
            if (deadlineExceeded) {
                embeddingFallbackReason = "deadline";
            }
            const queryVec = deadlineExceeded ? null : candidateQueryVec;

            // 2. Hybrid search with filter；复用并行阶段已完成的 FTS 结果。
            const rawResults = queryVec
                ? this.store.searchHybrid(query, queryVec, {
                    limit: limit * 2,
                    filter,
                    includeContent,
                    keywordResults,
                })
                : keywordResults.slice(0, limit * 2);
            const seededResults = applySearchResultSourceRegistryHints(dedupeMemorySearchResults([
                ...derivedTaskResults.items,
                ...derivedExperienceResults.items,
                ...derivedSessionExecution.items,
                ...rawResults,
            ]));
            let nodeAssisted = {
                results: seededResults,
                diagnostics: buildDefaultNodeAssistedDiagnostics(routingPolicy),
            };
            if (routingPolicy === "node_assisted" && !deadlineExceeded) {
                try {
                    nodeAssisted = await retrieval.waitFor(this.applyNodeAssistedRetrieval(query, {
                        limit,
                        filter,
                        rawResults: seededResults,
                        signal: retrieval.signal,
                    }));
                } catch (error) {
                    retrieval.throwIfCallerAborted();
                    if (!retrieval.isDeadlineExceeded()) throw error;
                    embeddingFallbackReason = "deadline";
                }
            }
            const sourceRegistryAwareResults = applySearchResultSourceRegistryHints(nodeAssisted.results);
            const scoreAwareResults = this.applyMemoryTreeScoreSignals(sourceRegistryAwareResults);
            const scoreSignalAppliedCount = scoreAwareResults.filter((item) => {
                const memoryTree = isRecord(item.metadata?.memoryTree) ? item.metadata.memoryTree : undefined;
                return typeof memoryTree?.scoreVersion === "string" && memoryTree.scoreVersion.trim().length > 0;
            }).length;

            // 3. Rule-based rerank (with MMR diversity if vectors available)
            const getVector = (chunkId: string) => this.store.getChunkVector(chunkId);
            const getVectors = (chunkIds: string[]) => this.store.getChunkVectors(chunkIds);
            const reranked = this.reranker.rerank(scoreAwareResults, getVector, getVectors);

            // 4. M-N4: 源路径聚合二次检索（仅当启用且有重复 source 时触发）
            let items = reranked.slice(0, limit);
            let deepRetrievalApplied = false;
            if (this.deepRetrievalEnabled && !retrieval.isDeadlineExceeded()) {
                items = this.applyDeepRetrieval(reranked, limit);
                deepRetrievalApplied = true;
            }

            const derived = {
                session: derivedSessionExecution.report,
                task: derivedTaskResults.report,
                experience: derivedExperienceResults.report,
            };
            this.latestDerivedRetrievalSnapshot = createDerivedRetrievalRuntimeSnapshot({ reports: derived });
            return {
                items,
                diagnostics: {
                    retrievalMode,
                    limit,
                    routingPolicy,
                    skipped: false,
                    ...(retrieval.isDeadlineExceeded() ? { deadlineExceeded: true } : {}),
                    ...(embeddingFallbackReason ? { embeddingFallbackReason } : {}),
                    deepRetrievalApplied,
                    scoreSignalAppliedCount,
                    sourceClassMix: buildMemorySearchSourceClassMix(items),
                    nodeAssisted: finalizeNodeAssistedDiagnostics(nodeAssisted.diagnostics, items),
                    derived,
                    stages: {
                        raw: buildMemorySearchStageSnapshot(seededResults),
                        scoreAware: buildMemorySearchStageSnapshot(scoreAwareResults),
                        reranked: buildMemorySearchStageSnapshot(reranked),
                        returned: buildMemorySearchStageSnapshot(items),
                    },
                },
            };
        } finally {
            retrieval.dispose();
        }
    }

    getDerivedRetrievalDoctorReport(): DerivedRetrievalDoctorReport {
        return buildDerivedRetrievalDoctorReport(this.latestDerivedRetrievalSnapshot);
    }

    getEmbeddingCacheDoctorReport(): EmbeddingCacheDoctorReport {
        return buildEmbeddingCacheDoctorReport({
            cache: this.store.getEmbeddingCacheStatus(),
            retention: DEFAULT_EMBEDDING_CACHE_RETENTION,
        });
    }

    async embedRetrievalQuery(text: string): Promise<number[] | null> {
        const normalized = String(text ?? "").trim();
        if (!normalized) return null;
        try {
            const vector = await (this.embeddingProvider.embedQuery
                ? this.embeddingProvider.embedQuery(normalized)
                : this.embeddingProvider.embed(normalized));
            return Array.isArray(vector) && vector.length > 0 ? vector : null;
        } catch {
            return null;
        }
    }

    private async applyNodeAssistedRetrieval(query: string, input: {
        limit: number;
        filter?: MemorySearchFilter;
        rawResults: MemorySearchResult[];
        signal?: AbortSignal;
    }): Promise<{
        results: MemorySearchResult[];
        diagnostics: MemorySearchNodeAssistedDiagnostics;
    }> {
        const routingPlan = resolveMemoryTreeNodeRoutingPlan(query, input.filter);
        if (input.signal?.aborted) {
            return {
                results: input.rawResults,
                diagnostics: buildDefaultNodeAssistedDiagnostics("node_assisted"),
            };
        }
        const managedKinds = routingPlan.includeKinds.filter((kind): kind is ManagedMemoryTreeNodeKind => (
            isManagedMemoryTreeNodeKind(kind)
        ));
        const lifecycle = this.getMemoryTreeLifecycleSnapshot({ kinds: managedKinds });
        const dirtyKinds = lifecycle.nodes
            .filter((node) => node.dirty && !node.governance.cooldownActive)
            .map((node) => node.kind);
        const refresh = dirtyKinds.length > 0
            ? this.memoryTreeRefreshQueue.enqueue({
                kinds: dirtyKinds,
                nodeLimit: Math.max(20, input.limit * 5),
                triggerSource: "node-assisted background",
            })
            : { scheduled: false };
        const treeFreshness = buildNodeAssistedTreeFreshness(lifecycle.nodes, refresh.scheduled);
        if (input.signal?.aborted) {
            return {
                results: input.rawResults,
                diagnostics: buildDefaultNodeAssistedDiagnostics("node_assisted"),
            };
        }
        const nodeResults = this.searchMemoryTreeNodes(query, {
            limit: Math.max(3, input.limit),
            chunkLimitPerNode: routingPlan.chunkLimitPerNode,
            filter: buildNodeAssistedSearchFilter(input.filter, routingPlan),
        });
        if (nodeResults.length <= 0) {
            return {
                results: input.rawResults,
                diagnostics: {
                    ...buildDefaultNodeAssistedDiagnostics("node_assisted"),
                    enabled: true,
                    routeClass: routingPlan.routeClass,
                    routeReasons: routingPlan.routeReasons,
                    routedKinds: routingPlan.includeKinds,
                    preferHighLevel: routingPlan.preferHighLevel,
                    chunkLimitPerNode: routingPlan.chunkLimitPerNode,
                    fallbackApplied: true,
                    treeFreshness,
                },
            };
        }

        const rawById = new Map(input.rawResults.map((item) => [item.id, item] as const));
        const answerStrategy = buildMemoryTreeNodeAnswerStrategy({
            limit: input.limit,
            routingPlan,
            nodeResults,
        });
        const injected = new Map<string, MemorySearchResult>();
        for (const selection of answerStrategy.selections) {
            const selectedChunk = selection.node.chunks[selection.chunkIndex];
            if (!selectedChunk) {
                continue;
            }
            const rawMatch = rawById.get(selectedChunk.id);
            injected.set(
                selectedChunk.id,
                buildNodeBackedSearchResult({
                    chunk: rawMatch ?? selectedChunk,
                    node: selection.node,
                    nodeIndex: selection.nodeIndex,
                    answerStage: selection.stage,
                }),
            );
        }

        const results = dedupeMemorySearchResults([
            ...injected.values(),
            ...input.rawResults,
        ]);
        return {
            results,
            diagnostics: {
                enabled: true,
                policy: "node_assisted",
                routeClass: routingPlan.routeClass,
                routeReasons: routingPlan.routeReasons,
                routedKinds: routingPlan.includeKinds,
                preferHighLevel: routingPlan.preferHighLevel,
                chunkLimitPerNode: routingPlan.chunkLimitPerNode,
                answerSufficient: answerStrategy.answerSufficient,
                evidenceExpanded: answerStrategy.evidenceExpanded,
                evidenceChunkCount: answerStrategy.evidenceChunkCount,
                highLevelOnly: answerStrategy.highLevelOnly,
                selectedNodeIds: answerStrategy.selectedNodeIds,
                nodeHitCount: nodeResults.length,
                injectedChunkCount: injected.size,
                fallbackApplied: injected.size < input.limit,
                treeFreshness,
                returnedMix: {
                    nodeBacked: 0,
                    chunkOnly: 0,
                },
                nodeBackedShare: 0,
                chunkOnlyShare: 0,
                topNodeHits: nodeResults.slice(0, 3).map((item) => ({
                    nodeId: item.node.id,
                    kind: item.node.kind,
                    score: roundMemoryTreeScore(normalizeNodeAssistedScore(item.score)),
                    chunkCount: item.chunks.length,
                    matchReasons: item.matchReasons,
                })),
            },
        };
    }

    async embedRetrievalPassages(texts: string[]): Promise<Array<number[] | null>> {
        const normalizedTexts = Array.isArray(texts)
            ? texts.map((item) => String(item ?? "").trim())
            : [];
        if (normalizedTexts.length <= 0) {
            return [];
        }
        try {
            const vectors = await this.embeddingProvider.embedBatch(normalizedTexts);
            return normalizedTexts.map((_, index) => {
                const vector = vectors[index];
                return Array.isArray(vector) && vector.length > 0 ? vector : null;
            });
        } catch {
            return normalizedTexts.map(() => null);
        }
    }

    private applyMemoryTreeScoreSignals(results: MemorySearchResult[]): MemorySearchResult[] {
        if (!Array.isArray(results) || results.length <= 0) {
            return [];
        }
        const scoreRecords = this.store.listMemoryScoresByTargetIds("chunk", results.map((item) => item.id));
        if (scoreRecords.length <= 0) {
            return results;
        }
        const scoreMap = new Map(scoreRecords.map((item) => [item.targetId, item] as const));
        return results.map((result) => {
            const scoreRecord = scoreMap.get(result.id);
            if (!scoreRecord) {
                return result;
            }
            const sourceClass = readMemoryTreeScoreSourceClass(scoreRecord);
            const blendedScore = clampScore(
                (result.score * MEMORY_TREE_SEARCH_RETRIEVAL_WEIGHT)
                + (scoreRecord.scoreTotal * MEMORY_TREE_SEARCH_GOVERNANCE_WEIGHT),
            );
            const metadata = result.metadata && typeof result.metadata === "object" && !Array.isArray(result.metadata)
                ? { ...result.metadata }
                : {};
            const memoryTree = metadata.memoryTree && typeof metadata.memoryTree === "object" && !Array.isArray(metadata.memoryTree)
                ? { ...metadata.memoryTree }
                : {};
            metadata.memoryTree = {
                ...memoryTree,
                scoreTotal: scoreRecord.scoreTotal,
                sourceClass: sourceClass ?? null,
                sourceId: scoreRecord.sourceId ?? null,
                scoreVersion: scoreRecord.scoreVersion,
            };
            return {
                ...result,
                score: clampScore(blendedScore * computeSearchSourceClassBoost(sourceClass)),
                metadata,
            };
        });
    }

    getEmbeddingRuntimeCacheKey(): string {
        return [
            this.embeddingProvider.modelName ?? "unknown",
            this.embeddingQueryPrefix ?? "",
            this.embeddingPassagePrefix ?? "",
        ].join("|");
    }

    /**
     * Get recent memory chunks (by updated_at, no embedding needed)
     */
    getRecent(limit = 5, filter?: MemorySearchFilter, includeContent = true): MemorySearchResult[] {
        return this.store.getRecentChunks(limit, filter, includeContent);
    }

    countChunks(filter?: MemorySearchFilter): number {
        return this.store.countChunks(filter);
    }

    async previewSourceInventory(options: {
        configuredSources?: MemorySourceInventoryConfiguredSource[];
    } = {}): Promise<MemorySourceInventoryReport> {
        return await buildMemorySourceInventoryReport({
            stateDir: this.stateDir,
            memoryStatus: this.getStatus(),
            taskStats: this.store.getTaskInventoryStats(),
            experienceStats: this.store.getExperienceInventoryStats(),
            configuredSources: options.configuredSources ?? [],
        });
    }

    async previewConfiguredExternalIngest(options: {
        configuredSources?: MemorySourceInventoryConfiguredSource[];
    } = {}): Promise<ExternalMemoryIngestPreview> {
        const configuredSources = Array.isArray(options.configuredSources) ? options.configuredSources : [];
        if (configuredSources.length !== 1) {
            throw new Error("external ingest preview requires exactly one configured source.");
        }
        const [source] = configuredSources;
        if (source?.rootPath && source.filePath) {
            throw new Error("external ingest preview requires configured source to use either rootPath or filePath, but not both.");
        }
        let preview: ExternalMemoryIngestPreview;
        if (source?.rootPath) {
            preview = await previewObsidianMarkdownDirectoryIngest(source);
        } else if (source?.filePath) {
            preview = await previewMarkdownFileIngest(source);
        } else {
            throw new Error("external ingest preview requires configured source to provide rootPath or filePath.");
        }
        return annotateExternalIngestPreviewRescan(preview, this.collectExistingExternalIngestFiles(preview.sourceId));
    }

    async rebuildMemoryTreeSources(options: {
        configuredSources?: MemorySourceInventoryConfiguredSource[];
        triggerSource?: string;
    } = {}): Promise<MemoryTreeSourceRebuildResult> {
        const rebuiltAt = new Date().toISOString();
        const triggerSource = typeof options.triggerSource === "string" && options.triggerSource.trim().length > 0
            ? options.triggerSource.trim()
            : "memory.tree.source.rebuild";
        const claim = claimMemoryTreeJobRun(this.store, {
            jobType: "source_rebuild",
            targetKey: "source",
            startedAt: rebuiltAt,
            triggerSource,
        });
        if (!claim.started) {
            return {
                rebuiltAt,
                totalSources: 0,
                inventorySources: 0,
                dynamicSources: 0,
                skipped: true,
                skipReason: claim.reason,
                skippedAt: rebuiltAt,
            };
        }
        try {
            const report = await this.previewSourceInventory(options);
            const inventoryRecords = report.items.map((item) => buildInventoryMemorySourceRecord(item, rebuiltAt));
            const inventoryIds = new Set(inventoryRecords.map((item) => item.id));
            const dynamicRecords: MemoryTreeSourceRecord[] = [];

            for (const summary of this.store.listChunkSourceSummaries()) {
                const matchedInventoryId = this.resolvePreferredMemorySourceId(summary.sourcePath, summary.sourceType, summary.memoryTypes, inventoryRecords);
                if (matchedInventoryId && inventoryIds.has(matchedInventoryId)) {
                    continue;
                }
                const classification = classifyMemorySource(summary.sourcePath, summary.sourceType, summary.memoryTypes);
                const admission = resolveMemorySourceAdmission({
                    sourceKind: classification.sourceKind,
                    sourceClass: classification.sourceClass,
                });
                const identity = resolveMemorySourceIdentity({
                    id: buildDynamicMemorySourceId(summary.sourcePath, summary.sourceType, summary.agentId),
                    sourceKind: classification.sourceKind,
                    sourceClass: classification.sourceClass,
                    scope: summary.scope,
                    sourcePath: summary.sourcePath,
                    sourceRef: summary.sourceType,
                    builtinInventoryId: classification.builtinInventoryId,
                    agentId: summary.agentId,
                    updatedAt: summary.timeTo,
                });
                dynamicRecords.push({
                    id: buildDynamicMemorySourceId(summary.sourcePath, summary.sourceType, summary.agentId),
                    sourceKind: classification.sourceKind,
                    sourceClass: classification.sourceClass,
                    scope: summary.scope,
                    agentId: summary.agentId,
                    sourcePath: summary.sourcePath,
                    sourceRef: summary.sourceType,
                    contentHash: hashMemoryTreePayload({
                        sourcePath: summary.sourcePath,
                        sourceType: summary.sourceType,
                        agentId: summary.agentId ?? null,
                        itemCount: summary.itemCount,
                        timeTo: summary.timeTo ?? null,
                        admission,
                        identity,
                    }),
                    timeFrom: summary.timeFrom,
                    timeTo: summary.timeTo,
                    itemCount: summary.itemCount,
                    metadata: {
                        recordType: "dynamic_chunk_source",
                        sourceType: summary.sourceType,
                        memoryTypes: summary.memoryTypes,
                        sourceRegistry: {
                            admission,
                            identity,
                        },
                    },
                    createdAt: rebuiltAt,
                    updatedAt: rebuiltAt,
                });
            }

            const records = [...inventoryRecords, ...dynamicRecords];
            this.store.upsertMemorySources(records);
            this.store.setMeta("memory_tree_sources_last_rebuilt_at", rebuiltAt);
            this.store.setMeta(buildMemoryTreeSourcesLastMemorySeqMetaKey(), String(this.store.getMemoryChangeSeq()));
            recordMemoryTreeJobLedgerSuccess(this.store, {
                jobType: "source_rebuild",
                targetKey: "source",
                completedAt: rebuiltAt,
                triggerSource,
            });
            this.clearMemoryTreeLifecycleGovernance("source");
            return {
                rebuiltAt,
                totalSources: records.length,
                inventorySources: inventoryRecords.length,
                dynamicSources: dynamicRecords.length,
            };
        } catch (error) {
            this.recordMemoryTreeLifecycleFailure("source", error, rebuiltAt, triggerSource);
            throw error;
        } finally {
            claim.release();
        }
    }

    listMemoryTreeSources(limit = 100, filter?: MemoryTreeSourceListFilter): MemoryTreeSourceRecord[] {
        return this.store.listMemorySources(limit, filter);
    }

    getMemoryTreeLifecycleSnapshot(options: {
        kinds?: Array<ManagedMemoryTreeNodeKind | MemoryTreeNodeKind | string>;
    } = {}): {
        checkedAt: string;
        source: MemoryTreeSourceLifecycleState;
        nodes: MemoryTreeNodeLifecycleState[];
    } {
        const checkedAt = new Date().toISOString();
        const currentMemorySeq = this.store.getMemoryChangeSeq();
        const currentTaskSeq = this.store.getTaskChangeSeq();
        const source = buildMemoryTreeSourceLifecycleState({
            sourcePresent: this.store.listMemorySources(1).length > 0,
            currentMemorySeq,
            lastMemorySeq: readNumericMetaValue(this.store.getMeta(buildMemoryTreeSourcesLastMemorySeqMetaKey())),
            lastRebuiltAt: this.store.getMeta("memory_tree_sources_last_rebuilt_at") ?? undefined,
            governance: this.readMemoryTreeLifecycleGovernance("source", checkedAt),
        });
        const nodes = resolveManagedMemoryTreeNodeKinds(options.kinds)
            .map((kind) => buildManagedMemoryTreeNodeLifecycleState({
                kind,
                nodePresent: this.store.listMemoryTreeNodes(1, { kind }).length > 0,
                currentMemorySeq,
                currentTaskSeq,
                lastMemorySeq: readNumericMetaValue(this.store.getMeta(buildManagedMemoryTreeNodeLastMemorySeqMetaKey(kind))),
                lastTaskSeq: readNumericMetaValue(this.store.getMeta(buildManagedMemoryTreeNodeLastTaskSeqMetaKey(kind))),
                lastRebuiltAt: this.store.getMeta(buildManagedMemoryTreeNodeLastRebuiltAtMetaKey(kind)) ?? undefined,
                governance: this.readMemoryTreeLifecycleGovernance(kind, checkedAt),
            }));
        return {
            checkedAt,
            source,
            nodes,
        };
    }

    getMemoryTreeLifecycleReport(options: {
        kinds?: Array<ManagedMemoryTreeNodeKind | MemoryTreeNodeKind | string>;
    } = {}): MemoryTreeLifecycleReport {
        return buildMemoryTreeLifecycleReport(this.getMemoryTreeLifecycleSnapshot(options));
    }

    getMemoryTreeJobReport(options: {
        kinds?: Array<ManagedMemoryTreeNodeKind | MemoryTreeNodeKind | string>;
    } = {}): MemoryTreeJobReport {
        const snapshot = this.getMemoryTreeLifecycleSnapshot(options);
        const jobLedger = listMemoryTreeJobLedgerRecords(this.store, [
            { jobType: "source_rebuild", targetKey: "source" },
            ...snapshot.nodes.map((node) => ({
                jobType: "node_rebuild" as const,
                targetKey: node.kind,
            })),
            { jobType: "score_rebuild", targetKey: "chunk_scores" },
        ]);
        const latestDedupPreviewReport = this.store.listMemoryCleanReports(1, {
            reportType: "dedup_preview",
        })[0] ?? null;
        return buildMemoryTreeJobReport({
            checkedAt: snapshot.checkedAt,
            source: snapshot.source,
            nodes: snapshot.nodes,
            scoreLastRebuiltAt: this.store.getMeta("memory_tree_scores_last_rebuilt_at") ?? undefined,
            latestDedupPreviewReport,
            jobLedger,
        });
    }

    async ensureManagedMemoryTreeFresh(options: {
        configuredSources?: MemorySourceInventoryConfiguredSource[];
        kinds?: Array<ManagedMemoryTreeNodeKind | MemoryTreeNodeKind | string>;
        nodeLimit?: number;
        rebuildSources?: boolean;
        triggerSource?: string;
    } = {}): Promise<{
        checkedAt: string;
        sourceRebuilt: boolean;
        rebuiltKinds: ManagedMemoryTreeNodeKind[];
        skipped: Array<{
            target: "source" | ManagedMemoryTreeNodeKind;
            reason: "cooldown_active" | "reentry_blocked";
            cooldownUntil?: string;
            lastError?: string;
            failureCount: number;
        }>;
        failures: Array<{ target: "source" | ManagedMemoryTreeNodeKind; message: string }>;
        before: {
            source: MemoryTreeSourceLifecycleState;
            nodes: MemoryTreeNodeLifecycleState[];
        };
        after: {
            source: MemoryTreeSourceLifecycleState;
            nodes: MemoryTreeNodeLifecycleState[];
        };
    }> {
        const before = this.getMemoryTreeLifecycleSnapshot({ kinds: options.kinds });
        const checkedAt = new Date().toISOString();
        const skipped: Array<{
            target: "source" | ManagedMemoryTreeNodeKind;
            reason: "cooldown_active" | "reentry_blocked";
            cooldownUntil?: string;
            lastError?: string;
            failureCount: number;
        }> = [];
        const failures: Array<{ target: "source" | ManagedMemoryTreeNodeKind; message: string }> = [];
        let sourceRebuilt = false;
        const triggerSource = typeof options.triggerSource === "string" && options.triggerSource.trim().length > 0
            ? options.triggerSource.trim()
            : "memory.tree.lifecycle.ensure";

        if (options.rebuildSources !== false && before.source.dirty) {
            if (before.source.governance.cooldownActive) {
                recordMemoryTreeJobLedgerSkip(this.store, {
                    jobType: "source_rebuild",
                    targetKey: "source",
                    skippedAt: checkedAt,
                    reason: "cooldown_active",
                    triggerSource,
                });
                skipped.push({
                    target: "source",
                    reason: "cooldown_active",
                    cooldownUntil: before.source.governance.cooldownUntil,
                    lastError: before.source.governance.lastError,
                    failureCount: before.source.governance.failureCount,
                });
            } else {
                try {
                    const sourceResult = await this.rebuildMemoryTreeSources({
                        configuredSources: options.configuredSources,
                        triggerSource,
                    });
                    if (sourceResult.skipped) {
                        skipped.push({
                            target: "source",
                            reason: sourceResult.skipReason === "cooldown_active" ? "cooldown_active" : "reentry_blocked",
                            cooldownUntil: before.source.governance.cooldownUntil,
                            lastError: before.source.governance.lastError,
                            failureCount: before.source.governance.failureCount,
                        });
                    } else {
                        sourceRebuilt = true;
                    }
                } catch (error) {
                    failures.push({
                        target: "source",
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        }

        const rebuiltKinds: ManagedMemoryTreeNodeKind[] = [];
        const nodeLimit = typeof options.nodeLimit === "number" && Number.isFinite(options.nodeLimit)
            ? Math.max(1, Math.floor(options.nodeLimit))
            : 20;
        for (const nodeState of before.nodes) {
            if (!nodeState.dirty) {
                continue;
            }
            if (nodeState.governance.cooldownActive) {
                recordMemoryTreeJobLedgerSkip(this.store, {
                    jobType: "node_rebuild",
                    targetKey: nodeState.kind,
                    skippedAt: checkedAt,
                    reason: "cooldown_active",
                    triggerSource,
                });
                skipped.push({
                    target: nodeState.kind,
                    reason: "cooldown_active",
                    cooldownUntil: nodeState.governance.cooldownUntil,
                    lastError: nodeState.governance.lastError,
                    failureCount: nodeState.governance.failureCount,
                });
                continue;
            }
            try {
                const nodeResult = this.rebuildMemoryTreeNodes({
                    kind: nodeState.kind,
                    limit: nodeLimit,
                    triggerSource,
                });
                if (nodeResult.skipped) {
                    skipped.push({
                        target: nodeState.kind,
                        reason: nodeResult.skipReason === "cooldown_active" ? "cooldown_active" : "reentry_blocked",
                        cooldownUntil: nodeState.governance.cooldownUntil,
                        lastError: nodeState.governance.lastError,
                        failureCount: nodeState.governance.failureCount,
                    });
                } else {
                    rebuiltKinds.push(nodeState.kind);
                }
            } catch (error) {
                failures.push({
                    target: nodeState.kind,
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }

        const after = this.getMemoryTreeLifecycleSnapshot({ kinds: options.kinds });
        return {
            checkedAt,
            sourceRebuilt,
            rebuiltKinds,
            skipped,
            failures,
            before: {
                source: before.source,
                nodes: before.nodes,
            },
            after: {
                source: after.source,
                nodes: after.nodes,
            },
        };
    }

    rebuildMemoryTreeScores(options: {
        triggerSource?: string;
    } = {}): MemoryTreeScoreRebuildResult {
        const rebuiltAt = new Date().toISOString();
        const triggerSource = typeof options.triggerSource === "string" && options.triggerSource.trim().length > 0
            ? options.triggerSource.trim()
            : "memory.tree.score.rebuild";
        const claim = claimMemoryTreeJobRun(this.store, {
            jobType: "score_rebuild",
            targetKey: "chunk_scores",
            startedAt: rebuiltAt,
            triggerSource,
        });
        if (!claim.started) {
            return {
                rebuiltAt,
                scoreVersion: MEMORY_TREE_SCORE_VERSION,
                totalScores: 0,
                skipped: true,
                skipReason: claim.reason,
                skippedAt: rebuiltAt,
            };
        }
        try {
            const sources = this.store.listMemorySources(10_000);
            const sourceMap = new Map(sources.map((item) => [item.id, item] as const));
            const records: MemoryTreeScoreRecord[] = this.store.listChunkScoreInputs().map((input) => {
                const fallbackClassification = classifyMemorySource(
                    input.sourcePath,
                    input.sourceType,
                    input.memoryType ? [input.memoryType] : undefined,
                );
                const sourceId = this.resolvePreferredMemorySourceId(input.sourcePath, input.sourceType, input.memoryType ? [input.memoryType] : undefined, sources)
                    ?? buildDynamicMemorySourceId(input.sourcePath, input.sourceType, input.agentId);
                const sourceRecord = sourceMap.get(sourceId) ?? {
                    id: sourceId,
                    sourceKind: fallbackClassification.sourceKind,
                    sourceClass: fallbackClassification.sourceClass,
                    scope: input.visibility === "shared" ? "shared" : "private",
                };
                const score = buildRuleOnlyChunkScore(input, sourceRecord);
                return {
                    id: `score:${MEMORY_TREE_SCORE_VERSION}:chunk:${input.chunkId}`,
                    targetType: "chunk",
                    targetId: input.chunkId,
                    sourceId,
                    scoreTotal: score.scoreTotal,
                    recencyScore: score.recencyScore,
                    sourceWeightScore: score.sourceWeightScore,
                    interactionScore: score.interactionScore,
                    taskOutcomeScore: score.taskOutcomeScore,
                    entityDensityScore: score.entityDensityScore,
                    scoreVersion: MEMORY_TREE_SCORE_VERSION,
                    rationale: score.rationale,
                    createdAt: rebuiltAt,
                    updatedAt: rebuiltAt,
                };
            });
            this.store.upsertMemoryScores(records);
            this.store.setMeta("memory_tree_scores_last_rebuilt_at", rebuiltAt);
            recordMemoryTreeJobLedgerSuccess(this.store, {
                jobType: "score_rebuild",
                targetKey: "chunk_scores",
                completedAt: rebuiltAt,
                triggerSource,
            });
            return {
                rebuiltAt,
                scoreVersion: MEMORY_TREE_SCORE_VERSION,
                totalScores: records.length,
            };
        } catch (error) {
            recordMemoryTreeJobLedgerFailure(this.store, {
                jobType: "score_rebuild",
                targetKey: "chunk_scores",
                failedAt: rebuiltAt,
                error,
                triggerSource,
            });
            throw error;
        } finally {
            claim.release();
        }
    }

    listMemoryTreeScores(limit = 100, filter?: MemoryTreeScoreListFilter): MemoryTreeScoreRecord[] {
        return this.store.listMemoryScores(limit, filter);
    }

    recordMemoryTreeReport(input: {
        reportType: MemoryTreeReportType;
        summary: Record<string, unknown>;
        details: Record<string, unknown>;
        scope?: MemoryTreeSourceRecord["scope"];
        agentId?: string;
        status?: MemoryTreeReportStatus;
        inputVersion?: string;
        createdBy?: string;
        exportMarkdownPath?: string;
        reportId?: string;
    }): MemoryTreeReportRecord {
        const persistedAt = new Date().toISOString();
        const reportId = input.reportId ?? buildMemoryTreeReportId({
            reportType: input.reportType,
            inputVersion: input.inputVersion,
            summary: input.summary,
            details: input.details,
            scope: input.scope ?? "private",
            agentId: input.agentId,
        });
        const record: MemoryTreeReportRecord = {
            id: reportId,
            reportType: input.reportType,
            scope: input.scope ?? "private",
            agentId: input.agentId,
            status: input.status ?? "ready",
            inputVersion: input.inputVersion,
            summary: input.summary,
            details: input.details,
            exportMarkdownPath: input.exportMarkdownPath,
            createdBy: input.createdBy,
            createdAt: persistedAt,
            updatedAt: persistedAt,
        };
        this.store.upsertMemoryCleanReports([record]);
        return this.store.getMemoryCleanReport(reportId) ?? record;
    }

    listMemoryTreeReports(limit = 50, filter?: MemoryTreeReportListFilter): MemoryTreeReportRecord[] {
        return this.store.listMemoryCleanReports(limit, filter);
    }

    getMemoryTreeReport(reportId: string): MemoryTreeReportRecord | null {
        return this.store.getMemoryCleanReport(reportId);
    }

    async exportMemoryTreeReportMarkdown(reportId: string, destinationPath?: string): Promise<{ report: MemoryTreeReportRecord; markdownPath: string }> {
        const report = this.store.getMemoryCleanReport(reportId);
        if (!report) {
            throw new Error(`Memory tree report not found: ${reportId}`);
        }
        const markdownPath = destinationPath ?? path.join(this.stateDir, "reports", "memory-tree", `${sanitizePathSegment(reportId)}.md`);
        await fs.mkdir(path.dirname(markdownPath), { recursive: true });
        const content = buildMemoryTreeReportMarkdown(report);
        await fs.writeFile(markdownPath, content, "utf-8");
        this.store.upsertMemoryCleanReports([{
            ...report,
            exportMarkdownPath: markdownPath,
            updatedAt: new Date().toISOString(),
        }]);
        const next = this.store.getMemoryCleanReport(reportId) ?? { ...report, exportMarkdownPath: markdownPath };
        return { report: next, markdownPath };
    }

    reviewMemoryTreeReport(
        reportId: string,
        decision: MemoryTreeReportReviewDecision,
        options: { reviewedBy?: string; note?: string } = {},
    ): MemoryTreeReportReviewResult {
        const current = this.store.getMemoryCleanReport(reportId);
        if (!current) {
            throw new Error(`Memory tree report not found: ${reportId}`);
        }
        if (!canReviewMemoryTreeReport(current.status, decision)) {
            throw new Error(`Report status ${current.status} cannot transition to ${decision}.`);
        }
        const reviewedAt = new Date().toISOString();
        const next: MemoryTreeReportRecord = {
            ...current,
            status: decision,
            summary: {
                ...current.summary,
                reviewStatus: decision,
                lastReviewedAt: reviewedAt,
            },
            details: appendMemoryTreeReportReviewEvent(current.details, {
                decision,
                previousStatus: current.status,
                reviewedAt,
                reviewedBy: options.reviewedBy ?? "rpc",
                note: options.note,
            }),
            updatedAt: reviewedAt,
        };
        this.store.upsertMemoryCleanReports([next]);
        return {
            report: this.store.getMemoryCleanReport(reportId) ?? next,
            previousStatus: current.status,
            decision,
            reviewedAt,
        };
    }

    async applyMemoryTreeReport(
        reportId: string,
        options: { appliedBy?: string; note?: string } = {},
    ): Promise<MemoryTreeReportApplyResult> {
        const current = this.store.getMemoryCleanReport(reportId);
        if (!current) {
            throw new Error(`Memory tree report not found: ${reportId}`);
        }
        if (current.status !== "approved") {
            throw new Error(`Only approved reports can be applied. Current status: ${current.status}.`);
        }
        if (current.reportType === "dedup_preview") {
            return this.applyDedupPreviewReport(current, options);
        }
        if (current.reportType === "external_ingest_preview") {
            return await this.applyExternalIngestPreviewReport(current, options);
        }
        if (
            current.reportType === "inventory"
            || current.reportType === "tree_build_preview"
            || current.reportType === "shared_governance_preview"
        ) {
            return this.applyReportGovernanceAck(current, options);
        }
        throw new Error(`Report type ${current.reportType} is not supported for apply.`);
    }

    private applyDedupPreviewReport(
        current: MemoryTreeReportRecord,
        options: { appliedBy?: string; note?: string } = {},
    ): MemoryTreeReportApplyResult {

        const appliedAt = new Date().toISOString();
        const plan = resolveMemoryTreeDedupApplyPlan(current);
        const operations = plan.operations;
        const existingScores = this.store.listMemoryScoresByTargetIds("chunk", operations.map((item) => item.chunkId));
        const scoreMap = new Map(existingScores.map((item) => [item.targetId, item] as const));
        const scoreRecords: MemoryTreeScoreRecord[] = [];
        const actions: MemoryTreeReportApplyResult["actions"] = [];
        const skippedChunkIds: string[] = plan.skipped.map((item) => item.chunkId);
        let updatedChunkCount = 0;

        for (const skipped of plan.skipped) {
            actions.push({
                kind: "dedup_skip",
                chunkId: skipped.chunkId,
                keepChunkId: skipped.keepChunkId,
                normalizedHash: skipped.normalizedHash,
                skipped: true,
                reason: skipped.reason,
            });
        }

        for (const operation of operations) {
            const chunk = this.store.getChunk(operation.chunkId);
            if (!chunk) {
                skippedChunkIds.push(operation.chunkId);
                continue;
            }
            const previousScore = scoreMap.get(operation.chunkId);
            const nextScoreTotal = computeArchivedGovernanceScore(previousScore?.scoreTotal);
            const nextMetadata = buildArchivedMemoryChunkMetadata(chunk.metadata, {
                reportId: current.id,
                archivedAt: appliedAt,
                keepChunkId: operation.keepChunkId,
                normalizedHash: operation.normalizedHash,
            });
            if (this.store.updateChunkMetadata(operation.chunkId, nextMetadata)) {
                updatedChunkCount += 1;
            }
            scoreRecords.push(buildArchivedMemoryTreeScoreRecord({
                chunk,
                existing: previousScore,
                reportId: current.id,
                appliedAt,
                keepChunkId: operation.keepChunkId,
                normalizedHash: operation.normalizedHash,
                nextScoreTotal,
            }));
            actions.push({
                kind: "dedup_archive",
                chunkId: operation.chunkId,
                keepChunkId: operation.keepChunkId,
                normalizedHash: operation.normalizedHash,
                previousScoreTotal: previousScore?.scoreTotal,
                nextScoreTotal,
                archived: true,
            });
        }

        if (scoreRecords.length > 0) {
            this.store.upsertMemoryScores(scoreRecords);
        }

        const next: MemoryTreeReportRecord = {
            ...current,
            status: "applied",
            summary: {
                ...current.summary,
                lastAppliedAt: appliedAt,
                applyMode: "metadata_and_score_only",
                appliedChunkCount: updatedChunkCount,
                appliedScoreCount: scoreRecords.length,
            },
            details: appendMemoryTreeReportApplyEvent(current.details, {
                appliedAt,
                appliedBy: options.appliedBy ?? "rpc",
                note: options.note,
                updatedChunkCount,
                updatedScoreCount: scoreRecords.length,
                skippedChunkIds,
                actions,
            }),
            updatedAt: appliedAt,
        };
        this.store.upsertMemoryCleanReports([next]);
        return {
            report: this.store.getMemoryCleanReport(current.id) ?? next,
            appliedAt,
            updatedChunkCount,
            updatedScoreCount: scoreRecords.length,
            skippedChunkIds,
            actions,
        };
    }

    private async applyExternalIngestPreviewReport(
        current: MemoryTreeReportRecord,
        options: { appliedBy?: string; note?: string } = {},
    ): Promise<MemoryTreeReportApplyResult> {
        const preview = readExternalIngestPreviewFromReport(current);
        const appliedAt = new Date().toISOString();
        const ingestResult = await materializeObsidianMarkdownChunks(preview, {
            appliedAt,
            reportId: current.id,
        });
        const staleFiles = Array.isArray(preview.rescan?.staleFiles) ? preview.rescan.staleFiles : [];
        const manifestBySourcePath = new Map(preview.fileManifest.map((item) => [item.path, item] as const));
        const transaction = this.store.applyExternalIngestBatch({
            sourceId: preview.sourceId,
            replacements: ingestResult.chunksBySourcePath.map((item) => ({
                sourcePath: item.sourcePath,
                chunks: item.chunks,
                expectedPreviousContentHash: manifestBySourcePath.get(item.sourcePath)?.previousContentHash,
                expectedExistingState: manifestBySourcePath.get(item.sourcePath)?.rescanState === "new"
                    ? "missing"
                    : manifestBySourcePath.get(item.sourcePath)?.rescanState
                        ? "present"
                        : undefined,
            })),
            staleSources: staleFiles.map((item) => ({
                sourcePath: item.path,
                expectedPreviousContentHash: item.previousContentHash,
            })),
        });
        const staleDeletionByPath = new Map(transaction.staleDeletions.map((item) => [item.sourcePath, item] as const));
        const staleChunksRemoved = transaction.staleDeletions.reduce((total, item) => total + item.deletedChunkCount, 0);
        const staleFilesRemoved = transaction.staleDeletions.filter((item) => item.deletedChunkCount > 0).length;

        const sourceRebuild = await this.rebuildMemoryTreeSources({
            configuredSources: [preview.source],
            triggerSource: "external ingest apply",
        });
        const scoreRebuild = this.rebuildMemoryTreeScores({
            triggerSource: "external ingest apply",
        });
        const actions: MemoryTreeReportApplyResult["actions"] = [
            ...ingestResult.chunksBySourcePath.map((item) => ({
                kind: "external_ingest" as const,
                sourcePath: item.sourcePath,
                importedChunkCount: item.chunks.length,
                skipped: false,
            })),
            ...ingestResult.skippedFiles.map((item) => ({
                kind: "external_ingest" as const,
                sourcePath: item.path,
                importedChunkCount: 0,
                skipped: true,
                reason: item.reason,
            })),
            ...staleFiles.map((item) => {
                const deletion = staleDeletionByPath.get(item.path);
                return {
                    kind: "external_ingest" as const,
                    sourcePath: item.path,
                    importedChunkCount: 0,
                    removedChunkCount: deletion?.deletedChunkCount ?? 0,
                    stale: true,
                    skipped: Boolean(deletion?.skippedReason),
                    reason: deletion?.skippedReason ?? item.reason,
                };
            }),
        ];
        ingestResult.staleFilesRemoved = staleFilesRemoved;
        ingestResult.staleChunksRemoved = staleChunksRemoved;

        const next: MemoryTreeReportRecord = {
            ...current,
            status: "applied",
            summary: {
                ...current.summary,
                lastAppliedAt: appliedAt,
                applyMode: "external_chunk_ingest",
                importedFileCount: ingestResult.importedFileCount,
                importedChunkCount: ingestResult.importedChunkCount,
                staleFileCount: staleFiles.length,
                staleFilesRemoved,
                staleChunksRemoved,
                sourceRebuildTotalSources: sourceRebuild.totalSources,
                scoreRebuildTotalScores: scoreRebuild.totalScores,
            },
            details: appendMemoryTreeReportApplyEvent(current.details, {
                appliedAt,
                appliedBy: options.appliedBy ?? "rpc",
                note: options.note,
                updatedChunkCount: ingestResult.importedChunkCount,
                updatedScoreCount: scoreRebuild.totalScores,
                skippedChunkIds: [],
                actions,
                extra: {
                    sourceId: ingestResult.sourceId,
                    importedFileCount: ingestResult.importedFileCount,
                    importedChunkCount: ingestResult.importedChunkCount,
                    skippedFiles: ingestResult.skippedFiles,
                    staleFiles,
                    staleDeletions: transaction.staleDeletions,
                    staleFilesRemoved,
                    staleChunksRemoved,
                    sourceRebuild,
                    scoreRebuild,
                },
            }),
            updatedAt: appliedAt,
        };
        this.store.upsertMemoryCleanReports([next]);
        return {
            report: this.store.getMemoryCleanReport(current.id) ?? next,
            appliedAt,
            updatedChunkCount: ingestResult.importedChunkCount,
            updatedScoreCount: scoreRebuild.totalScores,
            skippedChunkIds: [],
            actions,
        };
    }

    private applyReportGovernanceAck(
        current: MemoryTreeReportRecord,
        options: { appliedBy?: string; note?: string } = {},
    ): MemoryTreeReportApplyResult {
        const appliedAt = new Date().toISOString();
        const governanceState = resolveReportGovernanceState(current.reportType);
        const actions: MemoryTreeReportApplyResult["actions"] = [{
            kind: "report_governance_ack",
            reportType: current.reportType,
            governanceState,
        }];
        const next: MemoryTreeReportRecord = {
            ...current,
            status: "applied",
            summary: {
                ...current.summary,
                lastAppliedAt: appliedAt,
                applyMode: "report_state_only",
                governanceState,
            },
            details: appendMemoryTreeReportApplyEvent(current.details, {
                appliedAt,
                appliedBy: options.appliedBy ?? "rpc",
                note: options.note,
                updatedChunkCount: 0,
                updatedScoreCount: 0,
                skippedChunkIds: [],
                actions,
                extra: {
                    reportType: current.reportType,
                    governanceState,
                    applyMode: "report_state_only",
                },
            }),
            updatedAt: appliedAt,
        };
        this.store.upsertMemoryCleanReports([next]);
        return {
            report: this.store.getMemoryCleanReport(current.id) ?? next,
            appliedAt,
            updatedChunkCount: 0,
            updatedScoreCount: 0,
            skippedChunkIds: [],
            actions,
        };
    }

    persistMemoryTreeInventoryReport(report: MemorySourceInventoryReport, options: { configuredSources?: MemorySourceInventoryConfiguredSource[]; createdBy?: string } = {}): MemoryTreeReportRecord {
        const governance = buildMemorySourceInventoryGovernanceSummary(report);
        const summary = {
            reportVersion: report.version,
            sourceKinds: report.totals.sourceKinds,
            presentSourceKinds: report.totals.presentSourceKinds,
            declaredSourceKinds: report.totals.declaredSourceKinds,
            missingSourceKinds: report.totals.missingSourceKinds,
            fileCount: report.totals.fileCount,
            rowCount: report.totals.rowCount,
            totalBytes: report.totals.totalBytes,
            indexedFiles: report.totals.indexedFiles,
            indexedChunks: report.totals.indexedChunks,
            byClass: report.totals.byClass,
            byScope: report.totals.byScope,
            governance,
        };
        const details = {
            generatedAt: report.generatedAt,
            stateDir: report.stateDir,
            items: report.items,
            families: report.families,
            governance,
            configuredSources: options.configuredSources ?? [],
        };
        return this.recordMemoryTreeReport({
            reportType: "inventory",
            scope: "private",
            createdBy: options.createdBy ?? "rpc",
            inputVersion: hashMemoryTreePayload({
                reportVersion: report.version,
                totals: summary,
                configuredSources: options.configuredSources ?? [],
            }),
            summary,
            details,
        });
    }

    persistMemoryTreeExternalIngestReport(report: ExternalMemoryIngestPreview, options: { createdBy?: string } = {}): MemoryTreeReportRecord {
        const governance = this.buildExternalIngestGovernanceSummary(report);
        const summary = {
            adapter: report.adapter,
            sourceId: report.sourceId,
            sourceLabel: report.sourceLabel,
            sourceClass: report.sourceClass,
            scope: report.scope,
            storage: report.storage,
            totalFiles: report.totalFiles,
            eligibleFiles: report.eligibleFiles,
            skippedFiles: report.skippedFiles,
            estimatedChunks: report.estimatedChunks,
            estimatedBytes: report.estimatedBytes,
            lastScannedAt: report.generatedAt,
            applyMode: "chunk_replace_by_source",
            rescanMode: report.rescan.mode,
            previousFileCount: report.rescan.previousFileCount,
            newFileCount: report.rescan.newFileCount,
            changedFileCount: report.rescan.changedFileCount,
            unchangedFileCount: report.rescan.unchangedFileCount,
            staleFileCount: report.rescan.staleFileCount,
            governance,
        };
        const details = {
            preview: report,
            governance,
            configuredSource: report.source,
            adapter: report.adapter,
            rootPath: report.rootPath,
            fileManifest: report.fileManifest,
            skipReasons: report.skipReasons,
            rescan: report.rescan,
            ingestPolicy: {
                applyMode: "chunk_replace_by_source",
                sourceType: report.adapter === "markdown_file_v1"
                    ? "external_markdown_file"
                    : "external_obsidian_markdown",
                memoryType: "other",
                autoRebuildNodes: false,
            },
            provenance: {
                generatedAt: report.generatedAt,
                sourceId: report.sourceId,
            },
        };
        return this.recordMemoryTreeReport({
            reportType: "external_ingest_preview",
            scope: report.scope,
            createdBy: options.createdBy ?? "rpc",
            inputVersion: hashMemoryTreePayload({
                sourceId: report.sourceId,
                rootPath: report.rootPath,
                fileManifest: report.fileManifest.map((item) => ({
                    path: item.path,
                    contentHash: item.contentHash,
                    status: item.status,
                })),
            }),
            summary,
            details,
        });
    }

    private buildExternalIngestGovernanceSummary(report: ExternalMemoryIngestPreview) {
        return buildExternalMemoryIngestGovernanceSummary(report, {
            indexedSources: this.collectExternalIngestGovernanceIndexedSources(),
        });
    }

    private collectExternalIngestGovernanceIndexedSources(): ExternalMemoryIngestGovernanceIndexedSource[] {
        const records = this.store.listMemorySources(10_000);
        const recordsById = new Map(records.map((record) => [record.id, record] as const));
        return this.store.listChunkSourceSummaries().map((summary) => {
            const matchedSourceId = this.resolvePreferredMemorySourceId(summary.sourcePath, summary.sourceType, summary.memoryTypes, records);
            const matchedSource = matchedSourceId ? recordsById.get(matchedSourceId) : undefined;
            const classification = classifyMemorySource(summary.sourcePath, summary.sourceType, summary.memoryTypes);
            const sourceKind = matchedSource?.sourceKind ?? classification.sourceKind;
            const sourceClass = matchedSource?.sourceClass ?? classification.sourceClass;
            const sourceRegistry = isRecord(matchedSource?.metadata?.sourceRegistry) ? matchedSource.metadata?.sourceRegistry : undefined;
            const admission = isRecord(sourceRegistry?.admission) ? sourceRegistry.admission : undefined;
            const admissionSearchPolicy = typeof admission?.searchPolicy === "string"
                ? admission.searchPolicy
                : undefined;
            const searchPolicy = isMemorySourceSearchPolicy(admissionSearchPolicy)
                ? admissionSearchPolicy
                : resolveMemorySourceAdmission({
                    sourceKind,
                    sourceClass,
                }).searchPolicy;
            const sample = this.store.getChunksBySource(summary.sourcePath, 1)[0];
            const metadata = isRecord(sample?.metadata) ? sample.metadata : undefined;
            const memoryTree = isRecord(metadata?.memoryTree) ? metadata.memoryTree : undefined;
            return {
                sourcePath: summary.sourcePath,
                sourceKind,
                sourceClass,
                scope: matchedSource?.scope ?? summary.scope ?? "private",
                searchPolicy,
                externalSourceId: typeof memoryTree?.externalSourceId === "string"
                    ? memoryTree.externalSourceId
                    : undefined,
            };
        });
    }

    private collectExistingExternalIngestFiles(sourceId: string): Array<{
        path: string;
        relativePath: string;
        contentHash?: string;
        chunkCount: number;
    }> {
        const existing: Array<{
            path: string;
            relativePath: string;
            contentHash?: string;
            chunkCount: number;
        }> = [];
        for (const summary of this.store.listChunkSourceSummaries()) {
            const sample = this.store.getChunksBySource(summary.sourcePath, 1)[0];
            const metadata = isRecord(sample?.metadata) ? sample.metadata : undefined;
            const memoryTree = isRecord(metadata?.memoryTree) ? metadata.memoryTree : undefined;
            if (!memoryTree || memoryTree.externalSourceId !== sourceId) {
                continue;
            }
            existing.push({
                path: summary.sourcePath,
                relativePath: path.relative(path.dirname(summary.sourcePath), summary.sourcePath).replace(/\\/g, "/") || path.basename(summary.sourcePath),
                contentHash: typeof metadata?.file_hash === "string" ? metadata.file_hash : undefined,
                chunkCount: summary.itemCount,
            });
        }
        return existing;
    }

    persistMemoryTreeDedupPreviewReport(report: MemoryExactDedupPreviewReport, options: { filter?: MemorySearchFilter; maxGroups?: number; createdBy?: string } = {}): MemoryTreeReportRecord {
        const governance = report.governance ?? buildMemoryExactDedupGovernanceSummary(report, {
            topGroupLimit: 5,
        });
        const summary = {
            mode: report.mode,
            strategy: report.strategy,
            scannedChunks: report.totals.scannedChunks,
            duplicateGroups: report.totals.duplicateGroups,
            removableChunks: report.totals.removableChunks,
            estimatedRetainedChunks: Math.max(0, report.totals.scannedChunks - report.totals.removableChunks),
            governance,
        };
        const details = {
            observability: report.observability,
            sourceIndexingSummary: report.sourceIndexingSummary,
            groups: report.groups,
            governance,
            filter: options.filter ?? null,
            maxGroups: options.maxGroups ?? null,
        };
        return this.recordMemoryTreeReport({
            reportType: "dedup_preview",
            scope: "private",
            createdBy: options.createdBy ?? "rpc",
            inputVersion: hashMemoryTreePayload({
                filter: options.filter ?? null,
                maxGroups: options.maxGroups ?? null,
                mode: report.mode,
                strategy: report.strategy,
                totals: summary,
                governance,
            }),
            summary,
            details,
        });
    }

    rebuildMemoryTreeNodes(options: { limit?: number; kind?: MemoryTreeNodeKind; triggerSource?: string } = {}): MemoryTreeNodeRebuildResult {
        const rebuiltAt = new Date().toISOString();
        const limit = typeof options.limit === "number" && Number.isFinite(options.limit)
            ? Math.max(1, Math.floor(options.limit))
            : 100;
        const kind = options.kind ?? "task";
        const triggerSource = typeof options.triggerSource === "string" && options.triggerSource.trim().length > 0
            ? options.triggerSource.trim()
            : "memory.tree.node.rebuild";
        const claim = isManagedMemoryTreeNodeKind(kind)
            ? claimMemoryTreeJobRun(this.store, {
                jobType: "node_rebuild",
                targetKey: kind,
                startedAt: rebuiltAt,
                triggerSource,
            })
            : undefined;
        if (claim && !claim.started) {
            return {
                rebuiltAt,
                totalNodes: 0,
                totalEdges: 0,
                kind,
                skipped: true,
                skipReason: claim.reason,
                skippedAt: rebuiltAt,
            };
        }
        try {
            const existingSources = this.store.listMemorySources(10_000);
            const treeBuildResult = (() => {
                switch (kind) {
                    case "topic":
                        return this.buildTopicMemoryTreeNodes(limit, rebuiltAt, existingSources);
                    case "conversation":
                        return this.buildConversationMemoryTreeNodes(limit, rebuiltAt);
                    case "day":
                        return this.buildDayMemoryTreeNodes(limit, rebuiltAt);
                    case "project":
                        return this.buildProjectMemoryTreeNodes(limit, rebuiltAt);
                    case "agent":
                        return this.buildAgentMemoryTreeNodes(limit, rebuiltAt);
                    case "profile":
                        return buildProfileMemoryTreeNodes({
                            limit,
                            rebuiltAt,
                            tasks: this.collectDetailedMemoryTreeTasks(Math.max(limit * 20, 200)),
                            resolveChunk: (chunkId) => this.store.getChunk(chunkId),
                            rankChunks: (chunks) => rankMemoryTreeTopicChunks(
                                this.applyMemoryTreeScoreSignals(applySearchResultSourceRegistryHints(chunks)),
                            ),
                            existingSources,
                        });
                    case "global":
                        return buildGlobalMemoryTreeNodes({
                            limit,
                            rebuiltAt,
                            tasks: this.collectDetailedMemoryTreeTasks(Math.max(limit * 20, 200)),
                            resolveChunk: (chunkId) => this.store.getChunk(chunkId),
                            rankChunks: (chunks) => rankMemoryTreeTopicChunks(
                                this.applyMemoryTreeScoreSignals(applySearchResultSourceRegistryHints(chunks)),
                            ),
                            existingSources,
                        });
                    case "task":
                    default:
                        return this.buildTaskMemoryTreeNodes(limit, rebuiltAt);
                }
            })();
            const { nodes, edges, inputDetails } = treeBuildResult;
            const sourceRecords = Array.isArray((treeBuildResult as { sourceRecords?: MemoryTreeSourceRecord[] }).sourceRecords)
                ? (treeBuildResult as { sourceRecords?: MemoryTreeSourceRecord[] }).sourceRecords ?? []
                : [];

            this.store.publishMemoryTreeKind({
                kind,
                nodes,
                edges,
                sourceRecords,
            });
            this.recordMemoryTreeReport({
                reportType: "tree_build_preview",
                scope: "private",
                createdBy: "rpc",
                inputVersion: hashMemoryTreePayload({
                    kind,
                    limit,
                    inputDetails,
                    sourceRecordCount: sourceRecords.length,
                }),
                summary: {
                    nodeKind: kind,
                    nodeCount: nodes.length,
                    edgeCount: edges.length,
                    limit,
                },
                details: {
                    rebuiltAt,
                    kind,
                    nodes,
                    edges,
                    inputDetails,
                    ...(sourceRecords.length > 0 ? { sourceRecords } : {}),
                },
            });
            this.store.setMeta("memory_tree_nodes_last_rebuilt_at", rebuiltAt);
            if (isManagedMemoryTreeNodeKind(kind)) {
                this.store.setMeta(buildManagedMemoryTreeNodeLastRebuiltAtMetaKey(kind), rebuiltAt);
                this.store.setMeta(buildManagedMemoryTreeNodeLastMemorySeqMetaKey(kind), String(this.store.getMemoryChangeSeq()));
                this.store.setMeta(buildManagedMemoryTreeNodeLastTaskSeqMetaKey(kind), String(this.store.getTaskChangeSeq()));
                recordMemoryTreeJobLedgerSuccess(this.store, {
                    jobType: "node_rebuild",
                    targetKey: kind,
                    completedAt: rebuiltAt,
                    triggerSource,
                });
                this.clearMemoryTreeLifecycleGovernance(kind);
            }
            return {
                rebuiltAt,
                totalNodes: nodes.length,
                totalEdges: edges.length,
                kind,
            };
        } catch (error) {
            if (isManagedMemoryTreeNodeKind(kind)) {
                this.recordMemoryTreeLifecycleFailure(kind, error, rebuiltAt, triggerSource);
            }
            throw error;
        } finally {
            claim?.release();
        }
    }

    private readMemoryTreeLifecycleGovernance(
        target: "source" | ManagedMemoryTreeNodeKind,
        checkedAt: string,
    ): MemoryTreeLifecycleGovernanceState {
        return buildMemoryTreeLifecycleGovernanceState({
            failureCount: readNumericMetaValue(this.store.getMeta(this.buildMemoryTreeLifecycleFailureCountMetaKey(target))),
            lastFailureAt: readTextMetaValue(this.store.getMeta(this.buildMemoryTreeLifecycleLastFailureAtMetaKey(target))),
            lastError: readTextMetaValue(this.store.getMeta(this.buildMemoryTreeLifecycleLastErrorMetaKey(target))),
            cooldownUntil: readTextMetaValue(this.store.getMeta(this.buildMemoryTreeLifecycleCooldownUntilMetaKey(target))),
            checkedAt,
        });
    }

    private clearMemoryTreeLifecycleGovernance(target: "source" | ManagedMemoryTreeNodeKind): void {
        this.store.setMeta(this.buildMemoryTreeLifecycleFailureCountMetaKey(target), "0");
        this.store.setMeta(this.buildMemoryTreeLifecycleLastFailureAtMetaKey(target), "");
        this.store.setMeta(this.buildMemoryTreeLifecycleLastErrorMetaKey(target), "");
        this.store.setMeta(this.buildMemoryTreeLifecycleCooldownUntilMetaKey(target), "");
    }

    private recordMemoryTreeLifecycleFailure(
        target: "source" | ManagedMemoryTreeNodeKind,
        error: unknown,
        failedAt: string,
        triggerSource?: string,
    ): void {
        const failureCount = readNumericMetaValue(this.store.getMeta(this.buildMemoryTreeLifecycleFailureCountMetaKey(target))) + 1;
        const cooldownMs = resolveMemoryTreeLifecycleFailureCooldownMs(failureCount);
        const failedAtMs = Date.parse(failedAt);
        const cooldownUntil = Number.isFinite(failedAtMs)
            ? new Date(failedAtMs + cooldownMs).toISOString()
            : new Date(Date.now() + cooldownMs).toISOString();
        this.store.setMeta(this.buildMemoryTreeLifecycleFailureCountMetaKey(target), String(failureCount));
        this.store.setMeta(this.buildMemoryTreeLifecycleLastFailureAtMetaKey(target), failedAt);
        this.store.setMeta(this.buildMemoryTreeLifecycleLastErrorMetaKey(target), truncateMemoryTreeLifecycleErrorMessage(error));
        this.store.setMeta(this.buildMemoryTreeLifecycleCooldownUntilMetaKey(target), cooldownUntil);
        recordMemoryTreeJobLedgerFailure(this.store, {
            jobType: target === "source" ? "source_rebuild" : "node_rebuild",
            targetKey: target,
            failedAt,
            error,
            triggerSource: typeof triggerSource === "string" && triggerSource.trim().length > 0
                ? triggerSource.trim()
                : target === "source"
                    ? "memory.tree.source.rebuild"
                    : "memory.tree.node.rebuild",
        });
    }

    private buildMemoryTreeLifecycleFailureCountMetaKey(target: "source" | ManagedMemoryTreeNodeKind): string {
        return target === "source"
            ? buildMemoryTreeSourcesFailureCountMetaKey()
            : buildManagedMemoryTreeNodeFailureCountMetaKey(target);
    }

    private buildMemoryTreeLifecycleLastFailureAtMetaKey(target: "source" | ManagedMemoryTreeNodeKind): string {
        return target === "source"
            ? buildMemoryTreeSourcesLastFailureAtMetaKey()
            : buildManagedMemoryTreeNodeLastFailureAtMetaKey(target);
    }

    private buildMemoryTreeLifecycleLastErrorMetaKey(target: "source" | ManagedMemoryTreeNodeKind): string {
        return target === "source"
            ? buildMemoryTreeSourcesLastErrorMetaKey()
            : buildManagedMemoryTreeNodeLastErrorMetaKey(target);
    }

    private buildMemoryTreeLifecycleCooldownUntilMetaKey(target: "source" | ManagedMemoryTreeNodeKind): string {
        return target === "source"
            ? buildMemoryTreeSourcesCooldownUntilMetaKey()
            : buildManagedMemoryTreeNodeCooldownUntilMetaKey(target);
    }

    private buildTaskMemoryTreeNodes(limit: number, rebuiltAt: string): {
        nodes: MemoryTreeNodeRecord[];
        edges: MemoryTreeEdgeRecord[];
        inputDetails: Record<string, unknown>;
    } {
        const taskRecords = this.store.listTasks(limit, { status: ["success", "partial", "failed"] });
        const tasks = this.getTaskDetails(taskRecords.map((task) => task.id));
        const nodes: MemoryTreeNodeRecord[] = [];
        const edges: MemoryTreeEdgeRecord[] = [];

        for (const task of tasks) {
            const linkedChunks = task.memoryLinks ?? [];
            const sourceClassMix = buildMemoryTreeSourceClassMix(linkedChunks);
            nodes.push({
                id: `task:${task.id}`,
                level: 1,
                kind: "task",
                scope: "private",
                agentId: task.agentId ?? undefined,
                topicKey: task.conversationId,
                title: task.title ?? task.objective ?? `Task ${task.id}`,
                summary: buildMemoryTreeTaskSummary(task),
                summaryVersion: "p10-task-node-v1",
                timeFrom: task.startedAt,
                timeTo: task.finishedAt ?? task.updatedAt,
                sourceClassMix,
                metadata: {
                    taskId: task.id,
                    conversationId: task.conversationId,
                    status: task.status,
                    linkedChunkCount: linkedChunks.length,
                    activityCount: task.activities?.length ?? 0,
                    usedMethodCount: task.usedMethods?.length ?? 0,
                    usedSkillCount: task.usedSkills?.length ?? 0,
                },
                createdAt: rebuiltAt,
                updatedAt: rebuiltAt,
            });
            linkedChunks.forEach((link, index) => {
                edges.push({
                    id: `edge:task:${task.id}:chunk:${link.chunkId}:${link.relation}`,
                    parentNodeId: `task:${task.id}`,
                    childType: "chunk",
                    childId: link.chunkId,
                    relation: "contains",
                    position: index,
                    weight: 1,
                    metadata: {
                        relation: link.relation,
                        sourcePath: link.sourcePath,
                        memoryType: link.memoryType,
                        visibility: link.visibility,
                    },
                    createdAt: rebuiltAt,
                });
            });
        }

        return {
            nodes,
            edges,
            inputDetails: {
                taskLimit: limit,
                taskCount: taskRecords.length,
            },
        };
    }

    private buildTopicMemoryTreeNodes(limit: number, rebuiltAt: string, existingSources: MemoryTreeSourceRecord[]): {
        nodes: MemoryTreeNodeRecord[];
        edges: MemoryTreeEdgeRecord[];
        inputDetails: Record<string, unknown>;
        sourceRecords?: MemoryTreeSourceRecord[];
    } {
        const summaries = this.store.listChunkTopicSummaries().slice(0, Math.max(limit * 5, 100));
        return buildTopicMemoryTreeNodes({
            limit,
            rebuiltAt,
            explicitTopics: summaries.map((summary) => ({
                topic: summary.topic,
                agentId: summary.agentId ?? undefined,
                scope: summary.scope,
                chunks: this.store.getChunksByTopic(summary.topic, {
                    maxPerTopic: Math.max(1, Math.min(summary.itemCount, 200)),
                    agentId: summary.agentId ?? null,
                    scope: summary.scope,
                }),
                timeFrom: summary.timeFrom,
                timeTo: summary.timeTo,
                memoryTypes: summary.memoryTypes,
            })),
            tasks: this.collectDetailedMemoryTreeTasks(Math.max(limit * 20, 200)),
            resolveChunk: (chunkId) => this.store.getChunk(chunkId),
            rankChunks: (chunks) => rankMemoryTreeTopicChunks(
                this.applyMemoryTreeScoreSignals(applySearchResultSourceRegistryHints(chunks)),
            ),
            existingSources,
        });
    }

    private buildConversationMemoryTreeNodes(limit: number, rebuiltAt: string): {
        nodes: MemoryTreeNodeRecord[];
        edges: MemoryTreeEdgeRecord[];
        inputDetails: Record<string, unknown>;
    } {
        return this.buildGroupedTaskMemoryTreeNodes({
            kind: "conversation",
            level: 1,
            limit,
            rebuiltAt,
            collectKey: (task) => task.conversationId,
            buildNodeId: (key) => buildMemoryTreeConversationNodeId(key),
            buildTitle: (key) => `Conversation: ${key}`,
            buildSummary: (key, tasks) => buildMemoryTreeAggregateSummary(`Conversation ${key}`, tasks),
            buildNodeAgentId: (tasks) => resolveUniformTaskAgentId(tasks),
            buildMetadata: (key, tasks, bundle) => ({
                conversationId: key,
                taskCount: tasks.length,
                linkedChunkCount: bundle.linkedChunkCount,
                activityCount: bundle.activityCount,
                statusCounts: buildMemoryTreeTaskStatusCounts(tasks),
                goalIds: collectTaskGoalIds(tasks),
                agentIds: collectTaskAgentIds(tasks),
            }),
        });
    }

    private buildDayMemoryTreeNodes(limit: number, rebuiltAt: string): {
        nodes: MemoryTreeNodeRecord[];
        edges: MemoryTreeEdgeRecord[];
        inputDetails: Record<string, unknown>;
    } {
        return this.buildGroupedTaskMemoryTreeNodes({
            kind: "day",
            level: 2,
            limit,
            rebuiltAt,
            collectKey: (task) => buildMemoryTreeDayKey(task),
            buildNodeId: (key) => buildMemoryTreeDayNodeId(key),
            buildTitle: (key) => `Day: ${key}`,
            buildSummary: (key, tasks) => buildMemoryTreeAggregateSummary(`Day ${key}`, tasks),
            buildNodeAgentId: (tasks) => resolveUniformTaskAgentId(tasks),
            buildMetadata: (key, tasks, bundle) => ({
                day: key,
                taskCount: tasks.length,
                linkedChunkCount: bundle.linkedChunkCount,
                activityCount: bundle.activityCount,
                statusCounts: buildMemoryTreeTaskStatusCounts(tasks),
                conversationCount: collectTaskConversationIds(tasks).length,
                goalIds: collectTaskGoalIds(tasks),
                agentIds: collectTaskAgentIds(tasks),
            }),
        });
    }

    private buildProjectMemoryTreeNodes(limit: number, rebuiltAt: string): {
        nodes: MemoryTreeNodeRecord[];
        edges: MemoryTreeEdgeRecord[];
        inputDetails: Record<string, unknown>;
    } {
        return this.buildGroupedTaskMemoryTreeNodes({
            kind: "project",
            level: 2,
            limit,
            rebuiltAt,
            collectKey: (task) => extractTaskGoalId(task),
            buildNodeId: (key) => buildMemoryTreeProjectNodeId(key),
            buildTitle: (key) => `Project: ${key}`,
            buildSummary: (key, tasks) => buildMemoryTreeAggregateSummary(`Project ${key}`, tasks),
            buildNodeAgentId: (tasks) => resolveUniformTaskAgentId(tasks),
            buildMetadata: (key, tasks, bundle) => ({
                goalId: key,
                taskCount: tasks.length,
                linkedChunkCount: bundle.linkedChunkCount,
                activityCount: bundle.activityCount,
                statusCounts: buildMemoryTreeTaskStatusCounts(tasks),
                conversationCount: collectTaskConversationIds(tasks).length,
                agentIds: collectTaskAgentIds(tasks),
                goalSessionCount: tasks.filter((task) => task.metadata?.goalSession === true).length,
            }),
        });
    }

    private buildAgentMemoryTreeNodes(limit: number, rebuiltAt: string): {
        nodes: MemoryTreeNodeRecord[];
        edges: MemoryTreeEdgeRecord[];
        inputDetails: Record<string, unknown>;
    } {
        return this.buildGroupedTaskMemoryTreeNodes({
            kind: "agent",
            level: 3,
            limit,
            rebuiltAt,
            collectKey: (task) => task.agentId?.trim() || "default",
            buildNodeId: (key) => buildMemoryTreeAgentNodeId(key),
            buildTitle: (key) => `Agent: ${key}`,
            buildSummary: (key, tasks) => buildMemoryTreeAggregateSummary(`Agent ${key}`, tasks),
            buildNodeAgentId: (tasks, key) => key,
            buildMetadata: (key, tasks, bundle) => ({
                agentId: key,
                taskCount: tasks.length,
                linkedChunkCount: bundle.linkedChunkCount,
                activityCount: bundle.activityCount,
                statusCounts: buildMemoryTreeTaskStatusCounts(tasks),
                conversationCount: collectTaskConversationIds(tasks).length,
                goalIds: collectTaskGoalIds(tasks),
            }),
        });
    }

    private buildGroupedTaskMemoryTreeNodes(input: {
        kind: "conversation" | "day" | "project" | "agent";
        level: number;
        limit: number;
        rebuiltAt: string;
        collectKey: (task: TaskExperienceDetail) => string | undefined;
        buildNodeId: (key: string) => string;
        buildTitle: (key: string, tasks: TaskExperienceDetail[]) => string;
        buildSummary: (key: string, tasks: TaskExperienceDetail[]) => string;
        buildNodeAgentId?: (tasks: TaskExperienceDetail[], key: string) => string | undefined;
        buildMetadata: (
            key: string,
            tasks: TaskExperienceDetail[],
            bundle: {
                linkedChunkCount: number;
                activityCount: number;
            },
        ) => Record<string, unknown>;
    }): {
        nodes: MemoryTreeNodeRecord[];
        edges: MemoryTreeEdgeRecord[];
        inputDetails: Record<string, unknown>;
    } {
        const candidateLimit = Math.max(input.limit * 20, 200);
        const tasks = this.getTaskDetails(this.store
            .listTasks(candidateLimit, { status: ["success", "partial", "failed"] })
            .map((task) => task.id));
        const groups = new Map<string, TaskExperienceDetail[]>();
        for (const task of tasks) {
            const key = input.collectKey(task)?.trim();
            if (!key) {
                continue;
            }
            const bucket = groups.get(key);
            if (bucket) {
                bucket.push(task);
            } else {
                groups.set(key, [task]);
            }
        }

        const rankedGroups = [...groups.entries()]
            .map(([key, groupedTasks]) => ({
                key,
                tasks: groupedTasks,
                latestTimestamp: resolveLatestTaskTimestamp(groupedTasks),
            }))
            .sort((a, b) => {
                if (b.latestTimestamp !== a.latestTimestamp) {
                    return b.latestTimestamp - a.latestTimestamp;
                }
                return a.key.localeCompare(b.key);
            })
            .slice(0, input.limit);

        const nodes: MemoryTreeNodeRecord[] = [];
        const edges: MemoryTreeEdgeRecord[] = [];
        for (const group of rankedGroups) {
            const nodeId = input.buildNodeId(group.key);
            const chunkBundle = this.buildTaskGroupChunkBundle(group.tasks, nodeId, input.rebuiltAt);
            const timeRange = resolveTaskGroupTimeRange(group.tasks);
            nodes.push({
                id: nodeId,
                level: input.level,
                kind: input.kind,
                scope: "private",
                agentId: input.buildNodeAgentId?.(group.tasks, group.key),
                topicKey: group.key,
                title: input.buildTitle(group.key, group.tasks),
                summary: input.buildSummary(group.key, group.tasks),
                summaryVersion: `p17-${input.kind}-node-v1`,
                timeFrom: timeRange.timeFrom,
                timeTo: timeRange.timeTo,
                sourceClassMix: chunkBundle.sourceClassMix,
                metadata: input.buildMetadata(group.key, group.tasks, {
                    linkedChunkCount: chunkBundle.linkedChunkCount,
                    activityCount: group.tasks.reduce((total, task) => total + (task.activities?.length ?? 0), 0),
                }),
                createdAt: input.rebuiltAt,
                updatedAt: input.rebuiltAt,
            });
            edges.push(...chunkBundle.edges);
        }

        return {
            nodes,
            edges,
            inputDetails: {
                taskCandidateLimit: candidateLimit,
                groupedTaskCount: tasks.length,
                groupCount: groups.size,
            },
        };
    }

    private collectDetailedMemoryTreeTasks(limit: number): TaskExperienceDetail[] {
        return this.getTaskDetails(this.store
            .listTasks(limit, { status: ["success", "partial", "failed"] })
            .map((task) => task.id));
    }

    private buildTaskGroupChunkBundle(
        tasks: TaskExperienceDetail[],
        nodeId: string,
        rebuiltAt: string,
    ): {
        edges: MemoryTreeEdgeRecord[];
        sourceClassMix: Record<string, number>;
        linkedChunkCount: number;
    } {
        const chunkLinks = tasks.flatMap((task) => task.memoryLinks ?? []);
        const chunkMap = new Map<string, {
            chunk: MemorySearchResult;
            taskIds: Set<string>;
            relations: Set<string>;
        }>();
        for (const task of tasks) {
            for (const link of task.memoryLinks ?? []) {
                const chunk = this.store.getChunk(link.chunkId);
                if (!chunk) {
                    continue;
                }
                const existing = chunkMap.get(link.chunkId);
                if (existing) {
                    existing.taskIds.add(task.id);
                    existing.relations.add(link.relation);
                    continue;
                }
                chunkMap.set(link.chunkId, {
                    chunk,
                    taskIds: new Set([task.id]),
                    relations: new Set([link.relation]),
                });
            }
        }

        const rankedChunks = rankMemoryTreeTopicChunks(this.applyMemoryTreeScoreSignals([...chunkMap.values()].map((item) => item.chunk)));
        const edges = rankedChunks.map((chunk, index) => {
            const aggregate = chunkMap.get(chunk.id);
            return {
                id: `edge:${nodeId}:chunk:${chunk.id}`,
                parentNodeId: nodeId,
                childType: "chunk" as const,
                childId: chunk.id,
                relation: "contains",
                position: index,
                weight: Number.isFinite(chunk.score) ? chunk.score : undefined,
                metadata: {
                    sourcePath: chunk.sourcePath,
                    memoryType: chunk.memoryType,
                    visibility: chunk.visibility,
                    taskIds: aggregate ? [...aggregate.taskIds] : [],
                    linkRelations: aggregate ? [...aggregate.relations] : [],
                },
                createdAt: rebuiltAt,
            };
        });

        return {
            edges,
            sourceClassMix: buildMemoryTreeSourceClassMix(chunkLinks),
            linkedChunkCount: rankedChunks.length,
        };
    }

    listMemoryTreeNodes(limit = 100, filter?: MemoryTreeNodeListFilter): MemoryTreeNodeRecord[] {
        return this.store.listMemoryTreeNodes(limit, filter);
    }

    getMemoryTreeNode(nodeId: string): MemoryTreeNodeRecord | null {
        return this.store.getMemoryTreeNode(nodeId);
    }

    getMemoryTreeNodeDetail(nodeId: string, options: { chunkLimit?: number } = {}): MemoryTreeNodeDetailResult | null {
        return this.getMemoryTreeNodeDetails([nodeId], options).get(nodeId) ?? null;
    }

    getMemoryTreeNodeDetails(
        nodeIds: string[],
        options: { chunkLimit?: number } = {},
    ): Map<string, MemoryTreeNodeDetailResult> {
        return this.store.getMemoryTreeNodeDetails(nodeIds, options);
    }

    listMemoryTreeEdges(filter?: MemoryTreeEdgeListFilter): MemoryTreeEdgeRecord[] {
        return this.store.listMemoryTreeEdges(filter);
    }

    searchMemoryTreeNodes(query: string, options: {
        limit?: number;
        filter?: MemoryTreeNodeListFilter;
        chunkLimitPerNode?: number;
    } = {}): MemoryTreeNodeSearchResult[] {
        const normalizedQuery = normalizeMemoryTreeNodeText(query);
        if (!normalizedQuery) {
            return [];
        }
        const routingPlan = resolveMemoryTreeNodeRoutingPlan(query, buildRoutingPlanFilterFromNodeListFilter(options.filter));
        const limit = typeof options.limit === "number" && Number.isFinite(options.limit)
            ? Math.max(1, Math.floor(options.limit))
            : 10;
        const candidates = this.store.listMemoryTreeNodes(Math.max(limit * 10, 100), options.filter);
        const ranked = candidates
            .map((node) => {
                const match = scoreMemoryTreeNode(node, normalizedQuery, routingPlan);
                return {
                    node,
                    score: match.score,
                    matchReasons: match.matchReasons,
                };
            })
            .filter((item) => item.score > 0)
            .sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                return compareMemoryTreeNodeRecency(a.node, b.node);
            })
            .slice(0, limit);
        const details = this.getMemoryTreeNodeDetails(
            ranked.map((item) => item.node.id),
            { chunkLimit: options.chunkLimitPerNode },
        );
        return ranked.map((item) => {
            const detail = details.get(item.node.id);
            return {
                node: item.node,
                score: item.score,
                matchReasons: item.matchReasons,
                edges: detail?.edges ?? [],
                chunks: detail?.chunks ?? [],
                sources: detail?.sources ?? [],
            };
        });
    }

    previewExactDedup(filter?: MemorySearchFilter, options: { maxGroups?: number } = {}): MemoryExactDedupPreviewReport {
        const report = this.store.previewExactDedup(filter, options);
        const dbStats = this.store.getDatabasePageStats();
        return this.decorateExactDedupPreviewReport(report, dbStats);
    }

    applyExactDedup(filter: MemorySearchFilter | undefined, options: MemoryExactDedupApplyOptions): MemoryExactDedupApplyResult {
        const beforeDbStats = this.store.getDatabasePageStats();
        const result = this.store.applyExactDedup(filter, options);
        const afterDbStats = this.store.getDatabasePageStats();
        return {
            ...result,
            observability: {
                beforeChunkCount: result.totals.scannedChunks,
                afterChunkCount: Math.max(0, result.totals.scannedChunks - result.totals.removedChunks),
                beforePageCount: beforeDbStats.pageCount,
                afterPageCount: afterDbStats.pageCount,
                beforeFreelistCount: beforeDbStats.freelistCount,
                afterFreelistCount: afterDbStats.freelistCount,
            },
        };
    }

    previewMemoryVacuum(): MemoryVacuumPreviewReport {
        const observability = this.store.getDatabaseVacuumObservability();
        return {
            mode: "dry_run",
            requiresConfirmed: true,
            recommended: observability.freelistCount > 0 || observability.estimatedReclaimableBytes > 0 || observability.walFileBytes > 0,
            observability,
            warnings: buildMemoryVacuumWarnings(observability),
        };
    }

    applyMemoryVacuum(options: MemoryVacuumApplyOptions): MemoryVacuumApplyResult {
        return this.store.applyMemoryVacuum(options);
    }

    private decorateExactDedupPreviewReport(
        report: MemoryExactDedupPreviewReport,
        dbStats: { pageCount: number; freelistCount: number },
    ): MemoryExactDedupPreviewReport {
        const sourceInfoCache = new Map<string, MemoryDedupSourceIndexInfo>();
        const uniqueSourcePaths = new Set<string>();
        let duplicateGroupsWithReindexableSources = 0;
        let duplicateGroupsWithOnlyNonReindexableSources = 0;

        const classifySourcePath = (sourcePath: string): MemoryDedupSourceIndexInfo => {
            const cacheKey = String(sourcePath ?? "").trim();
            const cached = sourceInfoCache.get(cacheKey);
            if (cached) {
                return cached;
            }
            const resolved = this.classifyDedupSourcePath(cacheKey);
            sourceInfoCache.set(cacheKey, resolved);
            return resolved;
        };

        const groups = report.groups.map((group) => {
            const keep = {
                ...group.keep,
                sourceIndexing: classifySourcePath(group.keep.sourcePath),
            };
            const remove = group.remove.map((item) => ({
                ...item,
                sourceIndexing: classifySourcePath(item.sourcePath),
            }));
            const groupSourceInfos = group.affectedSourcePaths.map((sourcePath) => {
                uniqueSourcePaths.add(sourcePath);
                return classifySourcePath(sourcePath);
            });
            const sourceIndexing = summarizeDedupGroupSourceIndexing(groupSourceInfos);
            if (sourceIndexing.anyAffectedSourcePathReindexable) {
                duplicateGroupsWithReindexableSources += 1;
            } else {
                duplicateGroupsWithOnlyNonReindexableSources += 1;
            }
            return {
                ...group,
                keep,
                remove,
                sourceIndexing,
            };
        });

        let reindexableSourcePathCount = 0;
        let nonReindexableSourcePathCount = 0;
        for (const sourcePath of uniqueSourcePaths) {
            const info = classifySourcePath(sourcePath);
            if (info.reindexable) {
                reindexableSourcePathCount += 1;
            } else {
                nonReindexableSourcePathCount += 1;
            }
        }

        const sourceIndexingSummary: MemoryDedupSourceIndexSummary = {
            reindexableSourcePathCount,
            nonReindexableSourcePathCount,
            duplicateGroupsWithReindexableSources,
            duplicateGroupsWithOnlyNonReindexableSources,
        };

        return decorateMemoryExactDedupReportWithGovernance({
            ...report,
            groups,
            observability: {
                beforeChunkCount: report.totals.scannedChunks,
                estimatedAfterChunkCount: Math.max(0, report.totals.scannedChunks - report.totals.removableChunks),
                pageCount: dbStats.pageCount,
                freelistCount: dbStats.freelistCount,
            },
            sourceIndexingSummary,
        }, {
            topGroupLimit: 5,
        });
    }

    private classifyDedupSourcePath(sourcePath: string): MemoryDedupSourceIndexInfo {
        const normalizedSourcePath = String(sourcePath ?? "").trim();
        if (!normalizedSourcePath) {
            return {
                reindexable: false,
                scope: "external",
                matchedPath: null,
            };
        }

        const stateMemoryFilePath = path.resolve(this.publishStateDir, "MEMORY.md");
        const stateMemoryRootPath = path.resolve(this.publishStateDir, "memory");
        const teamMemoryFilePath = path.resolve(this.publishStateDir, "team-memory", "MEMORY.md");
        const teamMemoryRootPath = path.resolve(this.publishStateDir, "team-memory", "memory");

        if (!path.isAbsolute(normalizedSourcePath)) {
            const normalizedRelative = normalizedSourcePath.replace(/\\/g, "/").toLowerCase();
            if (normalizedRelative === "memory.md") {
                return {
                    reindexable: true,
                    scope: "state_memory_file",
                    matchedPath: stateMemoryFilePath,
                };
            }
            if (normalizedRelative.startsWith("memory/")) {
                return {
                    reindexable: true,
                    scope: "state_memory_root",
                    matchedPath: stateMemoryRootPath,
                };
            }
            if (normalizedRelative === "team-memory/memory.md") {
                return {
                    reindexable: true,
                    scope: "team_memory_file",
                    matchedPath: teamMemoryFilePath,
                };
            }
            if (normalizedRelative.startsWith("team-memory/memory/")) {
                return {
                    reindexable: true,
                    scope: "team_memory_root",
                    matchedPath: teamMemoryRootPath,
                };
            }
        }

        const candidatePaths = path.isAbsolute(normalizedSourcePath)
            ? [path.resolve(normalizedSourcePath)]
            : dedupePaths([
                path.resolve(this.publishStateDir, normalizedSourcePath),
            ]).map((item) => path.resolve(item));
        const candidateComparablePaths = candidatePaths.map(toComparablePath);
        const comparableStateMemoryFilePath = toComparablePath(stateMemoryFilePath);
        const comparableTeamMemoryFilePath = toComparablePath(teamMemoryFilePath);

        for (const candidatePath of candidatePaths) {
            const comparableCandidatePath = toComparablePath(candidatePath);
            if (comparableCandidatePath === comparableStateMemoryFilePath) {
                return {
                    reindexable: true,
                    scope: "state_memory_file",
                    matchedPath: stateMemoryFilePath,
                };
            }
            if (comparableCandidatePath === comparableTeamMemoryFilePath) {
                return {
                    reindexable: true,
                    scope: "team_memory_file",
                    matchedPath: teamMemoryFilePath,
                };
            }
            if (isPathWithinRoot(candidatePath, stateMemoryRootPath)) {
                return {
                    reindexable: true,
                    scope: "state_memory_root",
                    matchedPath: stateMemoryRootPath,
                };
            }
            if (isPathWithinRoot(candidatePath, teamMemoryRootPath)) {
                return {
                    reindexable: true,
                    scope: "team_memory_root",
                    matchedPath: teamMemoryRootPath,
                };
            }
        }

        for (const filePath of this.additionalFiles.map((item) => path.resolve(item))) {
            const comparableFilePath = toComparablePath(filePath);
            if (candidateComparablePaths.includes(comparableFilePath)) {
                return {
                    reindexable: true,
                    scope: deriveIndexedFileScope(filePath, this.publishStateDir, stateMemoryFilePath),
                    matchedPath: filePath,
                };
            }
        }

        if (path.isAbsolute(normalizedSourcePath)) {
            const workspaceRootPath = path.resolve(this.workspaceRoot);
            for (const candidatePath of candidatePaths) {
                if (isPathWithinRoot(candidatePath, workspaceRootPath)) {
                    return {
                        reindexable: true,
                        scope: "workspace_sessions",
                        matchedPath: workspaceRootPath,
                    };
                }
            }
        }

        for (const rootPath of this.additionalRoots.map((item) => path.resolve(item))) {
            for (const candidatePath of candidatePaths) {
                if (isPathWithinRoot(candidatePath, rootPath)) {
                    return {
                        reindexable: true,
                        scope: deriveIndexedRootScope(rootPath, this.publishStateDir, stateMemoryRootPath),
                        matchedPath: rootPath,
                    };
                }
            }
        }

        return {
            reindexable: false,
            scope: "external",
            matchedPath: null,
        };
    }

    getContextInjectionMemories(options: {
        limit?: number;
        agentId?: string | null;
        includeSession?: boolean;
        allowedCategories?: MemoryCategory[];
    } = {}): ContextInjectionMemory[] {
        const limit = options.limit ?? 5;
        const includeSession = options.includeSession ?? false;
        const allowedCategories = options.allowedCategories?.length
            ? new Set(options.allowedCategories)
            : null;

        const recent = this.store.getRecentChunks(Math.max(limit * 6, 24), {
            agentId: options.agentId,
        }, false);

        return recent
            .filter((item) => includeSession || item.memoryType !== "session")
            .filter((item) => !allowedCategories || (!!item.category && allowedCategories.has(item.category)))
            .map((item) => {
                const scored = scoreForContextInjection(item);
                return {
                    ...item,
                    importance: classifyImportance(scored.score),
                    importanceScore: scored.score,
                    rationale: scored.rationale,
                };
            })
            .sort((a, b) => b.importanceScore - a.importanceScore)
            .slice(0, limit);
    }

    getRecentTaskSummaries(limit = 3, filter?: TaskSearchFilter): RecentTaskSummary[] {
        return this.store
            .listTaskSummaries(Math.max(limit * 3, 12), filter)
            .filter((task) => task.status === "success" || task.status === "partial")
            .slice(0, limit)
            .map((task) => toRecentTaskSummary(task));
    }

    getRecentWork(input: {
        query?: string;
        limit?: number;
        filter?: TaskSearchFilter;
    } = {}): TaskWorkShortcutItem[] {
        const limit = clampTaskLookupLimit(input.limit);
        const query = normalizeTaskLookupQuery(input.query);
        const recentCandidates = this.collectTaskShortcutCandidates(Math.max(limit * 6, 24), input.filter);

        if (!query) {
            return recentCandidates
                .sort(compareTaskShortcutRecency)
                .slice(0, limit)
                .map((task) => toTaskWorkShortcutItem(task));
        }

        const fallbackCandidates = this.searchTasks(query, {
            limit: Math.max(limit * 4, 12),
            filter: input.filter,
        });
        const fallbackDetails = this.getTaskDetails(fallbackCandidates.map((task) => task.id));

        return rankTaskShortcutCandidates([
            ...recentCandidates,
            ...fallbackDetails,
        ], query)
            .slice(0, limit)
            .map((item) => toTaskWorkShortcutItem(item.task, item.matchReasons));
    }

    getResumeContext(input: {
        taskId?: string;
        conversationId?: string;
        query?: string;
        filter?: TaskSearchFilter;
    } = {}): TaskWorkShortcutItem | null {
        const directTaskId = typeof input.taskId === "string" ? input.taskId.trim() : "";
        if (directTaskId) {
            const task = this.getTaskDetail(directTaskId);
            return task ? toTaskWorkShortcutItem(task) : null;
        }

        const directConversationId = typeof input.conversationId === "string" ? input.conversationId.trim() : "";
        if (directConversationId) {
            const task = this.getTaskByConversation(directConversationId);
            if (!task) return null;
            const detail = this.getTaskDetail(task.id);
            return detail ? toTaskWorkShortcutItem(detail) : null;
        }

        const limit = clampTaskLookupLimit(input.filter?.status ? 8 : 6);
        const query = normalizeTaskLookupQuery(input.query);
        const recentCandidates = this.collectTaskShortcutCandidates(Math.max(limit * 6, 24), input.filter);
        const fallbackCandidates = query
            ? this.getTaskDetails(this.searchTasks(query, {
                limit: Math.max(limit * 4, 12),
                filter: input.filter,
            }).map((task) => task.id))
            : [];

        const ranked = rankTaskShortcutCandidates([
            ...recentCandidates,
            ...fallbackCandidates,
        ], query, { resumeMode: true });

        return ranked.length > 0
            ? toTaskWorkShortcutItem(ranked[0].task, ranked[0].matchReasons)
            : null;
    }

    findSimilarPastWork(input: {
        query: string;
        limit?: number;
        filter?: TaskSearchFilter;
    }): TaskWorkShortcutItem[] {
        const query = normalizeTaskLookupQuery(input.query);
        if (!query) return [];

        const limit = clampTaskLookupLimit(input.limit);
        const searchCandidates = this.getTaskDetails(this.searchTasks(query, {
            limit: Math.max(limit * 5, 15),
            filter: input.filter,
        }).map((task) => task.id));
        const recentCandidates = this.collectTaskShortcutCandidates(Math.max(limit * 4, 16), input.filter);

        return rankTaskShortcutCandidates([
            ...searchCandidates,
            ...recentCandidates,
        ], query)
            .slice(0, limit)
            .map((item) => toTaskWorkShortcutItem(item.task, item.matchReasons));
    }

    private collectDerivedTaskSearchResults(query: string, input: {
        limit: number;
        filter?: MemorySearchFilter;
        includeContent: boolean;
        deadlineMs?: number;
    }): DerivedRetrievalExecution {
        if (hasDerivedRetrievalDeadlinePassed(input.deadlineMs)) {
            return buildDeadlineSkippedDerivedRetrievalExecution();
        }
        const normalizedQuery = normalizeTaskLookupQuery(query);
        if (!normalizedQuery) {
            return {
                items: [],
                report: buildDerivedRetrievalReport({
                    admitted: false,
                    skipped: true,
                    skipReason: "empty_query",
                }),
            };
        }
        if (input.filter?.scope === "shared") {
            return {
                items: [],
                report: buildDerivedRetrievalReport({
                    admitted: false,
                    skipped: true,
                    skipReason: "scope",
                }),
            };
        }
        const taskFilter = toTaskSearchFilterFromMemoryFilter(input.filter);
        const resumeLimit = clampTaskLookupLimit(taskFilter?.status ? 8 : 6);
        const similarLimit = clampTaskLookupLimit(Math.max(3, Math.min(input.limit, 5)));
        const recentTaskIds = this.store
            .listTaskSummaries(Math.max(resumeLimit * 6, similarLimit * 4, 24), taskFilter)
            .filter((task) => task.status !== "running")
            .map((task) => task.id);
        const resumeSearchLimit = Math.max(resumeLimit * 4, 12);
        const searchTaskIds = this.searchTasks(normalizedQuery, {
            limit: Math.max(resumeSearchLimit, similarLimit * 5, 15),
            filter: taskFilter,
        }).map((task) => task.id);
        const candidateTaskIds = [...new Set([...recentTaskIds, ...searchTaskIds])];
        const detailsById = new Map(
            this.store.getTaskDerivedDetails(candidateTaskIds)
                .map((task) => [task.id, task]),
        );
        const recentCandidates = taskDetailsForIds(recentTaskIds, detailsById);
        const resumeSearchCandidates = taskDetailsForIds(
            searchTaskIds.slice(0, resumeSearchLimit),
            detailsById,
        );
        const similarSearchCandidates = taskDetailsForIds(searchTaskIds, detailsById);
        const candidates: TaskWorkShortcutItem[] = [];
        const seenTaskIds = new Set<string>();
        const push = (item: TaskWorkShortcutItem | null | undefined) => {
            if (!item || seenTaskIds.has(item.taskId)) return;
            seenTaskIds.add(item.taskId);
            candidates.push(item);
        };
        const resumeCandidate = rankTaskShortcutCandidates([
            ...recentCandidates,
            ...resumeSearchCandidates,
        ], normalizedQuery, { resumeMode: true })[0];
        if (resumeCandidate) {
            push(toTaskWorkShortcutItem(resumeCandidate.task, resumeCandidate.matchReasons));
        }
        for (const item of rankTaskShortcutCandidates([
            ...similarSearchCandidates,
            ...recentCandidates,
        ], normalizedQuery).slice(0, similarLimit)) {
            push(toTaskWorkShortcutItem(item.task, item.matchReasons));
        }
        const items = buildTaskDerivedSearchResults({
            items: candidates,
            limit: Math.max(1, Math.min(input.limit, 3)),
            includeContent: input.includeContent,
        });
        return {
            items,
            report: buildDerivedRetrievalReport({
                admitted: true,
                candidateCount: candidateTaskIds.length,
                detailCount: detailsById.size,
                resultCount: items.length,
                deadlineExceededAfterCompletion: hasDerivedRetrievalDeadlinePassed(input.deadlineMs),
            }),
        };
    }

    private collectDerivedExperienceSearchResults(query: string, input: {
        limit: number;
        filter?: MemorySearchFilter;
        includeContent: boolean;
        deadlineMs?: number;
    }): DerivedRetrievalExecution {
        if (hasDerivedRetrievalDeadlinePassed(input.deadlineMs)) {
            return buildDeadlineSkippedDerivedRetrievalExecution();
        }
        if (!query.trim()) {
            return {
                items: [],
                report: buildDerivedRetrievalReport({
                    admitted: false,
                    skipped: true,
                    skipReason: "empty_query",
                }),
            };
        }
        if (input.filter?.scope === "shared") {
            return {
                items: [],
                report: buildDerivedRetrievalReport({
                    admitted: false,
                    skipped: true,
                    skipReason: "scope",
                }),
            };
        }
        const candidateIds = this.store.searchExperienceDerivedCandidateIds(query, 24, {
            status: ["accepted", "published"],
            synthesisConsumed: false,
            ...(typeof input.filter?.agentId === "string" && input.filter.agentId.trim()
                ? { agentId: input.filter.agentId.trim() }
                : {}),
        });
        const candidates = this.store.getExperienceDerivedCandidates(candidateIds);
        const items = buildExperienceDerivedSearchResults({
            query,
            candidates,
            limit: Math.max(1, Math.min(input.limit, 2)),
            filter: input.filter,
            includeContent: input.includeContent,
        });
        return {
            items,
            report: buildDerivedRetrievalReport({
                admitted: true,
                candidateCount: candidateIds.length,
                detailCount: candidates.length,
                readByteCount: candidates.reduce((total, candidate) => total + Buffer.byteLength(candidate.content), 0),
                resultCount: items.length,
                deadlineExceededAfterCompletion: hasDerivedRetrievalDeadlinePassed(input.deadlineMs),
            }),
        };
    }

    getTaskActivities(taskId: string, limit = 200): TaskActivityRecord[] {
        return this.store.listTaskActivities(taskId, limit);
    }

    findRecentDuplicateToolAction(input: {
        toolName: string;
        actionKey?: string;
        agentId?: string;
        withinMinutes?: number;
    }): TaskRecord | null {
        const actionKey = String(input.actionKey ?? "").trim();
        if (!actionKey) return null;

        const threshold = Date.now() - ((input.withinMinutes ?? 20) * 60 * 1000);
        const candidates = this.store.listTasks(30, {
            agentId: input.agentId,
            status: "success",
        });

        for (const task of candidates) {
            const finishedAt = Date.parse(task.finishedAt ?? task.updatedAt);
            if (!Number.isFinite(finishedAt) || finishedAt < threshold) continue;

            const matched = (task.toolCalls ?? []).some((item) => {
                return item.success && item.toolName === input.toolName && item.actionKey === actionKey;
            });

            if (matched) {
                return task;
            }
        }

        return null;
    }

    startTaskCapture(input: {
        conversationId: string;
        sessionKey: string;
        agentId?: string;
        source: TaskSource;
        objective?: string;
        parentConversationId?: string;
        metadata?: Record<string, unknown>;
    }): string | null {
        return this.taskProcessor.startTask(input);
    }

    recordTaskToolCall(conversationId: string, item: TaskToolCallSummary): void {
        this.taskProcessor.recordToolCall(conversationId, item);
    }

    linkTaskMemories(conversationId: string, chunkIds: string[], relation: TaskMemoryRelation = "used"): void {
        this.taskProcessor.linkMemory(conversationId, chunkIds, relation);
    }

    completeTaskCapture(input: {
        conversationId: string;
        success: boolean;
        durationMs?: number;
        error?: string;
        messages?: unknown[];
    }): string | null {
        const taskId = this.taskProcessor.completeTask(input);
        if (!taskId || !this.experienceAutoPromotionEnabled) {
            return taskId;
        }

        const task = this.store.getTask(taskId);
        if (!task || !this.shouldAutoPromoteTask(task)) {
            return taskId;
        }

        try {
            if (this.experienceAutoMethodEnabled) {
                this.experiencePromoter.promoteTask(taskId, "method");
            }
            if (this.experienceAutoSkillEnabled) {
                this.experiencePromoter.promoteTask(taskId, "skill");
            }
        } catch (err) {
            console.warn("[MemoryManager] Failed to auto-promote experience candidates:", err);
        }

        return taskId;
    }

    getTask(taskId: string): TaskRecord | null {
        return this.store.getTask(taskId);
    }

    getMemory(chunkId: string): MemorySearchResult | null {
        return this.store.getChunk(chunkId);
    }

    getMemoriesBySource(sourcePath: string, limit = 100): MemorySearchResult[] {
        for (const candidatePath of this.resolveSourcePathCandidates(sourcePath)) {
            const chunks = this.store.getChunksBySource(candidatePath, limit);
            if (chunks.length > 0) {
                return chunks;
            }
        }
        return [];
    }

    upsertMemoryChunk(chunk: MemoryChunk): MemorySearchResult | null {
        this.store.upsertChunk(chunk);
        return this.store.getChunk(chunk.id);
    }

    promoteMemoryChunk(chunkId: string): MemorySearchResult | null {
        const updated = this.store.promoteChunkVisibility(chunkId, "shared");
        if (!updated) return null;
        return this.store.getChunk(chunkId);
    }

    promoteMemorySource(sourcePath: string): { count: number; chunks: MemorySearchResult[] } {
        for (const candidatePath of this.resolveSourcePathCandidates(sourcePath)) {
            const count = this.store.promoteSourceVisibility(candidatePath, "shared");
            if (count > 0) {
                return {
                    count,
                    chunks: this.store.getChunksBySource(candidatePath, 100),
                };
            }
        }

        return { count: 0, chunks: [] };
    }

    assignMemorySourceAgent(sourcePath: string, agentId: string): void {
        if (!agentId) return;
        this.store.setSourceAgentId(this.resolveSourcePath(sourcePath), agentId);
    }

    getTaskByConversation(conversationId: string): TaskRecord | null {
        return this.store.getTaskByConversation(conversationId);
    }

    upsertProfileStateEntry(input: UpsertProfileStateEntryInput): ProfileStateEntry {
        return this.store.upsertProfileStateEntry(input);
    }

    getProfileStateEntry(
        path: string,
        filter: Omit<ProfileStateEntryFilter, "path" | "pathPrefix" | "ids"> = {},
    ): ProfileStateEntry | null {
        return this.store.getProfileStateEntry(path, filter);
    }

    listProfileStateEntries(limit = 20, filter: ProfileStateEntryFilter = {}): ProfileStateEntry[] {
        return this.store.listProfileStateEntries(limit, filter);
    }

    deleteProfileStateEntry(path: string, input: DeleteProfileStateEntryInput = {}): ProfileStateEntry | null {
        return this.store.deleteProfileStateEntry(path, input);
    }

    listProfileStateEvents(limit = 50, filter: ProfileStateEventFilter = {}): ProfileStateEvent[] {
        return this.store.listProfileStateEvents(limit, filter);
    }

    getTaskDetail(taskId: string): TaskExperienceDetail | null {
        if (typeof taskId !== "string" || taskId.trim() !== taskId) {
            return null;
        }
        return this.getTaskDetails([taskId])[0] ?? null;
    }

    getTaskDetails(taskIds: string[]): TaskExperienceDetail[] {
        return this.store.getTaskDetails(taskIds);
    }

    getRecentTasks(limit = 10, filter?: TaskSearchFilter): TaskRecord[] {
        return this.store.listTasks(limit, filter);
    }

    getTaskChangeSeq(): number {
        return this.store.getTaskChangeSeq();
    }

    getMemoryChangeSeq(): number {
        return this.store.getMemoryChangeSeq();
    }

    searchTasks(query: string, options: TaskSearchOptions = {}): TaskRecord[] {
        const limit = options.limit ?? 10;
        return this.store.searchTasksKeyword(query, limit, options.filter);
    }

    promoteTaskToMethodCandidate(taskId: string): ExperiencePromoteResult | null {
        return this.experiencePromoter.promoteTask(taskId, "method");
    }

    promoteTaskToSkillCandidate(taskId: string): ExperiencePromoteResult | null {
        return this.experiencePromoter.promoteTask(taskId, "skill");
    }

    checkTaskMethodCandidateDuplicate(taskId: string) {
        return this.experiencePromoter.checkTaskDuplicate(taskId, "method");
    }

    checkTaskSkillCandidateDuplicate(taskId: string) {
        return this.experiencePromoter.checkTaskDuplicate(taskId, "skill");
    }

    getExperienceCandidate(candidateId: string): ExperienceCandidate | null {
        return this.store.getExperienceCandidate(candidateId);
    }

    findExperienceCandidateByTaskAndType(taskId: string, type: ExperienceCandidateType): ExperienceCandidate | null {
        return this.store.findExperienceCandidateByTaskAndType(taskId, type);
    }

    upsertExperienceCandidate(candidate: ExperienceCandidate): ExperienceCandidate {
        const existing = this.store.findExperienceCandidateByTaskAndType(candidate.taskId, candidate.type);
        if (existing) {
            return this.store.updateExperienceCandidate(existing.id, {
                status: candidate.status,
                title: candidate.title,
                slug: candidate.slug,
                content: candidate.content,
                summary: candidate.summary,
                qualityScore: candidate.qualityScore,
                sourceTaskSnapshot: candidate.sourceTaskSnapshot,
                publishedPath: candidate.publishedPath,
                reviewedAt: candidate.reviewedAt,
                acceptedAt: candidate.acceptedAt,
                rejectedAt: candidate.rejectedAt,
                metadata: candidate.metadata,
            }) ?? existing;
        }

        this.store.createExperienceCandidate(candidate);
        return this.store.getExperienceCandidate(candidate.id) ?? candidate;
    }

    createExperienceCandidate(candidate: ExperienceCandidate): ExperienceCandidate {
        this.store.createExperienceCandidate(candidate);
        return this.store.getExperienceCandidate(candidate.id) ?? candidate;
    }

    listExperienceCandidates(limit = 20, filter?: ExperienceCandidateListFilter, offset = 0): ExperienceCandidate[] {
        return this.store.listExperienceCandidates(limit, filter, offset);
    }

    getExperienceCandidateStats(filter?: ExperienceCandidateListFilter): ExperienceCandidateStats {
        return this.store.getExperienceCandidateStats(filter);
    }

    previewExperienceCandidateSynthesis(candidateId: string, options: { limit?: number } = {}): ExperienceSynthesisPreviewResult | null {
        const seedCandidate = this.store.getExperienceCandidate(candidateId);
        if (!seedCandidate) return null;
        const candidates = this.store.listExperienceCandidates(1000, {
            type: seedCandidate.type,
            status: "draft",
            synthesisConsumed: false,
        });
        return buildExperienceSynthesisPreview(seedCandidate, candidates, options);
    }

    createSynthesizedExperienceCandidate(input: {
        seedCandidate: ExperienceCandidate;
        sourceCandidates: ExperienceCandidate[];
        title: string;
        slug: string;
        summary?: string;
        content: string;
        metadata?: ExperienceCandidateMetadata;
    }): ExperienceCandidate {
        const now = new Date().toISOString();
        const sourceCount = Array.isArray(input.sourceCandidates) ? input.sourceCandidates.length : 0;
        const sourceScores = (Array.isArray(input.sourceCandidates) ? input.sourceCandidates : [])
            .map((item) => Number(item?.qualityScore))
            .filter((item) => Number.isFinite(item)) as number[];
        const qualityScore = sourceScores.length > 0
            ? Math.min(100, Math.round((sourceScores.reduce((sum, value) => sum + value, 0) / sourceScores.length) + Math.min(10, sourceCount)))
            : input.seedCandidate.qualityScore;
        const sourceTaskId = input.seedCandidate.sourceTaskSnapshot?.taskId || input.seedCandidate.taskId;
        const taskId = `${sourceTaskId}::synth::${randomUUID().slice(0, 8)}`;
        const candidate: ExperienceCandidate = {
            id: `exp_${randomUUID().slice(0, 8)}`,
            taskId,
            type: input.seedCandidate.type,
            status: "draft",
            title: input.title,
            slug: input.slug,
            content: input.content,
            summary: input.summary,
            qualityScore,
            sourceTaskSnapshot: input.seedCandidate.sourceTaskSnapshot,
            createdAt: now,
            metadata: input.metadata,
        };
        return this.createExperienceCandidate(candidate);
    }

    markExperienceCandidatesSynthesisConsumed(input: {
        candidateIds: string[];
        consumedByCandidateId: string;
        consumedRunId?: string;
        consumedAt?: string;
    }): ExperienceCandidate[] {
        const consumedByCandidateId = String(input.consumedByCandidateId ?? "").trim();
        if (!consumedByCandidateId) return [];
        const consumedAt = String(input.consumedAt ?? "").trim() || new Date().toISOString();
        const consumedRunId = String(input.consumedRunId ?? "").trim() || `synth_${randomUUID().slice(0, 8)}`;
        const updatedCandidates: ExperienceCandidate[] = [];
        const seen = new Set<string>();
        for (const rawCandidateId of Array.isArray(input.candidateIds) ? input.candidateIds : []) {
            const candidateId = String(rawCandidateId ?? "").trim();
            if (!candidateId || candidateId === consumedByCandidateId || seen.has(candidateId)) {
                continue;
            }
            seen.add(candidateId);
            const existing = this.store.getExperienceCandidate(candidateId);
            if (!existing) continue;
            const metadata: ExperienceCandidateMetadata = {
                ...(existing.metadata ?? {}),
                synthesisConsumed: {
                    consumed: true,
                    consumedByCandidateId,
                    consumedAt,
                    consumedRunId,
                },
            };
            const updated = this.store.updateExperienceCandidate(candidateId, { metadata });
            if (updated) {
                updatedCandidates.push(updated);
            }
        }
        return updatedCandidates;
    }

    recordExperienceUsage(input: {
        taskId: string;
        assetType: ExperienceAssetType;
        assetKey: string;
        sourceCandidateId?: string;
        usedVia?: ExperienceUsageVia;
    }): ExperienceUsageRecordResult | null {
        const taskId = String(input.taskId ?? "").trim();
        const assetKey = String(input.assetKey ?? "").trim();
        if (!taskId || !assetKey) return null;

        const task = this.store.getTask(taskId);
        if (!task) return null;

        const existing = this.store.findExperienceUsage(taskId, input.assetType, assetKey);
        if (existing) {
            return { usage: existing, reusedExisting: true };
        }

        const usage: ExperienceUsage = {
            id: randomUUID(),
            taskId,
            assetType: input.assetType,
            assetKey,
            sourceCandidateId: input.sourceCandidateId ?? this.inferExperienceSourceCandidateId(input.assetType, assetKey),
            usedVia: input.usedVia ?? "tool",
            createdAt: new Date().toISOString(),
        };
        this.store.createExperienceUsage(usage);
        return {
            usage: this.store.getExperienceUsage(usage.id) ?? usage,
            reusedExisting: false,
        };
    }

    recordMethodUsage(taskId: string, methodFile: string, options: { sourceCandidateId?: string; usedVia?: ExperienceUsageVia } = {}): ExperienceUsageRecordResult | null {
        return this.recordExperienceUsage({
            taskId,
            assetType: "method",
            assetKey: methodFile,
            sourceCandidateId: options.sourceCandidateId,
            usedVia: options.usedVia ?? "tool",
        });
    }

    recordSkillUsage(taskId: string, skillName: string, options: { sourceCandidateId?: string; usedVia?: ExperienceUsageVia } = {}): ExperienceUsageRecordResult | null {
        return this.recordExperienceUsage({
            taskId,
            assetType: "skill",
            assetKey: skillName,
            sourceCandidateId: options.sourceCandidateId,
            usedVia: options.usedVia ?? "tool",
        });
    }

    getExperienceUsage(usageId: string): ExperienceUsage | null {
        return this.store.getExperienceUsage(usageId);
    }

    revokeExperienceUsage(input: {
        usageId?: string;
        taskId?: string;
        assetType?: ExperienceAssetType;
        assetKey?: string;
    }): ExperienceUsage | null {
        const usageId = String(input.usageId ?? "").trim();
        if (usageId) {
            return this.store.deleteExperienceUsage(usageId);
        }

        const taskId = String(input.taskId ?? "").trim();
        const assetKey = String(input.assetKey ?? "").trim();
        if (!taskId || !assetKey || (input.assetType !== "method" && input.assetType !== "skill")) {
            return null;
        }

        return this.store.deleteExperienceUsageByTaskAsset(taskId, input.assetType, assetKey);
    }

    listExperienceUsages(limit = 20, filter?: ExperienceUsageListFilter): ExperienceUsage[] {
        return this.store.listExperienceUsages(limit, filter);
    }

    getExperienceUsageStats(assetType: ExperienceAssetType, assetKey: string): ExperienceUsageStats {
        return this.store.getExperienceUsageStats(assetType, assetKey);
    }

    listExperienceUsageStats(limit = 50, filter?: Pick<ExperienceUsageListFilter, "assetType" | "assetKey" | "sourceCandidateId">): ExperienceUsageStats[] {
        return this.store.listExperienceUsageStats(limit, filter);
    }

    private inferExperienceSourceCandidateId(assetType: ExperienceAssetType, assetKey: string): string | undefined {
        const normalizedAssetKey = this.normalizeExperienceAssetLookupKey(assetType, assetKey);
        if (!normalizedAssetKey) return undefined;

        const candidates = this.store.listExperienceCandidates(500, {
            type: assetType,
            status: "accepted",
        });

        for (const candidate of candidates) {
            if (assetType === "method") {
                const publishedName = candidate.publishedPath ? path.basename(candidate.publishedPath) : "";
                const slugName = candidate.slug ? `${candidate.slug}.md` : "";
                const titleName = candidate.title ?? "";
                const matched = [
                    publishedName,
                    slugName,
                    titleName,
                ].some((value) => this.normalizeExperienceAssetLookupKey(assetType, value) === normalizedAssetKey);
                if (matched) {
                    return candidate.id;
                }
                continue;
            }

            const skillName = this.extractSkillNameFromCandidate(candidate);
            const publishedDir = candidate.publishedPath ? path.basename(path.dirname(candidate.publishedPath)) : "";
            const matched = [
                skillName,
                candidate.slug,
                candidate.title,
                publishedDir,
            ].some((value) => this.normalizeExperienceAssetLookupKey(assetType, value) === normalizedAssetKey);
            if (matched) {
                return candidate.id;
            }
        }

        return undefined;
    }

    private extractSkillNameFromCandidate(candidate: ExperienceCandidate): string {
        const match = candidate.content.match(/(?:^|\n)name:\s*["']?([^"\n']+)["']?/i);
        return match?.[1]?.trim() || candidate.title;
    }

    private normalizeExperienceAssetKey(value: string | undefined): string {
        return String(value ?? "").trim().toLowerCase();
    }

    private normalizeExperienceAssetLookupKey(assetType: ExperienceAssetType, value: string | undefined): string {
        const normalized = this.normalizeExperienceAssetKey(value)
            .replace(/\\/g, "/")
            .replace(/\/skill\.md$/i, "")
            .replace(/\.md$/i, "")
            .replace(/\s+/g, " ")
            .trim();
        if (assetType !== "skill") {
            return normalized;
        }
        return normalized
            .replace(/技能草稿|skill draft/gi, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    acceptExperienceCandidate(candidateId: string, options: { publishedPath?: string } = {}): ExperienceCandidate | null {
        const existing = this.store.getExperienceCandidate(candidateId);
        if (!existing) return null;
        if (existing.status !== "draft") return null;
        const now = new Date().toISOString();
        const publishedPath = existing.type === "method"
            ? this.publishMethodCandidate(existing, options.publishedPath)
            : options.publishedPath ?? existing.publishedPath;
        return this.store.updateExperienceCandidate(candidateId, {
            status: "accepted",
            reviewedAt: existing.reviewedAt ?? now,
            acceptedAt: now,
            rejectedAt: undefined,
            publishedPath,
        });
    }

    rejectExperienceCandidate(candidateId: string): ExperienceCandidate | null {
        const existing = this.store.getExperienceCandidate(candidateId);
        if (!existing) return null;
        if (existing.status !== "draft") return null;
        const now = new Date().toISOString();
        return this.store.updateExperienceCandidate(candidateId, {
            status: "rejected",
            reviewedAt: existing.reviewedAt ?? now,
            acceptedAt: undefined,
            rejectedAt: now,
        });
    }

    rejectExperienceCandidates(filter?: ExperienceCandidateListFilter): number {
        return this.store.rejectExperienceCandidates(filter);
    }

    deleteExperienceCandidates(filter?: ExperienceCandidateListFilter): number {
        return this.store.deleteExperienceCandidates(filter);
    }

    async linkTaskMemoriesFromSource(
        conversationId: string,
        sourcePath: string,
        relation: TaskMemoryRelation = "generated",
        options: { attempts?: number; delayMs?: number } = {},
    ): Promise<number> {
        if (this.closed) {
            return 0;
        }
        const attempts = Math.max(1, options.attempts ?? 4);
        const delayMs = Math.max(50, options.delayMs ?? 300);
        const candidatePaths = this.resolveSourcePathCandidates(sourcePath);
        const indexedCandidates = new Set<string>();

        for (let attempt = 0; attempt < attempts; attempt++) {
            if (this.closed) {
                return 0;
            }
            for (const candidatePath of candidatePaths) {
                if (this.closed) {
                    return 0;
                }
                let chunks = this.store.getChunksBySource(candidatePath, 100);
                if (chunks.length === 0 && !indexedCandidates.has(candidatePath)) {
                    indexedCandidates.add(candidatePath);
                    await this.indexSourceForTaskLinking(candidatePath);
                    if (this.closed) {
                        return 0;
                    }
                    chunks = this.store.getChunksBySource(candidatePath, 100);
                }
                if (chunks.length === 0) {
                    continue;
                }

                this.taskProcessor.linkMemory(conversationId, chunks.map((chunk) => chunk.id), relation);
                this.taskProcessor.addArtifactPath(conversationId, candidatePath);

                const task = this.store.getTaskByConversation(conversationId);
                if (task) {
                    for (const chunk of chunks) {
                        this.store.linkTaskMemory(task.id, chunk.id, relation);
                    }

                    const artifactPaths = [...new Set([...(task.artifactPaths ?? []), candidatePath])];
                    this.store.updateTask(task.id, { artifactPaths });
                }
                return chunks.length;
            }

            if (attempt < attempts - 1) {
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
        }

        if (this.closed) {
            return 0;
        }
        const resolvedSourcePath = candidatePaths[0] ?? sourcePath;
        this.taskProcessor.addArtifactPath(conversationId, resolvedSourcePath);

        const task = this.store.getTaskByConversation(conversationId);
        if (task) {
            const artifactPaths = [...new Set([...(task.artifactPaths ?? []), resolvedSourcePath])];
            this.store.updateTask(task.id, { artifactPaths });
        }
        return 0;
    }

    private async indexSourceForTaskLinking(sourcePath: string): Promise<void> {
        if (this.closed) {
            return;
        }
        try {
            const stats = await fs.stat(sourcePath);
            if (!stats.isFile() || this.closed) {
                return;
            }
            await this.indexer.indexFile(sourcePath);
        } catch (err) {
            const code = (err as NodeJS.ErrnoException | undefined)?.code;
            if (this.closed || code === "ENOENT") {
                return;
            }
        }
    }

    private computeEmbeddingSignature(dims: number): string {
        const model = this.embeddingProvider.modelName ?? "unknown";
        // 签名中包含：模型名 + 真实维度 + task-aware 前缀。
        // 任何一项变更都必须触发向量/缓存重建，否则会出现语义空间不一致或维度不匹配。
        return [
            "v2", // 预留版本号，未来可演进
            `model=${model}`,
            `dims=${dims}`,
            `queryPrefix=${this.embeddingQueryPrefix ?? ""}`,
            `passagePrefix=${this.embeddingPassagePrefix ?? ""}`,
        ].join("|");
    }

    /**
     * 失败退避不依赖 vec0 维度，确保首次真实 passage 请求在推导维度前失败时也能跨重启恢复。
     * scope 仅保存哈希，避免把自定义 prefix 原文持久化到 SQLite。
     */
    private computeEmbeddingFailureScope(): string {
        const material = [
            "v1",
            this.embeddingProvider.modelName ?? "unknown",
            this.embeddingQueryPrefix,
            this.embeddingPassagePrefix,
        ].join("\n");
        return `v1:${createHash("sha256").update(material).digest("hex")}`;
    }

    private ensureEmbeddingSignature(signature: string): void {
        const key = "embedding_signature";
        const prev = this.store.getMeta(key);
        const vecStatus = this.store.getVectorStatus();

        // 兼容老库：之前没有写 signature，但可能已经有向量/缓存。
        // 为了避免“复用旧向量/旧缓存导致检索失效”，这里会做一次自愈清理。
        if (!prev) {
            if (vecStatus.indexed > 0 || vecStatus.cached > 0) {
                console.warn(
                    `[MemoryManager] Legacy embedding signature not found (indexed=${vecStatus.indexed}, cached=${vecStatus.cached}); rebuilding vector index & cache...`
                );
                this.store.clearVectorIndex();
                this.store.clearEmbeddingCache();
            }
            this.store.setMeta(key, signature);
            return;
        }

        if (prev !== signature) {
            console.warn(`[MemoryManager] Embedding signature changed, rebuilding vector index & cache...`);
            console.warn(`  prev: ${prev}`);
            console.warn(`  next: ${signature}`);
            this.store.clearVectorIndex();
            this.store.clearEmbeddingCache();
            this.store.setMeta(key, signature);
        }
    }

    /**
     * Process chunks that lack embeddings (with cache support)
     */
    private async processPendingEmbeddings(signal?: AbortSignal): Promise<void> {
        if (this.closed || signal?.aborted) {
            return;
        }
        const providerName = this.embeddingProvider.modelName ?? "unknown";
        const failureScope = this.computeEmbeddingFailureScope();
        const createPendingCursor = (): PendingEmbeddingCandidateCursor => new PendingEmbeddingCandidateCursor({
            listPage: (limit, afterRowId) => this.store.getPendingEmbeddingCandidatePage(limit, afterRowId),
            getBackoffChunkIds: (chunkIds) => this.embeddingFailureLedger.getBackoffChunkIds(
                failureScope,
                chunkIds,
                Date.now(),
            ),
        });
        let pendingCursor = createPendingCursor();
        let hadEmbeddingFailure = false;
        let syncCompleted = false;
        const recordFailures = (chunkIds: string[], reason: EmbeddingFailureReason): void => {
            if (chunkIds.length === 0) {
                return;
            }
            hadEmbeddingFailure = true;
            this.embeddingFailureLedger.recordFailures({
                scope: failureScope,
                chunkIds,
                reason,
                failedAtMs: Date.now(),
            });
        };
        const embeddingStats = {
            batchCount: 0,
            totalChunks: 0,
            writtenChunks: 0,
            failedChunks: 0,
            cacheHits: 0,
            cacheMisses: 0,
            apiRequestCount: 0,
            apiChunkCount: 0,
        };
        const declaredDimension = resolveEmbeddingDimension(this.embeddingProvider.dimension);
        const discoverDimensionFromResponse = this.embeddingProvider.discoverDimensionFromResponse === true;
        // Provider 未声明维度时，首次真实响应会写入此标记。它与失败退避使用相同的
        // 模型/前缀作用域，避免每次无待处理 chunk 的同步都额外发送 probe 请求。
        const discoveredDimensionMetaKey = `embedding_discovered_dimension:${failureScope}`;
        const discoveredDimension = discoverDimensionFromResponse && declaredDimension === null
            ? resolveEmbeddingDimension(Number(this.store.getMeta(discoveredDimensionMetaKey)))
            : null;
        let dims = declaredDimension
            ?? discoveredDimension
            ?? (discoverDimensionFromResponse ? null : this.store.getVectorDimensions());
        let signature: string | null = null;
        let prefetchedVectors: ReturnType<typeof validateEmbeddingBatchResponse> | null = null;
        let prefetchedPending: MemoryChunk[] | null = null;

        const prepareEmbeddingStore = (dimensions: number): void => {
            dims = dimensions;
            this.store.prepareVectorStore(dimensions);
            signature = this.computeEmbeddingSignature(dimensions);
            this.ensureEmbeddingSignature(signature);
        };

        if (dims !== null) {
            prepareEmbeddingStore(dims);
        } else {
            // 未声明维度的 Provider 直接使用首个真实 passage 响应，避免额外的可计费 probe。
            // 旧 vec0 表已填满时没有 pending chunk；仅在尚未协商过维度时取一个现有 chunk，
            // 以便识别升级前错误保留的表维度并触发安全重建。
            let initialCandidates = pendingCursor.take(this.embeddingBatchSize);
            if (
                discoverDimensionFromResponse
                && initialCandidates.length === 0
                && this.store.getVectorStatus().indexed > 0
            ) {
                const legacyCandidates = this.store.getInitialEmbeddingCandidates(this.embeddingBatchSize);
                const blockedChunkIds = this.embeddingFailureLedger.getBackoffChunkIds(
                    failureScope,
                    legacyCandidates.map((candidate) => candidate.id),
                    Date.now(),
                );
                initialCandidates = legacyCandidates.filter((candidate) => !blockedChunkIds.has(candidate.id));
            }
            if (initialCandidates.length === 0) {
                return;
            }
            const texts = initialCandidates.map((chunk) => chunk.content.replace(/\n+/g, " ").slice(0, 8000));
            embeddingStats.batchCount += 1;
            embeddingStats.totalChunks += initialCandidates.length;
            embeddingStats.cacheMisses += initialCandidates.length;
            embeddingStats.apiRequestCount += 1;
            embeddingStats.apiChunkCount += initialCandidates.length;

            try {
                const response = await this.embeddingProvider.embedBatch(texts, { signal });
                if (this.closed || signal?.aborted) {
                    return;
                }
                prefetchedVectors = validateEmbeddingBatchResponse(response, initialCandidates.length);
                prefetchedPending = initialCandidates;
                if (prefetchedVectors.dimension === null) {
                    embeddingStats.failedChunks += prefetchedVectors.failedCount;
                    recordFailures(initialCandidates.map((candidate) => candidate.id), "invalid_response");
                    if (providerName === "none") {
                        console.log("[MemoryManager] Embedding provider returned no finite vectors; skipping vector generation.");
                    } else {
                        console.warn(
                            `[MemoryManager] Embedding sync stopped after a zero-progress batch `
                            + `(selected=${initialCandidates.length}, written=0, failed=${prefetchedVectors.failedCount}).`,
                        );
                    }
                    this.logEmbeddingSyncSummary(embeddingStats);
                    return;
                }
                prepareEmbeddingStore(prefetchedVectors.dimension);
                if (discoverDimensionFromResponse) {
                    this.store.setMeta(discoveredDimensionMetaKey, String(prefetchedVectors.dimension));
                }
                // prepareEmbeddingStore may have rebuilt the derived vec0 table. Recreate the cursor
                // so the remaining chunks are read against its current state rather than the old table.
                pendingCursor = createPendingCursor();
            } catch {
                if (this.closed || signal?.aborted) {
                    return;
                }
                embeddingStats.failedChunks += initialCandidates.length;
                recordFailures(initialCandidates.map((candidate) => candidate.id), "request_failed");
                console.warn("[MemoryManager] Embedding batch request failed; stopping current sync pass.");
                this.logEmbeddingSyncSummary(embeddingStats);
                return;
            }
        }

        if (dims === null || signature === null) {
            return;
        }
        const embeddingDimensions = dims;
        const embeddingSignature = signature;

        // Loop until no more pending chunks
        while (!this.closed && !signal?.aborted) {
            const pending = prefetchedPending ?? pendingCursor.take(this.embeddingBatchSize);
            const validatedResponse = prefetchedVectors;
            prefetchedPending = null;
            prefetchedVectors = null;
            if (pending.length === 0) {
                syncCompleted = true;
                break;
            }
            if (validatedResponse === null) {
                embeddingStats.batchCount += 1;
                embeddingStats.totalChunks += pending.length;
            }

            // Normalize content for embedding and compute content hashes
            const normalized = pending.map(c => c.content.replace(/\n+/g, " ").slice(0, 8000));
            // IMPORTANT: hash 必须包含 embedding signature（模型/维度/prefix），否则升级后会错误复用旧缓存。
            const hashes = normalized.map(t => createHash("sha256").update(embeddingSignature).update("\n").update(t).digest("hex"));

            // Separate cached vs uncached
            const needEmbed: { idx: number; text: string }[] = [];
            const cachedVectors: (number[] | null)[] = new Array(pending.length).fill(null);
            const cachedVectorWrites: Array<{ chunkId: string; embedding: number[] }> = [];
            let batchWritten = 0;
            let batchFailed = 0;

            if (validatedResponse === null) {
                for (let i = 0; i < pending.length; i++) {
                    if (this.closed || signal?.aborted) return;
                    const cached = this.store.getCachedEmbedding(hashes[i]);
                    if (cached && isValidEmbeddingVector(cached, embeddingDimensions)) {
                        cachedVectors[i] = cached;
                    } else {
                        needEmbed.push({ idx: i, text: normalized[i] });
                    }
                }

                const cacheHits = pending.length - needEmbed.length;
                embeddingStats.cacheHits += cacheHits;
                embeddingStats.cacheMisses += needEmbed.length;

                // 缓存命中同样通过批量 transaction 写入 vec0，避免逐项 rowid/vec 提交。
                for (let i = 0; i < pending.length; i++) {
                    if (this.closed || signal?.aborted) return;
                    if (cachedVectors[i]) {
                        cachedVectorWrites.push({
                            chunkId: pending[i].id,
                            embedding: cachedVectors[i]!,
                        });
                    }
                }
                if (cachedVectorWrites.length > 0) {
                    try {
                        const writtenChunkIds = this.store.upsertChunkVectorsBatch(cachedVectorWrites, providerName);
                        batchWritten += writtenChunkIds.length;
                        this.embeddingFailureLedger.clearFailures(failureScope, writtenChunkIds);
                    } catch {
                        batchFailed += cachedVectorWrites.length;
                        recordFailures(cachedVectorWrites.map((write) => write.chunkId), "storage_failed");
                        embeddingStats.writtenChunks += batchWritten;
                        embeddingStats.failedChunks += batchFailed;
                        console.warn("[MemoryManager] Embedding batch write failed; stopping current sync pass.");
                        break;
                    }
                }
            }

            let responseValidation = validatedResponse;
            if (responseValidation === null && needEmbed.length > 0) {
                embeddingStats.apiRequestCount += 1;
                embeddingStats.apiChunkCount += needEmbed.length;
                try {
                    const texts = needEmbed.map(e => e.text);
                    const response = await this.embeddingProvider.embedBatch(texts, { signal });
                    if (this.closed || signal?.aborted) {
                        return;
                    }
                    responseValidation = validateEmbeddingBatchResponse(response, needEmbed.length, embeddingDimensions);
                } catch {
                    if (this.closed || signal?.aborted) {
                        return;
                    }
                    batchFailed += needEmbed.length;
                    recordFailures(needEmbed.map(({ idx }) => pending[idx].id), "request_failed");
                    embeddingStats.writtenChunks += batchWritten;
                    embeddingStats.failedChunks += batchFailed;
                    console.warn("[MemoryManager] Embedding batch request failed; stopping current sync pass.");
                    break;
                }
            }

            if (responseValidation !== null) {
                if (!responseValidation.responseCountMatches || responseValidation.failedCount > 0) {
                    console.warn(
                        `[MemoryManager] Embedding batch response validation rejected invalid entries `
                        + `(expected=${responseValidation.expectedCount}, received=${responseValidation.receivedCount}, `
                        + `failed=${responseValidation.failedCount}).`,
                    );
                }
                const responseTargets = validatedResponse === null ? needEmbed : pending.map((_, idx) => ({ idx, text: normalized[idx] }));
                const invalidChunkIds: string[] = [];
                const responseVectorWrites: Array<{ chunkId: string; embedding: number[]; cacheHash: string }> = [];
                for (let index = 0; index < responseTargets.length; index++) {
                    if (this.closed || signal?.aborted) return;
                    const vector = responseValidation.vectors[index];
                    const { idx } = responseTargets[index];
                    if (vector === null) {
                        invalidChunkIds.push(pending[idx].id);
                        continue;
                    }
                    responseVectorWrites.push({
                        chunkId: pending[idx].id,
                        embedding: vector,
                        cacheHash: hashes[idx],
                    });
                }
                batchFailed += responseValidation.failedCount;
                recordFailures(invalidChunkIds, "invalid_response");
                if (responseVectorWrites.length > 0) {
                    try {
                        const writtenChunkIds = this.store.upsertChunkVectorsBatch(responseVectorWrites, providerName);
                        batchWritten += writtenChunkIds.length;
                        this.embeddingFailureLedger.clearFailures(failureScope, writtenChunkIds);
                    } catch {
                        batchFailed += responseVectorWrites.length;
                        recordFailures(responseVectorWrites.map((write) => write.chunkId), "storage_failed");
                        embeddingStats.writtenChunks += batchWritten;
                        embeddingStats.failedChunks += batchFailed;
                        console.warn("[MemoryManager] Embedding batch write failed; stopping current sync pass.");
                        break;
                    }
                }
            }

            embeddingStats.writtenChunks += batchWritten;
            embeddingStats.failedChunks += batchFailed;
            if (batchWritten === 0) {
                console.warn(
                    `[MemoryManager] Embedding sync stopped after a zero-progress batch `
                    + `(selected=${pending.length}, written=0, failed=${batchFailed}).`,
                );
                break;
            }

            // 让出一次事件循环，避免大批量缓存命中时长时间占住首屏请求。
            await new Promise<void>((resolve) => setImmediate(resolve));
        }

        this.logEmbeddingSyncSummary(embeddingStats);
        if (
            syncCompleted
            && embeddingStats.totalChunks > 0
            && !hadEmbeddingFailure
            && !this.closed
            && !signal?.aborted
        ) {
            this.pruneEmbeddingCacheAfterCompletedSync();
        }
    }

    private pruneEmbeddingCacheAfterCompletedSync(): void {
        try {
            this.store.pruneEmbeddingCache(DEFAULT_EMBEDDING_CACHE_RETENTION);
        } catch {
            console.warn("[MemoryManager] Embedding cache retention failed.");
        }
    }

    /**
     * M-N4: 源路径聚合二次检索。
     * 当第一轮结果中某个 source 出现 ≥2 次时，拉取该 source 的全部 chunk 补充上下文。
     */
    private applyDeepRetrieval(firstRound: MemorySearchResult[], limit: number): MemorySearchResult[] {
        // 按 source_path 分组统计
        const sourceGroups = new Map<string, { count: number; totalScore: number }>();
        for (const r of firstRound) {
            const existing = sourceGroups.get(r.sourcePath);
            if (existing) {
                existing.count++;
                existing.totalScore += r.score;
            } else {
                sourceGroups.set(r.sourcePath, { count: 1, totalScore: r.score });
            }
        }

        // 找出出现 ≥2 次的 source（触发条件）
        const hotSources: Array<{ path: string; aggScore: number }> = [];
        for (const [sourcePath, { count, totalScore }] of sourceGroups) {
            if (count >= 2) {
                // 聚合分数：avg(score) * log(count + 1)
                const aggScore = (totalScore / count) * Math.log(count + 1);
                hotSources.push({ path: sourcePath, aggScore });
            }
        }

        // 无热点 source → 直接返回第一轮结果
        if (hotSources.length === 0) {
            return firstRound.slice(0, limit);
        }

        // 选出 Top-3 高分 source
        hotSources.sort((a, b) => b.aggScore - a.aggScore);
        const topSources = hotSources.slice(0, 3);

        // 第二轮：拉取 Top source 的全部 chunk
        const existingIds = new Set(firstRound.map(r => r.id));
        const supplementary: MemorySearchResult[] = [];

        for (const { path: sourcePath, aggScore } of topSources) {
            const chunks = this.store.getChunksBySource(sourcePath, 10);
            for (const chunk of chunks) {
                if (!existingIds.has(chunk.id)) {
                    // 赋予补充 chunk 一个基于聚合分数的衰减分数
                    supplementary.push({ ...chunk, score: aggScore * 0.5 });
                    existingIds.add(chunk.id);
                }
            }
        }

        // 合并第一轮 + 补充结果，按 score 降序排序
        const merged = [...firstRound, ...supplementary]
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);

        return merged;
    }

    private resolveSourcePath(sourcePath: string): string {
        if (!sourcePath) return sourcePath;
        if (path.isAbsolute(sourcePath)) {
            return sourcePath;
        }
        const resolutionRoots = this.getSourceResolutionRoots();
        return resolutionRoots.length > 0
            ? path.resolve(resolutionRoots[0], sourcePath)
            : path.resolve(this.workspaceRoot, sourcePath);
    }

    private resolveSourcePathCandidates(sourcePath: string): string[] {
        if (!sourcePath) return [];
        if (path.isAbsolute(sourcePath)) {
            return [sourcePath];
        }

        const candidates = [sourcePath];
        for (const root of this.getSourceResolutionRoots()) {
            candidates.push(path.resolve(root, sourcePath));
        }
        return dedupePaths(candidates);
    }

    private getSourceResolutionRoots(): string[] {
        const explicitFileRoots = this.additionalFiles.map((filePath) => path.dirname(filePath));
        return dedupePaths([
            this.publishStateDir,
            this.workspaceRoot,
            ...this.additionalRoots,
            ...explicitFileRoots,
        ]);
    }

    private resolvePreferredMemorySourceId(
        sourcePath: string,
        sourceType: string,
        memoryTypes: string[] | undefined,
        records: MemoryTreeSourceRecord[],
    ): string | undefined {
        const classification = classifyMemorySource(sourcePath, sourceType, memoryTypes);
        if (classification.builtinInventoryId && records.some((item) => item.id === classification.builtinInventoryId)) {
            return classification.builtinInventoryId;
        }

        const normalizedCandidates = new Set(
            this.resolveSourcePathCandidates(sourcePath)
                .concat(sourcePath)
                .map(normalizeSourcePathForMatch)
                .filter(Boolean),
        );
        for (const record of records) {
            if (!record.sourcePath) {
                continue;
            }
            const normalizedRecordPath = normalizeSourcePathForMatch(record.sourcePath);
            if (!normalizedRecordPath) {
                continue;
            }
            if (normalizedCandidates.has(normalizedRecordPath)) {
                return record.id;
            }
            if (record.id.startsWith("configured:")) {
                for (const candidate of normalizedCandidates) {
                    if (candidate === normalizedRecordPath || candidate.startsWith(`${normalizedRecordPath}/`)) {
                        return record.id;
                    }
                }
            }
        }
        return undefined;
    }

    getStatus(): MemoryIndexStatus {
        const basic = this.store.getStatus();
        const vec = this.store.getVectorStatus();
        const summary = this.store.getSummaryStatus();
        return {
            ...basic,
            vectorIndexed: vec.indexed,
            vectorCached: vec.cached,
            summarized: summary.summarized,
            summaryPending: summary.pending,
        };
    }

    /**
     * L0 摘要生成：扫描未摘要的长 chunk，批量调用 LLM 生成单句摘要。
     * 异步后台执行，不阻塞主流程。支持 pause/resume 协作式让步。
     */
    async generateSummaries(options: { maxBatches?: number; signal?: AbortSignal } = {}): Promise<number> {
        if (!this.summaryEnabled || !this.summaryApiKey || !this.summaryModel) {
            return 0;
        }

        const summaryConcurrency = Math.max(1, Math.min(2, this.summaryBatchSize));
        const summaryThrottleMs = summaryConcurrency > 1 ? 200 : 0;
        const maxBatches = typeof options.maxBatches === "number" && Number.isFinite(options.maxBatches)
            ? Math.max(1, Math.floor(options.maxBatches))
            : Number.POSITIVE_INFINITY;
        let totalGenerated = 0;
        let processedBatches = 0;

        while (processedBatches < maxBatches) {
            // 协作式让步：Agent 活跃时暂停
            await this.waitIfPaused(options.signal);
            throwIfBackgroundAborted(options.signal, "Idle summary run was aborted.");

            const chunks = this.store.getChunksNeedingSummary(
                this.summaryMinContentLength,
                this.summaryBatchSize
            );
            if (chunks.length === 0) break;
            processedBatches += 1;

            console.log(`[MemoryManager] Generating summaries for ${chunks.length} chunks...`);

            const pendingChunks = chunks.slice();
            const workers = Array.from(
                { length: Math.min(summaryConcurrency, pendingChunks.length) },
                async () => {
                    while (pendingChunks.length > 0) {
                        // 每个 chunk 前再检查一次暂停状态
                        await this.waitIfPaused(options.signal);
                        throwIfBackgroundAborted(options.signal, "Idle summary run was aborted.");

                        const chunk = pendingChunks.shift();
                        if (!chunk) break;

                        try {
                            const summary = await this.callLLMForSummary(chunk.content, options.signal);
                            throwIfBackgroundAborted(options.signal, "Idle summary run was aborted.");
                            if (summary) {
                                // 粗略估算 token 数（中文约 1.5 字/token，英文约 0.75 词/token）
                                const estimatedTokens = Math.ceil(summary.length / 2);
                                this.store.updateChunkSummary(chunk.id, summary, estimatedTokens);
                                totalGenerated++;
                            }
                        } catch (err) {
                            throwIfBackgroundAborted(options.signal, "Idle summary run was aborted.");
                            console.error(`[MemoryManager] Failed to generate summary for chunk ${chunk.id}:`, err);
                            // 单个失败不中断整批
                        }

                        if (summaryThrottleMs > 0 && pendingChunks.length > 0) {
                            await new Promise((resolve) => setTimeout(resolve, summaryThrottleMs));
                            throwIfBackgroundAborted(options.signal, "Idle summary run was aborted.");
                        }
                    }
                },
            );
            await Promise.all(workers);
        }

        if (totalGenerated > 0) {
            console.log(`[MemoryManager] Generated ${totalGenerated} summaries`);
        }
        return totalGenerated;
    }

    /**
     * 调用 LLM 生成单条 chunk 的摘要
     */
    private async callLLMForSummary(content: string, signal?: AbortSignal): Promise<string | null> {
        const truncated = content.length > 4000 ? content.slice(0, 4000) + "..." : content;

        const data = await requestMemoryChunkSummaryModel({
            baseUrl: this.summaryBaseUrl,
            apiKey: this.summaryApiKey,
            timeoutMs: 120_000,
            signal,
            ...(this.modelPrivacyRuntime ? { privacyRuntime: this.modelPrivacyRuntime } : {}),
            payload: {
                model: this.summaryModel,
                messages: [
                    {
                        role: "system",
                        content: "你是一个精确的文本摘要助手。请用一到两句话概括以下内容的核心要点。摘要应保留关键信息（人名、技术术语、数字、结论），便于快速判断是否需要阅读全文。只输出摘要，不要任何前缀或解释。"
                    },
                    {
                        role: "user",
                        content: truncated
                    }
                ],
                max_tokens: 150,
                temperature: 0.3,
            },
        });
        const result = data.choices?.[0]?.message?.content?.trim();
        return result || null;
    }

    // ========== M-N3: 会话记忆自动提取 ==========

    /**
     * 从会话消息中提取长期记忆。
     * 由 agent_end hook 调用。
     * @returns 提取并写入的记忆条数
     */
    async extractMemoriesFromConversation(
        sessionKey: string,
        messages: Array<{ role: string; content: string }>,
        options: ExtractConversationMemoriesOptions = {},
    ): Promise<ExtractConversationMemoriesResult> {
        if (this.closed) {
            return {
                count: 0,
                acceptedCandidateTypes: [],
                rejectedCount: 0,
                rejectedReasons: [],
                summary: "Memory manager is closing.",
                skipReason: "manager_closed",
            };
        }
        return this.registerInFlight((async () => {
        const dedupeKey = options.markKey?.trim() || sessionKey;
        const sourceConversationId = options.sourceConversationId?.trim() || sessionKey;
        const sourceLabel = options.sourceLabel?.trim() || dedupeKey;

        if (!this.evolutionEnabled) {
            return {
                count: 0,
                acceptedCandidateTypes: [],
                rejectedCount: 0,
                rejectedReasons: [],
                summary: "Durable extraction disabled by configuration.",
                skipReason: "extractor_disabled",
            };
        }
        if (messages.length < this.evolutionMinMessages) {
            return {
                count: 0,
                acceptedCandidateTypes: [],
                rejectedCount: 0,
                rejectedReasons: [],
                summary: `Skipped because messages (${messages.length}) are below minMessages (${this.evolutionMinMessages}).`,
                skipReason: "messages_below_min",
            };
        }

        // 防重复：检查是否已提取过
        if (this.store.isSessionMemoryExtracted(dedupeKey)) {
            return {
                count: 0,
                acceptedCandidateTypes: [],
                rejectedCount: 0,
                rejectedReasons: [],
                summary: "Skipped because the same durable extraction key was already processed.",
                skipReason: "dedupe_key_already_processed",
            };
        }

        const conversationText = renderDurableExtractionMessages(messages);

        try {
            await this.waitIfPaused(options.signal);
            throwIfBackgroundAborted(options.signal, "Durable extraction was aborted.");
            if (this.closed) {
                return {
                    count: 0,
                    acceptedCandidateTypes: [],
                    rejectedCount: 0,
                    rejectedReasons: [],
                    summary: "Memory manager is closing.",
                    skipReason: "manager_closed",
                };
            }

            // 调用 LLM 提取记忆
            const extracted = await this.callLLMForExtraction(conversationText, options.signal);
            throwIfBackgroundAborted(options.signal, "Durable extraction was aborted.");
            if (!extracted || extracted.length === 0) {
                // 无值得记住的内容，仍标记为已处理
                this.store.markSessionMemoryExtracted(dedupeKey);
                return {
                    count: 0,
                    acceptedCandidateTypes: [],
                    rejectedCount: 0,
                    rejectedReasons: [],
                    summary: "No durable memory candidate was produced by the extractor.",
                    skipReason: "extractor_empty",
                };
            }

            const filtered = this.applyDurableMemoryPolicy(extracted);
            throwIfBackgroundAborted(options.signal, "Durable extraction was aborted.");
            if (filtered.accepted.length === 0) {
                this.store.markSessionMemoryExtracted(dedupeKey);
                return {
                    count: 0,
                    acceptedCandidateTypes: [],
                    rejectedCount: filtered.rejected.length,
                    rejectedReasons: [...new Set(filtered.rejected.map((item) => item.code))],
                    summary: filtered.summary || "All durable memory candidates were rejected by policy.",
                    skipReason: "policy_filtered",
                };
            }

            const profileStatePlan = buildDurableProfileStatePlan({
                items: filtered.accepted,
                sourceConversationId,
                sourceLabel,
            });
            throwIfBackgroundAborted(options.signal, "Durable extraction was aborted.");
            const profileStateSync = this.syncDurableProfileStatePatches(profileStatePlan.patches);

            // 去重：检查每条记忆是否已存在相似内容
            const newMemories: Array<ExtractedConversationMemory> = [];
            for (const item of filtered.accepted) {
                const similar = await this.search(item.content, { limit: 1 });
                throwIfBackgroundAborted(options.signal, "Durable extraction was aborted.");
                if (similar.length > 0 && similar[0].score > 0.85) {
                    continue; // 已有相似记忆，跳过
                }
                newMemories.push(item);
            }

            if (newMemories.length === 0) {
                this.store.markSessionMemoryExtracted(dedupeKey);
                const acceptedCandidateTypes = profileStateSync.appliedCount > 0
                    ? [...new Set(
                        filtered.accepted
                            .map((item) => item.candidateType)
                            .filter((item): item is DurableMemoryCandidateType => Boolean(item)),
                    )]
                    : [];
                return {
                    count: 0,
                    acceptedCandidateTypes,
                    rejectedCount: filtered.rejected.length,
                    rejectedReasons: [...new Set(filtered.rejected.map((item) => item.code))],
                    summary: this.appendDurableProfileStateSummary(
                        profileStateSync.appliedCount > 0
                            ? "All durable memory candidates were already covered by similar memories, but profile state was refreshed."
                            : "All durable memory candidates were skipped because similar memories already exist.",
                        profileStateSync,
                        profileStatePlan.rejected.length,
                    ),
                    skipReason: profileStateSync.appliedCount > 0 ? undefined : "dedupe_skipped",
                };
            }

            // 写入每日记忆文件
            const lines = newMemories.map(m =>
                `- [${m.type}][${m.category}] ${m.content} (来源: ${sourceLabel})`
            );
            const content = lines.join("\n");
            throwIfBackgroundAborted(options.signal, "Durable extraction was aborted.");
            const filePath = await appendToTodayMemory(this.stateDir, content);
            throwIfBackgroundAborted(options.signal, "Durable extraction was aborted.");
            await this.linkTaskMemoriesFromSource(sourceConversationId, filePath, "generated");
            throwIfBackgroundAborted(options.signal, "Durable extraction was aborted.");

            // 标记已提取
            this.store.markSessionMemoryExtracted(dedupeKey);

            console.log(`[MemoryManager] Extracted ${newMemories.length} memories from session ${sourceLabel}`);
            return {
                count: newMemories.length,
                acceptedCandidateTypes: [...new Set(newMemories.map((item) => item.candidateType).filter((item): item is DurableMemoryCandidateType => Boolean(item)))],
                rejectedCount: filtered.rejected.length,
                rejectedReasons: [...new Set(filtered.rejected.map((item) => item.code))],
                summary: this.appendDurableProfileStateSummary(
                    buildDurableExtractionSummary({
                        acceptedCount: newMemories.length,
                        acceptedCandidateTypes: newMemories.map((item) => item.candidateType).filter((item): item is DurableMemoryCandidateType => Boolean(item)),
                        rejected: filtered.rejected,
                    }),
                    profileStateSync,
                    profileStatePlan.rejected.length,
                ),
            };
        } catch (err) {
            throwIfBackgroundAborted(options.signal, "Durable extraction was aborted.");
            console.error(`[MemoryManager] Memory extraction failed for session ${sourceLabel}:`, err);
            return {
                count: 0,
                acceptedCandidateTypes: [],
                rejectedCount: 0,
                rejectedReasons: [],
                summary: `Durable extraction failed: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
        })());
    }

    /** 检查 session 是否已提取过记忆 */
    isSessionMemoryExtracted(sessionKey: string): boolean {
        return this.store.isSessionMemoryExtracted(sessionKey);
    }

    isConversationMemoryExtractionEnabled(): boolean {
        return this.evolutionEnabled;
    }

    getConversationMemoryExtractionSupport(): ConversationMemoryExtractionSupport {
        const model = this.evolutionModel.trim();
        const hasBaseUrl = this.evolutionBaseUrl.trim().length > 0;
        const hasApiKey = this.evolutionApiKey.trim().length > 0;
        const reasons: ConversationMemoryExtractionSupportReason[] = [];

        if (!this.evolutionEnabled) {
            reasons.push({
                code: "gate_disabled",
                message: "Durable extraction is disabled because BELLDANDY_MEMORY_EVOLUTION_ENABLED is not enabled.",
            });
        }
        if (this.evolutionEnabled && !model) {
            reasons.push({
                code: "model_missing",
                message: "Durable extraction model is not configured.",
            });
        }
        if (this.evolutionEnabled && !hasBaseUrl) {
            reasons.push({
                code: "base_url_missing",
                message: "Durable extraction base URL is not configured.",
            });
        }
        if (this.evolutionEnabled && !hasApiKey) {
            reasons.push({
                code: "api_key_missing",
                message: "Durable extraction API key is not configured.",
            });
        }

        return {
            enabled: this.evolutionEnabled,
            available: this.evolutionEnabled && reasons.length === 0,
            minMessages: this.evolutionMinMessages,
            model: model || undefined,
            hasBaseUrl,
            hasApiKey,
            reasons,
        };
    }

    getDurableMemoryGuidance(): DurableMemoryGuidance {
        return {
            policyVersion: DURABLE_MEMORY_GUIDANCE.policyVersion,
            acceptedCandidateTypes: [...DURABLE_MEMORY_GUIDANCE.acceptedCandidateTypes],
            rejectedContentTypes: DURABLE_MEMORY_GUIDANCE.rejectedContentTypes.map((item) => ({ ...item })),
            summary: DURABLE_MEMORY_GUIDANCE.summary,
        };
    }

    private applyDurableMemoryPolicy(items: ExtractedConversationMemory[]): {
        accepted: ExtractedConversationMemory[];
        rejected: Array<{ code: DurableMemoryRejectionReasonCode; content: string }>;
        summary: string;
    } {
        const accepted: ExtractedConversationMemory[] = [];
        const rejected: Array<{ code: DurableMemoryRejectionReasonCode; content: string }> = [];

        for (const item of items) {
            const normalizedContent = item.content.trim();
            if (!normalizedContent) {
                continue;
            }
            const rejection = detectDurableMemoryRejection(normalizedContent);
            if (rejection) {
                rejected.push({
                    code: rejection.code,
                    content: normalizedContent,
                });
                continue;
            }
            accepted.push({
                ...item,
                content: normalizedContent,
                candidateType: normalizeDurableMemoryCandidateType(item.candidateType)
                    ?? inferDurableMemoryCandidateType(item),
            });
        }

        return {
            accepted,
            rejected,
            summary: buildDurableExtractionSummary({
                acceptedCount: accepted.length,
                acceptedCandidateTypes: accepted.map((item) => item.candidateType).filter((item): item is DurableMemoryCandidateType => Boolean(item)),
                rejected,
            }),
        };
    }

    private syncDurableProfileStatePatches(
        patches: DurableProfileStatePatch[],
    ): { appliedCount: number; appliedPaths: string[]; skippedConflictCount: number } {
        const appliedPaths: string[] = [];
        let skippedConflictCount = 0;

        for (const patch of patches) {
            const existing = this.store.getProfileStateEntry(patch.path, {
                scope: "user",
                status: ["active", "deleted"],
            });
            if (existing?.status === "active") {
                const currentValue = JSON.stringify(existing.value ?? null);
                const nextValue = JSON.stringify(patch.value ?? null);
                if (currentValue !== nextValue) {
                    skippedConflictCount += 1;
                    continue;
                }
            }

            this.store.upsertProfileStateEntry({
                scope: "user",
                path: patch.path,
                value: patch.value,
                confidence: patch.confidence,
                reason: patch.reason,
                sourceRefs: patch.sourceRefs,
                createdBy: "durable_extraction",
            });
            appliedPaths.push(patch.path);
        }

        return {
            appliedCount: appliedPaths.length,
            appliedPaths,
            skippedConflictCount,
        };
    }

    private appendDurableProfileStateSummary(
        baseSummary: string,
        sync: { appliedCount: number; appliedPaths: string[]; skippedConflictCount: number },
        rejectedCount: number,
    ): string {
        const parts = [baseSummary];
        if (sync.appliedCount > 0) {
            parts.push(`profileUpdates=${sync.appliedCount}`);
            parts.push(`profilePaths=${sync.appliedPaths.join(",")}`);
        }
        if (sync.skippedConflictCount > 0) {
            parts.push(`profileConflicts=${sync.skippedConflictCount}`);
        }
        if (rejectedCount > 0) {
            parts.push(`profileRejected=${rejectedCount}`);
        }
        return parts.join("; ");
    }

    /**
     * 调用 LLM 从对话中提取记忆
     */
    private async callLLMForExtraction(
        conversationText: string,
        signal?: AbortSignal,
    ): Promise<ExtractedConversationMemory[] | null> {
        const requestBody: Record<string, unknown> = {
            model: this.evolutionModel,
            messages: [
                {
                    role: "system",
                    content: `分析以下对话，提取值得长期记住的信息。优先归入以下 durable candidate type：
- user：用户偏好、习惯、长期工作方式、稳定背景信息
- feedback：用户对结果质量、交互方式、输出风格的持续反馈
- project：项目背景、阶段性决定、长期约束、外部依赖入口
- reference：值得长期记住的人名、组织名、系统入口、外部资源引用

同时给每条记忆保留一个已有 memory category，分为以下类别：
- 【偏好/preference】：用户表达的喜好、习惯、工作方式、技术栈偏好等
- 【经验/experience】：解决问题的有效方法、踩过的坑、有用的工具/命令等
- 【事实/fact】：用户提到的客观事实、背景信息、项目状态等
- 【决策/decision】：用户做出的技术决策、架构选择、方案确定等
- 【实体/entity】：用户提到的重要人名、项目名、组织名等

${DURABLE_PROFILE_STATE_PROMPT_BLOCK}

仅提取有长期价值的信息，忽略临时性的对话内容。
不要记下面这些内容：
- 代码模式、架构片段、函数实现、文件路径、项目目录结构
- git 历史、最近变更、commit/PR 记录
- debugging / fix recipe、命令执行步骤、一次性排障过程
- 已在 AGENTS.md / CLAUDE.md / README / 项目规范中稳定存在的规则

每条记忆用一句话概括。
返回 JSON 数组，格式：[{"type":"偏好","category":"preference","candidateType":"user","content":"...","reason":"...","profilePath":"preferences.response_style","profileValue":"先给结论，再展开证据"}]
category 必须是以下之一：preference / experience / fact / decision / entity
candidateType 必须是以下之一：user / feedback / project / reference
如果没有值得记住的内容，返回空数组 []。
只输出 JSON，不要其他内容。`
                },
                {
                    role: "user",
                    content: conversationText
                }
            ],
            max_tokens: 500,
            temperature: 0.3,
        };
        if (shouldEnableMiniMaxReasoningSplit(this.evolutionBaseUrl, this.evolutionModel)) {
            requestBody.reasoning_split = true;
        }
        const data = await this.evolutionRequests.run({
            timeoutMs: this.evolutionTimeoutMs,
            fallbackTimeoutMs: 120_000,
            timeoutMessage: (timeoutMs) => `Evolution LLM call timed out after ${timeoutMs}ms.`,
            signal,
            operation: (signal) => requestMemoryEvolutionModel({
                baseUrl: this.evolutionBaseUrl,
                apiKey: this.evolutionApiKey,
                payload: requestBody,
                signal,
                idleTimeoutMs: this.evolutionTimeoutMs,
                ...(this.modelPrivacyRuntime ? { privacyRuntime: this.modelPrivacyRuntime } : {}),
            }),
        });
        const raw = data.choices?.[0]?.message?.content?.trim();
        if (!raw) return null;

        try {
            // 提取 JSON（兼容前置 think 块与 markdown code block 包裹）
            const jsonStr = sanitizeExtractionJsonText(raw);
            const parsed = JSON.parse(jsonStr);
            if (!Array.isArray(parsed)) return null;
            return parsed.filter(
                (item: any) => item && typeof item.type === "string" && typeof item.content === "string"
            ).map((item: any) => ({
                type: item.type as string,
                content: item.content as string,
                category: (typeof item.category === "string" ? item.category : "other") as string,
                candidateType: normalizeDurableMemoryCandidateType(item.candidateType),
                reason: typeof item.reason === "string" ? item.reason : undefined,
                profilePath: typeof item.profilePath === "string" ? item.profilePath : undefined,
                profileValue: item.profileValue,
            }));
        } catch {
            console.warn("[MemoryManager] Failed to parse extraction result:", raw.slice(0, 200));
            return null;
        }
    }

    // ========== 后台任务暂停/恢复 ==========

    /**
     * 暂停后台 LLM 任务（摘要生成等）。
     * 由 before_agent_start hook 调用，避免与 Agent 主请求争抢 API 并发。
     */
    pause(): void {
        this.backgroundPauseGate.pause();
    }

    /**
     * 恢复后台 LLM 任务。
     * 由 agent_end hook 调用。
     */
    resume(): void {
        this.backgroundPauseGate.resume();
    }

    get isPaused(): boolean {
        return this.backgroundPauseGate.isPaused;
    }

    /**
     * 等待暂停结束。在后台循环中调用，实现协作式让步。
     */
    private waitIfPaused(signal?: AbortSignal): Promise<void> {
        if (this.closed) return Promise.resolve();
        if (!this.backgroundPauseGate.isPaused) return Promise.resolve();
        console.log("[MemoryManager] Background task paused (agent active)");
        return this.backgroundPauseGate.wait(signal);
    }

    /**
     * 空闲时执行摘要生成。
     * 由 gateway 的空闲定时器调用，仅在无活跃 Agent 请求时运行。
     * 返回本次生成的摘要数。
     */
    async runIdleSummaries(options: { signal?: AbortSignal } = {}): Promise<number> {
        if (!this.summaryEnabled || this.backgroundPauseGate.isPaused || this._summaryRunning || this.closed) return 0;
        this._summaryRunning = true;
        return this.registerInFlight((async () => {
            try {
                return await this.generateSummaries({ maxBatches: 1, signal: options.signal });
            } finally {
                this._summaryRunning = false;
            }
        })());
    }

    /**
     * 暴露底层 SQLite db 句柄供同进程治理模块共享 schema 和事务。
     * 代理到 MemoryStore.getDbHandleForSharedSchema()。
     * 使用约束见 MemoryStore.getDbHandleForSharedSchema() 的注释。
     */
    getDbHandleForSharedSchema(): SqliteDatabase {
        return this.store.getDbHandleForSharedSchema();
    }

    async close(): Promise<void> {
        if (this.closePromise) {
            return this.closePromise;
        }
        this.closed = true;
        this.queryEmbeddingCache.close();
        this.backgroundPauseGate.close();
        this.evolutionRequests.abortAll("Memory manager is closing.");
        this.indexCoordinator.stopAcceptingWatchEvents();
        this.closePromise = (async () => {
            await this.memoryTreeRefreshQueue.close();
            await this.indexer.stopWatching().catch(console.error);
            await this.indexCoordinator.close();
            await this.waitForInFlightOperations();
            await this.indexer.close();
            this.store.close();
        })();
        return this.closePromise;
    }

    private registerInFlight<T>(promise: Promise<T>): Promise<T> {
        let tracked: Promise<T>;
        tracked = promise.finally(() => {
            this.inFlightOperations.delete(tracked);
        });
        this.inFlightOperations.add(tracked);
        return tracked;
    }

    private async waitForInFlightOperations(): Promise<void> {
        while (this.inFlightOperations.size > 0) {
            await Promise.allSettled([...this.inFlightOperations]);
        }
    }

    private collectTaskShortcutCandidates(limit: number, filter?: TaskSearchFilter): TaskExperienceDetail[] {
        return dedupeTaskShortcutCandidates(
            this.getTaskDetails(this.store
                .listTaskSummaries(limit, filter)
                .filter((task) => task.status !== "running")
                .map((task) => task.id)),
        );
    }

    private shouldAutoPromoteTask(task: TaskRecord): boolean {
        return shouldAutoPromoteTaskByPolicy(task);
    }

    private publishMethodCandidate(candidate: ExperienceCandidate, explicitPublishedPath?: string): string {
        const issues = validateMethodCandidateDraftForPublish(candidate.content);
        if (issues.length > 0) {
            throw new Error(`Method candidate publish validation failed: ${issues.join("；")}`);
        }

        const methodsDir = path.join(this.publishStateDir, "methods");
        mkdirSync(methodsDir, { recursive: true });

        const filePath = explicitPublishedPath || this.resolveMethodPublishPath(methodsDir, candidate);
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, candidate.content, "utf-8");
        return filePath;
    }

    private resolveMethodPublishPath(methodsDir: string, candidate: ExperienceCandidate): string {
        if (candidate.publishedPath) {
            return candidate.publishedPath;
        }

        const title = candidate.content.match(/^#\s+(.+)$/m)?.[1]?.trim();
        const baseName = buildExperienceMethodFilenameBase({
            title,
            slug: candidate.slug,
            fallback: candidate.taskId,
            summary: candidate.summary,
        });
        const suffixTaskId = normalizeAsciiToken(candidate.taskId, "task");
        const suffixCandidateId = normalizeAsciiToken(candidate.id, "candidate");
        const candidates = [
            `${baseName}.md`,
            `${appendMethodFilenameRevision(baseName, suffixTaskId)}.md`,
            `${appendMethodFilenameRevision(baseName, suffixCandidateId)}.md`,
        ];

        for (const filename of candidates) {
            const filePath = path.join(methodsDir, filename);
            if (!existsSync(filePath)) {
                return filePath;
            }
        }

        return path.join(methodsDir, `${appendMethodFilenameRevision(baseName, `${suffixCandidateId}_${Date.now()}`)}.md`);
    }
}

function normalizeAsciiToken(value: string, fallback: string): string {
    const normalized = String(value ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");
    return normalized || fallback;
}

function dedupePaths(items: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of items) {
        const normalized = String(item ?? "").trim();
        if (!normalized) continue;
        const resolved = path.resolve(normalized);
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        result.push(normalized);
    }
    return result;
}

function summarizeDedupGroupSourceIndexing(sourceInfos: MemoryDedupSourceIndexInfo[]): MemoryDedupGroupSourceIndexSummary {
    const reindexableSourcePathCount = sourceInfos.filter((item) => item.reindexable).length;
    const nonReindexableSourcePathCount = Math.max(0, sourceInfos.length - reindexableSourcePathCount);
    return {
        reindexableSourcePathCount,
        nonReindexableSourcePathCount,
        allAffectedSourcePathsReindexable: sourceInfos.length > 0 && nonReindexableSourcePathCount === 0,
        anyAffectedSourcePathReindexable: reindexableSourcePathCount > 0,
        scopes: [...new Set(sourceInfos.map((item) => item.scope))],
    };
}

function toComparablePath(value: string): string {
    const normalized = path.resolve(String(value ?? "").trim());
    return process.platform === "win32"
        ? normalized.toLowerCase()
        : normalized;
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
    const relative = path.relative(rootPath, candidatePath);
    return relative === ""
        || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function deriveIndexedRootScope(
    rootPath: string,
    publishStateDir: string,
    stateMemoryRootPath: string,
): MemoryDedupSourceIndexScope {
    const comparableRootPath = toComparablePath(rootPath);
    const comparableStateMemoryRootPath = toComparablePath(stateMemoryRootPath);
    if (comparableRootPath === comparableStateMemoryRootPath) {
        return "state_memory_root";
    }
    const teamMemoryRootRelative = path.relative(publishStateDir, rootPath);
    if (!teamMemoryRootRelative.startsWith("..") && !path.isAbsolute(teamMemoryRootRelative)) {
        const normalizedRelative = teamMemoryRootRelative.replace(/\\/g, "/").toLowerCase();
        if (normalizedRelative === "team-memory/memory") {
            return "team_memory_root";
        }
    }
    return "additional_root";
}

function deriveIndexedFileScope(
    filePath: string,
    publishStateDir: string,
    stateMemoryFilePath: string,
): MemoryDedupSourceIndexScope {
    const comparableFilePath = toComparablePath(filePath);
    const comparableStateMemoryFilePath = toComparablePath(stateMemoryFilePath);
    if (comparableFilePath === comparableStateMemoryFilePath) {
        return "state_memory_file";
    }
    const teamMemoryFileRelative = path.relative(publishStateDir, filePath);
    if (!teamMemoryFileRelative.startsWith("..") && !path.isAbsolute(teamMemoryFileRelative)) {
        const normalizedRelative = teamMemoryFileRelative.replace(/\\/g, "/").toLowerCase();
        if (normalizedRelative === "team-memory/memory.md") {
            return "team_memory_file";
        }
    }
    return "additional_file";
}

function scoreForContextInjection(item: MemorySearchResult): { score: number; rationale: string[] } {
    let score = 0;
    const rationale: string[] = [];

    switch (item.memoryType) {
        case "core":
            score += 6;
            rationale.push("core-memory");
            break;
        case "daily":
            score += 4;
            rationale.push("daily-memory");
            break;
        case "other":
            score += 2;
            rationale.push("general-memory");
            break;
        case "session":
            score += 1;
            rationale.push("session-memory");
            break;
        default:
            break;
    }

    switch (item.category) {
        case "decision":
            score += 5;
            rationale.push("decision");
            break;
        case "preference":
        case "fact":
            score += 4;
            rationale.push(item.category);
            break;
        case "entity":
            score += 3;
            rationale.push("entity");
            break;
        case "experience":
            score += 2;
            rationale.push("experience");
            break;
        case "other":
            score += 1;
            rationale.push("other");
            break;
        default:
            break;
    }

    const updatedAt = Date.parse(item.updatedAt ?? "");
    if (Number.isFinite(updatedAt)) {
        const ageHours = (Date.now() - updatedAt) / (1000 * 60 * 60);
        if (ageHours <= 24) {
            score += 4;
            rationale.push("fresh-24h");
        } else if (ageHours <= 24 * 3) {
            score += 3;
            rationale.push("fresh-3d");
        } else if (ageHours <= 24 * 7) {
            score += 2;
            rationale.push("fresh-7d");
        } else if (ageHours <= 24 * 30) {
            score += 1;
            rationale.push("fresh-30d");
        }
    }

    const textLength = (item.summary ?? item.snippet ?? "").trim().length;
    if (textLength >= 24 && textLength <= 220) {
        score += 1;
        rationale.push("concise");
    }

    return { score, rationale };
}

function classifyImportance(score: number): MemoryImportance {
    if (score >= 11) return "high";
    if (score >= 7) return "medium";
    return "low";
}

type TaskShortcutCandidate = TaskExperienceDetail | TaskDerivedDetail;

type RankedTaskShortcutCandidate = {
    task: TaskShortcutCandidate;
    score: number;
    resumePriority: number;
    matchReasons: string[];
};

function clampTaskLookupLimit(limit?: number): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) return 5;
    return Math.min(Math.max(Math.floor(limit), 1), 10);
}

function normalizeTaskLookupQuery(value?: string): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.replace(/\s+/g, " ").trim();
    return trimmed ? trimmed : undefined;
}

function toTaskWorkShortcutItem(task: TaskShortcutCandidate, matchReasons?: string[]): TaskWorkShortcutItem {
    return {
        taskId: task.id,
        conversationId: task.conversationId,
        title: task.title,
        objective: task.objective,
        summary: task.summary,
        status: task.status,
        source: task.source,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
        updatedAt: task.updatedAt,
        agentId: task.agentId,
        toolNames: (task.toolCalls ?? []).map((item) => item.toolName),
        artifactPaths: task.artifactPaths ?? [],
        workRecap: task.workRecap,
        resumeContext: task.resumeContext,
        recentActivityTitles: collectRecentActivityTitles(task),
        matchReasons: matchReasons?.length ? matchReasons : undefined,
    };
}

function dedupeTaskShortcutCandidates<T extends TaskShortcutCandidate>(items: T[]): T[] {
    const seen = new Set<string>();
    const result: T[] = [];
    for (const item of items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        result.push(item);
    }
    return result;
}

function taskDetailsForIds(
    taskIds: string[],
    detailsById: ReadonlyMap<string, TaskDerivedDetail>,
): TaskDerivedDetail[] {
    const details: TaskDerivedDetail[] = [];
    for (const taskId of taskIds) {
        const detail = detailsById.get(taskId);
        if (detail) {
            details.push(detail);
        }
    }
    return details;
}

function rankTaskShortcutCandidates(
    candidates: TaskShortcutCandidate[],
    query?: string,
    options: {
        resumeMode?: boolean;
    } = {},
): RankedTaskShortcutCandidate[] {
    const deduped = dedupeTaskShortcutCandidates(candidates).filter((task) => task.status !== "running");
    const ranked = deduped.map((task) => {
        const match = scoreTaskShortcut(task, query);
        return {
            task,
            score: match.score,
            resumePriority: computeResumePriority(task),
            matchReasons: match.matchReasons,
        };
    });

    const filtered = query
        ? ranked.filter((item) => item.score > 0)
        : ranked;

    return filtered.sort((a, b) => {
        if (options.resumeMode) {
            if (query) {
                if (b.score !== a.score) return b.score - a.score;
                if (b.resumePriority !== a.resumePriority) return b.resumePriority - a.resumePriority;
                return compareTaskShortcutRecency(a.task, b.task);
            }
            if (b.resumePriority !== a.resumePriority) return b.resumePriority - a.resumePriority;
            if (b.score !== a.score) return b.score - a.score;
            return compareTaskShortcutRecency(a.task, b.task);
        }
        if (b.score !== a.score) return b.score - a.score;
        if (b.resumePriority !== a.resumePriority) return b.resumePriority - a.resumePriority;
        return compareTaskShortcutRecency(a.task, b.task);
    });
}

function compareTaskShortcutRecency(a: Pick<TaskRecord, "finishedAt" | "updatedAt" | "startedAt">, b: Pick<TaskRecord, "finishedAt" | "updatedAt" | "startedAt">): number {
    return resolveTaskShortcutTimestamp(b) - resolveTaskShortcutTimestamp(a);
}

function resolveTaskShortcutTimestamp(task: Pick<TaskRecord, "finishedAt" | "updatedAt" | "startedAt">): number {
    const timestamp = Date.parse(task.finishedAt ?? task.updatedAt ?? task.startedAt);
    return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function computeResumePriority(task: TaskShortcutCandidate): number {
    let priority = 0;
    switch (task.status) {
        case "partial":
            priority += 6;
            break;
        case "failed":
            priority += 5;
            break;
        case "success":
            priority += 2;
            break;
        default:
            break;
    }
    if (task.resumeContext?.currentStopPoint) priority += 3;
    if (task.resumeContext?.nextStep) priority += 4;
    if ((task.resumeContext?.blockers?.length ?? 0) > 0) priority += 2;
    if ((task.workRecap?.pendingActions?.length ?? 0) > 0) priority += 1;
    return priority;
}

function collectRecentActivityTitles(task: TaskShortcutCandidate, limit = 3): string[] {
    if ("recentActivityTitles" in task) {
        return task.recentActivityTitles
            .map((title) => sanitizeTaskShortcutText(title))
            .filter((title): title is string => Boolean(title))
            .slice(0, limit);
    }
    const collected: string[] = [];
    for (const activity of [...(task.activities ?? [])].reverse()) {
        if (activity.kind === "task_completed") continue;
        const text = sanitizeTaskShortcutText(activity.title || activity.summary);
        if (!text) continue;
        collected.push(text);
        if (collected.length >= limit) break;
    }
    return collected;
}

function scoreTaskShortcut(task: TaskShortcutCandidate, query?: string): { score: number; matchReasons: string[] } {
    const normalizedQuery = normalizeTaskShortcutText(query);
    if (!normalizedQuery) {
        return { score: 0, matchReasons: [] };
    }

    const queryTokens = tokenizeTaskShortcutQuery(normalizedQuery);
    let matchScore = 0;
    const reasons = new Set<string>();

    const fields: Array<{ label: string; values: Array<string | undefined> }> = [
        { label: "标题/目标", values: [task.title, task.objective] },
        { label: "摘要/复盘", values: [task.summary, task.reflection, task.workRecap?.headline] },
        { label: "已确认事实", values: task.workRecap?.confirmedFacts ?? [] },
        { label: "当前停点", values: [task.resumeContext?.currentStopPoint, task.resumeContext?.nextStep, ...(task.resumeContext?.blockers ?? [])] },
        { label: "最近活动", values: collectRecentActivityTitles(task, 5) },
        { label: "工具/产物", values: [...(task.toolCalls?.map((item) => item.toolName) ?? []), ...(task.artifactPaths ?? [])] },
    ];

    for (const field of fields) {
        const fieldScore = scoreTaskShortcutField(field.values, normalizedQuery, queryTokens);
        if (fieldScore <= 0) continue;
        matchScore += fieldScore;
        reasons.add(field.label);
    }

    if (matchScore <= 0) {
        return { score: 0, matchReasons: [] };
    }

    return {
        score: matchScore + computeTaskShortcutRecencyBoost(task),
        matchReasons: [...reasons],
    };
}

function scoreTaskShortcutField(values: Array<string | undefined>, normalizedQuery: string, queryTokens: string[]): number {
    let best = 0;
    for (const value of values) {
        const normalizedValue = normalizeTaskShortcutText(value);
        if (!normalizedValue) continue;
        let score = 0;
        if (normalizedValue.includes(normalizedQuery)) {
            score += 8;
        }
        const tokenMatches = queryTokens.filter((token) => normalizedValue.includes(token)).length;
        const minTokenMatches = queryTokens.length >= 3 ? 2 : 1;
        if (tokenMatches >= minTokenMatches) {
            score += tokenMatches * 2;
        }
        if (score > best) {
            best = score;
        }
    }
    return best;
}

function tokenizeTaskShortcutQuery(value: string): string[] {
    return [...new Set(value
        .toLowerCase()
        .split(/[\s,.;:!?/\\()[\]{}<>|"'`~\-_=+]+/)
        .map((item) => item.trim())
        .filter((item) => item.length >= 2))];
}

function normalizeTaskShortcutText(value?: string): string | undefined {
    const sanitized = sanitizeTaskShortcutText(value);
    if (!sanitized) return undefined;
    return sanitized.toLowerCase();
}

function sanitizeTaskShortcutText(value?: string): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value
        .replace(/\s+/g, " ")
        .trim();
    return trimmed ? trimmed : undefined;
}

function computeTaskShortcutRecencyBoost(task: TaskShortcutCandidate): number {
    const timestamp = resolveTaskShortcutTimestamp(task);
    if (!Number.isFinite(timestamp)) return 0;
    const ageHours = (Date.now() - timestamp) / (1000 * 60 * 60);
    if (ageHours <= 24) return 3;
    if (ageHours <= 24 * 7) return 2;
    if (ageHours <= 24 * 30) return 1;
    return 0;
}

function canReviewMemoryTreeReport(
    currentStatus: MemoryTreeReportStatus,
    decision: MemoryTreeReportReviewDecision,
): boolean {
    if (currentStatus === "applied") {
        return false;
    }
    switch (decision) {
        case "approved":
            return currentStatus === "ready" || currentStatus === "rejected";
        case "rejected":
            return currentStatus === "ready" || currentStatus === "approved";
        case "superseded":
            return currentStatus !== "superseded";
        default:
            return false;
    }
}

function appendMemoryTreeReportReviewEvent(
    details: Record<string, unknown>,
    event: {
        decision: MemoryTreeReportReviewDecision;
        previousStatus: MemoryTreeReportStatus;
        reviewedAt: string;
        reviewedBy: string;
        note?: string;
    },
): Record<string, unknown> {
    const history = Array.isArray(details.reviewHistory) ? [...details.reviewHistory] : [];
    history.push({
        decision: event.decision,
        previousStatus: event.previousStatus,
        reviewedAt: event.reviewedAt,
        reviewedBy: event.reviewedBy,
        note: event.note ?? null,
    });
    return {
        ...details,
        lastReview: history[history.length - 1],
        reviewHistory: history,
    };
}

function resolveMemoryTreeDedupApplyPlan(report: MemoryTreeReportRecord): {
    operations: Array<{
        chunkId: string;
        keepChunkId: string;
        normalizedHash?: string;
    }>;
    skipped: Array<{
        chunkId: string;
        keepChunkId: string;
        normalizedHash?: string;
        reason: string;
    }>;
} {
    const groups = Array.isArray(report.details.groups) ? report.details.groups : [];
    const operations: Array<{ chunkId: string; keepChunkId: string; normalizedHash?: string }> = [];
    const skipped: Array<{ chunkId: string; keepChunkId: string; normalizedHash?: string; reason: string }> = [];
    for (const group of groups) {
        if (!group || typeof group !== "object") {
            continue;
        }
        const normalizedHash = typeof group.normalizedHash === "string" ? group.normalizedHash : undefined;
        const keepChunkId = typeof group.keep?.id === "string" ? group.keep.id : undefined;
        const remove = Array.isArray(group.remove) ? group.remove : [];
        const governance = isRecord(group.governance) ? group.governance : undefined;
        const suggestedAction = typeof governance?.suggestedAction === "string" ? governance.suggestedAction : "archive";
        if (!keepChunkId) {
            continue;
        }
        for (const item of remove) {
            if (!item || typeof item !== "object" || typeof item.id !== "string") {
                continue;
            }
            if (suggestedAction === "archive") {
                operations.push({
                    chunkId: item.id,
                    keepChunkId,
                    normalizedHash,
                });
            } else {
                skipped.push({
                    chunkId: item.id,
                    keepChunkId,
                    normalizedHash,
                    reason: suggestedAction === "keep" ? "governance_keep" : "governance_review",
                });
            }
        }
    }
    return { operations, skipped };
}

function computeArchivedGovernanceScore(previousScoreTotal?: number): number {
    const previous = typeof previousScoreTotal === "number" && Number.isFinite(previousScoreTotal)
        ? previousScoreTotal
        : undefined;
    if (previous === undefined) {
        return 0.05;
    }
    return roundMemoryTreeScore(Math.max(0, Math.min(previous * 0.25, 0.05)));
}

function buildArchivedMemoryChunkMetadata(
    metadata: Record<string, unknown> | undefined,
    input: {
        reportId: string;
        archivedAt: string;
        keepChunkId: string;
        normalizedHash?: string;
    },
): Record<string, unknown> {
    const memoryTree = isRecord(metadata?.memoryTree) ? metadata.memoryTree : {};
    const governance = isRecord(memoryTree.governance) ? memoryTree.governance : {};
    return {
        ...(metadata ?? {}),
        memoryTree: {
            ...memoryTree,
            governance: {
                ...governance,
                archived: true,
                archivedAt: input.archivedAt,
                archivedByReportId: input.reportId,
                archiveReason: "dedup_preview_remove",
                keepChunkId: input.keepChunkId,
                normalizedHash: input.normalizedHash ?? null,
            },
        },
    };
}

function buildArchivedMemoryTreeScoreRecord(input: {
    chunk: MemorySearchResult;
    existing?: MemoryTreeScoreRecord;
    reportId: string;
    appliedAt: string;
    keepChunkId: string;
    normalizedHash?: string;
    nextScoreTotal: number;
}): MemoryTreeScoreRecord {
    const rationale = isRecord(input.existing?.rationale) ? input.existing.rationale : {};
    const governance = isRecord(rationale.governance) ? rationale.governance : {};
    return {
        id: input.existing?.id ?? `score:${MEMORY_TREE_SCORE_VERSION}:chunk:${input.chunk.id}`,
        targetType: "chunk",
        targetId: input.chunk.id,
        sourceId: input.existing?.sourceId,
        scoreTotal: input.nextScoreTotal,
        recencyScore: input.existing?.recencyScore,
        sourceWeightScore: input.existing?.sourceWeightScore,
        interactionScore: input.existing?.interactionScore,
        taskOutcomeScore: input.existing?.taskOutcomeScore,
        entityDensityScore: input.existing?.entityDensityScore,
        llmImportanceScore: input.existing?.llmImportanceScore,
        dedupConfidence: Math.max(input.existing?.dedupConfidence ?? 0, 1),
        scoreVersion: input.existing?.scoreVersion ?? MEMORY_TREE_SCORE_VERSION,
        rationale: {
            ...rationale,
            governance: {
                ...governance,
                archivedByReportId: input.reportId,
                archivedAt: input.appliedAt,
                archiveReason: "dedup_preview_remove",
                keepChunkId: input.keepChunkId,
                normalizedHash: input.normalizedHash ?? null,
                previousScoreTotal: input.existing?.scoreTotal ?? null,
                nextScoreTotal: input.nextScoreTotal,
            },
        },
        createdAt: input.existing?.createdAt ?? input.appliedAt,
        updatedAt: input.appliedAt,
    };
}

function appendMemoryTreeReportApplyEvent(
    details: Record<string, unknown>,
    event: {
        appliedAt: string;
        appliedBy: string;
        note?: string;
        updatedChunkCount: number;
        updatedScoreCount: number;
        skippedChunkIds: string[];
        actions: MemoryTreeReportApplyResult["actions"];
        extra?: Record<string, unknown>;
    },
): Record<string, unknown> {
    const history = Array.isArray(details.applyHistory) ? [...details.applyHistory] : [];
    history.push({
        appliedAt: event.appliedAt,
        appliedBy: event.appliedBy,
        note: event.note ?? null,
        updatedChunkCount: event.updatedChunkCount,
        updatedScoreCount: event.updatedScoreCount,
        skippedChunkIds: event.skippedChunkIds,
        actions: event.actions,
        ...(event.extra ? { extra: event.extra } : {}),
    });
    return {
        ...details,
        lastApply: history[history.length - 1],
        applyHistory: history,
    };
}

function resolveReportGovernanceState(reportType: MemoryTreeReportType): string {
    switch (reportType) {
        case "inventory":
            return "inventory_baseline_confirmed";
        case "tree_build_preview":
            return "tree_build_baseline_confirmed";
        default:
            return `${reportType}_confirmed`;
    }
}

function roundMemoryTreeScore(value: number): number {
    return Math.round(value * 10_000) / 10_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildMemoryTreeReportId(input: {
    reportType: MemoryTreeReportType;
    inputVersion?: string;
    summary: Record<string, unknown>;
    details: Record<string, unknown>;
    scope: string;
    agentId?: string;
}): string {
    return `report:${input.reportType}:${hashMemoryTreePayload({
        reportType: input.reportType,
        inputVersion: input.inputVersion ?? "",
        summary: input.summary,
        details: input.details,
        scope: input.scope,
        agentId: input.agentId ?? null,
    })}`;
}

function sanitizePathSegment(value: string): string {
    return value
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
}

function buildMemoryTreeReportMarkdown(report: MemoryTreeReportRecord): string {
    return [
        `# Memory Tree Report`,
        "",
        `- id: ${report.id}`,
        `- type: ${report.reportType}`,
        `- scope: ${report.scope}`,
        `- status: ${report.status}`,
        `- inputVersion: ${report.inputVersion ?? ""}`,
        `- createdAt: ${report.createdAt ?? ""}`,
        `- updatedAt: ${report.updatedAt ?? ""}`,
        "",
        "## Summary",
        "```json",
        JSON.stringify(report.summary, null, 2),
        "```",
        "",
        "## Details",
        "```json",
        JSON.stringify(report.details, null, 2),
        "```",
        "",
    ].join("\n");
}

function readExternalIngestPreviewFromReport(report: MemoryTreeReportRecord): ExternalMemoryIngestPreview {
    const preview = isRecord(report.details.preview) ? report.details.preview : null;
    if (!preview) {
        throw new Error(`External ingest preview payload is missing in report ${report.id}.`);
    }
    const rootPath = typeof preview.rootPath === "string" ? preview.rootPath.trim() : "";
    const sourceId = typeof preview.sourceId === "string" ? preview.sourceId.trim() : "";
    const sourceLabel = typeof preview.sourceLabel === "string" ? preview.sourceLabel.trim() : "";
    const adapter = typeof preview.adapter === "string" ? preview.adapter.trim() : "";
    if (!rootPath || !sourceId || !sourceLabel || !adapter) {
        throw new Error(`External ingest preview payload is incomplete in report ${report.id}.`);
    }
    return preview as unknown as ExternalMemoryIngestPreview;
}

function buildMemoryTreeTaskSummary(task: TaskExperienceDetail): string {
    return [
        task.summary?.trim(),
        task.workRecap?.headline?.trim(),
        task.resumeContext?.currentStopPoint?.trim(),
    ].filter((item): item is string => Boolean(item)).slice(0, 2).join(" | ")
        || task.objective?.trim()
        || task.title?.trim()
        || `Task ${task.id}`;
}

function buildMemoryTreeSourceClassMix(links: Array<{ sourcePath?: string; memoryType?: string }>): Record<string, number> {
    const mix: Record<string, number> = {};
    for (const link of links) {
        const classification = classifyMemorySource(link.sourcePath ?? "", "file", link.memoryType ? [link.memoryType] : undefined);
        mix[classification.sourceClass] = (mix[classification.sourceClass] ?? 0) + 1;
    }
    return mix;
}

function readSearchResultSourceClass(result: MemorySearchResult): MemorySourceInventoryClass | "unknown" {
    const memoryTree = isRecord(result.metadata?.memoryTree) ? result.metadata.memoryTree : undefined;
    const sourceClass = typeof memoryTree?.sourceClass === "string" ? memoryTree.sourceClass.trim() : "";
    switch (sourceClass) {
        case "raw":
        case "derived":
        case "curated":
            return sourceClass;
        default:
            return "unknown";
    }
}

function isNodeBackedSearchResult(result: MemorySearchResult): boolean {
    const memoryTree = isRecord(result.metadata?.memoryTree) ? result.metadata.memoryTree : undefined;
    return isRecord(memoryTree?.nodeHit);
}

function buildMemorySearchStageSnapshot(results: MemorySearchResult[]): MemorySearchStageSnapshot {
    return {
        count: Array.isArray(results) ? results.length : 0,
        topHits: (Array.isArray(results) ? results : []).slice(0, 3).map((item) => ({
            id: item.id,
            score: roundMemoryTreeScore(item.score),
            sourceClass: readSearchResultSourceClass(item),
        })),
    };
}

function buildMemorySearchSourceClassMix(results: MemorySearchResult[]): Record<string, number> {
    const mix: Record<string, number> = {};
    for (const result of results) {
        const sourceClass = readSearchResultSourceClass(result);
        mix[sourceClass] = (mix[sourceClass] ?? 0) + 1;
    }
    return mix;
}

function buildDefaultNodeAssistedDiagnostics(policy: MemorySearchRoutingPolicy): MemorySearchNodeAssistedDiagnostics {
    return {
        enabled: policy === "node_assisted",
        policy,
        answerSufficient: false,
        evidenceExpanded: false,
        evidenceChunkCount: 0,
        highLevelOnly: false,
        selectedNodeIds: [],
        nodeHitCount: 0,
        injectedChunkCount: 0,
        fallbackApplied: false,
        returnedMix: {
            nodeBacked: 0,
            chunkOnly: 0,
        },
        nodeBackedShare: 0,
        chunkOnlyShare: 0,
        topNodeHits: [],
    };
}

function finalizeNodeAssistedDiagnostics(
    diagnostics: MemorySearchNodeAssistedDiagnostics,
    items: MemorySearchResult[],
): MemorySearchNodeAssistedDiagnostics {
    const returnedMix = {
        nodeBacked: 0,
        chunkOnly: 0,
    };
    for (const item of items) {
        if (isNodeBackedSearchResult(item)) {
            returnedMix.nodeBacked += 1;
        } else {
            returnedMix.chunkOnly += 1;
        }
    }
    const denominator = Math.max(returnedMix.nodeBacked + returnedMix.chunkOnly, 1);
    return {
        ...diagnostics,
        returnedMix,
        nodeBackedShare: roundMemoryTreeScore(returnedMix.nodeBacked / denominator),
        chunkOnlyShare: roundMemoryTreeScore(returnedMix.chunkOnly / denominator),
    };
}

function buildNodeAssistedTreeFreshness(
    nodes: MemoryTreeNodeLifecycleState[],
    refreshScheduled: boolean,
): NonNullable<MemorySearchNodeAssistedDiagnostics["treeFreshness"]> {
    const rebuiltAt = nodes
        .map((node) => node.lastRebuiltAt)
        .filter((value): value is string => Boolean(value))
        .sort()[0];
    return {
        stale: nodes.some((node) => node.dirty),
        refreshScheduled,
        dirtyKinds: nodes.filter((node) => node.dirty).map((node) => node.kind),
        ...(rebuiltAt ? { oldestRebuiltAt: rebuiltAt } : {}),
    };
}

function buildNodeAssistedSearchFilter(
    filter: MemorySearchFilter | undefined,
    routingPlan: ReturnType<typeof resolveMemoryTreeNodeRoutingPlan>,
): MemoryTreeNodeListFilter {
    const nodeFilter: MemoryTreeNodeListFilter = {
        kind: routingPlan.includeKinds,
    };
    if (filter?.agentId !== undefined) {
        nodeFilter.agentId = filter.agentId;
    }
    if (filter?.scope === "private" || filter?.scope === "shared") {
        nodeFilter.scope = filter.scope;
    }
    if (typeof filter?.topic === "string" && filter.topic.trim().length > 0) {
        nodeFilter.kind = "topic";
        nodeFilter.topicKey = filter.topic.trim();
    }
    return nodeFilter;
}

function buildRoutingPlanFilterFromNodeListFilter(
    filter?: MemoryTreeNodeListFilter,
): Pick<MemorySearchFilter, "topic" | "agentId" | "scope"> | undefined {
    if (!filter) {
        return undefined;
    }
    const routingFilter: Pick<MemorySearchFilter, "topic" | "agentId" | "scope"> = {};
    if (typeof filter.topicKey === "string" && filter.topicKey.trim().length > 0) {
        routingFilter.topic = filter.topicKey.trim();
    }
    if (filter.agentId !== undefined) {
        routingFilter.agentId = filter.agentId;
    }
    if (filter.scope === "private" || filter.scope === "shared") {
        routingFilter.scope = filter.scope;
    }
    return Object.keys(routingFilter).length > 0 ? routingFilter : undefined;
}

function buildNodeBackedSearchResult(input: {
    chunk: MemorySearchResult;
    node: MemoryTreeNodeSearchResult;
    nodeIndex: number;
    answerStage?: MemoryTreeNodeAnswerStage;
}): MemorySearchResult {
    const chunkMetadata = isRecord(input.chunk.metadata) ? input.chunk.metadata : {};
    const memoryTree = isRecord(chunkMetadata.memoryTree) ? chunkMetadata.memoryTree : {};
    const baseScore = Math.max(input.chunk.score, normalizeNodeAssistedScore(input.node.score) - (input.nodeIndex * 0.02));
    return {
        ...input.chunk,
        ...(input.answerStage === "high_level" && typeof input.node.node.summary === "string" && input.node.node.summary.trim().length > 0
            ? { summary: input.node.node.summary }
            : {}),
        score: clampScore(baseScore),
        metadata: {
            ...chunkMetadata,
            memoryTree: {
                ...memoryTree,
                answerStage: input.answerStage ?? "high_level",
                nodeHit: {
                    nodeId: input.node.node.id,
                    kind: input.node.node.kind,
                    score: roundMemoryTreeScore(normalizeNodeAssistedScore(input.node.score)),
                    matchReasons: input.node.matchReasons,
                },
            },
        },
    };
}

function normalizeNodeAssistedScore(score: number): number {
    return clampScore(0.35 + (Math.min(Math.max(score, 0), 12) / 20));
}

function dedupeMemorySearchResults(results: MemorySearchResult[]): MemorySearchResult[] {
    const seen = new Set<string>();
    const deduped: MemorySearchResult[] = [];
    for (const item of results) {
        if (!item?.id || seen.has(item.id)) {
            continue;
        }
        seen.add(item.id);
        deduped.push(item);
    }
    return deduped;
}

function buildMemoryTreeConversationNodeId(conversationId: string): string {
    return `conversation:${hashMemoryTreePayload({
        conversationId,
    })}`;
}

function buildMemoryTreeDayNodeId(dayKey: string): string {
    return `day:${hashMemoryTreePayload({
        day: dayKey,
    })}`;
}

function buildMemoryTreeProjectNodeId(projectKey: string): string {
    return `project:${hashMemoryTreePayload({
        project: projectKey,
    })}`;
}

function buildMemoryTreeAgentNodeId(agentKey: string): string {
    return `agent:${hashMemoryTreePayload({
        agent: agentKey,
    })}`;
}

function buildMemoryTreeAggregateSummary(label: string, tasks: TaskExperienceDetail[]): string {
    const highlights = dedupeStrings(tasks.flatMap((task) => [
        sanitizeTaskShortcutText(task.summary),
        sanitizeTaskShortcutText(task.workRecap?.headline),
        sanitizeTaskShortcutText(task.resumeContext?.currentStopPoint),
        sanitizeTaskShortcutText(task.objective),
        sanitizeTaskShortcutText(task.title),
    ])).slice(0, 2);
    return [
        label,
        ...highlights,
    ].join(" | ");
}

function scoreMemoryTreeNode(
    node: MemoryTreeNodeRecord,
    normalizedQuery: string,
    routingPlan?: ReturnType<typeof resolveMemoryTreeNodeRoutingPlan>,
): { score: number; matchReasons: string[] } {
    const queryTokens = tokenizeTaskShortcutQuery(normalizedQuery);
    let score = 0;
    const reasons = new Set<string>();
    const fields: Array<{ label: string; values: Array<string | undefined> }> = [
        { label: "标题", values: [node.title] },
        { label: "摘要", values: [node.summary] },
        { label: resolveMemoryTreeNodeKeyLabel(node.kind), values: [node.topicKey] },
    ];
    for (const field of fields) {
        const fieldScore = scoreTaskShortcutField(field.values, normalizedQuery, queryTokens);
        if (fieldScore <= 0) {
            continue;
        }
        score += fieldScore;
        reasons.add(field.label);
    }
    if (score <= 0) {
        return {
            score: 0,
            matchReasons: [],
        };
    }
    const boosted = routingPlan
        ? applyMemoryTreeNodeRoutingBoost(node, score, [...reasons], routingPlan)
        : {
            score,
            matchReasons: [...reasons],
        };
    return {
        score: boosted.score + computeMemoryTreeNodeRecencyBoost(node),
        matchReasons: boosted.matchReasons,
    };
}

function compareMemoryTreeNodeRecency(a: MemoryTreeNodeRecord, b: MemoryTreeNodeRecord): number {
    return resolveMemoryTreeNodeTimestamp(b) - resolveMemoryTreeNodeTimestamp(a);
}

function resolveMemoryTreeNodeTimestamp(node: MemoryTreeNodeRecord): number {
    const timestamp = Date.parse(node.timeTo ?? node.timeFrom ?? node.updatedAt ?? node.createdAt ?? "");
    return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function computeMemoryTreeNodeRecencyBoost(node: MemoryTreeNodeRecord): number {
    const timestamp = resolveMemoryTreeNodeTimestamp(node);
    if (!Number.isFinite(timestamp)) return 0;
    const ageHours = (Date.now() - timestamp) / (1000 * 60 * 60);
    if (ageHours <= 24) return 2;
    if (ageHours <= 24 * 7) return 1;
    return 0;
}

function normalizeMemoryTreeNodeText(value?: string): string | undefined {
    const sanitized = sanitizeTaskShortcutText(value);
    if (!sanitized) return undefined;
    return sanitized.toLowerCase();
}

function resolveMemoryTreeNodeKeyLabel(kind: MemoryTreeNodeKind): string {
    switch (kind) {
        case "conversation":
            return "conversation";
        case "day":
            return "day";
        case "project":
            return "project";
        case "agent":
            return "agent";
        case "topic":
            return "topic";
        default:
            return "key";
    }
}

function resolveUniformTaskAgentId(tasks: TaskExperienceDetail[]): string | undefined {
    const agentIds = collectTaskAgentIds(tasks);
    return agentIds.length === 1 ? agentIds[0] : undefined;
}

function collectTaskAgentIds(tasks: TaskExperienceDetail[]): string[] {
    return dedupeStrings(tasks.map((task) => task.agentId?.trim()).filter((item): item is string => Boolean(item)));
}

function collectTaskConversationIds(tasks: TaskExperienceDetail[]): string[] {
    return dedupeStrings(tasks.map((task) => task.conversationId?.trim()).filter((item): item is string => Boolean(item)));
}

function collectTaskGoalIds(tasks: TaskExperienceDetail[]): string[] {
    return dedupeStrings(tasks.map((task) => extractTaskGoalId(task)).filter((item): item is string => Boolean(item)));
}

function extractTaskGoalId(task: TaskExperienceDetail): string | undefined {
    const goalId = isRecord(task.metadata) && typeof task.metadata.goalId === "string"
        ? task.metadata.goalId.trim()
        : "";
    return goalId || undefined;
}

function buildMemoryTreeTaskStatusCounts(tasks: TaskExperienceDetail[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const task of tasks) {
        const status = task.status?.trim();
        if (!status) {
            continue;
        }
        counts[status] = (counts[status] ?? 0) + 1;
    }
    return counts;
}

function resolveLatestTaskTimestamp(tasks: TaskExperienceDetail[]): number {
    return tasks.reduce((latest, task) => {
        const timestamp = resolveTaskGroupTimestamp(task);
        return timestamp > latest ? timestamp : latest;
    }, Number.NEGATIVE_INFINITY);
}

function resolveTaskGroupTimeRange(tasks: TaskExperienceDetail[]): {
    timeFrom?: string;
    timeTo?: string;
} {
    let earliestValue: string | undefined;
    let earliestTimestamp = Number.POSITIVE_INFINITY;
    let latestValue: string | undefined;
    let latestTimestamp = Number.NEGATIVE_INFINITY;

    for (const task of tasks) {
        const fromValue = task.startedAt || task.createdAt || task.updatedAt;
        const toValue = task.finishedAt || task.updatedAt || task.startedAt || task.createdAt;
        const fromTimestamp = Date.parse(String(fromValue ?? ""));
        const toTimestamp = Date.parse(String(toValue ?? ""));
        if (Number.isFinite(fromTimestamp) && fromTimestamp < earliestTimestamp) {
            earliestTimestamp = fromTimestamp;
            earliestValue = fromValue;
        }
        if (Number.isFinite(toTimestamp) && toTimestamp > latestTimestamp) {
            latestTimestamp = toTimestamp;
            latestValue = toValue;
        }
    }

    return {
        ...(earliestValue ? { timeFrom: earliestValue } : {}),
        ...(latestValue ? { timeTo: latestValue } : {}),
    };
}

function resolveTaskGroupTimestamp(task: TaskExperienceDetail): number {
    const value = task.finishedAt || task.updatedAt || task.startedAt || task.createdAt;
    const timestamp = Date.parse(String(value ?? ""));
    return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function buildMemoryTreeDayKey(task: TaskExperienceDetail): string | undefined {
    const value = task.finishedAt || task.updatedAt || task.startedAt || task.createdAt;
    const normalized = typeof value === "string" ? value.trim() : "";
    return normalized ? normalized.slice(0, 10) : undefined;
}

function dedupeStrings(values: Array<string | undefined>): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
        const normalized = sanitizeTaskShortcutText(value);
        if (!normalized || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
}

function toTaskSearchFilterFromMemoryFilter(filter?: MemorySearchFilter): TaskSearchFilter | undefined {
    if (!filter) return undefined;
    const taskFilter: TaskSearchFilter = {};
    if (typeof filter.agentId === "string" && filter.agentId.trim()) {
        taskFilter.agentId = filter.agentId.trim();
    }
    if (typeof filter.dateFrom === "string" && filter.dateFrom.trim()) {
        taskFilter.dateFrom = filter.dateFrom.trim();
    }
    if (typeof filter.dateTo === "string" && filter.dateTo.trim()) {
        taskFilter.dateTo = filter.dateTo.trim();
    }
    return Object.keys(taskFilter).length > 0 ? taskFilter : undefined;
}

function buildInventoryMemorySourceRecord(item: MemorySourceInventoryItem, now: string): MemoryTreeSourceRecord {
    return {
        id: item.id,
        sourceKind: item.sourceKind,
        sourceClass: item.sourceClass,
        scope: item.scope,
        sourcePath: item.location.path,
        sourceRef: item.location.table ?? item.location.pattern,
        contentHash: hashMemoryTreePayload({
            id: item.id,
            sourceKind: item.sourceKind,
            stats: item.stats,
            location: item.location,
            status: item.status,
            admission: item.admission,
            identity: item.identity,
        }),
        timeFrom: undefined,
        timeTo: item.stats.lastUpdatedAt,
        itemCount: item.stats.itemCount,
        metadata: {
            recordType: "inventory_preview",
            storage: item.storage,
            status: item.status,
            duplicateRisk: item.duplicateRisk,
            stats: item.stats,
            location: item.location,
            notes: item.notes,
            sourceRegistry: {
                admission: item.admission,
                identity: item.identity,
            },
        },
        createdAt: now,
        updatedAt: now,
    };
}

function buildDynamicMemorySourceId(sourcePath: string, sourceType: string, agentId?: string): string {
    return `dynamic:${hashMemoryTreePayload({
        sourcePath,
        sourceType,
        agentId: agentId ?? null,
    })}`;
}

function hashMemoryTreePayload(payload: unknown): string {
    return createHash("sha1")
        .update(JSON.stringify(payload))
        .digest("hex");
}

function normalizeSourcePathForMatch(value?: string): string {
    if (typeof value !== "string") return "";
    return value.trim().replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

function readTextMetaValue(value: string | null | undefined): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const normalized = value.trim();
    return normalized || undefined;
}

function readNumericMetaValue(value: string | null | undefined): number {
    if (typeof value !== "string") {
        return 0;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function truncateMemoryTreeLifecycleErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.trim() || "Unknown lifecycle failure";
    return normalized.length > 280
        ? `${normalized.slice(0, 277)}...`
        : normalized;
}

function buildRuleOnlyChunkScore(
    input: {
        chunkId: string;
        sourcePath: string;
        sourceType: string;
        memoryType?: string;
        visibility?: string;
        updatedAt?: string;
        content?: string;
        taskLinkCount: number;
        successTaskCount: number;
        partialTaskCount: number;
        failedTaskCount: number;
        runningTaskCount: number;
    },
    sourceRecord?: MemoryTreeSourceRecord,
): {
    scoreTotal: number;
    recencyScore: number;
    sourceWeightScore: number;
    interactionScore: number;
    taskOutcomeScore: number;
    entityDensityScore: number;
    rationale: Record<string, unknown>;
} {
    const recencyScore = computeRecencyScore(input.updatedAt);
    const sourceKindWeight = computeSourceKindWeight(sourceRecord?.sourceKind);
    const sourceClassWeight = computeSourceClassWeight(sourceRecord?.sourceClass);
    const sourceWeightScore = clampScore((sourceKindWeight + sourceClassWeight) / 2);
    const interactionScore = computeInteractionScore(input.taskLinkCount, input.visibility === "shared");
    const taskOutcomeScore = computeTaskOutcomeScore(input);
    const entityDensityScore = computeEntityDensityScore(input.content);
    const scoreTotal = clampScore(
        (recencyScore * 0.30)
        + (sourceWeightScore * 0.25)
        + (interactionScore * 0.25)
        + (taskOutcomeScore * 0.15)
        + (entityDensityScore * 0.05),
    );
    return {
        scoreTotal,
        recencyScore,
        sourceWeightScore,
        interactionScore,
        taskOutcomeScore,
        entityDensityScore,
        rationale: {
            chunkId: input.chunkId,
            sourcePath: input.sourcePath,
            sourceKind: sourceRecord?.sourceKind ?? "unmapped",
            sourceClass: sourceRecord?.sourceClass ?? "raw",
            sourceClassWeight,
            sourceKindWeight,
            taskLinkCount: input.taskLinkCount,
            successTaskCount: input.successTaskCount,
            partialTaskCount: input.partialTaskCount,
            failedTaskCount: input.failedTaskCount,
            runningTaskCount: input.runningTaskCount,
            visibility: input.visibility ?? "private",
            updatedAt: input.updatedAt,
            scoreWeights: {
                recency: 0.30,
                sourceWeight: 0.25,
                interaction: 0.25,
                taskOutcome: 0.15,
                entityDensity: 0.05,
            },
        },
    };
}

function computeRecencyScore(updatedAt?: string): number {
    if (!updatedAt) return 0.35;
    const timestamp = Date.parse(updatedAt);
    if (!Number.isFinite(timestamp)) return 0.35;
    const ageDays = (Date.now() - timestamp) / (1000 * 60 * 60 * 24);
    if (ageDays <= 1) return 1;
    if (ageDays <= 7) return 0.9;
    if (ageDays <= 30) return 0.75;
    if (ageDays <= 90) return 0.55;
    if (ageDays <= 180) return 0.4;
    return 0.25;
}

function computeSourceKindWeight(sourceKind?: string): number {
    switch (sourceKind) {
        case "memory_core_note":
        case "dream_notes":
            return 0.9;
        case "session_messages":
        case "memory_notes":
            return 0.75;
        case "workspace_file":
        case "manual_memory":
            return 0.7;
        case "dream_index":
        case "dream_runtime":
        case "session_meta":
        case "session_digest":
        case "session_memory":
        case "session_transcripts":
            return 0.5;
        default:
            return 0.6;
    }
}

function computeSourceClassWeight(sourceClass?: MemorySourceInventoryClass): number {
    switch (sourceClass) {
        case "curated":
            return 0.9;
        case "raw":
            return 0.75;
        case "derived":
            return 0.5;
        default:
            return 0.65;
    }
}

function readMemoryTreeScoreSourceClass(scoreRecord: MemoryTreeScoreRecord): MemorySourceInventoryClass | undefined {
    const sourceClass = scoreRecord.rationale && typeof scoreRecord.rationale.sourceClass === "string"
        ? scoreRecord.rationale.sourceClass
        : undefined;
    switch (sourceClass) {
        case "raw":
        case "derived":
        case "curated":
            return sourceClass;
        default:
            return undefined;
    }
}

function computeSearchSourceClassBoost(sourceClass?: MemorySourceInventoryClass): number {
    switch (sourceClass) {
        case "curated":
            return 1.08;
        case "raw":
            return 1.03;
        case "derived":
            return 0.94;
        default:
            return 1;
    }
}

function computeInteractionScore(taskLinkCount: number, isShared: boolean): number {
    let base = 0.25;
    if (taskLinkCount >= 3) {
        base = 1;
    } else if (taskLinkCount === 2) {
        base = 0.8;
    } else if (taskLinkCount === 1) {
        base = 0.6;
    }
    if (isShared) {
        base += 0.1;
    }
    return clampScore(base);
}

function computeTaskOutcomeScore(input: {
    successTaskCount: number;
    partialTaskCount: number;
    failedTaskCount: number;
    runningTaskCount: number;
}): number {
    if (input.successTaskCount > 0) return 1;
    if (input.partialTaskCount > 0) return 0.7;
    if (input.failedTaskCount > 0) return 0.35;
    if (input.runningTaskCount > 0) return 0.2;
    return 0.3;
}

function computeEntityDensityScore(content?: string): number {
    if (!content) return 0;
    const pathHits = (content.match(/[A-Za-z]:\\|\/[\w./-]+|\b[\w.-]+\.(?:ts|tsx|js|jsx|md|json|yml|yaml|sql|py)\b/g) ?? []).length;
    const codeHits = (content.match(/[`#]/g) ?? []).length;
    const taskHits = (content.match(/\b(task|agent|goal|memory|chunk|prompt|tool)\b/gi) ?? []).length;
    const rawScore = Math.min(8, pathHits + Math.ceil(codeHits / 4) + Math.ceil(taskHits / 2));
    return clampScore(rawScore / 8);
}

function clampScore(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}
