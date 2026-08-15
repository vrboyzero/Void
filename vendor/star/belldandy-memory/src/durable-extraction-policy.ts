export type DurableExtractionRequestSource =
  | "manual"
  | "message.send"
  | "memory.extract"
  | "api.message"
  | "webhook.receive";

export type DurableExtractionSkipReasonCode =
  | "digest_not_ready"
  | "pending_below_threshold"
  | "message_delta_below_threshold"
  | "stale_digest"
  | "up_to_date"
  | "retry_failed"
  | "cooldown_active"
  | "failure_backoff_active"
  | "policy_filtered"
  | "dedupe_skipped"
  | "extractor_empty"
  | "extractor_disabled"
  | "messages_below_min"
  | "dedupe_key_already_processed"
  | "durable_extraction_request_rate_limited"
  | "durable_extraction_run_budget_exceeded";

export const DURABLE_EXTRACTION_REQUEST_RATE_LIMIT_REASON_CODE = "durable_extraction_request_rate_limited" as const;
export const DURABLE_EXTRACTION_REQUEST_RATE_LIMIT_REASON_MESSAGE = "Durable extraction request rate limit exceeded." as const;

export function normalizeDurableExtractionRequestSource(value: unknown): DurableExtractionRequestSource | undefined {
  const normalized = normalizeNonEmptyString(value)?.toLowerCase();
  switch (normalized) {
    case "manual":
    case "message.send":
    case "memory.extract":
    case "api.message":
    case "webhook.receive":
      return normalized;
    default:
      return undefined;
  }
}

export function normalizeDurableExtractionSkipReason(value: unknown): DurableExtractionSkipReasonCode | undefined {
  const normalized = normalizeNonEmptyString(value)?.toLowerCase();
  switch (normalized) {
    case "digest_not_ready":
    case "pending_below_threshold":
    case "message_delta_below_threshold":
    case "stale_digest":
    case "up_to_date":
    case "retry_failed":
    case "cooldown_active":
    case "failure_backoff_active":
    case "policy_filtered":
    case "dedupe_skipped":
    case "extractor_empty":
    case "extractor_disabled":
    case "messages_below_min":
    case "dedupe_key_already_processed":
    case "durable_extraction_request_rate_limited":
    case "durable_extraction_run_budget_exceeded":
      return normalized;
    default:
      return undefined;
  }
}

export function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}
