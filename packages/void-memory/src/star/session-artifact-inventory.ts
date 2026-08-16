/**
 * Memory 对 Agent 会话工件清单的只读契约。
 * 具体 inventory 由 Agent/Host 按 state root 提供，Memory 不反向依赖 ConversationStore。
 */
export type SessionArtifactInventoryItem = {
  safeConversationId: string;
  conversationId: string;
  newestFileMs: number;
  digestPath?: string;
  sessionMemoryPath?: string;
};

export type SessionArtifactInventoryPage = {
  status: "ready" | "unavailable";
  items: SessionArtifactInventoryItem[];
};

export type SessionArtifactInventoryProvider = {
  listPage(options?: { limit?: number }): Promise<SessionArtifactInventoryPage>;
};
