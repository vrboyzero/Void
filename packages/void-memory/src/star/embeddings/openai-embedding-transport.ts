import { OutboundRequestPolicy } from "../protocol/index.js";

export const OPENAI_EMBEDDING_MAX_RESPONSE_BYTES = 1024 * 1024;

export type OpenAIEmbeddingOutboundRequestPolicy = Pick<OutboundRequestPolicy, "request">;

export type OpenAIEmbeddingFetchOptions = {
  baseURL: string;
  outboundRequestPolicy?: OpenAIEmbeddingOutboundRequestPolicy;
};

export type OpenAIEmbeddingFetch = (
  input: string | URL | { readonly url: string },
  init?: RequestInit,
) => Promise<Response>;

/**
 * 将 OpenAI SDK 的 embedding JSON 请求收口到统一 outbound policy；SDK 只负责协议字段映射。
 */
export function createOpenAIEmbeddingFetch(
  options: OpenAIEmbeddingFetchOptions,
): OpenAIEmbeddingFetch {
  const configuredUrl = new URL(options.baseURL);
  const outboundRequestPolicy = options.outboundRequestPolicy ?? new OutboundRequestPolicy({
    allowedHosts: [configuredUrl.hostname],
    maxRedirects: 0,
  });

  return async (input, init) => {
    const url = resolveRequestUrl(input);
    const { response } = await outboundRequestPolicy.request({
      url,
      method: init?.method,
      headers: normalizeHeaders(init?.headers),
      body: normalizeRequestBody(init?.body),
      signal: init?.signal ?? undefined,
      maxRedirects: 0,
    });
    return await bufferBoundedResponse(response, init?.signal ?? undefined);
  };
}

function resolveRequestUrl(input: string | URL | { readonly url: string }): URL {
  if (typeof input === "string" || input instanceof URL) return new URL(input);
  return new URL(input.url);
}

function normalizeHeaders(input: HeadersInit | undefined): Record<string, string> | undefined {
  if (!input) return undefined;
  const headers: Record<string, string> = {};
  new Headers(input).forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

function normalizeRequestBody(body: BodyInit | null | undefined): string | Uint8Array | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new TypeError("OpenAI embedding request body must be buffered JSON.");
}

async function bufferBoundedResponse(response: Response, signal?: AbortSignal): Promise<Response> {
  const bytes = await readBoundedResponseBytes(response, signal);
  const headers = new Headers(response.headers);
  headers.set("content-length", String(bytes.byteLength));
  const body = response.status === 204 || response.status === 205 || response.status === 304
    ? null
    : Uint8Array.from(bytes).buffer;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function readBoundedResponseBytes(response: Response, signal?: AbortSignal): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength.trim())) {
      await cancelResponseBody(response);
      throw new Error("OpenAI embedding response has invalid Content-Length.");
    }
    if (Number(declaredLength) > OPENAI_EMBEDDING_MAX_RESPONSE_BYTES) {
      await cancelResponseBody(response);
      throw new Error(
        `OpenAI embedding response exceeds ${OPENAI_EMBEDDING_MAX_RESPONSE_BYTES} byte limit.`,
      );
    }
  }

  const body = response.body;
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let completed = false;
  try {
    while (true) {
      throwIfAborted(signal);
      const next = await readWithAbort(reader, signal);
      if (next.done) {
        completed = true;
        break;
      }
      const chunk = new Uint8Array(next.value.buffer, next.value.byteOffset, next.value.byteLength);
      byteLength += chunk.byteLength;
      if (byteLength > OPENAI_EMBEDDING_MAX_RESPONSE_BYTES) {
        throw new Error(
          `OpenAI embedding response exceeds ${OPENAI_EMBEDDING_MAX_RESPONSE_BYTES} byte limit.`,
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

  throwIfAborted(signal);
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function readWithAbort<T>(
  reader: ReadableStreamDefaultReader<T>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<T>> {
  throwIfAborted(signal);
  if (!signal) return reader.read();
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

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("OpenAI embedding request was aborted.");
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
