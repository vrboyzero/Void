/**
 * 业务详情视图（§16.1 的「业务只读视图 + 详情」）：列表 → 详情 → 编辑 / 动作。
 *
 * 这一侧是**通用渲染器**：它只认「视图 id + 渲染数据 + 回调」，不认识军团、记忆或灵魂。
 * 业务语义（组织图、人数上限、取消动作）由所属插件在 host 侧算好，这里照原样画出来。
 *
 * 两条硬要求落在这里：
 * 1. 编辑一律「暂存 → 校验 → 保存」，以**开始编辑时**的 revision 设栅；冲突或失败保留草稿。
 * 2. 正文（Markdown）按安全文本渲染，绝不 `innerHTML`；内存记录与 SOUL 正文不进控制台。
 *
 * @module @void/void-entry/src/client/details
 */
import { createElement as h, useCallback, useEffect, useState } from 'react'
import { BORDER, BORDER_SOFT, DANGER, SURFACE_HOVER, TEXT_SECONDARY, WARN } from './theme.js'

/**
 * 改动请求必须带的自定义头。
 *
 * host 侧对 `/void/api/*` 的写路由要求它（跨站页面发不出自定义头，发得出就得先过
 * preflight，而宿主不回应 CORS 预检）。缺了它会被 403 挡下，且原因是明确的。
 */
export const VOID_REQUEST_HEADER = 'x-void-request'

/** 视图目录项；由 host 侧随 `/void/api/panels` 给出。 */
export interface DetailViewManifest {
  id: string
  title: string
}

export interface DetailItem {
  id: string
  title: string
  summary?: string
  meta?: string
}

/** 文本类区块（只读）：行、表、组织图。 */
export interface DetailTextSection {
  id: string
  title: string
  kind?: 'lines' | 'table' | 'org'
  columns?: string[]
  rows?: string[][]
  lines?: string[]
  /**
   * `table` 用：哪些格子其实是一个能点开的原生会话。
   *
   * 键是 `${行号}:${列号}`（都从 0 数），值是宿主会话 id。服务端不给、或这台宿主没有会话
   * 服务时，格子照旧画纯文本——链接是增强，不是数据本身。
   */
  sessionLinks?: Record<string, string>
}

/** 可编辑行表格的一列。 */
export interface DetailColumn {
  key: string
  label: string
  type?: 'text' | 'list' | 'boolean' | 'number'
}

/** 可编辑行表格：一组同形对象（成员名单这类）。`key` 是它写回 `changes` 的字段名。 */
export interface DetailRowsSection {
  id: string
  title: string
  kind: 'rows'
  columns: DetailColumn[]
  rows: Record<string, unknown>[]
  key?: string
  editable?: boolean
  addLabel?: string
  help?: string
}

export type DetailSection = DetailTextSection | DetailRowsSection

export interface DetailField {
  key: string
  label: string
  value: string | number | null
  readOnly?: boolean
  /** 默认单行文本框；`markdown` 给多行正文草稿用（仍然只是字符串，绝不 innerHTML）。 */
  kind?: 'text' | 'markdown'
  help?: string
}

export interface DetailAction {
  id: string
  label: string
  hint?: string
  danger?: boolean
  args?: DetailField[]
}

/**
 * 检索声明。有它就在列表上方出搜索框；`list` 会收到 `query`。
 *
 * 面板不猜「哪些视图能检索」：能不能查、查的是不是全量，只有所属插件知道。
 */
export interface DetailSearch {
  label?: string
  hint?: string
}

export interface DetailBody {
  title: string
  markdown?: string
  sections: DetailSection[]
  /** 数字或字符串都行（队伍修订是自增整数，文件正文是内容哈希）。面板只负责原样带回。 */
  revision?: number | string
  fields?: DetailField[]
  actions?: DetailAction[]
  /**
   * 这份详情还在动（一次运行还在跑）：打开期间按 {@link LIVE_REFRESH_MS} 自动重读。
   *
   * 服务端只在**还没结束**的对象上置位；终态置位等于让面板白轮询。
   */
  live?: boolean
}

type Result<T> = { ok: true; value: T } | { ok: false; message: string }

/** 把一次响应收成「值或原因」：失败时把服务端写的原因原样带出来，不吞成 HTTP 码。 */
async function readResult<T>(response: Response): Promise<Result<T>> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }
  if (!response.ok) {
    const reason = (payload as { error?: unknown } | undefined)?.error
    return { ok: false, message: typeof reason === 'string' ? reason : `HTTP ${response.status}` }
  }
  return { ok: true, value: payload as T }
}

export async function loadDetailList(
  view: string,
  query?: string,
): Promise<Result<{ title: string; items: DetailItem[]; actions: DetailAction[]; search?: DetailSearch; note?: string }>> {
  const suffix = query === undefined || query === '' ? '' : `&q=${encodeURIComponent(query)}`
  const response = await fetch(`/void/api/detail?view=${encodeURIComponent(view)}${suffix}`)
  const outcome = await readResult<{ title?: unknown; items?: unknown; actions?: unknown; search?: unknown; note?: unknown }>(response)
  if (!outcome.ok) return outcome
  // 缺字段按空列表处理：面板崩掉比少一行难查得多，而「空」在界面上是看得出来的。
  const search = outcome.value.search as DetailSearch | undefined
  return {
    ok: true,
    value: {
      title: typeof outcome.value.title === 'string' ? outcome.value.title : view,
      items: Array.isArray(outcome.value.items) ? (outcome.value.items as DetailItem[]) : [],
      actions: Array.isArray(outcome.value.actions) ? (outcome.value.actions as DetailAction[]) : [],
      ...(search === undefined || search === null ? {} : { search }),
      ...(typeof outcome.value.note === 'string' ? { note: outcome.value.note } : {}),
    },
  }
}

export async function loadDetailItem(view: string, itemId: string): Promise<Result<{ detail: DetailBody }>> {
  const response = await fetch(`/void/api/detail?view=${encodeURIComponent(view)}&itemId=${encodeURIComponent(itemId)}`)
  const outcome = await readResult<{ detail?: unknown }>(response)
  if (!outcome.ok) return outcome
  if (outcome.value.detail === undefined || outcome.value.detail === null) {
    return { ok: false, message: '服务端没有返回详情内容' }
  }
  return { ok: true, value: { detail: outcome.value.detail as DetailBody } }
}

export async function saveDetailItem(
  view: string,
  itemId: string,
  expectedRevision: number | string,
  changes: Record<string, unknown>,
): Promise<Result<{ detail: DetailBody }>> {
  const response = await fetch('/void/api/detail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [VOID_REQUEST_HEADER]: '1' },
    body: JSON.stringify({ view, itemId, op: 'save', expectedRevision, changes }),
  })
  return readResult<{ detail: DetailBody }>(response)
}

/**
 * 条目上的动作。
 *
 * `expectedRevision` 是打开这一条时读到的修订：删除这类动作也要栅，否则「看着旧数据
 * 下手」删掉的可能是别人刚改过的那份。不传就是不带栅（有些动作本来就不改文件）。
 */
export async function actDetailItem(
  view: string,
  itemId: string,
  actionId: string,
  args: Record<string, unknown>,
  expectedRevision?: number | string,
): Promise<Result<{ detail: DetailBody }>> {
  const response = await fetch('/void/api/detail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [VOID_REQUEST_HEADER]: '1' },
    body: JSON.stringify({
      view,
      itemId,
      op: 'act',
      actionId,
      args,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    }),
  })
  return readResult<{ detail: DetailBody }>(response)
}

/**
 * 视图级动作（新建队伍这类「条目还不存在」的事）。
 *
 * 没有条目，所以没有详情可回：执行完由调用方重读列表。
 */
export async function actView(view: string, actionId: string, args: Record<string, unknown>): Promise<Result<null>> {
  const response = await fetch('/void/api/detail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [VOID_REQUEST_HEADER]: '1' },
    body: JSON.stringify({ view, op: 'act', actionId, args }),
  })
  const outcome = await readResult<unknown>(response)
  return outcome.ok ? { ok: true, value: null } : outcome
}

/** 字段控件的共用外观：有草稿就换成警示色边框，一眼能看出哪几格改过。 */
function fieldBoxStyle(pristine: boolean): React.CSSProperties {
  return {
    border: `1px solid ${pristine ? BORDER : WARN}`,
    borderRadius: 6,
    background: 'transparent',
    color: 'inherit',
    flex: 1,
    fontSize: 12,
    padding: '4px 8px',
  }
}

/** 字段当前显示值：草稿优先，否则是读回来的值。 */
export function shownFieldValue(field: DetailField, drafts: Record<string, string>): string {
  const draft = drafts[field.key]
  if (draft !== undefined) return draft
  return field.value === null ? '' : String(field.value)
}

/** 原值的文本形式；用它判断草稿是不是真的改了。 */
function original(field: DetailField): string {
  return field.value === null ? '' : String(field.value)
}

/** 数字字段提交成数字：面板交上去的是字符串，而 host 侧只收整数。 */
function toChange(field: DetailField, text: string): unknown {
  if (typeof field.value === 'number') {
    const parsed = Number(text.trim())
    return text.trim() === '' || Number.isNaN(parsed) ? text : parsed
  }
  return text
}

/**
 * 这次要提交的改动。
 *
 * 只提交**真的改过**的可编辑字段：没碰过的字段不进请求，免得把面板读到的旧值
 * 当成用户的意图写回去。只读字段永不提交（它们是组合入口决定的，改了不生效）。
 *
 * `additions` 是各可编辑行表格里「点了加一行」的条数；它们跟单元格草稿一样属于草稿，
 * 没填内容的空行不算数。
 */
export function dirtyChanges(
  body: DetailBody,
  drafts: Record<string, string>,
  additions: Record<string, number> = {},
): Record<string, unknown> {
  const changes: Record<string, unknown> = {}
  for (const field of body.fields ?? []) {
    if (field.readOnly === true) continue
    const draft = drafts[field.key]
    if (draft === undefined || draft === original(field)) continue
    changes[field.key] = toChange(field, draft)
  }
  for (const section of body.sections) {
    if (section.kind !== 'rows') continue
    if (section.editable !== true || section.key === undefined || section.key === '') continue
    const rows = editedRows(section, drafts, additions[section.key] ?? 0)
    if (rows === undefined) continue
    // 整组替换：行表格是「一组同形对象」，逐格打补丁反而会把顺序与删除表达错。
    changes[section.key] = rows
  }
  return changes
}

/** 行表格里一个单元格的草稿键。 */
export function cellDraftKey(sectionKey: string, rowIndex: number, columnKey: string): string {
  return `${sectionKey}[${rowIndex}].${columnKey}`
}

/** 单元格显示值。列表用顿号连起来，布尔用「是/否」——空表示这个字段没写。 */
export function cellText(value: unknown, column: DetailColumn): string {
  if (value === undefined || value === null) return ''
  if (column.type === 'list') return Array.isArray(value) ? value.map((item) => String(item)).join('，') : String(value)
  if (column.type === 'boolean') return value === true ? '是' : '否'
  return String(value)
}

/**
 * 单元格草稿 → 提交值。
 *
 * 空文本表示「不写这个字段」而不是写空串：成员的可选字段没写就是没有，写空串会让
 * host 侧的校验报一堆「空字符串」的错，而用户只是把格子留空了。列表例外——空列表
 * 是明确的意思（「没有上下级」），所以留空提交成 `[]`。
 */
export function cellChange(column: DetailColumn, text: string): unknown {
  const trimmed = text.trim()
  if (column.type === 'list') {
    return trimmed === '' ? [] : trimmed.split(/[,，、]/).map((item) => item.trim()).filter((item) => item !== '')
  }
  if (column.type === 'boolean') {
    if (trimmed === '是' || trimmed === 'true') return true
    if (trimmed === '否' || trimmed === 'false') return false
    // 认不出来就原样交上去：host 侧会给出「必须是布尔值」这种说得清的错误，
    // 比面板自己猜一个值再默默写进去强。
    return text
  }
  if (column.type === 'number') {
    const parsed = Number(trimmed)
    return trimmed === '' || Number.isNaN(parsed) ? text : parsed
  }
  return text
}

/** 有改动就返回整组行，没改动返回 undefined（表示这个区块不进请求）。 */
function editedRows(
  section: DetailRowsSection,
  drafts: Record<string, string>,
  added: number,
): Array<Record<string, unknown>> | undefined {
  const sectionKey = section.key as string
  const base = section.rows
  const extra = Number.isFinite(added) && added > 0 ? Math.floor(added) : 0
  const rows: Array<Record<string, unknown>> = []
  let changed = false
  for (let index = 0; index < base.length + extra; index += 1) {
    const source: Record<string, unknown> | undefined = index < base.length ? base[index] : undefined
    const next: Record<string, unknown> = { ...(source ?? {}) }
    let touched = false
    for (const column of section.columns) {
      const draft = drafts[cellDraftKey(sectionKey, index, column.key)]
      if (draft === undefined || draft === cellText(source?.[column.key], column)) continue
      touched = true
      const value = cellChange(column, draft)
      if (value === '' && column.type !== 'list') {
        delete next[column.key]
        continue
      }
      next[column.key] = value
    }
    if (source === undefined) {
      // 点了「加一行」又一格没填：不该凭空多出一条成员。
      if (!touched) continue
      changed = true
    } else if (touched) {
      changed = true
    }
    rows.push(next)
  }
  return changed ? rows : undefined
}

const CELL: React.CSSProperties = {
  borderBottom: `1px solid ${BORDER_SOFT}`,
  padding: '4px 8px 4px 0',
  fontSize: 12,
  textAlign: 'left',
  verticalAlign: 'top',
}

const CELL_INPUT: React.CSSProperties = {
  border: `1px solid ${BORDER}`,
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  fontSize: 12,
  minWidth: 90,
  padding: '3px 6px',
  width: '100%',
}

/** 会话链接那一格：看着是链接、点下去切到那个会话。 */
const SESSION_LINK: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  padding: 0,
  textDecoration: 'underline',
  textUnderlineOffset: 2,
}

/** 这一格是不是一个能点开的原生会话；不是就返回 undefined（照旧画纯文本）。 */
export function sessionLinkAt(section: DetailTextSection, rowIndex: number, columnIndex: number): string | undefined {
  const sessionId = section.sessionLinks?.[`${rowIndex}:${columnIndex}`]
  return sessionId === undefined || sessionId === '' ? undefined : sessionId
}

/**
 * 还在动的详情多久自动重读一次。
 *
 * 3 秒是「看得出在动」与「别把宿主问爆」之间的折中：一次运行也就几十秒到几分钟，
 * 真嫌吵的话关掉面板就停了（这个定时器跟着打开的条目走）。
 */
const LIVE_REFRESH_MS = 3000

/** 可编辑行表格：一格一个输入框，整组一起提交。 */
function RowsSection(props: {
  section: DetailRowsSection
  drafts: Record<string, string>
  onDraft: (key: string, value: string) => void
  added: number
  onAddRow: () => void
}): React.ReactElement {
  const { section, drafts, onDraft, added, onAddRow } = props
  const editable = section.editable === true && section.key !== undefined && section.key !== ''
  const sectionKey = section.key ?? section.id
  const total = section.rows.length + (editable ? added : 0)
  const indices = Array.from({ length: total }, (_, index) => index)
  const placeholderOf = (column: DetailColumn): string =>
    column.type === 'boolean' ? '是/否' : column.type === 'list' ? '逗号分隔' : ''

  return h('section', { 'data-detail-section': section.id, style: { marginBottom: 12 } },
    h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, section.title),
    h('table', { style: { borderCollapse: 'collapse', width: '100%' } },
      h('thead', null, h('tr', null,
        ...section.columns.map((column) =>
          h('th', { key: column.key, style: { ...CELL, color: TEXT_SECONDARY, fontWeight: 500 } }, column.label)),
      )),
      h('tbody', null,
        ...indices.map((index) => {
          const source = index < section.rows.length ? section.rows[index] : undefined
          return h('tr', { key: `${section.id}-${index}` },
            ...section.columns.map((column) => {
              const cellKey = cellDraftKey(sectionKey, index, column.key)
              const value = drafts[cellKey] ?? cellText(source?.[column.key], column)
              if (!editable) return h('td', { key: column.key, style: CELL }, value)
              return h('td', { key: column.key, style: CELL },
                h('input', {
                  type: 'text',
                  'data-detail-cell': cellKey,
                  placeholder: placeholderOf(column),
                  value,
                  onChange: (event: React.ChangeEvent<HTMLInputElement>) => onDraft(cellKey, event.target.value),
                  style: {
                    ...CELL_INPUT,
                    border: `1px solid ${drafts[cellKey] === undefined ? BORDER : WARN}`,
                  },
                }),
              )
            }),
          )
        }),
      ),
    ),
    editable
      ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 } },
          h('button', {
            type: 'button',
            'data-detail-add-row': sectionKey,
            onClick: onAddRow,
            style: { border: `1px solid ${BORDER}`, borderRadius: 8, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12, padding: '3px 10px' },
          }, section.addLabel ?? '加一行'),
        )
      : null,
    section.help ? h('div', { style: { color: TEXT_SECONDARY, fontSize: 12, marginTop: 4 } }, section.help) : null,
  )
}

/**
 * 表格的一行。
 *
 * 服务端在 `sessionLinks` 里标了「这一格是一个原生会话」的格子画成按钮（跳过去），
 * 其余照旧纯文本；没有会话服务时整张表都是纯文本。
 */
function tableRow(
  section: DetailTextSection,
  row: string[],
  index: number,
  onOpenSession?: (sessionId: string) => void,
): React.ReactElement {
  return h('tr', { key: `${section.id}-${index}` },
    ...row.map((cell, cellIndex) => {
      const sessionId = sessionLinkAt(section, index, cellIndex)
      if (sessionId === undefined || onOpenSession === undefined) {
        return h('td', { key: cellIndex, style: CELL }, cell)
      }
      return h('td', { key: cellIndex, style: CELL },
        h('button', {
          type: 'button',
          'data-detail-session-link': sessionId,
          title: `跳到原生会话 ${sessionId}`,
          onClick: () => onOpenSession(sessionId),
          style: SESSION_LINK,
        }, cell),
      )
    }),
  )
}

function Section(props: {
  section: DetailSection
  drafts: Record<string, string>
  onDraft: (key: string, value: string) => void
  additions: Record<string, number>
  onAddRow: (sectionKey: string) => void
  /** 有它才把 `sessionLinks` 指到的格子画成按钮：没有会话服务就保持纯文本。 */
  onOpenSession?: (sessionId: string) => void
}): React.ReactElement {
  const { section, drafts, onDraft, additions, onAddRow, onOpenSession } = props
  if (section.kind === 'rows') {
    const key = section.key ?? section.id
    return h(RowsSection, {
      section,
      drafts,
      onDraft,
      added: additions[key] ?? 0,
      onAddRow: () => onAddRow(key),
    })
  }
  const body =
    section.kind === 'table'
      ? h('table', { style: { borderCollapse: 'collapse', width: '100%' } },
          section.columns
            ? h('thead', null, h('tr', null, ...section.columns.map((column) => h('th', { key: column, style: { ...CELL, color: TEXT_SECONDARY, fontWeight: 500 } }, column))))
            : null,
          h('tbody', null,
            ...(section.rows ?? []).map((row, index) => tableRow(section, row, index, onOpenSession)),
          ),
        )
      : h('div', {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            fontFamily: section.kind === 'org' ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined,
            fontSize: 12,
          },
        },
          ...(section.lines ?? []).map((line, index) => h('div', { key: index, style: { whiteSpace: 'pre-wrap' } }, line)),
        )

  return h('section', { 'data-detail-section': section.id, style: { marginBottom: 12 } },
    h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, section.title),
    body,
  )
}

/** 动作参数：只收用户真填了的（空输入不提交，免得把「没填」变成空字符串）。 */
function collectArgs(action: DetailAction, actionArgs: Record<string, string>, prefix: string): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  for (const arg of action.args ?? []) {
    const value = actionArgs[`${prefix}${action.id}.${arg.key}`]
    if (value !== undefined && value.trim() !== '') args[arg.key] = value
  }
  return args
}

/**
 * 业务视图区。
 *
 * 没有登记任何视图时**什么都不画**：headless 组合或没装业务插件时，这里多一块空白
 * 只会让人以为坏了。
 */
export function VoidDetails(props: { views: DetailViewManifest[]; onOpenSession?: (sessionId: string) => boolean | Promise<boolean> }): React.ReactElement | null {
  const { views, onOpenSession } = props
  const [openView, setOpenView] = useState<string | null>(null)
  const [lists, setLists] = useState<Record<string, DetailItem[]>>({})
  const [viewActions, setViewActions] = useState<Record<string, DetailAction[]>>({})
  const [searches, setSearches] = useState<Record<string, DetailSearch | undefined>>({})
  const [listNotes, setListNotes] = useState<Record<string, string | undefined>>({})
  // 输入框里的字与**已经提交**的检索词分开：边打字边改列表会让人以为结果在跳，
  // 而重读列表（保存、动作之后）必须沿用已提交的那个词，不能跟着输入框跑。
  const [queryDrafts, setQueryDrafts] = useState<Record<string, string>>({})
  const [activeQueries, setActiveQueries] = useState<Record<string, string>>({})
  const [item, setItem] = useState<{ view: string; itemId: string; body: DetailBody } | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [additions, setAdditions] = useState<Record<string, number>>({})
  const [actionArgs, setActionArgs] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // 视图被卸载（插件被关掉）后，打开着的那一份不能继续显示——它已经没人负责了。
  useEffect(() => {
    if (openView !== null && !views.some((view) => view.id === openView)) {
      setOpenView(null)
      setItem(null)
      setDrafts({})
      setAdditions({})
    }
  }, [views, openView])

  const openList = useCallback(async (viewId: string, query?: string) => {
    setError(null)
    setNotice(null)
    setBusy(`list:${viewId}`)
    const outcome = await loadDetailList(viewId, query)
    setBusy(null)
    if (!outcome.ok) {
      setError(outcome.message)
      return
    }
    setLists((current) => ({ ...current, [viewId]: outcome.value.items }))
    setViewActions((current) => ({ ...current, [viewId]: outcome.value.actions }))
    setSearches((current) => ({ ...current, [viewId]: outcome.value.search }))
    setListNotes((current) => ({ ...current, [viewId]: outcome.value.note }))
  }, [])

  /**
   * 执行一次检索 / 清除检索。
   *
   * 提交后的词记在 `activeQueries` 里：之后每次重读列表都带上它，否则「保存一条之后
   * 列表突然变回全量」会让人以为自己的改动把检索弄丢了。
   */
  const submitQuery = useCallback(async (viewId: string, query: string) => {
    const trimmed = query.trim()
    setActiveQueries((current) => ({ ...current, [viewId]: trimmed }))
    await openList(viewId, trimmed === '' ? undefined : trimmed)
  }, [openList])

  const openItem = useCallback(async (viewId: string, itemId: string) => {
    setError(null)
    setNotice(null)
    setBusy(`item:${itemId}`)
    const outcome = await loadDetailItem(viewId, itemId)
    setBusy(null)
    if (!outcome.ok) {
      setError(outcome.message)
      return
    }
    setItem({ view: viewId, itemId, body: outcome.value.detail })
    // 换条目就丢掉上一份草稿：草稿属于某一条，跟着跑到另一条上是错的数据。
    setDrafts({})
    setAdditions({})
    setActionArgs({})
  }, [])

  const reload = useCallback(async () => {
    if (item === null) return
    await openItem(item.view, item.itemId)
  }, [item, openItem])

  /**
   * 跳到宿主原生会话。
   *
   * 跳不了就如实说出来：一个点了没反应的链接比不画更糟。
   */
  const jumpToSession = useCallback(async (sessionId: string) => {
    // 子代理会话要先拉父会话的目录再开，这一跳是异步的。
    let opened = false
    try {
      opened = onOpenSession !== undefined && (await onOpenSession(sessionId)) === true
    } catch {
      opened = false
    }
    if (!opened) {
      setNotice(`这台宿主没有会话跳转服务，打不开子会话 ${sessionId}`)
      return
    }
    setNotice(`已跳到会话 ${sessionId}`)
  }, [onOpenSession])

  /**
   * 还在动的详情自己重读。
   *
   * 不这么做的话，面板上的「进度」只是打开那一刻的快照：写着「在跑 1」，实际早就跑完了。
   * 有草稿时不动它——自动重读不能吃掉用户正在填的东西。
   */
  const refreshLive = useCallback(async () => {
    if (item === null || busy !== null) return
    const outcome = await loadDetailItem(item.view, item.itemId)
    // 自动重读失败不弹错：下一拍还会再试，别拿它打扰正在看的人。
    if (!outcome.ok) return
    setItem((current) =>
      current === null || current.view !== item.view || current.itemId !== item.itemId
        ? current
        : { ...current, body: outcome.value.detail },
    )
  }, [item, busy])

  const live = item !== null && item.body.live === true
  const hasDrafts = Object.keys(drafts).length > 0 || Object.keys(additions).length > 0

  useEffect(() => {
    if (!live || hasDrafts) return undefined
    const timer = setInterval(() => void refreshLive(), LIVE_REFRESH_MS)
    return () => clearInterval(timer)
  }, [live, hasDrafts, refreshLive])

  const save = useCallback(async () => {
    if (item === null) return
    const changes = dirtyChanges(item.body, drafts, additions)
    if (Object.keys(changes).length === 0) {
      setNotice('没有改动要保存')
      return
    }
    setBusy('save')
    setError(null)
    setNotice(null)
    // 栅是**读回来那一份**的 revision：期间别人改过就会被拒，而不是盖掉他的改动。
    const outcome = await saveDetailItem(item.view, item.itemId, item.body.revision ?? 0, changes)
    setBusy(null)
    if (!outcome.ok) {
      // 失败保留草稿：用户改的东西不能因为一次失败就没了。
      setError(outcome.message)
      return
    }
    setItem({ view: item.view, itemId: item.itemId, body: outcome.value.detail })
    setDrafts({})
    setAdditions({})
    setNotice('已保存')
  }, [item, drafts, additions])

  const runAction = useCallback(async (action: DetailAction) => {
    if (item === null) return
    const args = collectArgs(action, actionArgs, `${item.itemId}.`)
    setBusy(`act:${action.id}`)
    setError(null)
    setNotice(null)
    const outcome = await actDetailItem(item.view, item.itemId, action.id, args, item.body.revision)
    setBusy(null)
    if (!outcome.ok) {
      setError(outcome.message)
      return
    }
    setItem({ view: item.view, itemId: item.itemId, body: outcome.value.detail })
    setNotice(`已执行：${action.label}`)
    // 动作可能改掉列表里的状态（取消之后状态就变了，撤回之后这一条就不该再列出来），
    // 顺手重读一遍列表（沿用已提交的检索词）；但当前这一条留着，用户可能还要看细节。
    void openList(item.view, activeQueries[item.view])
  }, [item, actionArgs, activeQueries, openList])

  const runViewAction = useCallback(async (viewId: string, action: DetailAction) => {
    const args = collectArgs(action, actionArgs, `${viewId}.`)
    setBusy(`view:${viewId}:${action.id}`)
    setError(null)
    setNotice(null)
    const outcome = await actView(viewId, action.id, args)
    if (!outcome.ok) {
      setBusy(null)
      setError(outcome.message)
      return
    }
    // 视图级动作没有详情可回：重读列表，新建出来的条目自然会出现在里面。
    // 带上已提交的检索词，否则「新建完列表突然变回全量」会让人以为刚建的东西没进去。
    await openList(viewId, activeQueries[viewId])
    setBusy(null)
    setNotice(`已执行：${action.label}`)
  }, [actionArgs, activeQueries, openList])

  if (views.length === 0) return null

  const changes = item === null ? {} : dirtyChanges(item.body, drafts, additions)
  const dirty = Object.keys(changes).length > 0
  const editable = (item?.body.fields ?? []).filter((field) => field.readOnly !== true)
  const readOnlyFields = (item?.body.fields ?? []).filter((field) => field.readOnly === true)
  // 可编辑的行表格也算「能编辑」：只有成员表能改、没有标量字段时，保存按钮照样得在。
  const editableRows = (item?.body.sections ?? []).filter(
    (section): section is DetailRowsSection =>
      section.kind === 'rows' && section.editable === true && section.key !== undefined && section.key !== '',
  )
  const canEdit = editable.length > 0 || editableRows.length > 0
  // 搜索框与列表说明都只对「当前打开的那个视图」有效，先在渲染前取出来：
  // 元素访问的收窄不如普通常量可靠，而且这几行在下面要用好几次。
  const openSearch = openView === null ? undefined : searches[openView]
  const openNote = openView === null ? undefined : listNotes[openView]
  const openQuery = openView === null ? '' : activeQueries[openView] ?? ''
  // 输入框优先显示正在编辑的草稿；草稿是空串说明用户刚清掉，不能退回已提交的词。
  const openDraft = openView === null ? '' : queryDrafts[openView] ?? activeQueries[openView] ?? ''

  return h('section', { 'data-void-details': '', style: { marginTop: 16, borderTop: `1px solid ${BORDER}`, paddingTop: 12 } },
    h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, '业务视图'),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 } },
      ...views.map((view) =>
        h('button', {
          key: view.id,
          type: 'button',
          'data-detail-view': view.id,
          onClick: () => {
            if (openView === view.id) {
              setOpenView(null)
              setItem(null)
              setDrafts({})
              return
            }
            setOpenView(view.id)
            setItem(null)
            setDrafts({})
            // 每个视图记着自己上一次的检索词：来回切视图不该把检索悄悄清掉。
            void openList(view.id, activeQueries[view.id])
          },
          style: {
            border: `1px solid ${openView === view.id ? WARN : BORDER}`,
            borderRadius: 8,
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 12,
            padding: '4px 10px',
          },
        }, view.title),
      ),
    ),

    openView === null
      ? null
      : h('div', { 'data-detail-panel': openView },
          busy === `list:${openView}` ? h('div', { style: { fontSize: 12, color: TEXT_SECONDARY } }, '正在读取…') : null,

          // 搜索框与列表说明都在列表上方：它们是「这份列表是怎么来的」，放在下面会被当成
          // 列表的一部分。只有所属插件声明了 search 才画——面板不猜哪些视图能查。
          openSearch === undefined
            ? null
            : h('div', { 'data-detail-search': openView, style: { marginBottom: 8 } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                  h('input', {
                    type: 'text',
                    placeholder: openSearch.label ?? '检索',
                    'data-detail-search-input': openView,
                    value: openDraft,
                    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                      setQueryDrafts((current) => ({ ...current, [openView]: event.target.value })),
                    // 回车就检索：输入框旁边那颗按钮是给不看键盘的人准备的，两条路都要通。
                    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
                      if (event.key === 'Enter') void submitQuery(openView, openDraft)
                    },
                    style: { border: `1px solid ${BORDER}`, borderRadius: 6, background: 'transparent', color: 'inherit', fontSize: 12, padding: '4px 8px', minWidth: 200 },
                  }),
                  h('button', {
                    type: 'button',
                    'data-detail-search-go': openView,
                    disabled: busy !== null,
                    onClick: () => void submitQuery(openView, openDraft),
                    style: {
                      border: `1px solid ${BORDER}`,
                      borderRadius: 8,
                      background: 'transparent',
                      color: 'inherit',
                      cursor: 'pointer',
                      fontSize: 12,
                      padding: '4px 12px',
                    },
                  }, busy === `list:${openView}` ? '检索中…' : '检索'),
                  openQuery === ''
                    ? null
                    : h('button', {
                        type: 'button',
                        'data-detail-search-clear': openView,
                        disabled: busy !== null,
                        onClick: () => {
                          setQueryDrafts((current) => ({ ...current, [openView]: '' }))
                          void submitQuery(openView, '')
                        },
                        style: {
                          border: `1px solid ${BORDER}`,
                          borderRadius: 8,
                          background: 'transparent',
                          color: 'inherit',
                          cursor: 'pointer',
                          fontSize: 12,
                          padding: '4px 12px',
                        },
                      }, '清除检索'),
                ),
                openSearch.hint ? h('div', { style: { color: TEXT_SECONDARY, fontSize: 12, marginTop: 2 } }, openSearch.hint) : null,
                openQuery === '' ? null : h('div', { style: { color: TEXT_SECONDARY, fontSize: 12, marginTop: 2 } }, `正在检索：${openQuery}`),
              ),

          // 列表级说明（被截断、有档案读不出来）：不说出来就会被当成「就这些」。
          openNote === undefined
            ? null
            : h('div', { 'data-detail-note': openView, style: { color: TEXT_SECONDARY, fontSize: 12, marginBottom: 8 } }, openNote),

          // 视图级动作在条目列表上方：新建出来的条目本来就该出现在下面的列表里。
          (viewActions[openView] ?? []).length === 0
            ? null
            : h('div', { 'data-detail-view-actions': openView, style: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 } },
                ...(viewActions[openView] ?? []).map((action) =>
                  h('div', { key: action.id, 'data-detail-view-action': action.id },
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                      ...(action.args ?? []).map((arg) => {
                        const argKey = `${openView}.${action.id}.${arg.key}`
                        return h('input', {
                          key: arg.key,
                          type: 'text',
                          placeholder: arg.label,
                          'data-detail-view-arg': argKey,
                          value: actionArgs[argKey] ?? '',
                          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                            setActionArgs((current) => ({ ...current, [argKey]: event.target.value })),
                          style: { border: `1px solid ${BORDER}`, borderRadius: 6, background: 'transparent', color: 'inherit', fontSize: 12, padding: '4px 8px' },
                        })
                      }),
                      h('button', {
                        type: 'button',
                        'data-detail-view-act': action.id,
                        disabled: busy !== null,
                        onClick: () => void runViewAction(openView, action),
                        style: {
                          border: `1px solid ${action.danger === true ? DANGER : BORDER}`,
                          borderRadius: 8,
                          background: 'transparent',
                          color: action.danger === true ? DANGER : 'inherit',
                          cursor: 'pointer',
                          fontSize: 12,
                          padding: '4px 12px',
                        },
                      }, busy === `view:${openView}:${action.id}` ? '执行中…' : action.label),
                    ),
                    action.hint ? h('div', { style: { color: TEXT_SECONDARY, fontSize: 12, marginTop: 2 } }, action.hint) : null,
                  ),
                ),
              ),

          (lists[openView] ?? []).length === 0 && busy === null
            ? h('div', { style: { fontSize: 12, color: TEXT_SECONDARY } }, '这个视图现在是空的。')
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 } },
                ...(lists[openView] ?? []).map((entry) =>
                  h('button', {
                    key: entry.id,
                    type: 'button',
                    'data-detail-item': entry.id,
                    onClick: () => void openItem(openView, entry.id),
                    style: {
                      border: `1px solid ${BORDER}`,
                      borderRadius: 8,
                      background: item?.body.title === entry.id ? SURFACE_HOVER : 'transparent',
                      color: 'inherit',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                      padding: '6px 10px',
                      textAlign: 'left',
                    },
                  },
                    h('span', { style: { fontSize: 13 } }, entry.title),
                    entry.summary ? h('span', { style: { color: TEXT_SECONDARY, fontSize: 12 } }, entry.summary) : null,
                    entry.meta ? h('span', { style: { color: TEXT_SECONDARY, fontSize: 12 } }, entry.meta) : null,
                  ),
                ),
              ),

          item === null
            ? null
            : h('div', { 'data-detail-body': item.body.title, style: { border: `1px solid ${BORDER}`, borderRadius: 10, padding: 10 } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
                  h('span', { style: { fontSize: 13, fontWeight: 600 } }, item.body.title),
                  item.body.revision === undefined
                    ? null
                    : h('span', { style: { color: TEXT_SECONDARY, fontSize: 12 } }, `修订 ${item.body.revision}`),
                  dirty ? h('span', { style: { color: WARN, fontSize: 12 } }, '有未保存改动') : null,
                  h('span', { style: { flex: 1 } }),
                  h('button', {
                    type: 'button',
                    'data-detail-reload': item.body.title,
                    onClick: () => void reload(),
                    style: { border: `1px solid ${BORDER}`, borderRadius: 8, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12, padding: '4px 10px' },
                  }, dirty ? '重新读取（放弃改动）' : '重新读取'),
                ),

                item.body.markdown
                  // 安全文本：正文里可能有 SOUL/记忆内容，绝不 innerHTML。
                  ? h('pre', {
                      style: {
                        background: SURFACE_HOVER,
                        border: `1px solid ${BORDER_SOFT}`,
                        borderRadius: 8,
                        fontSize: 12,
                        margin: '0 0 12px',
                        padding: 8,
                        whiteSpace: 'pre-wrap',
                      },
                    }, item.body.markdown)
                  : null,

                ...item.body.sections.map((section) =>
                  h(Section, {
                    key: section.id,
                    section,
                    drafts,
                    onDraft: (cellKey, value) => setDrafts((current) => ({ ...current, [cellKey]: value })),
                    additions,
                    onAddRow: (sectionKey) =>
                      setAdditions((current) => ({ ...current, [sectionKey]: (current[sectionKey] ?? 0) + 1 })),
                    onOpenSession: jumpToSession,
                  }),
                ),

                canEdit === false
                  ? null
                  : h('div', { style: { marginBottom: 8 } },
                      ...editable.map((field) =>
                        h('div', { key: field.key, style: { display: 'flex', alignItems: field.kind === 'markdown' ? 'flex-start' : 'center', gap: 8, padding: '4px 0' } },
                          h('span', { style: { fontSize: 12, width: 120, paddingTop: field.kind === 'markdown' ? 4 : 0 } }, field.label),
                          field.kind === 'markdown'
                            ? h('textarea', {
                                'data-detail-field': field.key,
                                value: shownFieldValue(field, drafts),
                                rows: 14,
                                spellCheck: false,
                                onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
                                  setDrafts((current) => ({ ...current, [field.key]: event.target.value })),
                                style: {
                                  ...fieldBoxStyle(drafts[field.key] === undefined),
                                  fontFamily: 'monospace',
                                  lineHeight: 1.5,
                                  resize: 'vertical',
                                  whiteSpace: 'pre',
                                },
                              })
                            : h('input', {
                                type: 'text',
                                'data-detail-field': field.key,
                                value: shownFieldValue(field, drafts),
                                onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                                  setDrafts((current) => ({ ...current, [field.key]: event.target.value })),
                                style: fieldBoxStyle(drafts[field.key] === undefined),
                              }),
                        ),
                      ),
                      h('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
                        h('button', {
                          type: 'button',
                          'data-detail-save': item.body.title,
                          disabled: busy !== null || !dirty,
                          onClick: () => void save(),
                          style: {
                            border: `1px solid ${BORDER}`,
                            borderRadius: 8,
                            background: 'transparent',
                            color: 'inherit',
                            cursor: dirty ? 'pointer' : 'default',
                            fontSize: 12,
                            opacity: dirty ? 1 : 0.5,
                            padding: '4px 12px',
                          },
                        }, busy === 'save' ? '保存中…' : '保存'),
                        h('button', {
                          type: 'button',
                          'data-detail-discard': item.body.title,
                          disabled: !dirty,
                          onClick: () => {
                            setDrafts({})
                            setAdditions({})
                            setNotice(null)
                          },
                          style: { border: `1px solid ${BORDER}`, borderRadius: 8, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12, padding: '4px 12px' },
                        }, '放弃改动'),
                      ),
                    ),

                readOnlyFields.length === 0
                  ? null
                  : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 8 } },
                      ...readOnlyFields.map((field) =>
                        h('div', { key: field.key, style: { fontSize: 12 } },
                          h('span', { style: { color: TEXT_SECONDARY } }, `${field.label}：`),
                          h('span', null, field.value === null ? '—' : String(field.value)),
                        ),
                      ),
                    ),

                (item.body.actions ?? []).length === 0
                  ? null
                  : h('div', { style: { borderTop: `1px solid ${BORDER_SOFT}`, paddingTop: 8 } },
                      ...(item.body.actions ?? []).map((action) =>
                        h('div', { key: action.id, 'data-detail-action': action.id, style: { marginBottom: 8 } },
                          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                            ...(action.args ?? []).map((arg) => {
                              const argKey = `${item.itemId}.${action.id}.${arg.key}`
                              return h('input', {
                                key: arg.key,
                                type: 'text',
                                placeholder: arg.label,
                                'data-detail-arg': argKey,
                                value: actionArgs[argKey] ?? '',
                                onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                                  setActionArgs((current) => ({ ...current, [argKey]: event.target.value })),
                                style: { border: `1px solid ${BORDER}`, borderRadius: 6, background: 'transparent', color: 'inherit', fontSize: 12, padding: '4px 8px' },
                              })
                            }),
                            h('button', {
                              type: 'button',
                              'data-detail-act': action.id,
                              disabled: busy !== null,
                              onClick: () => void runAction(action),
                              style: {
                                border: `1px solid ${action.danger === true ? DANGER : BORDER}`,
                                borderRadius: 8,
                                background: 'transparent',
                                color: action.danger === true ? DANGER : 'inherit',
                                cursor: 'pointer',
                                fontSize: 12,
                                padding: '4px 12px',
                              },
                            }, busy === `act:${action.id}` ? '执行中…' : action.label),
                          ),
                          action.hint ? h('div', { style: { color: TEXT_SECONDARY, fontSize: 12, marginTop: 2 } }, action.hint) : null,
                        ),
                      ),
                    ),
              ),

          error !== null ? h('div', { 'data-detail-error': '', style: { color: DANGER, fontSize: 12, marginTop: 8 } }, error) : null,
          notice !== null ? h('div', { 'data-detail-notice': '', style: { color: TEXT_SECONDARY, fontSize: 12, marginTop: 8 } }, notice) : null,
        ),
  )
}
