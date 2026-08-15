/**
 * openai→ctx.llm 补丁的核心：把 OpenAI 兼容的 chat-completion payload 走 dsh 的
 * ctx.llm.stream，收集文本增量，返回与快照 HTTP 请求相同的
 * `{ choices: [{ message: { content } }] }` 形状。
 *
 * 边界（见 SOURCES.md / README）：
 * - summary/evolution/dream 的 chat-completion 请求 → 走 ctx.llm（本文件）。
 * - embedding → 仍走 openai（dsh 无 embedding seam，快照保留 OpenAIEmbeddingProvider）。
 */

export interface LlmStreamChunk {
  type: string;
  text?: string;
}

/** dsh 的 ctx.llm 最小表面（只用到 stream）。 */
export interface LlmLike {
  stream(options: { messages: unknown; model?: string }): AsyncIterable<LlmStreamChunk>;
}

/** OpenAI 兼容的 chat-completion payload（快照里 summary/evolution 请求的 body）。 */
export interface ChatCompletionPayload {
  model?: string;
  messages?: unknown;
  [key: string]: unknown;
}

export interface ChatCompletionResponse {
  choices: Array<{ message: { content: string } }>;
}

/**
 * 经 ctx.llm 完成一次 chat-completion 请求。
 * @param llm - dsh 的 ctx.llm（注入）。
 * @param payload - OpenAI 兼容 payload（含 messages + 可选 model）。
 */
export async function requestChatCompletionViaLlm(
  llm: LlmLike,
  payload: ChatCompletionPayload,
): Promise<ChatCompletionResponse> {
  const messages = payload.messages ?? [];
  let content = "";
  for await (const chunk of llm.stream({
    messages,
    ...(payload.model ? { model: payload.model } : {}),
  })) {
    if (chunk.type === "text-delta" && typeof chunk.text === "string") {
      content += chunk.text;
    }
  }
  return { choices: [{ message: { content } }] };
}
