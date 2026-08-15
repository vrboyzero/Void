function normalizeTimeoutMs(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeAbortReason(reason: unknown, fallback: string): Error {
  if (reason instanceof Error) {
    return reason;
  }
  if (typeof reason === "string" && reason.trim()) {
    return new Error(reason.trim());
  }
  return new Error(fallback);
}

export function throwIfBackgroundAborted(
  signal: AbortSignal | undefined,
  fallback = "Background operation aborted.",
): void {
  if (!signal?.aborted) return;
  throw normalizeAbortReason(signal.reason, fallback);
}

/** 管理协作式暂停的全部等待者，避免单 resolver 覆盖导致后台任务永久挂起。 */
export class BackgroundPauseGate {
  private paused = false;
  private readonly waiters = new Set<() => void>();

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.releaseAll();
  }

  close(): void {
    this.paused = false;
    this.releaseAll();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  wait(signal?: AbortSignal): Promise<void> {
    throwIfBackgroundAborted(signal);
    if (!this.paused) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const release = () => {
        signal?.removeEventListener("abort", handleAbort);
        resolve();
      };
      const handleAbort = () => {
        this.waiters.delete(release);
        signal?.removeEventListener("abort", handleAbort);
        try {
          throwIfBackgroundAborted(signal);
        } catch (error) {
          reject(error);
        }
      };
      this.waiters.add(release);
      signal?.addEventListener("abort", handleAbort, { once: true });
    });
  }

  private releaseAll(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  }
}

export type DeadlineOperationOptions<T> = {
  timeoutMs: number;
  fallbackTimeoutMs: number;
  timeoutMessage: (timeoutMs: number) => string;
  signal?: AbortSignal;
  operation: (signal: AbortSignal) => Promise<T>;
};

/** 给后台远端调用提供 deadline、close abort 和忽略 signal 时的有界调用方终态。 */
export class BackgroundAbortRegistry {
  private readonly controllers = new Set<AbortController>();

  async run<T>(options: DeadlineOperationOptions<T>): Promise<T> {
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs, options.fallbackTimeoutMs);
    const controller = new AbortController();
    this.controllers.add(controller);
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

    let rejectOnAbort!: (reason?: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = reject;
    });
    const handleAbort = () => {
      rejectOnAbort(normalizeAbortReason(controller.signal.reason, "Background operation aborted."));
    };
    controller.signal.addEventListener("abort", handleAbort, { once: true });

    const timeout = setTimeout(() => {
      controller.abort(new Error(options.timeoutMessage(timeoutMs)));
    }, timeoutMs);
    timeout.unref?.();

    try {
      const operation = Promise.resolve().then(() => options.operation(controller.signal));
      return await Promise.race([operation, aborted]);
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", handleAbort);
      options.signal?.removeEventListener("abort", abortFromParent);
      this.controllers.delete(controller);
    }
  }

  abortAll(reason: string): void {
    const error = new Error(reason);
    for (const controller of this.controllers) {
      if (!controller.signal.aborted) {
        controller.abort(error);
      }
    }
  }
}
