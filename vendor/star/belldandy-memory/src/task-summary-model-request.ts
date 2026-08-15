import { OutboundRequestPolicy } from "./protocol/index.js";

import { buildOpenAIChatCompletionsUrl } from "./openai-url.js";

export const TASK_SUMMARY_MODEL_MAX_RESPONSE_BYTES = 1024 * 1024;

export type TaskSummaryModelResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

export type TaskSummaryModelRequestOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  timeoutMs: number;
  outboundRequestPolicy?: Pick<OutboundRequestPolicy, "request">;
};

/**
 * 统一承担 Task Summary 的凭据传输、deadline 和有界 JSON 读取，业务字段解析留在 summarizer。
 */
export async function requestTaskSummaryModel(
  options: TaskSummaryModelRequestOptions,
): Promise<TaskSummaryModelResponse> {
  const url = new URL(buildOpenAIChatCompletionsUrl(options.baseUrl));
  const outboundRequestPolicy = options.outboundRequestPolicy ?? new OutboundRequestPolicy({
    allowedHosts: [url.hostname],
    maxRedirects: 0,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Task summary LLM call timed out after ${options.timeoutMs}ms.`));
  }, options.timeoutMs);

  try {
    const { response } = await outboundRequestPolicy.request({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages: [
          { role: "system", content: options.systemPrompt },
          { role: "user", content: options.userPrompt },
        ],
        max_tokens: 400,
        temperature: 0.2,
      }),
      signal: controller.signal,
      maxRedirects: 0,
      idleTimeoutMs: options.timeoutMs,
    });
    const responseText = await readBoundedTaskSummaryResponse(response, controller.signal);
    if (!response.ok) {
      throw new Error(`Task summary LLM call failed: ${response.status} ${responseText.slice(0, 200)}`);
    }
    return JSON.parse(responseText) as TaskSummaryModelResponse;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Task summary LLM call timed out after ${options.timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedTaskSummaryResponse(
  response: Pick<Response, "body" | "headers">,
  abortSignal: AbortSignal,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength.trim())) {
      await cancelResponseBody(response);
      throw new Error("Task summary LLM response has invalid Content-Length.");
    }
    if (Number(declaredLength) > TASK_SUMMARY_MODEL_MAX_RESPONSE_BYTES) {
      await cancelResponseBody(response);
      throw new Error(
        `Task summary LLM response exceeds ${TASK_SUMMARY_MODEL_MAX_RESPONSE_BYTES} byte limit.`,
      );
    }
  }

  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let byteLength = 0;
  let completed = false;
  try {
    while (true) {
      throwIfAborted(abortSignal);
      const next = await readWithAbort(reader, abortSignal);
      if (next.done) {
        completed = true;
        break;
      }
      const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
      byteLength += chunk.length;
      if (byteLength > TASK_SUMMARY_MODEL_MAX_RESPONSE_BYTES) {
        throw new Error(
          `Task summary LLM response exceeds ${TASK_SUMMARY_MODEL_MAX_RESPONSE_BYTES} byte limit.`,
        );
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (!completed) await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  throwIfAborted(abortSignal);
  return Buffer.concat(chunks, byteLength).toString("utf8");
}

function readWithAbort<T>(
  reader: ReadableStreamDefaultReader<T>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<T>> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Task summary LLM call was aborted.");
  error.name = "AbortError";
  throw error;
}

async function cancelResponseBody(response: Pick<Response, "body">): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 已决定拒绝正文，取消失败不得覆盖原始限界错误。
  }
}
