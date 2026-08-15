import type { ManagedMemoryTreeNodeKind } from "./memory-tree-lifecycle.js";

export type MemoryTreeRefreshQueueInput = {
  kinds: ManagedMemoryTreeNodeKind[];
  nodeLimit: number;
  triggerSource: string;
};

export type MemoryTreeRefreshQueueOptions = {
  run: (input: MemoryTreeRefreshQueueInput) => Promise<void>;
  onError?: (error: unknown) => void;
};

export type MemoryTreeRefreshQueueEnqueueResult = {
  accepted: boolean;
  scheduled: boolean;
  pendingKinds: ManagedMemoryTreeNodeKind[];
};

/**
 * 仅用于 managed tree 的请求外 refresh owner。
 * 同一 kind 在 pending 或运行期间只保留一次，避免 node-assisted 请求重复触发 rebuild。
 */
export class MemoryTreeRefreshQueue {
  private readonly pendingKinds = new Set<ManagedMemoryTreeNodeKind>();
  private readonly activeKinds = new Set<ManagedMemoryTreeNodeKind>();
  private pendingNodeLimit = 0;
  private pendingTriggerSource = "memory.tree.background";
  private scheduled = false;
  private drainPromise: Promise<void> | null = null;
  private accepting = true;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly options: MemoryTreeRefreshQueueOptions) {}

  enqueue(input: MemoryTreeRefreshQueueInput): MemoryTreeRefreshQueueEnqueueResult {
    const kinds = normalizeKinds(input.kinds);
    if (!this.accepting || kinds.length === 0) {
      return this.buildEnqueueResult(false);
    }

    let added = false;
    let touchesPending = false;
    for (const kind of kinds) {
      if (this.activeKinds.has(kind)) {
        continue;
      }
      if (this.pendingKinds.has(kind)) {
        touchesPending = true;
        continue;
      }
      this.pendingKinds.add(kind);
      added = true;
      touchesPending = true;
    }
    if (touchesPending) {
      this.pendingNodeLimit = Math.max(this.pendingNodeLimit, normalizeNodeLimit(input.nodeLimit));
      this.pendingTriggerSource = normalizeTriggerSource(input.triggerSource);
    }
    if (added) {
      this.scheduleDrain();
    }
    return this.buildEnqueueResult(added);
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.accepting = false;
      this.pendingKinds.clear();
      this.pendingNodeLimit = 0;
      this.closePromise = this.drainPromise ?? Promise.resolve();
    }
    return this.closePromise;
  }

  private scheduleDrain(): void {
    if (this.scheduled || this.drainPromise || !this.accepting) {
      return;
    }
    this.scheduled = true;
    const immediate = setImmediate(() => {
      this.scheduled = false;
      if (!this.accepting || this.drainPromise) {
        return;
      }
      let visible: Promise<void>;
      visible = this.drain().finally(() => {
        if (this.drainPromise === visible) {
          this.drainPromise = null;
        }
      });
      this.drainPromise = visible;
    });
    immediate.unref?.();
  }

  private async drain(): Promise<void> {
    while (this.accepting) {
      const next = this.takeNext();
      if (!next) {
        return;
      }
      try {
        await this.options.run(next);
      } catch (error) {
        this.options.onError?.(error);
      } finally {
        for (const kind of next.kinds) {
          this.activeKinds.delete(kind);
        }
      }
    }
  }

  private takeNext(): MemoryTreeRefreshQueueInput | null {
    if (this.pendingKinds.size === 0) {
      return null;
    }
    const kinds = [...this.pendingKinds];
    this.pendingKinds.clear();
    for (const kind of kinds) {
      this.activeKinds.add(kind);
    }
    const nodeLimit = Math.max(1, this.pendingNodeLimit);
    this.pendingNodeLimit = 0;
    const triggerSource = this.pendingTriggerSource;
    this.pendingTriggerSource = "memory.tree.background";
    return { kinds, nodeLimit, triggerSource };
  }

  private buildEnqueueResult(accepted: boolean): MemoryTreeRefreshQueueEnqueueResult {
    return {
      accepted,
      scheduled: this.scheduled || this.drainPromise !== null,
      pendingKinds: [...this.pendingKinds],
    };
  }
}

function normalizeKinds(values: ManagedMemoryTreeNodeKind[]): ManagedMemoryTreeNodeKind[] {
  const results: ManagedMemoryTreeNodeKind[] = [];
  const seen = new Set<ManagedMemoryTreeNodeKind>();
  for (const value of values) {
    if ((value !== "topic" && value !== "profile" && value !== "global") || seen.has(value)) {
      continue;
    }
    seen.add(value);
    results.push(value);
  }
  return results;
}

function normalizeNodeLimit(value: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : 20;
}

function normalizeTriggerSource(value: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || "memory.tree.background";
}
