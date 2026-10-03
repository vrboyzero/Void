/**
 * 「虚空(Void) Agents」——侧栏面板行 + 主面板。
 *
 * 方案见 `docs/灵魂记忆与军团.md` 第二十一节。
 *
 * 一张卡片上有**两个后果不同**的动作，视觉上必须分得开（21.4 第 3 条）：
 * - **点卡片主体 = 换 Agent**：把当前会话绑到这份档案（整份身份换掉）；
 * - **下拉 + 「加载模组」= 换模组**：只换角色层，底线一个字节不动。
 *
 * 两处槽位一对一配对（宿主 `dsh-client-ui-sidebar` / `dsh-client-ui-layout` 的契约）：
 * - `'main'` 是 `keyed` 槽位，每个 key 是一个主面板；
 * - `sidebar.panellist` 是 `list` 槽位，`id` **必须等于** `'main'` 的 `key`，
 *   侧栏据此渲染按钮、并从 list 元数据解析标签。
 *
 * 参考实现：宿主自己的 `dsh-client-ui-plugin-manager/lib/client.js`。
 * **不注入 DOM**：任务看板那个插件用 `plain-DOM surfaces (sidebar row)` 直接改侧栏，
 * 我们不学——走槽位才有随声明塌陷回收、跟随 fiber 生命周期的正规生命周期。
 *
 * @module @void/void-entry/src/client/agents-panel
 */
import { createElement as h, useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { postDetailAction, postFacetSelection } from './api.js'
import { BRAND_LOGO_DATA_URI } from './brand-logo.js'
import type { Context } from './context-types.js'
import { BORDER, BORDER_SOFT, BRAND, BUTTON_FILL, DANGER, SURFACE_HOVER, SURFACE_PANEL, TEXT_PRIMARY, TEXT_SECONDARY } from './theme.js'

/** 主面板 key 与侧栏行的 `id` 必须相等，这是配对本身。 */
export const VOID_AGENTS_PANEL_ID = 'void-agents'

/** 侧栏行文案。用户 2026-09-26 定：写全，长一点更吸睛。 */
export const VOID_AGENTS_LABEL = '虚空(Void) Agents'

/**
 * 侧栏行排序。落在「新会话」下方那一组——20 是初值，
 * 真机上按实际排位再调（宿主侧栏按 order 升序，平序保持注册顺序）。
 */
export const VOID_AGENTS_ORDER = 20

/** 档案列表视图。卡片数据与「绑会话」动作都挂在这个视图上。 */
export const PROFILES_VIEW_ID = 'void-soul:profiles'

/** 模组库视图。下拉的选项从这里来。 */
export const FACETS_VIEW_ID = 'void-soul:facets'

const PROFILES_ENDPOINT = `/void/api/detail?view=${PROFILES_VIEW_ID}`
const FACETS_ENDPOINT = `/void/api/detail?view=${FACETS_VIEW_ID}`

/** 下拉里「不装模组」那一项的值。宿主把 `facetId: null` 解释成摘掉角色。 */
export const NO_FACET_VALUE = ''

/**
 * 一个下拉选项。
 *
 * 底色与文字色**必须显式给**：原生 `<select>` 的**弹出列表不吃外层的文字色**，
 * 而 `<option>` 的默认底色是系统白。深色主题下继承来的浅色文字落在白底上，
 * 除当前项外全部看不见——2026-09-26 用户截图报的就是这个。走令牌才随主题走。
 *
 * 导出只为让 `tests/agents-panel.spec.ts` 钉住这条（有人改回裸 `option` 时红灯）。
 */
export function facetOption(value: string, label: string): ReactElement {
  return h('option', {
    key: value,
    value,
    style: { background: SURFACE_PANEL, color: TEXT_PRIMARY },
  }, label)
}

// ── 数据形状 ───────────────────────────────────────────────────────────────

/** 一张档案卡片。来自宿主详情接口的列表条目。 */
export interface VoidAgentCard {
  readonly id: string
  readonly name: string
  /** 接口给的组合行：`<id> · <模组名|没有模组> · N 个会话`。 */
  readonly summary: string
  /** 接口给的修订行原文（`修订 <hash>`，停用时会多一段）。 */
  readonly meta: string
  readonly suspended: boolean
  /** 角色选择的乐观锁修订号；切模组必须带回。取不到就是 undefined（老宿主）。 */
  readonly selectionRevision?: number
  /** 当前装载的模组 id；没装或取不到是 null / undefined。 */
  readonly facetId?: string | null
  /** 当前装载的模组显示名。 */
  readonly facetName?: string | null
  /** 绑在这份档案上的会话 id——用来认出「哪个档案绑着当前会话」。 */
  readonly boundSessions: readonly string[]
}

/** 下拉里的一个模组选项。 */
export interface VoidFacetOption {
  readonly id: string
  readonly name: string
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 收一个字符串数组；非数组或含非字符串一律当空表（坏数据不该让面板白屏）。 */
function asTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * 把 `/void/api/detail?view=void-soul:profiles` 的响应解析成卡片。
 *
 * 纯函数，便于单测。**不抛**：认不出的条目直接跳过——一个坏条目不该让整个面板白屏，
 * 这正是 0.1.7 那次事故的教训（渲染期抛错会打掉整个 slot 条目）。
 */
export function parseAgentCards(payload: unknown): VoidAgentCard[] {
  if (typeof payload !== 'object' || payload === null) return []
  const items = (payload as { items?: unknown }).items
  if (!Array.isArray(items)) return []
  const cards: VoidAgentCard[] = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const id = asText(record.id)
    if (id === '') continue
    const meta = asText(record.meta)
    cards.push({
      id,
      name: asText(record.title) || id,
      summary: asText(record.summary),
      meta,
      suspended: meta.includes('已停用'),
      ...(typeof record.selectionRevision === 'number' ? { selectionRevision: record.selectionRevision } : {}),
      ...(record.facetId === null || typeof record.facetId === 'string' ? { facetId: record.facetId } : {}),
      ...(record.facetName === null || typeof record.facetName === 'string' ? { facetName: record.facetName } : {}),
      boundSessions: asTextArray(record.boundSessions),
    })
  }
  return cards
}

/** 把模组库视图的响应解析成下拉选项。纯函数，规则同 `parseAgentCards`。 */
export function parseFacetOptions(payload: unknown): VoidFacetOption[] {
  if (typeof payload !== 'object' || payload === null) return []
  const items = (payload as { items?: unknown }).items
  if (!Array.isArray(items)) return []
  const options: VoidFacetOption[] = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const id = asText(record.id)
    if (id === '') continue
    options.push({ id, name: asText(record.title) || id })
  }
  return options
}

// ── 当前会话 ───────────────────────────────────────────────────────────────

/** `useSessionRetainInfo(id)` 给回来的那一小块。 */
export interface SessionRetainShape {
  readonly retainedBy?: Readonly<Record<string, number>>
}

/**
 * 从会话保留信息里认出**当前会话**。
 *
 * `'main'` 是 `root` 作用域，面板拿不到 `SessionStandardProps.sessionId`（宿主契约明说
 * 「other keys receive no Session binding」），URL 也不带会话 id（纯 SPA，实测过）。
 * 但 `GlobalStandardProps` 里的 `useSessionRetainInfo(id)` 会给出 `retainedBy`——
 * **主列正在看的那一个会话有 `mainView > 0`**，其余都是 0。
 *
 * 2026-09-26 在隔离实例上实测确认：10 个会话里**恰好一个** `mainView=1`，绑定后落盘的
 * id 与它完全一致。这是 `useSessionRetainInfo` 的公开契约用法，不是猜的。
 */
export function isCurrentSession(info: SessionRetainShape | undefined): boolean {
  return (info?.retainedBy?.mainView ?? 0) > 0
}

/**
 * 每个会话一个这样的隐形子组件：`useSessionRetainInfo` 是 Hook，不能在 `map` 里直接调
 * （调用次数随会话数变化，违反 Hooks 规则）。命中当前会话时报给上层。
 */
function CurrentSessionReporter(props: {
  id: string
  useRetain: (id: string) => unknown
  onResolve: (id: string) => void
}): null {
  const info = props.useRetain(props.id) as SessionRetainShape | undefined
  const current = isCurrentSession(info)
  const { id, onResolve } = props
  useEffect(() => {
    if (current) onResolve(id)
  }, [current, id, onResolve])
  return null
}

// ── 侧栏字形 ───────────────────────────────────────────────────────────────

/**
 * 侧栏面板行字形。宿主传 `{size, active}`（见 `SidebarPanelIconOwnerProps`）。
 *
 * 用品牌 logo 而不是宿主图标集：用户要的就是这张图。代价是 PNG 不随主题换色，
 * 所以用透明度表达选中态，而不是 `currentColor`。
 */
export function VoidAgentsGlyph(props: { size?: unknown; active?: unknown }): ReactElement {
  const size = typeof props.size === 'number' && props.size > 0 ? props.size : 20
  const active = props.active === true
  return h('img', {
    src: BRAND_LOGO_DATA_URI,
    width: size,
    height: size,
    alt: '',
    'aria-hidden': 'true',
    'data-void-agents-glyph': '',
    style: {
      display: 'block',
      width: `${size}px`,
      height: `${size}px`,
      objectFit: 'contain',
      borderRadius: '4px',
      opacity: active ? 1 : 0.72,
      transition: 'opacity .15s ease',
    },
  })
}

// ── 主面板 ─────────────────────────────────────────────────────────────────

type PanelState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly cards: readonly VoidAgentCard[] }
  | { readonly kind: 'error'; readonly message: string }

type Notice =
  | { readonly kind: 'idle' }
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'failed'; readonly text: string }

const cardShellStyle = {
  display: 'flex',
  flexDirection: 'column',
  border: `1px solid ${BORDER}`,
  borderRadius: 12,
  background: SURFACE_HOVER,
  overflow: 'hidden',
} as const

const plainButtonStyle = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  font: 'inherit',
  color: 'inherit',
  cursor: 'pointer',
  textAlign: 'left',
} as const

/** 面板根：纵向排，铺满主列高度。 */
const PANEL_ROOT_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: '100%',
} as const

/**
 * 面板正文区。
 *
 * 左右各留 10px：主列左边紧贴着侧栏，正文贴上去分不出界（用户 2026-09-26 截图报的）。
 * 标题栏**保持通栏**——它是这个面板的框，缩进去反而不像框了。
 */
function bodyArea(...children: ReactNode[]): ReactElement {
  return h('div', {
    'data-void-agents-body': '',
    style: {
      display: 'flex',
      flexDirection: 'column',
      flex: '1 1 auto',
      minHeight: 0,
      padding: '0 10px 10px',
    },
  }, ...children)
}

/**
 * 一张档案卡片。
 *
 * 主体是一个 `<button>`（换 Agent）；模组那一行是**兄弟节点**而不是嵌在按钮里——
 * `<button>` 里套 `<select>` 是非法 HTML，浏览器会把 DOM 拆开。
 * 两区之间用上边框分开，配合不同的交互提示，满足「视觉上必须分得开」。
 */
function Card(props: {
  card: VoidAgentCard
  currentSession: string | undefined
  onBind: (card: VoidAgentCard) => void
  bindBusy: boolean
  /** 下拉当前选中的值（模组 id，或 `NO_FACET_VALUE` 表示不装）。 */
  selected: string
  onSelect: (profileId: string, value: string) => void
  /** 第一次展开下拉时才拉模组列表。 */
  facets: readonly VoidFacetOption[] | undefined
  onNeedFacets: () => void
  onLoadFacet: (card: VoidAgentCard, facetId: string | null) => void
  facetBusy: boolean
}): ReactElement {
  const { card, currentSession, onBind, bindBusy, selected, onSelect, facets, onNeedFacets, onLoadFacet, facetBusy } = props

  const boundToCurrent = currentSession !== undefined && card.boundSessions.includes(currentSession)
  const facetValue = selected
  const facetDirty = facetValue !== (card.facetId ?? NO_FACET_VALUE)

  return h('div', { 'data-void-agent-card': card.id, style: { ...cardShellStyle, opacity: card.suspended ? 0.55 : 1 } },
    // ── 换 Agent：点这里 ──────────────────────────────────────────────────
    h('button', {
      type: 'button',
      'data-void-agent-bind': card.id,
      onClick: () => onBind(card),
      disabled: bindBusy,
      title: card.suspended
        ? '这份档案已停用，绑定后不会生效'
        : boundToCurrent ? '当前会话已经绑着这份档案' : '把当前会话绑到这份档案',
      style: {
        ...plainButtonStyle,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '12px 14px',
        minHeight: 96,
        cursor: bindBusy ? 'progress' : 'pointer',
        // 绑着的卡片描一圈亮边。这里用 `BRAND` 是对的——它是近白色，细线强调醒目，
        // 当填充才会出事（见 theme.ts 的注释）。
        boxShadow: boundToCurrent ? `inset 0 0 0 2px ${BRAND}` : 'none',
      },
    },
      h('div', { style: { fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 } },
        h('img', {
          src: BRAND_LOGO_DATA_URI, width: 18, height: 18, alt: '', 'aria-hidden': 'true',
          style: { width: '18px', height: '18px', borderRadius: '4px', flex: 'none' },
        }),
        card.name,
        boundToCurrent
          ? h('span', { 'data-void-agent-bound': card.id, style: { fontSize: 11, color: TEXT_SECONDARY, fontWeight: 400 } }, '当前会话')
          : null,
      ),
      h('div', { 'data-void-agent-card-id': card.id, style: { fontSize: 12, color: TEXT_SECONDARY } }, card.id),
      h('div', { style: { fontSize: 12, color: TEXT_SECONDARY } }, card.summary),
      h('div', { style: { fontSize: 12, color: TEXT_SECONDARY, marginTop: 'auto' } }, card.meta),
    ),
    // ── 换模组：这一行 ────────────────────────────────────────────────────
    h('div', {
      'data-void-agent-facet-row': card.id,
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 14px',
        borderTop: `1px solid ${BORDER}`,
      },
    },
      h('span', { style: { fontSize: 12, color: TEXT_SECONDARY, flex: 'none' } }, '角色'),
      h('select', {
        'data-void-agent-facet-select': card.id,
        value: facetValue,
        disabled: facetBusy,
        onMouseDown: onNeedFacets,
        onFocus: onNeedFacets,
        onChange: (event: { target: { value: string } }) => onSelect(card.id, event.target.value),
        style: {
          flex: 1,
          minWidth: 0,
          fontSize: 12,
          padding: '3px 6px',
          borderRadius: 6,
          border: `1px solid ${BORDER_SOFT}`,
          // 必须显式给：原生下拉的**弹出列表**继承不到外层的文字色，而 `<option>` 的
          // 系统默认底色是白的 —— 不写就是深色主题下白字白底、除当前项外全看不见。
          background: SURFACE_PANEL,
          color: TEXT_PRIMARY,
        },
      },
        // 惰性：列表还没拉回来时，至少把当前值显示出来（21.4 第 2 条）。
        facets === undefined
          ? [facetOption(facetValue, card.facetName ?? '（不装模组）')]
          : [
              facetOption(NO_FACET_VALUE, '（不装模组）'),
              ...facets.map((facet) => facetOption(facet.id, facet.name)),
            ],
      ),
      h('button', {
        type: 'button',
        'data-void-agent-facet-load': card.id,
        disabled: facetBusy || !facetDirty,
        onClick: () => onLoadFacet(card, facetValue === NO_FACET_VALUE ? null : facetValue),
        title: facetDirty ? '把选中的模组装给这份档案' : '先在下拉里换一个模组',
        style: {
          flex: 'none',
          fontSize: 12,
          padding: '3px 10px',
          borderRadius: 8,
          border: `1px solid ${facetDirty ? BUTTON_FILL : BORDER_SOFT}`,
          // 可点时才上底色。**不要用 `BRAND`**——它在深色下是 #f9fafb 近白，拿来当填充就是
          // 一块白板，与面板色调不合；配文字色还会因为令牌名写错而看不见字。走 `BUTTON_FILL`
          // （#43454a）+ `TEXT_PRIMARY`（#f9fafb，对比度约 8.9:1）。
          background: facetDirty ? BUTTON_FILL : 'transparent',
          color: facetDirty ? TEXT_PRIMARY : TEXT_SECONDARY,
          cursor: facetBusy || !facetDirty ? 'not-allowed' : 'pointer',
          opacity: facetDirty ? 1 : 0.5,
        },
      }, facetBusy ? '加载中…' : '加载模组'),
    ),
  )
}

/**
 * 主面板：灵魂档案卡片网格。
 *
 * - **点卡片主体** = 把当前会话绑到那份档案（没有当前会话时给门禁提示）；
 * - **下拉 + 「加载模组」** = 只换该档案的角色层，不动底线。
 *
 * 门禁不做复杂流程（用户 2026-09-26 裁定：用户总是先进入会话才会改选 Agent，
 * 空态只可能是刻意构造的）。
 */
export function VoidAgentsPage(props: Record<string, unknown> = {}): ReactElement {
  const [state, setState] = useState<PanelState>({ kind: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const [currentSession, setCurrentSession] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<Notice>({ kind: 'idle' })
  const [bindBusy, setBindBusy] = useState<string | undefined>(undefined)
  const [facetBusy, setFacetBusy] = useState<string | undefined>(undefined)
  const [facetOptions, setFacetOptions] = useState<readonly VoidFacetOption[] | undefined>(undefined)
  /** 每张卡下拉里**暂存**的选择；没暂存过就用卡片自己的当前模组。 */
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({})

  const onResolve = useCallback((id: string) => setCurrentSession(id), [])

  // 全局座位：由 `ui-session` 声明合并进 GlobalStandardProps，每个 slot 组件都能拿到。
  const useSessions = props.useSessions as ((selector: (value: unknown) => unknown) => unknown) | undefined
  const useRetain = props.useSessionRetainInfo as ((id: string) => unknown) | undefined
  const listState = (typeof useSessions === 'function'
    ? useSessions((value: unknown) => value)
    : undefined) as { ids?: unknown } | undefined
  const sessionIds = Array.isArray(listState?.ids) ? (listState.ids as string[]) : []

  useEffect(() => {
    let alive = true
    setState({ kind: 'loading' })
    fetch(PROFILES_ENDPOINT, { headers: { accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return await response.json() as unknown
      })
      .then((payload) => {
        if (!alive) return
        setState({ kind: 'ready', cards: parseAgentCards(payload) })
      })
      .catch((error: unknown) => {
        if (!alive) return
        setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      })
    return () => { alive = false }
  }, [reloadToken])

  /**
   * 惰性拉模组列表：只在**第一次展开下拉**时拉一次，之后缓存。
   * 面板一挂载就拉 N 次是用户在 21.4 第 2 条里明确否掉的。
   */
  const needFacets = useCallback(() => {
    if (facetOptions !== undefined) return
    setFacetOptions([])
    void fetch(FACETS_ENDPOINT, { headers: { accept: 'application/json' } })
      .then(async (response) => (response.ok ? await response.json() as unknown : undefined))
      .then((payload) => setFacetOptions(parseFacetOptions(payload)))
      .catch(() => setFacetOptions([]))
  }, [facetOptions])

  const bindCard = useCallback((card: VoidAgentCard) => {
    if (currentSession === undefined) return
    if (card.boundSessions.includes(currentSession)) {
      setNotice({ kind: 'ok', text: `当前会话已经绑着「${card.name}」了。` })
      return
    }
    setBindBusy(card.id)
    void postDetailAction({
      view: PROFILES_VIEW_ID,
      itemId: card.id,
      op: 'act',
      actionId: 'bind-session',
      args: { sessionId: currentSession },
    }).then((outcome) => {
      setBindBusy(undefined)
      if (outcome.ok) {
        setNotice({ kind: 'ok', text: `已把当前会话绑到「${card.name}」。下一轮它就用这份档案的身份。` })
        setReloadToken((value) => value + 1)
      } else {
        setNotice({ kind: 'failed', text: `绑定失败：${outcome.error ?? '未知错误'}` })
      }
    })
  }, [currentSession])

  const loadFacet = useCallback((card: VoidAgentCard, facetId: string | null) => {
    if (card.selectionRevision === undefined) {
      setNotice({ kind: 'failed', text: '切模组失败：这份档案的列表数据没带选择修订号，宿主版本可能偏旧。' })
      return
    }
    setFacetBusy(card.id)
    void postFacetSelection({
      agentId: card.id,
      facetId,
      expectedRevision: card.selectionRevision,
    }).then((outcome) => {
      setFacetBusy(undefined)
      if (outcome.ok) {
        const name = facetId === null ? '（不装模组）' : (facetOptions ?? []).find((o) => o.id === facetId)?.name ?? facetId
        setNotice({ kind: 'ok', text: `已把「${card.name}」的角色换成 ${name}。下一轮生效。` })
        setDrafts((current) => {
          const next = { ...current }
          delete next[card.id]
          return next
        })
        setReloadToken((value) => value + 1)
      } else {
        // 409 是乐观锁冲突：别人（或人类面板）先改过。照实说出来，不静默重试。
        setNotice({ kind: 'failed', text: `换模组失败：${outcome.error ?? '未知错误'}` })
      }
    })
  }, [facetOptions])

  const status = state.kind === 'ready' ? `${state.cards.length} 份档案` : ''
  const sessionLabel = currentSession === undefined
    ? (sessionIds.length > 0 ? '没有选中的会话' : '还没有会话')
    : `当前会话 …${currentSession.slice(-8)}`

  const header = h('div', {
    style: { display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 12, borderBottom: `1px solid ${BORDER}`, marginBottom: 12, flexWrap: 'wrap' },
  },
    h('img', {
      src: BRAND_LOGO_DATA_URI, width: 24, height: 24, alt: '', 'aria-hidden': 'true',
      style: { width: '24px', height: '24px', borderRadius: '6px' },
    }),
    h('span', { style: { fontSize: 16, fontWeight: 600 } }, VOID_AGENTS_LABEL),
    h('span', { 'data-void-agents-session': '', style: { fontSize: 12, color: TEXT_SECONDARY } }, sessionLabel),
    h('span', { style: { fontSize: 12, color: TEXT_SECONDARY, marginLeft: 'auto' } }, status),
    h('button', {
      type: 'button',
      'data-void-agents-reload': '',
      onClick: () => setReloadToken((value) => value + 1),
      style: {
        fontSize: 12, color: TEXT_SECONDARY, background: 'transparent',
        border: `1px solid ${BORDER_SOFT}`, borderRadius: 8, padding: '4px 10px', cursor: 'pointer',
      },
    }, '刷新'),
  )

  /** 门禁与结果条：只在需要时出现，不占常驻空间。 */
  const noticeNode = (() => {
    if (notice.kind !== 'idle') {
      return h('div', {
        'data-void-agents-notice': notice.kind,
        style: { fontSize: 12, color: notice.kind === 'failed' ? DANGER : TEXT_SECONDARY, marginBottom: 12 },
      }, notice.text)
    }
    if (currentSession === undefined && state.kind === 'ready' && state.cards.length > 0) {
      return h('div', {
        'data-void-agents-notice': 'gate',
        style: { fontSize: 12, color: TEXT_SECONDARY, marginBottom: 12 },
      }, sessionIds.length > 0
        ? '点卡片要有当前会话：请先在侧栏选中一个会话。'
        : '请先新建或打开一个会话，再点卡片把 Agent 绑给它。')
    }
    return null
  })()

  const reporters = typeof useRetain === 'function'
    ? sessionIds.map((id) => h(CurrentSessionReporter, { key: id, id, useRetain, onResolve }))
    : []

  if (state.kind === 'loading') {
    return h('div', { 'data-void-agents-panel': '', style: PANEL_ROOT_STYLE }, reporters, header,
      bodyArea(h('div', { style: { fontSize: 13, color: TEXT_SECONDARY } }, '正在读取灵魂档案…')))
  }

  if (state.kind === 'error') {
    return h('div', { 'data-void-agents-panel': '', style: PANEL_ROOT_STYLE }, reporters, header,
      bodyArea(
        h('div', { style: { fontSize: 13, color: DANGER } }, `读取失败：${state.message}`),
        h('div', { style: { fontSize: 12, color: TEXT_SECONDARY, marginTop: 8 } },
          '灵魂插件没装或数据根还没配好时会出现这一条。装齐 void-soul 后点右上角刷新。'),
      ))
  }

  return h('div', { 'data-void-agents-panel': '', style: PANEL_ROOT_STYLE },
    reporters,
    header,
    bodyArea(
      noticeNode,
      state.cards.length === 0
        ? h('div', { style: { fontSize: 13, color: TEXT_SECONDARY } },
            '还没有任何灵魂档案。建一份之后这里会出现它的卡片。')
        : h('div', {
            'data-void-agents-grid': '',
            style: {
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
              gap: 12,
              alignItems: 'start',
            },
          }, ...state.cards.map((card) => h(Card, {
          key: card.id,
          card,
          currentSession,
          onBind: bindCard,
          bindBusy: bindBusy === card.id,
          selected: drafts[card.id] ?? card.facetId ?? NO_FACET_VALUE,
          onSelect: (profileId: string, value: string) =>
            setDrafts((current) => ({ ...current, [profileId]: value })),
          facets: facetOptions,
          onNeedFacets: needFacets,
          onLoadFacet: loadFacet,
          facetBusy: facetBusy === card.id,
        })))),
  )
}

// ── 注册 ───────────────────────────────────────────────────────────────────

/**
 * 把侧栏行与主面板挂上去。由客户端 `apply` 调用。
 *
 * `label` 传**纯字符串**（不引 locale 字典）：省一个依赖面，也省一套字典文件。
 */
export function registerVoidAgents(ctx: Context): void {
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: VOID_AGENTS_PANEL_ID,
  }, VoidAgentsPage))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: VOID_AGENTS_PANEL_ID,
    order: VOID_AGENTS_ORDER,
    label: VOID_AGENTS_LABEL,
  }, VoidAgentsGlyph))
}
