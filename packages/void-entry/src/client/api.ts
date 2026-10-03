/**
 * 详情动作的改动类请求。
 *
 * 单独成模块的理由和 `session-jump.ts` 一样：`details.tsx` 会拉进宿主的
 * `@deepseek-ai/dsh-client-ui-primitives`（磁盘上不存在，靠前端冻结模块表在浏览器里
 * 兑现），单测环境解析不了。任何要被单测直接叫的逻辑都不能住在 `details.tsx` 里。
 *
 * @module @void/void-entry/src/client/api
 */

/**
 * 改动类请求的同源标记。
 *
 * 宿主半边的 `assertTrustedMutation` 要求这个头**存在**（值不校验）并配上
 * `Content-Type: application/json`。它不是身份校验，是防浏览器 CSRF 的：
 * 跨站页面发不出自定义头（要先过 preflight，而入口不回应任何 CORS 预检）。
 * 本机非浏览器客户端（不发 `Origin`）三条全过——见第二十节 20.9.3。
 */
export const VOID_REQUEST_HEADER = 'x-void-request'

/** 一次详情动作的结果。**不抛**：调用方要能把失败原样显示出来。 */
export interface DetailActionOutcome {
  readonly ok: boolean
  readonly error?: string
}

/**
 * 派发一个 JSON 改动请求。
 *
 * @param path - 端点路径。
 * @param body - 完整请求体。
 * @returns 成败与失败原因原文。网络异常也收敛成 `{ok:false}`，不往外抛——
 *   调用方（面板）要把失败原因原样显示给用户，不能让异常打掉整个 slot 条目。
 */
export async function postJson(path: string, body: Record<string, unknown>): Promise<DetailActionOutcome> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [VOID_REQUEST_HEADER]: '1' },
      body: JSON.stringify(body),
    })
    const payload = (await response.json().catch(() => undefined)) as
      | { ok?: boolean; error?: string }
      | undefined
    if (!response.ok || payload?.ok === false) {
      return { ok: false, error: payload?.error ?? `HTTP ${response.status}` }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 派发一个详情视图动作（`POST /void/api/detail`，`op: 'act'`）。
 *
 * 形状取自本仓库客户端既有的 `actDetailItem`：
 * `{ view, itemId, op: 'act', actionId, args }`。
 */
export function postDetailAction(body: Record<string, unknown>): Promise<DetailActionOutcome> {
  return postJson('/void/api/detail', body)
}

/**
 * 切换某份档案的当前角色（模组）。
 *
 * 端点与面板「清空已保存角色」用的是同一个（`/void/api/facet-selection`），
 * 体是 `{ agentId, facetId, expectedRevision }`。`expectedRevision` 是**必填**的
 * 乐观锁：省略会回 400，传错会回 409——**不能**为了省事放宽它，人类面板与 Agent
 * 会同时改同一份 `state.json`（见 second 节 21.3 缺口 C 的否决理由）。
 *
 * @param input.agentId - 档案 id。
 * @param input.facetId - 模组 id；`null` 表示摘掉角色。
 * @param input.expectedRevision - 该档案当前的 `selectionRevision`。
 */
export function postFacetSelection(input: {
  agentId: string
  facetId: string | null
  expectedRevision: number
}): Promise<DetailActionOutcome> {
  return postJson('/void/api/facet-selection', { ...input })
}

/** 参考：把 `button.dataset` 之类拿到的字符串收成非空，否则回 undefined。 */
export function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}
