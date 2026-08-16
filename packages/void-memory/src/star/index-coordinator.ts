const DEFAULT_WATCH_COALESCE_MS = 200;
const DEFAULT_MAX_PENDING_WATCH_PATHS = 1_024;
const DEFAULT_MAX_CONCURRENT_WATCH_EVENTS = 4;
const DEFAULT_CLOSE_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_ABORT_SETTLE_TIMEOUT_MS = 250;

export type IndexWatchEventKind = "upsert" | "remove";

export type IndexWatchEvent = {
  sourcePath: string;
  kind: IndexWatchEventKind;
};

export type IndexCoordinatorOptions = {
  runFullScan: (signal: AbortSignal) => Promise<void>;
  processWatchEvent: (event: IndexWatchEvent, signal: AbortSignal) => Promise<void>;
  watchCoalesceMs?: number;
  maxPendingWatchPaths?: number;
  maxConcurrentWatchEvents?: number;
  closeDrainTimeoutMs?: number;
  onWatchError?: (event: IndexWatchEvent, error: unknown) => void;
  onFullScanError?: (error: unknown) => void;
};

type PendingWatchEvent = IndexWatchEvent & {
  version: number;
  ready: boolean;
  timer: NodeJS.Timeout | null;
};

type ActiveWatchEvent = {
  controller: AbortController;
  promise: Promise<void>;
};

type ReadyWatchEvent = {
  sourcePath: string;
  version: number;
};

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

/**
 * 统一 full scan 与 watch 事件的并发所有权，避免多个入口绕开同一组容量边界。
 * 同一路径永不并发执行；活跃事件后的新事件保留一个 latest-wins 槽位。
 */
export class IndexCoordinator {
  private readonly options: Required<Pick<
    IndexCoordinatorOptions,
    | "watchCoalesceMs"
    | "maxPendingWatchPaths"
    | "maxConcurrentWatchEvents"
    | "closeDrainTimeoutMs"
  >> & IndexCoordinatorOptions;
  private readonly pendingWatchEvents = new Map<string, PendingWatchEvent>();
  private readonly readyWatchEvents: ReadyWatchEvent[] = [];
  private readonly activeWatchEvents = new Map<string, ActiveWatchEvent>();
  private readonly idleWaiters = new Set<() => void>();
  private fullScanPromise: Promise<void> | null = null;
  private fullScanController: AbortController | null = null;
  private fullScanStarter: (() => void) | null = null;
  private overflowRescanRequested = false;
  private acceptingWatchEvents = true;
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: IndexCoordinatorOptions) {
    this.options = {
      ...options,
      watchCoalesceMs: normalizePositiveInteger(options.watchCoalesceMs, DEFAULT_WATCH_COALESCE_MS),
      maxPendingWatchPaths: normalizePositiveInteger(
        options.maxPendingWatchPaths,
        DEFAULT_MAX_PENDING_WATCH_PATHS,
      ),
      maxConcurrentWatchEvents: normalizePositiveInteger(
        options.maxConcurrentWatchEvents,
        DEFAULT_MAX_CONCURRENT_WATCH_EVENTS,
      ),
      closeDrainTimeoutMs: normalizePositiveInteger(
        options.closeDrainTimeoutMs,
        DEFAULT_CLOSE_DRAIN_TIMEOUT_MS,
      ),
    };
  }

  /** lazy/manual/full scan 都返回同一 generation 的可见 promise。 */
  runFullScan(): Promise<void> {
    if (this.closing) {
      return Promise.resolve();
    }
    if (this.fullScanPromise) {
      return this.fullScanPromise;
    }

    const controller = new AbortController();
    this.fullScanController = controller;
    let resolveScan!: () => void;
    let rejectScan!: (error: unknown) => void;
    const operation = new Promise<void>((resolve, reject) => {
      resolveScan = resolve;
      rejectScan = reject;
    });

    let visible: Promise<void>;
    visible = operation.finally(() => {
      if (this.fullScanPromise === visible) {
        this.fullScanPromise = null;
        this.fullScanController = null;
        this.fullScanStarter = null;
      }
      this.pumpWatchEvents();
      this.notifyIdleIfNeeded();
      this.startOverflowRescanIfReady();
    });
    this.fullScanPromise = visible;
    this.fullScanStarter = () => {
      if (this.fullScanStarter === null) return;
      this.fullScanStarter = null;
      if (controller.signal.aborted) {
        resolveScan();
        return;
      }
      let started: Promise<void>;
      try {
        started = this.options.runFullScan(controller.signal);
      } catch (error) {
        started = Promise.reject(error);
      }
      void Promise.resolve(started).then(resolveScan, rejectScan);
    };
    this.startQueuedFullScanIfReady();
    return visible;
  }

  enqueueWatchEvent(sourcePath: string, kind: IndexWatchEventKind): boolean {
    if (!this.acceptingWatchEvents || this.closing) {
      return false;
    }

    const existing = this.pendingWatchEvents.get(sourcePath);
    if (existing) {
      this.resetPendingWatchEvent(existing, kind);
      return true;
    }

    // overflow 后的 distinct path 交给一次 full rescan 收敛，避免继续制造 timer。
    if (this.overflowRescanRequested
      || this.pendingWatchEvents.size >= this.options.maxPendingWatchPaths) {
      this.overflowRescanRequested = true;
      this.startOverflowRescanIfReady();
      return false;
    }

    const event: PendingWatchEvent = {
      sourcePath,
      kind,
      version: 1,
      ready: false,
      timer: null,
    };
    this.pendingWatchEvents.set(sourcePath, event);
    this.armPendingWatchEvent(event);
    return true;
  }

  /** 在关闭 watcher 前先封住事件入口，避免 close 与 chokidar 回调竞态。 */
  stopAcceptingWatchEvents(): void {
    this.acceptingWatchEvents = false;
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.closeInternal();
    }
    return this.closePromise;
  }

  private resetPendingWatchEvent(event: PendingWatchEvent, kind: IndexWatchEventKind): void {
    if (event.timer) {
      clearTimeout(event.timer);
    }
    event.kind = kind;
    event.version += 1;
    event.ready = false;
    this.armPendingWatchEvent(event);
  }

  private armPendingWatchEvent(event: PendingWatchEvent): void {
    const version = event.version;
    event.timer = setTimeout(() => {
      const current = this.pendingWatchEvents.get(event.sourcePath);
      if (!current || current.version !== version) {
        return;
      }
      current.timer = null;
      current.ready = true;
      this.readyWatchEvents.push({ sourcePath: current.sourcePath, version });
      this.pumpWatchEvents();
    }, this.options.watchCoalesceMs);
    event.timer.unref?.();
  }

  private pumpWatchEvents(): void {
    this.startQueuedFullScanIfReady();
    if (this.fullScanPromise) {
      this.notifyIdleIfNeeded();
      return;
    }
    if (this.closing && this.pendingWatchEvents.size === 0) {
      this.notifyIdleIfNeeded();
      return;
    }

    // 每轮最多检查当前队列长度，避免同一路径活跃时反复出队入队形成忙循环。
    let remainingCandidates = this.readyWatchEvents.length;
    while (this.activeWatchEvents.size < this.options.maxConcurrentWatchEvents
      && remainingCandidates > 0) {
      remainingCandidates -= 1;
      const ready = this.readyWatchEvents.shift();
      if (!ready) break;
      const pending = this.pendingWatchEvents.get(ready.sourcePath);
      if (!pending || !pending.ready || pending.version !== ready.version) {
        continue;
      }
      if (this.activeWatchEvents.has(ready.sourcePath)) {
        this.readyWatchEvents.push(ready);
        continue;
      }

      this.pendingWatchEvents.delete(ready.sourcePath);
      const event: IndexWatchEvent = {
        sourcePath: pending.sourcePath,
        kind: pending.kind,
      };
      this.startWatchEvent(event);
    }

    this.notifyIdleIfNeeded();
    this.startOverflowRescanIfReady();
  }

  private startWatchEvent(event: IndexWatchEvent): void {
    const controller = new AbortController();
    let operation: Promise<void>;
    try {
      operation = this.options.processWatchEvent(event, controller.signal);
    } catch (error) {
      operation = Promise.reject(error);
    }

    let tracked: Promise<void>;
    tracked = Promise.resolve(operation)
      .catch((error) => {
        if (!controller.signal.aborted) {
          this.options.onWatchError?.(event, error);
        }
      })
      .finally(() => {
        const active = this.activeWatchEvents.get(event.sourcePath);
        if (active?.promise === tracked) {
          this.activeWatchEvents.delete(event.sourcePath);
        }
        this.pumpWatchEvents();
      });
    this.activeWatchEvents.set(event.sourcePath, { controller, promise: tracked });
  }

  private startQueuedFullScanIfReady(): void {
    if (this.activeWatchEvents.size > 0) {
      return;
    }
    this.fullScanStarter?.();
  }

  private startOverflowRescanIfReady(): void {
    if (this.closing
      || !this.overflowRescanRequested
      || this.pendingWatchEvents.size > 0
      || this.activeWatchEvents.size > 0) {
      return;
    }

    // 当前扫描结束时会再次检查 overflow；必须开启下一 generation，不能加入旧扫描。
    if (this.fullScanPromise) {
      return;
    }

    this.overflowRescanRequested = false;
    void this.runFullScan().catch((error) => {
      this.options.onFullScanError?.(error);
    });
  }

  private async closeInternal(): Promise<void> {
    this.closing = true;
    this.stopAcceptingWatchEvents();
    this.overflowRescanRequested = false;

    // 已接收事件不再等待 debounce；close 负责把它们立即送入有界执行队列。
    for (const event of this.pendingWatchEvents.values()) {
      if (event.timer) {
        clearTimeout(event.timer);
        event.timer = null;
      }
      if (!event.ready) {
        event.ready = true;
        this.readyWatchEvents.push({ sourcePath: event.sourcePath, version: event.version });
      }
    }
    this.pumpWatchEvents();

    const drained = await this.waitForIdle(this.options.closeDrainTimeoutMs);
    if (drained) {
      return;
    }

    this.fullScanController?.abort(new Error("Memory index coordinator is closing."));
    for (const active of this.activeWatchEvents.values()) {
      active.controller.abort(new Error("Memory index coordinator is closing."));
    }
    this.clearPendingWatchEvents();

    // 内部 I/O 会在 signal 安全点停止；若第三方忽略 signal，调用方终态仍保持有界。
    await this.waitForIdle(DEFAULT_ABORT_SETTLE_TIMEOUT_MS);
  }

  private clearPendingWatchEvents(): void {
    for (const event of this.pendingWatchEvents.values()) {
      if (event.timer) {
        clearTimeout(event.timer);
      }
    }
    this.pendingWatchEvents.clear();
    this.readyWatchEvents.length = 0;
    this.notifyIdleIfNeeded();
  }

  private waitForIdle(timeoutMs: number): Promise<boolean> {
    if (this.isIdle()) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.idleWaiters.delete(handleIdle);
        resolve(value);
      };
      const handleIdle = () => finish(true);
      const timeout = setTimeout(() => finish(false), timeoutMs);
      timeout.unref?.();
      this.idleWaiters.add(handleIdle);
    });
  }

  private isIdle(): boolean {
    return this.pendingWatchEvents.size === 0
      && this.activeWatchEvents.size === 0
      && this.fullScanPromise === null;
  }

  private notifyIdleIfNeeded(): void {
    if (!this.isIdle()) return;
    const waiters = [...this.idleWaiters];
    this.idleWaiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  }
}
