import { loadSessionBindings, resolveBinding, tryResolveVoidDataRoot } from "@void/void-soul";
import type { MemoryActorBinding } from "./service.js";

/**
 * 会话 → 档案的核验。模型工具拿到的只有 `exec.agent.id`（就是会话 id），
 * 档案必须从 void-soul 的会话绑定里查出来；查不到就拒绝，绝不套默认身份。
 */

export class MemoryIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryIdentityError";
  }
}

export interface ActorResolverOptions {
  /** 数据根。给了就不再解析 DSH_HOME / profile。 */
  dataDir?: string | undefined;
  dshHome?: string | undefined;
  profile?: string | undefined;
  /** 宿主给插件的档案目录（`ctx.baseUrl`），认运行中的档案用。 */
  baseUrl?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** 写入来源标记，默认 `agent`。 */
  source?: string | undefined;
}

export type ActorResolver = (sessionId: string | undefined) => Promise<MemoryActorBinding>;

/** 数据根只解析一次；绑定文件每次读取，保证新绑定的会话立刻生效。 */
export function createActorResolver(options: ActorResolverOptions = {}): ActorResolver {
  const env = options.env ?? process.env;
  let cached: string | undefined;
  return async (sessionId) => {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new MemoryIdentityError("记忆工具缺少执行会话，已拒绝");
    }
    cached ??= resolveDataRoot(options, env);
    const bindings = await loadSessionBindings(cached);
    const agentId = resolveBinding(bindings, sessionId);
    return { agentId, sessionId, source: options.source ?? "agent" };
  };
}

/**
 * 数据根解析委托给 void-soul：`DSH_HOME` 的默认值（`~/.dsh`）和
 * `<DSH_HOME>/void-data/<profile>` 的目录规则只允许有一份实现，灵魂、记忆、
 * 军团必须落在同一个根下。这里只负责把失败换成记忆自己的说法。
 */
export { resolveHarnessHome } from "@void/void-soul";

export function resolveDataRoot(options: ActorResolverOptions = {}, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = options.dataDir?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const resolved = tryResolveVoidDataRoot({
    env,
    ...(options.dshHome === undefined ? {} : { dshHome: options.dshHome }),
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
  });
  if (resolved === undefined) {
    throw new MemoryIdentityError("记忆工具缺少数据根：需要显式 dataDir，或 profile（DSH_PROFILE / 宿主给的档案目录）与可选的 dshHome（DSH_HOME）");
  }
  return resolved;
}
