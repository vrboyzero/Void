export const PRIVATE_SUMMARY_MODEL_MAX_RESPONSE_BYTES = 1024 * 1024;

export async function readBoundedPrivateSummaryModelResponse(
  response: Pick<Response, "body" | "headers">,
  options: {
    label: string;
    signal?: AbortSignal;
    maxResponseBytes?: number;
  },
): Promise<{ text: string; bytes: number }> {
  const maxResponseBytes = normalizeByteLimit(
    options.maxResponseBytes,
    PRIVATE_SUMMARY_MODEL_MAX_RESPONSE_BYTES,
  );
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength.trim())) {
      await cancelResponseBody(response);
      throw new Error(`${options.label} response has invalid Content-Length.`);
    }
    if (Number(declaredLength) > maxResponseBytes) {
      await cancelResponseBody(response);
      throw new Error(`${options.label} response exceeds ${maxResponseBytes} byte limit.`);
    }
  }
  if (options.signal?.aborted) {
    await cancelResponseBody(response);
    throwIfAborted(options.signal, options.label);
  }

  const body = response.body;
  if (!body) return { text: "", bytes: 0 };
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let byteLength = 0;
  let completed = false;
  try {
    while (true) {
      throwIfAborted(options.signal, options.label);
      const next = await readWithAbort(reader, options.signal, options.label);
      if (next.done) {
        completed = true;
        break;
      }
      const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
      byteLength += chunk.length;
      if (byteLength > maxResponseBytes) {
        throw new Error(`${options.label} response exceeds ${maxResponseBytes} byte limit.`);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (!completed) await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  throwIfAborted(options.signal, options.label);
  return {
    text: Buffer.concat(chunks, byteLength).toString("utf8"),
    bytes: byteLength,
  };
}

function readWithAbort<T>(
  reader: ReadableStreamDefaultReader<T>,
  signal: AbortSignal | undefined,
  label: string,
): Promise<ReadableStreamReadResult<T>> {
  throwIfAborted(signal, label);
  if (!signal) return reader.read();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      try {
        throwIfAborted(signal, label);
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

function throwIfAborted(signal: AbortSignal | undefined, label: string): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error(`${label} call was aborted.`);
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

function normalizeByteLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}
