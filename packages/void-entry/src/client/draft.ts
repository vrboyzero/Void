/**
 * 面板的草稿层。
 *
 * 官方设置卡片的做法是「页面暂存用户输入，**只有用户保存时才写入**」——本模块把
 * 这条规则落成可单测的纯逻辑，界面只负责调用。
 *
 * 为什么要有这一层：P4 时发现的「每敲一个字就提交」不是一个孤立的控件 bug。没有
 * 草稿层时，任何输入都必须立刻变成一次写回，于是每个控件都得各自想办法（失焦提交、
 * 空行过滤……）去避免半成品值上线。有了草稿层，输入**根本不碰写回**，那一整类问题
 * 从结构上消失了。
 *
 * @module @void/void-entry/client/draft
 */

/**
 * 一个命名空间的待保存改动。
 *
 * `revision` 是**草稿开始编辑时**读到的值，不是保存时的最新值——保存以它设栅，这样
 * 一个已经与文档脱节的表单会被拒绝，而不是盖掉并发发生的改动。
 */
export interface Draft {
  /** 字段路径（用 `.` 连接）→ 草稿值。 */
  values: Record<string, unknown>
  /** 第一次编辑时读到的命名空间 revision，用作保存时的设栅。 */
  revision: number
}

/** 草稿表的键：冲突时用来区分「这条数组行」与「那一条」。 */
export function pathKey(path: readonly string[]): string {
  return path.join('.')
}

/**
 * 写入一条草稿。
 *
 * 保留首次编辑时的 revision：中途有人改了配置，这里**不**跟着更新，否则设栅就失去
 * 意义了——保存时会被 `settings/conflict` 拒绝，那正是我们想要的。
 *
 * @param current - 现有草稿。
 * @param path - 字段路径。
 * @param value - 草稿值。
 * @param revision - 当前读到的命名空间 revision，仅在草稿不存在时采用。
 * @returns 新的草稿。
 */
export function editDraft(
  current: Draft | undefined,
  path: readonly string[],
  value: unknown,
  revision: number,
): Draft {
  return {
    values: { ...(current?.values ?? {}), [pathKey(path)]: value },
    revision: current?.revision ?? revision,
  }
}

/**
 * 取出一个字段应当展示的值：草稿优先，否则用服务端值。
 *
 * @param viewValue - 服务端解析后的值。
 * @param draft - 该命名空间的草稿。
 * @param path - 字段路径。
 * @returns 展示值。
 */
export function shownValue(viewValue: unknown, draft: Draft | undefined, path: readonly string[]): unknown {
  const key = pathKey(path)
  if (draft !== undefined && Object.prototype.hasOwnProperty.call(draft.values, key)) {
    return draft.values[key]
  }
  return readValue(viewValue, path)
}

/** 按路径取值。 */
export function readValue(root: unknown, path: readonly string[]): unknown {
  let node: unknown = root
  for (const segment of path) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return node
}

/** 该字段是否有未保存的改动。 */
export function isDirty(draft: Draft | undefined, path: readonly string[]): boolean {
  return draft !== undefined && Object.prototype.hasOwnProperty.call(draft.values, pathKey(path))
}

/**
 * 值在保存前的规整。
 *
 * 「点添加」产生的空行只是草稿——立刻提交会被服务端按「必须是存在的绝对目录」这类规则
 * 拒掉，用户看到一句错误、行还没加出来。所以空行在这里统一丢掉。
 *
 * 判定按**控件类型**而不是路径：哪个字段是数组、数组元素长什么样，是清单里的 `widget`
 * 说了算，不是保存路径该猜的。
 *
 * @param widget - 清单里该字段的控件类型。
 * @param value - 草稿值。
 * @returns 可提交的值。
 */
export function sanitizeForSave(widget: string | undefined, value: unknown): unknown {
  if (!Array.isArray(value)) return value
  switch (widget) {
    case 'list':
      return value.filter((row) => typeof row === 'string' && row.trim() !== '')
    case 'patterns':
      return value.filter((row) => typeof row === 'string' && row.trim() !== '')
    case 'rules':
      return value.filter(
        (row) => row !== null && typeof row === 'object' && String((row as { id?: unknown }).id ?? '').trim() !== '',
      )
    case 'tokens':
      return value.filter((row) => {
        if (row === null || typeof row !== 'object') return false
        const { callerId, tokenEnv } = row as { callerId?: unknown; tokenEnv?: unknown }
        return String(callerId ?? '').trim() !== '' && String(tokenEnv ?? '').trim() !== ''
      })
    default:
      return value
  }
}

/**
 * 保存前的不通过项。
 *
 * 「字段不接受的草稿会**阻塞保存**，而不是被丢弃」——所以这里给出人能看懂的理由，界面
 * 据此禁用保存并显示原因。真正的裁判仍是 Host：这里只拦我们确定它一定会拒的。
 *
 * **先判阻塞，再看是否与已存值相同。** 反过来的话，「点添加后什么都没填就保存」会因为
 * 规整结果等于原值而被当成「没有改动」，那一行就被静默丢掉了——而用户明明刚加了一行。
 *
 * @param draft - 该命名空间的草稿。
 * @param widgets - 字段路径键 → 清单里的控件类型。
 * @returns 阻塞理由；空数组表示可以保存。
 */
export function saveBlockers(draft: Draft | undefined, widgets: Record<string, string | undefined>): string[] {
  if (draft === undefined) return []
  const reasons: string[] = []
  for (const [key, raw] of Object.entries(draft.values)) {
    if (!Array.isArray(raw)) continue
    if (widgets[key] === 'rules') {
      const blank = raw.some(
        (row) => row !== null && typeof row === 'object' && String((row as { id?: unknown }).id ?? '').trim() === '',
      )
      if (blank) reasons.push('「任务要求」里有规则没填 id，补齐后才会保存。')
    }
    if (widgets[key] === 'tokens') {
      const half = raw.some((row) => {
        if (row === null || typeof row !== 'object') return false
        const { callerId, tokenEnv } = row as { callerId?: unknown; tokenEnv?: unknown }
        const id = String(callerId ?? '').trim()
        const env = String(tokenEnv ?? '').trim()
        // 两样都空 = 刚点出来还没填的空行，会被静默丢掉，不算阻塞。
        return (id === '') !== (env === '')
      })
      if (half) reasons.push('「调用方」有一行只填了身份或只填了变量名，两个都要填。')
    }
  }
  return [...new Set(reasons)]
}

export function draftOps(
  draft: Draft,
  widgets: Record<string, string | undefined>,
  viewValue: unknown,
): { op: 'set'; path: string[]; value: unknown }[] {
  const ops: { op: 'set'; path: string[]; value: unknown }[] = []
  for (const [key, raw] of Object.entries(draft.values)) {
    const path = key.split('.')
    const clean = sanitizeForSave(widgets[key], raw)
    if (JSON.stringify(clean) === JSON.stringify(readValue(viewValue, path))) continue
    ops.push({ op: 'set', path, value: clean })
  }
  return ops
}