export type MemoryRetrievalAbortSource = "caller" | "deadline";

export type MemoryRetrievalRequest = {
  signal: AbortSignal;
  getAbortSource(): MemoryRetrievalAbortSource | undefined;
  isDeadlineExceeded(): boolean;
  throwIfCallerAborted(): void;
  waitFor<T>(work: Promise<T>): Promise<T>;
  dispose(): void;
};

function createAbortError(source: MemoryRetrievalAbortSource): DOMException {
  return source === "deadline"
    ? new DOMException("Memory retrieval deadline exceeded.", "TimeoutError")
    : new DOMException("Memory retrieval cancelled by caller.", "AbortError");
}

/**
 * 合并调用方取消与绝对时间 deadline，并让忽略 signal 的 Provider 也不能阻塞调用方终态。
 * 底层工作仍应接收返回的 signal；race 只负责丢弃无法协作取消的迟到结果。
 */
export function createMemoryRetrievalRequest(input: {
  signal?: AbortSignal;
  deadlineMs?: number;
}): MemoryRetrievalRequest {
  const controller = new AbortController();
  let abortSource: MemoryRetrievalAbortSource | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const abort = (source: MemoryRetrievalAbortSource): void => {
    if (abortSource) return;
    abortSource = source;
    controller.abort(createAbortError(source));
  };
  const onCallerAbort = (): void => abort("caller");
  const checkDeadline = (): boolean => {
    if (
      !abortSource
      && typeof input.deadlineMs === "number"
      && Number.isFinite(input.deadlineMs)
      && Date.now() >= input.deadlineMs
    ) {
      abort("deadline");
    }
    return abortSource === "deadline";
  };

  if (input.signal?.aborted) {
    abort("caller");
  } else {
    input.signal?.addEventListener("abort", onCallerAbort, { once: true });
  }

  if (!abortSource && typeof input.deadlineMs === "number" && Number.isFinite(input.deadlineMs)) {
    const remainingMs = Math.floor(input.deadlineMs - Date.now());
    if (remainingMs <= 0) {
      abort("deadline");
    } else {
      deadlineTimer = setTimeout(() => abort("deadline"), remainingMs);
      deadlineTimer.unref?.();
    }
  }

  const waitFor = async <T>(work: Promise<T>): Promise<T> => {
    if (controller.signal.aborted) {
      // work 可能已在参数求值阶段启动；吸收其迟到拒绝，不能让调用方终态旁路成 unhandled rejection。
      void work.catch(() => undefined);
      throw controller.signal.reason;
    }
    return await new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        cleanup();
        reject(controller.signal.reason);
      };
      const cleanup = (): void => {
        controller.signal.removeEventListener("abort", onAbort);
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      work.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  };

  return {
    signal: controller.signal,
    getAbortSource: () => abortSource,
    isDeadlineExceeded: checkDeadline,
    throwIfCallerAborted: () => {
      if (abortSource === "caller") {
        throw controller.signal.reason;
      }
    },
    waitFor,
    dispose: () => {
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
      input.signal?.removeEventListener("abort", onCallerAbort);
    },
  };
}
