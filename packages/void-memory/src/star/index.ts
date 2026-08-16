import type Database from "better-sqlite3";

export { MemoryStore } from "./store.js";
/** better-sqlite3 的 Database 实例类型，供同进程治理模块（如 WorkflowJournal）共享 db 句柄时使用 */
export type SqliteDatabase = InstanceType<typeof Database>;
export { MemoryIndexer } from "./indexer.js";
export type {
  SessionArtifactInventoryItem,
  SessionArtifactInventoryPage,
  SessionArtifactInventoryProvider,
} from "./session-artifact-inventory.js";
export { ResultReranker, type RerankerOptions, type GetVectorFn, type GetVectorsFn } from "./reranker.js";
export {
  MEMORY_CLASS_VALUES,
  MEMORY_CLASS_ORDER,
  MEMORY_TRUTH_MODE_VALUES,
  getMemoryClassContract,
  isMemoryClass,
  isMemoryTruthMode,
  listMemoryClassContracts,
  normalizeMemoryClass,
  normalizeMemoryTruthMode,
  type MemoryClass,
  type MemoryClassContract,
  type MemoryTruthMode,
} from "./memory-class-contract.js";
export {
  MEMORY_CLASS_BINDING_ROLE_VALUES,
  findMemoryClassBindingsByModulePath,
  getMemoryClassBindingEntry,
  isMemoryClassBindingRole,
  listMemoryClassBindingEntries,
  listMemoryClassBindings,
  normalizeMemoryClassModulePath,
  type MemoryClassBindingFilter,
  type MemoryClassBindingRegistryEntry,
  type MemoryClassBindingRole,
  type MemoryClassModuleBinding,
} from "./memory-class-bindings.js";
export {
  MemoryManager,
  type MemoryManagerOptions,
  type ConversationMemoryExtractionSupport,
  type ConversationMemoryExtractionSupportReason,
  type ConversationMemoryExtractionSupportReasonCode,
  type DurableMemoryCandidateType,
  type DurableMemoryGuidance,
  type MemorySearchDiagnostics,
  type MemorySearchExecution,
  type MemorySearchNodeAssistedDiagnostics,
  type MemorySearchNodeAssistedHit,
  type MemorySearchStageSnapshot,
  type MemorySearchStageTopHit,
  type DurableMemoryRejectionReasonCode,
  type ExtractConversationMemoriesResult,
  type GlobalMemoryManagerRegistrationOptions,
  type GlobalMemoryManagerScope,
  type TaskWorkShortcutItem,
  registerGlobalMemoryManager,
  registerGlobalMemoryManagerResolver,
  getGlobalMemoryManager,
  listGlobalMemoryManagers,
  resetGlobalMemoryManagers,
} from "./manager.js";
export {
  buildDerivedRetrievalDoctorReport,
  createDerivedRetrievalRuntimeSnapshot,
  type DerivedRetrievalDoctorCheck,
  type DerivedRetrievalDoctorReport,
  type DerivedRetrievalRuntimeSnapshot,
} from "./derived-retrieval-doctor.js";
export {
  DurableExtractionRuntime,
  type DurableExtractionRuntimeOptions,
  type DurableExtractionRecord,
  type DurableExtractionStatus,
  type DurableExtractionChangeEvent,
  type DurableExtractionDigestSnapshot,
  type DurableExtractionRequestEvent,
  type DurableExtractionRunStartEvent,
  type DurableExtractionRunDecision,
  type DurableExtractionRunResultEvent,
  type DurableExtractionJobClaim,
  type DurableExtractionJobClaimResult,
} from "./durable-extraction.js";
export {
  DEFAULT_DURABLE_EXTRACTION_MAX_AGGREGATE_BYTES,
  DEFAULT_DURABLE_EXTRACTION_MAX_MESSAGE_BYTES,
  DEFAULT_DURABLE_EXTRACTION_MAX_MESSAGES,
  renderDurableExtractionMessages,
  selectDurableExtractionInput,
  type DurableExtractionInputLimits,
  type DurableExtractionInputSelection,
  type DurableExtractionMessage,
} from "./durable-extraction-input.js";
export {
  MEMORY_MODEL_MAX_REQUEST_BYTES,
  MemoryModelPrivacyRuntime,
  preparePrivateSummaryModelRequest,
  resolveMemoryModelEndpointTrust,
  type MemoryModelEndpointTrust,
  type MemoryModelPrivacyDoctorItem,
  type MemoryModelPrivacyDoctorReport,
  type MemoryModelPrivacyObservation,
  type MemoryModelPrivacySnapshot,
  type MemoryModelRedactor,
  type MemoryPrivateSummaryJobFamily,
} from "./memory-model-privacy.js";
export {
  DURABLE_PROFILE_STATE_PROMPT_BLOCK,
  buildDurableProfileStatePlan,
  isAllowedDurableProfileStatePath,
  type DurableProfileStateCandidate,
  type DurableProfileStatePatch,
  type DurableProfileStatePlan,
} from "./durable-profile-state.js";
export {
  DURABLE_EXTRACTION_REQUEST_RATE_LIMIT_REASON_CODE,
  DURABLE_EXTRACTION_REQUEST_RATE_LIMIT_REASON_MESSAGE,
  normalizeDurableExtractionRequestSource,
  normalizeDurableExtractionSkipReason,
  normalizeNonEmptyString,
  type DurableExtractionRequestSource,
  type DurableExtractionSkipReasonCode,
} from "./durable-extraction-policy.js";
export {
  createDurableExtractionSurface,
  getDurableExtractionSurfacePolicy,
  type DurableExtractionSurface,
  type DurableExtractionSurfaceDelegate,
  type DurableExtractionSurfacePolicy,
} from "./durable-extraction-surface.js";
export {
  createTaskWorkSurface,
  type TaskWorkSourceExplanation,
  type TaskWorkSourceReference,
  type TaskWorkSourceReferenceKind,
  type TaskWorkSurface,
  type TaskWorkSurfaceDelegate,
} from "./task-work-surface.js";
export {
  DreamStore,
  buildDreamFilePath,
  buildDreamIndexPath,
  buildDreamRuntimePath,
  buildDreamsDirPath,
  createDefaultDreamRuntimeState,
  toDreamInputMeta,
  type BuildDreamFilePathOptions,
  type DreamStoreOptions,
} from "./dream-store.js";
export {
  buildDreamConversationArtifactPath,
  buildDreamRuleSkeleton,
  buildDreamInputSnapshot,
  readDreamSessionDigestFile,
  readDreamSessionMemoryFile,
} from "./dream-input.js";
export {
  buildDreamPromptBundle,
  parseDreamModelOutput,
  summarizeDreamModelOutput,
} from "./dream-prompt.js";
export { writeDreamArtifacts } from "./dream-writer.js";
export {
  DEFAULT_DREAM_OBSIDIAN_ROOT_DIR,
  resolveDreamObsidianMirrorPaths,
} from "./obsidian-sync-paths.js";
export { syncDreamToObsidian } from "./dream-obsidian-sync.js";
export { writeObsidianCommonsExport } from "./commons-exporter.js";
export { DreamRuntime } from "./dream-runtime.js";
export { ExperiencePromoter } from "./experience-promoter.js";
export {
  hasEmailToolCalls,
  isEmailConversationTask,
  resolveAutomaticExperiencePromotionTaskGate,
  shouldAutoPromoteTaskByPolicy,
  type AutomaticExperiencePromotionTaskGate,
} from "./task-auto-promotion-policy.js";
export {
  buildExperienceCandidateSlug,
  buildExperienceMethodFilenameBase,
  buildExperienceSkillMachineName,
  normalizeExperienceSkillMachineName,
  readFirstMarkdownTitle,
  validateMethodCandidateDraftForPublish,
  validateSkillCandidateDraftForPublish,
  EXPERIENCE_METHOD_REQUIRED_HEADINGS,
  EXPERIENCE_SKILL_REQUIRED_HEADINGS,
} from "./experience-publish-rules.js";
export {
  buildMemoryExactDedupPreviewReport,
  buildMemoryExactDedupApplyPlan,
  ensureMemoryDedupBackupFile,
  normalizeChunkContentForExactDedup,
  type MemoryDedupGroupSourceIndexSummary,
  type MemoryDedupGovernanceRiskLevel,
  type MemoryDedupGovernanceSignal,
  type MemoryDedupGovernanceSuggestedAction,
  type MemoryExactDedupApplyOptions,
  type MemoryExactDedupApplyResult,
  type MemoryExactDedupGovernanceGroup,
  type MemoryExactDedupGovernanceSummary,
  type MemoryDedupChunkSnapshot,
  type MemoryDedupSourceIndexInfo,
  type MemoryDedupSourceIndexScope,
  type MemoryDedupSourceIndexSummary,
  type MemoryExactDedupPreviewGroup,
  type MemoryExactDedupPreviewObservability,
  type MemoryExactDedupPreviewItem,
  type MemoryExactDedupPreviewReport,
} from "./memory-dedup.js";
export {
  buildMemoryExactDedupGovernanceSummary,
  buildMemoryExactDedupGroupGovernance,
  decorateMemoryExactDedupReportWithGovernance,
} from "./memory-dedup-governance.js";
export {
  buildMemoryVacuumWarnings,
  ensureMemoryVacuumBackupFile,
  type MemoryVacuumApplyOptions,
  type MemoryVacuumApplyResult,
  type MemoryVacuumObservability,
  type MemoryVacuumPreviewReport,
} from "./memory-vacuum.js";
export {
  buildMemorySourceInventoryReport,
  type BuildMemorySourceInventoryInput,
  type MemoryExperienceInventoryStats,
  type MemorySourceInventoryClass,
  type MemorySourceInventoryConfiguredSource,
  type MemorySourceInventoryDuplicateRiskLevel,
  type MemorySourceInventoryFamily,
  type MemorySourceInventoryFamilyMember,
  type MemorySourceInventoryFamilyRiskLevel,
  type MemorySourceInventoryItem,
  type MemorySourceInventoryReport,
  type MemorySourceInventoryScope,
  type MemorySourceInventoryStatus,
  type MemorySourceInventoryStorage,
  type MemoryTaskInventoryStats,
} from "./memory-source-inventory.js";
export {
  classifyMemorySource,
  isMemorySourceSearchPolicy,
  normalizeSourcePathForRegistryMatch,
  resolveMemorySourceAdmission,
  resolveMemorySourceIdentity,
  type MemorySourceAdmissionPolicy,
  type MemorySourceDedupPolicy,
  type MemorySourceIdentity,
  type MemorySourceRetentionHint,
  type MemorySourceSearchPolicy,
} from "./memory-source-registry.js";
export {
  buildMemorySourceInventoryDoctorReport,
  buildMemorySourceInventoryGovernanceSummary,
  type MemorySourceInventoryDoctorCheck,
  type MemorySourceInventoryDoctorReport,
  type MemorySourceInventoryGovernanceCategory,
  type MemorySourceInventoryGovernanceFamilySummary,
  type MemorySourceInventoryGovernanceFamilySuggestion,
  type MemorySourceInventoryGovernanceRiskLevel,
  type MemorySourceInventoryGovernanceSignal,
  type MemorySourceInventoryGovernanceSuggestedAction,
  type MemorySourceInventoryGovernanceSummary,
} from "./memory-source-inventory-governance.js";
export {
  buildExternalMemoryIngestGovernanceSummary,
  type ExternalMemoryIngestGovernanceIndexedSource,
  type ExternalMemoryIngestGovernanceRiskLevel,
  type ExternalMemoryIngestGovernanceSignal,
  type ExternalMemoryIngestGovernanceSuggestion,
  type ExternalMemoryIngestGovernanceSuggestionCategory,
  type ExternalMemoryIngestGovernanceSuggestedAction,
  type ExternalMemoryIngestGovernanceSummary,
} from "./external-memory-ingest-governance.js";
export {
  buildMemoryTreeJobReport,
  type MemoryTreeJobDefinition,
  type MemoryTreeJobImplementationStage,
  type MemoryTreeJobReport,
  type MemoryTreeJobReportCheck,
  type MemoryTreeJobStatus,
  type MemoryTreeJobType,
  type MemoryTreeJobView,
} from "./memory-tree-job-report.js";
export {
  clearMemoryTreeJobInflightForTest,
} from "./memory-tree-job-control.js";
export {
  buildMemoryTreeLifecycleReport,
  type MemoryTreeLifecycleReport,
  type MemoryTreeLifecycleReportCheck,
  type MemoryTreeLifecycleReportCheckStatus,
  type MemoryTreeLifecycleReportTarget,
  type MemoryTreeLifecycleReportTargetKind,
} from "./memory-tree-lifecycle-report.js";
export {
  type MemoryTreeChunkScoreInput,
  type MemoryTreeEdgeListFilter,
  type MemoryTreeEdgeRecord,
  type MemoryTreeNodeKind,
  type MemoryTreeNodeListFilter,
  type MemoryTreeNodeRebuildResult,
  type MemoryTreeNodeRecord,
  type MemoryTreeNodeSearchResult,
  type MemoryTreeReportApplyAction,
  type MemoryTreeReportApplyResult,
  type MemoryTreeReportListFilter,
  type MemoryTreeReportPersistResult,
  type MemoryTreeReportRecord,
  type MemoryTreeReportReviewDecision,
  type MemoryTreeReportReviewResult,
  type MemoryTreeReportStatus,
  type MemoryTreeReportType,
  type MemoryTreeScoreListFilter,
  type MemoryTreeScoreRecord,
  type MemoryTreeScoreRebuildResult,
  type MemoryTreeScope,
  type MemoryTreeSourceListFilter,
  type MemoryTreeSourceRecord,
  type MemoryTreeSourceRebuildResult,
  type MemoryTreeTargetType,
} from "./memory-tree-types.js";
export {
  buildMemorySourceCoveragePolicyExplanations,
  describeMemorySourceCoverageItem,
  type MemorySourceCoveragePolicyExplanation,
} from "./memory-source-coverage-explanations.js";
export {
  buildVirtualCandidateFromPublishedAsset,
  listPublishedAssets,
  type PublishedExperienceAssetRecord,
} from "./published-experience-assets.js";
export {
  buildExperienceSynthesisPreview,
  buildExperienceSynthesisPreviewFromSourceCandidates,
} from "./experience-synthesis.js";
export { shouldSkipRetrieval } from "./adaptive-retrieval.js";
export { isNoise, filterNoise, type NoiseFilterOptions } from "./noise-filter.js";
export * from "./types.js";
export * from "./task-types.js";
export * from "./experience-types.js";
export * from "./dream-types.js";
export * from "./profile-state-types.js";
export * from "./memory-files.js";
export * from "./team-memory.js";
export { TaskProcessor, type TaskProcessorOptions } from "./task-processor.js";
export { TaskSummarizer, type TaskSummarizerOptions, type TaskSummaryPayload } from "./task-summarizer.js";
export { OpenAIEmbeddingProvider, type OpenAIEmbeddingOptions } from "./embeddings/openai.js";
export type {
  EmbeddingModel,
  EmbeddingProvider,
  EmbeddingRequestContext,
  EmbeddingVector,
} from "./embeddings/index.js";
export type {
  EmbeddingAdapterRequest,
  EmbeddingAdapterResponse,
  EmbeddingAdapterResult,
  EmbeddingProviderConfig,
  LegacyEmbeddingProvider,
} from "./embeddings/types.js";
