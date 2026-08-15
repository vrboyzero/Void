import { OutboundRequestPolicy } from "./protocol/index.js";

import { buildOpenAIChatCompletionsUrl } from "./openai-url.js";
import {
  type MemoryModelPrivacyObservation,
  MemoryModelPrivacyRuntime,
  preparePrivateSummaryModelRequest,
} from "./memory-model-privacy.js";
import {
  PRIVATE_SUMMARY_MODEL_MAX_RESPONSE_BYTES,
  readBoundedPrivateSummaryModelResponse,
} from "./private-summary-model-response.js";

export const MEMORY_CHUNK_SUMMARY_MAX_RESPONSE_BYTES = PRIVATE_SUMMARY_MODEL_MAX_RESPONSE_BYTES;

export type MemoryChunkSummaryModelResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

export type MemoryChunkSummaryModelRequestOptions = {
  baseUrl: string;
  apiKey: string;
  payload: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
  outboundRequestPolicy?: Pick<OutboundRequestPolicy, "request">;
  privacyRuntime?: MemoryModelPrivacyRuntime;
};

/**
 * 统一承担 chunk summary 模型请求的 endpoint admission 与 pinned transport。
 */
export async function requestMemoryChunkSummaryModel(
  options: MemoryChunkSummaryModelRequestOptions,
): Promise<MemoryChunkSummaryModelResponse> {
  const url = new URL(buildOpenAIChatCompletionsUrl(options.baseUrl));
  const outboundRequestPolicy = options.outboundRequestPolicy ?? new OutboundRequestPolicy({
    allowedHosts: [url.hostname],
    maxRedirects: 0,
  });
  const prepared = options.privacyRuntime
    ? options.privacyRuntime.prepareRequest({
      jobFamily: "idle_summary",
      baseUrl: options.baseUrl,
      payload: options.payload,
    })
    : preparePrivateSummaryModelRequest({
      jobFamily: "idle_summary",
      baseUrl: options.baseUrl,
      payload: options.payload,
      trustedRemoteHosts: [],
    });
  const observation = "observation" in prepared
    ? prepared.observation as MemoryModelPrivacyObservation
    : undefined;
  let observationFinished = false;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => {
    if (!controller.signal.aborted) {
      controller.abort(options.signal?.reason);
    }
  };
  if (options.signal?.aborted) {
    abortFromParent();
  } else {
    options.signal?.addEventListener("abort", abortFromParent, { once: true });
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    if (!controller.signal.aborted) {
      controller.abort(new Error(`Summary LLM call timed out after ${options.timeoutMs}ms`));
    }
  }, options.timeoutMs);

  try {
    throwIfAborted(controller.signal);
    const { response } = await outboundRequestPolicy.request({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: prepared.body,
      signal: controller.signal,
      maxRedirects: 0,
      idleTimeoutMs: options.timeoutMs,
    });
    const { text: responseText, bytes: responseBytes } = await readBoundedPrivateSummaryModelResponse(
      response,
      { label: "Summary LLM", signal: controller.signal },
    );
    if (!response.ok) {
      if (observation) {
        options.privacyRuntime?.completeRequest(observation, {
          httpStatus: response.status,
          responseBytes,
        });
        observationFinished = true;
      }
      throw new Error(`Summary LLM call failed: ${response.status}.`);
    }
    let parsed: MemoryChunkSummaryModelResponse;
    try {
      parsed = JSON.parse(responseText) as MemoryChunkSummaryModelResponse;
    } catch {
      throw new Error("Summary LLM returned invalid JSON.");
    }
    if (observation) {
      options.privacyRuntime?.completeRequest(observation, {
        httpStatus: response.status,
        responseBytes,
      });
      observationFinished = true;
    }
    return parsed;
  } catch (error) {
    if (observation && !observationFinished) {
      options.privacyRuntime?.failRequest(observation);
      observationFinished = true;
    }
    if (timedOut) {
      throw new Error(`Summary LLM call timed out after ${options.timeoutMs}ms`);
    }
    if (options.signal?.aborted) {
      throwIfAborted(options.signal);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Summary LLM call was aborted.");
  error.name = "AbortError";
  throw error;
}
