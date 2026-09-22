import { Service, type Context } from "@deepseek-ai/cordis";
import type {
  MemoryDocumentView,
  MemoryListResult,
  MemoryRetractResult,
  MemorySearchResult,
  MemoryTarget,
  MemoryWriteResult,
} from "./agent-store.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    voidMemory: VoidMemory;
    voidMemoryLegacy: VoidMemoryLegacy;
  }
}

/**
 * 执行身份绑定。模型工具永远拿不到 `agentId` 参数，只能由宿主从
 * `exec.agent` 反查出来，再经 void-soul 的会话绑定核验。
 */
export interface MemoryActorBinding {
  agentId: string;
  sessionId?: string | undefined;
  /** 写进条目前置信息的来源标记；默认 `agent`。 */
  source?: string | undefined;
}

/**
 * 受控句柄：只操作绑定身份自己的记忆仓，不接受任意 `agentId`、目录或绝对路径。
 * 每条记忆都属于某一份档案，句柄本身就是那道边界。
 */
export interface AgentMemoryHandle {
  readonly agentId: string;
  search(input: { query: string; k?: number }): Promise<MemorySearchResult[]>;
  read(target: MemoryTarget): Promise<MemoryDocumentView>;
  list(input?: { limit?: number; cursor?: string }): Promise<MemoryListResult>;
  write(input: { body: string; target?: "entry" | "long-term"; date?: string }): Promise<MemoryWriteResult>;
  update(input: { target: MemoryTarget; body: string; expectedRevision: number }): Promise<MemoryWriteResult>;
  retract(input: { target: MemoryTarget; expectedRevision?: number }): Promise<MemoryRetractResult>;
}

/**
 * Service Definition：人格文字记忆。必须绑定执行身份才能取到句柄——
 * 没有 `forAgent` 就没有任何读写入口，无身份的旧调用不可能走进新记忆库。
 */
export abstract class VoidMemory extends Service {
  constructor(ctx: Context) {
    super(ctx, "voidMemory");
  }

  /** 取绑定身份的记忆句柄。未绑定或 id 非法必须抛错，不得回退到默认库。 */
  abstract forAgent(binding: MemoryActorBinding): AgentMemoryHandle;
}

export interface LegacyMemorySearchResult {
  id: string;
  content: string;
  score: number;
}

/**
 * 旧的无身份知识 seam（Star 快照）。只保留给隔离的旧 profile，
 * 新代码一律经 `VoidMemory.forAgent`；两个服务名分开，避免无身份调用
 * 通过兼容层继续进入新记忆库。
 */
export abstract class VoidMemoryLegacy extends Service {
  constructor(ctx: Context) {
    super(ctx, "voidMemoryLegacy");
  }

  abstract store(content: string, embedding?: Float32Array): string;

  abstract search(query: string, k: number): LegacyMemorySearchResult[];

  abstract searchByVector(embedding: Float32Array, k: number): LegacyMemorySearchResult[];

  abstract ingest(content: string): number;
}
