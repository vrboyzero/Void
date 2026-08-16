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

export const MEMORY_EVOLUTION_MAX_RESPONSE_BYTES = PRIVATE_SUMMARY_MODEL_MAX_RESPONSE_BYTES;

export type MemoryEvolutionModelResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

export type MemoryEvolutionModelRequestOptions = {
  baseUrl: string;
  apiKey: string;
  payload: Record<string, unknown>;
  signal?: AbortSignal;
  idleTimeoutMs: number;
  outboundRequestPolicy?: Pick<OutboundRequestPolicy, "request">;
  privacyRuntime?: MemoryModelPrivacyRuntime;
};

/**
 * 统一承担 durable extraction 模型请求的 endpoint admission 与 pinned transport。
 */
export async function requestMemoryEvolutionModel(
  options: MemoryEvolutionModelRequestOptions,
): Promise<MemoryEvolutionModelResponse> {
  const url = new URL(buildOpenAIChatCompletionsUrl(options.baseUrl));
  const outboundRequestPolicy = options.outboundRequestPolicy ?? new OutboundRequestPolicy({
    allowedHosts: [url.hostname],
    maxRedirects: 0,
  });
  const prepared = options.privacyRuntime
    ? options.privacyRuntime.prepareRequest({
      jobFamily: "durable_extraction",
      baseUrl: options.baseUrl,
      payload: options.payload,
    })
    : preparePrivateSummaryModelRequest({
      jobFamily: "durable_extraction",
      baseUrl: options.baseUrl,
      payload: options.payload,
      trustedRemoteHosts: [],
    });
  const observation = "observation" in prepared
    ? prepared.observation as MemoryModelPrivacyObservation
    : undefined;
  let observationFinished = false;
  try {
    const { response } = await outboundRequestPolicy.request({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: prepared.body,
      signal: options.signal,
      maxRedirects: 0,
      idleTimeoutMs: options.idleTimeoutMs,
    });
    const { text: responseText, bytes: responseBytes } = await readBoundedPrivateSummaryModelResponse(
      response,
      { label: "Evolution LLM", signal: options.signal },
    );
    if (!response.ok) {
      if (observation) {
        options.privacyRuntime?.completeRequest(observation, {
          httpStatus: response.status,
          responseBytes,
        });
        observationFinished = true;
      }
      throw new Error(`Evolution LLM call failed: ${response.status}.`);
    }
    let parsed: MemoryEvolutionModelResponse;
    try {
      parsed = JSON.parse(responseText) as MemoryEvolutionModelResponse;
    } catch {
      throw new Error("Evolution LLM returned invalid JSON.");
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
    throw error;
  }
}
