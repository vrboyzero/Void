import type {
  ConversationMemoryExtractionSupport,
  DurableMemoryGuidance,
  ExtractConversationMemoriesOptions,
  ExtractConversationMemoriesResult,
} from "./manager.js";

export type DurableExtractionSurfacePolicy = {
  summary: string;
  allowedCapabilities: string[];
  blockedCapabilities: string[];
};

export type DurableExtractionSurfaceDelegate = {
  extractMemoriesFromConversation(
    sessionKey: string,
    messages: Array<{ role: string; content: string }>,
    options?: ExtractConversationMemoriesOptions,
  ): Promise<number | ExtractConversationMemoriesResult>;
  isConversationMemoryExtractionEnabled(): boolean;
  getConversationMemoryExtractionSupport?(): ConversationMemoryExtractionSupport;
  getDurableMemoryGuidance?(): DurableMemoryGuidance;
  readonly isPaused: boolean;
};

export type DurableExtractionSurface = DurableExtractionSurfaceDelegate;

const DURABLE_EXTRACTION_SURFACE_POLICY: DurableExtractionSurfacePolicy = {
  summary: "Durable extraction uses a constrained background runtime and does not expose the main-thread tool surface.",
  allowedCapabilities: [
    "Read normalized conversation snapshots",
    "Read session digest snapshots",
    "Write durable memories through MemoryManager.extractMemoriesFromConversation()",
    "Yield while MemoryManager is paused to avoid contending with the main request path",
  ],
  blockedCapabilities: [
    "No ToolExecutor builtin / MCP / plugin / skill execution",
    "No arbitrary codebase reads, shell commands, browser automation, or worktree mutations",
    "No direct memory file editing outside the extractor-managed write path",
  ],
};

export function getDurableExtractionSurfacePolicy(): DurableExtractionSurfacePolicy {
  return {
    summary: DURABLE_EXTRACTION_SURFACE_POLICY.summary,
    allowedCapabilities: [...DURABLE_EXTRACTION_SURFACE_POLICY.allowedCapabilities],
    blockedCapabilities: [...DURABLE_EXTRACTION_SURFACE_POLICY.blockedCapabilities],
  };
}

export function createDurableExtractionSurface(delegate: DurableExtractionSurfaceDelegate): DurableExtractionSurface {
  const surface: DurableExtractionSurface = {
    get isPaused() {
      return delegate.isPaused;
    },
    extractMemoriesFromConversation(sessionKey, messages, options) {
      return delegate.extractMemoriesFromConversation(sessionKey, messages, options);
    },
    isConversationMemoryExtractionEnabled() {
      return delegate.isConversationMemoryExtractionEnabled();
    },
  };
  if (delegate.getConversationMemoryExtractionSupport) {
    surface.getConversationMemoryExtractionSupport = () => delegate.getConversationMemoryExtractionSupport!();
  }
  if (delegate.getDurableMemoryGuidance) {
    surface.getDurableMemoryGuidance = () => delegate.getDurableMemoryGuidance!();
  }
  return surface;
}
