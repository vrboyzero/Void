export type DurableExtractionMessage = {
  role: string;
  content: string;
};

export type DurableExtractionInputLimits = {
  maxMessages?: number;
  maxMessageBytes?: number;
  maxAggregateBytes?: number;
};

export type DurableExtractionInputSelection = {
  messages: DurableExtractionMessage[];
  conversationText: string;
  inputBytes: number;
  droppedMessageCount: number;
  truncatedMessageCount: number;
};

export const DEFAULT_DURABLE_EXTRACTION_MAX_MESSAGES = 64;
export const DEFAULT_DURABLE_EXTRACTION_MAX_MESSAGE_BYTES = 16 * 1024;
export const DEFAULT_DURABLE_EXTRACTION_MAX_AGGREGATE_BYTES = 48 * 1024;

function normalizeLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.max(1, Math.floor(Number(value)))
    : fallback;
}

function normalizeRole(role: string): string {
  return role.trim().toLowerCase() === "user" ? "user" : "assistant";
}

function renderMessage(message: DurableExtractionMessage): string {
  return `${message.role === "user" ? "用户" : "助手"}: ${message.content}`;
}

function truncateUtf8Tail(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  let byteLength = 0;
  const codePoints = Array.from(value);
  for (let index = codePoints.length - 1; index >= 0; index -= 1) {
    const codePoint = codePoints[index];
    const nextBytes = Buffer.byteLength(codePoint, "utf8");
    if (byteLength + nextBytes > maxBytes) break;
    result = codePoint + result;
    byteLength += nextBytes;
  }
  return result;
}

export function renderDurableExtractionMessages(messages: DurableExtractionMessage[]): string {
  return messages.map(renderMessage).join("\n\n");
}

export function selectDurableExtractionInput(
  sourceMessages: DurableExtractionMessage[],
  limits: DurableExtractionInputLimits = {},
): DurableExtractionInputSelection {
  const maxMessages = normalizeLimit(limits.maxMessages, DEFAULT_DURABLE_EXTRACTION_MAX_MESSAGES);
  const maxMessageBytes = normalizeLimit(
    limits.maxMessageBytes,
    DEFAULT_DURABLE_EXTRACTION_MAX_MESSAGE_BYTES,
  );
  const maxAggregateBytes = normalizeLimit(
    limits.maxAggregateBytes,
    DEFAULT_DURABLE_EXTRACTION_MAX_AGGREGATE_BYTES,
  );
  const normalized = sourceMessages
    .filter((message) => message && typeof message.role === "string" && typeof message.content === "string")
    .map((message) => ({
      role: normalizeRole(message.role),
      content: message.content,
    }));
  const candidates = normalized.slice(-maxMessages).map((message, index) => {
    const content = truncateUtf8Tail(message.content, maxMessageBytes);
    return {
      message: { ...message, content },
      truncated: content !== message.content,
      index,
    };
  });
  const selectedReversed: Array<typeof candidates[number]> = [];
  let usedBytes = 0;

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    let candidate = candidates[index];
    const separatorBytes = selectedReversed.length > 0 ? Buffer.byteLength("\n\n", "utf8") : 0;
    let renderedBytes = Buffer.byteLength(renderMessage(candidate.message), "utf8");
    const remainingBytes = maxAggregateBytes - usedBytes - separatorBytes;
    if (renderedBytes > remainingBytes) {
      if (selectedReversed.length > 0) break;
      const envelopeBytes = Buffer.byteLength(renderMessage({
        ...candidate.message,
        content: "",
      }), "utf8");
      if (remainingBytes <= envelopeBytes) break;
      const content = truncateUtf8Tail(candidate.message.content, remainingBytes - envelopeBytes);
      candidate = {
        ...candidate,
        message: { ...candidate.message, content },
        truncated: true,
      };
      renderedBytes = Buffer.byteLength(renderMessage(candidate.message), "utf8");
    }
    selectedReversed.push(candidate);
    usedBytes += separatorBytes + renderedBytes;
  }

  const selected = selectedReversed.reverse();
  const messages = selected.map((item) => item.message);
  const conversationText = renderDurableExtractionMessages(messages);
  return {
    messages,
    conversationText,
    inputBytes: Buffer.byteLength(conversationText, "utf8"),
    droppedMessageCount: normalized.length - messages.length,
    truncatedMessageCount: selected.filter((item) => item.truncated).length,
  };
}
