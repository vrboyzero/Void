import type { Context } from './context-types.ts'

/**
 * 跳到宿主原生会话。
 *
 * 单独成模块的理由有二：一是这段逻辑要能被单测直接叫（`index.tsx` 会拉进宿主的
 * `@deepseek-ai/dsh-client-ui-primitives`，测试环境解析不了）；二是它只依赖 ctx，与界面无关。
 *
 * 客户端半边由宿主提供：`sessions`（会话服务的客户端一半，宿主自己的工作流运行面板就用它）
 * 优先，没有就退到 `uiWorkspace.openSession`。两边都跳不了时返回 false，由面板如实说出来——
 * 不假装跳了。
 *
 * 子代理会话要先把它父会话的子代理目录拉出来：宿主只认「带着直接父地址」的来路，
 * 光给一个会话 id 时历史会用普通会话地址去要，被 `session/agent-busy` 顶回来
 * （真机上就是「历史加载失败：subagent Sessions require their durable parent address」）。
 */

/** 客户端会话服务里我们用到的部分。按结构重述，理由同 `context-types.ts`。 */
interface VoidSessionSummary {
  id?: string
  parentId?: string
  origin?: string
}

interface VoidSessionsService {
  open?: (id: string) => void
  openSubagent?: (address: unknown) => void
  subagentAddress?: (id: string) => unknown
  refreshSubagents?: (parentSessionId: string) => Promise<unknown> | unknown
  list?: { getSnapshot?: () => { byId?: Record<string, VoidSessionSummary> } }
}

export async function openSession(ctx: Context, sessionId: string): Promise<boolean> {
  const sessions = ctx.get('sessions') as VoidSessionsService | undefined
  if (sessions !== undefined) {
    const summary = sessions.list?.getSnapshot?.().byId?.[sessionId]
    if (summary?.origin === 'subagent' && typeof summary.parentId === 'string') {
      try {
        await sessions.refreshSubagents?.(summary.parentId)
        const address = sessions.subagentAddress?.(sessionId)
        if (address !== undefined && typeof sessions.openSubagent === 'function') {
          sessions.openSubagent(address)
          return true
        }
      } catch {
        // 目录拉不到、或这个孩子不在目录里：退回下面的普通开法，至少把会话切过去。
      }
    }
    if (typeof sessions.open === 'function') {
      try {
        sessions.open(sessionId)
        return true
      } catch {
        // 没列出来的会话 `select` 会抛 unknown session，交给下面的退路。
      }
    }
  }
  const workspace = ctx.get('uiWorkspace') as { openSession?: (id: string) => void } | undefined
  if (typeof workspace?.openSession === 'function') {
    workspace.openSession(sessionId)
    return true
  }
  return false
}
