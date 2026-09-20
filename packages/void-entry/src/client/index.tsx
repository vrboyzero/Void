import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import type { Context } from './context-types.ts'
import { createVoidWidgetsService } from './widgets.js'
import {
  Button,
  DisclosureRow,
  IconCordisPluginOutline14,
  IconQuestionOutline14,
  IconSearchOutline16,
  Input,
  RiskConfirmation,
  StateDot,
  Switch,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { PRIMITIVE_GAPS } from './primitives-probe.js'
import {
  describeNamespaces,
  mutateNamespace,
  type NamespaceView,
  type PathOp,
  type SchemaEnvelope,
  type SchemaNode,
} from './remote.js'
import { ConnectBlock } from './connect.js'
import { TEXT_SECONDARY, BORDER, WARN, WARN_SURFACE, ROW_TITLE_CLASS, ensureStyles } from './theme.js'
import { draftOps, editDraft, isDirty, saveBlockers, shownValue, type Draft } from './draft.js'
import { readonlyText } from './display.js'
import {
  ChoicesField,
  Group,
  Hint,
  ListField,
  NumberField,
  OperationsField,
  PatternListField,
  RulesField,
  SwitchField,
  TextField,
  TokensField,
  type DocumentRuleRow,
  type OperationEntry,
  type TokenRow,
} from './controls.js'

export const inject = ['slots']

/** 设置页导航里的栏目名。 */
const SECTION_LABEL = '虚空（Void）'

/**
 * 排序位。宿主内置栏目的 order 依次是：模型 10、插件 15、Agent 预设 20；
 * 其他第三方栏目是插件市场 40、侧边卡片 100。45 落在插件市场之后、侧边卡片
 * 之前，正好和其他第三方扩展聚在一起。
 */
const SECTION_ORDER = 45


interface PluginState {
  id: string
  name: string
  description: string
  enabled: boolean
  toggleable: boolean
}

/** 插件板块的元数据；由插件自己通过 `voidSuite.registerPanel` 贡献。 */
interface PanelField {
  path: string[]
  label?: string
  widget?: string
  options?: Array<{ value: string; label: string }>
  help?: string
  danger?: boolean
  readOnly?: boolean
  /**
   * 取值来源。
   *
   * `settings`（默认）读设置命名空间；`runtime` 读清单里的 `runtime` 块——那是组合入口
   * 决定、**不在设置 schema 里**的值（启用开关、端点路径、账本后端、传输方式）。这类值
   * 在 `describe()` 的 `value` 和 `base` 里都不存在，只能由宿主半边写进清单。
   */
  source?: 'settings' | 'runtime'
}

interface PanelManifest {
  namespace: string
  groups: Array<{
    id: string
    title: string
    summary?: string
    fields: PanelField[]
    /**
     * 分组顶部的警示行；不写就不显示。
     *
     * 用于「做错这一步会静默坏掉、而从界面上看不出来」的前提——比如改
     * `cordis.patch.yml` 时 `config` 是整体替换而非深合并，只写一个字段会把 `tokens`
     * 一并抹掉，端点还在但所有请求 401。这类内容得在**动手之前**看到，所以放在分组最上面。
     */
    notice?: string
    /** 分组末尾的展示区块；connect 让面板渲染 MCP 接入信息。 */
    block?: string
  }>
  operations?: OperationEntry[]
  /**
   * 组合入口决定的运行时值（启用开关、端点路径、账本后端、传输方式）。
   *
   * 这几项不在设置 schema 里，所以 `describe()` 的 `value` 与 `base` 都没有它们；
   * `source: 'runtime'` 的字段从这里取值。
   */
  runtime?: Record<string, unknown>
  /** MCP 接入信息：主机与端口由面板用 window.location.origin 补。 */
  connect?: { path: string; transport?: string }
}

/**
 * Client half：壳 A 的薄 UI 入口。
 *
 * 1. 发布 `ctx.voidWidgets` 服务（借鉴 dsh-better-sidebar 的 `ctx.betterSidebar`：
 *    在挂载任何 panel 之前 `ctx.provide`，消费者 `inject = ["voidWidgets"]` 时已就绪）。
 * 2. 把「虚空（Void）」目录挂进 DSH 设置 shell 的 settings.section slot。
 *
 * 面板是**通用渲染器**：目录成员由 host 半边扫 loader 得出，配置字段由插件的
 * settings schema 与它自己贡献的清单决定。所以新插件装上就出现、注册了命名空间
 * 就能配，这一侧不需要认识任何一个具体插件。
 */
export function apply(ctx: Context): void {
  // 行标题加粗只能靠注入的样式表：DisclosureRow 的 title 是字符串，只收 className。
  ensureStyles()

  ctx.provide('voidWidgets', createVoidWidgetsService())

  if (PRIMITIVE_GAPS.length > 0) {
    // 宿主原语缺失（旧版 dsh）：不致命——面板会回退到手写 HTML，仍然可用。
    console.warn(
      `[void-entry] host ui-primitives missing ${PRIMITIVE_GAPS.join(', ')}; ` +
        'falling back to plain markup for the affected controls',
    )
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'void',
    order: SECTION_ORDER,
    label: () => SECTION_LABEL,
  }, VoidSection))
}

// ── schema 读取 ────────────────────────────────────────────────────────────

/** 沿路径读一个值；任一段缺失就返回 undefined。 */
function readPath(root: unknown, path: readonly string[]): unknown {
  let cursor: unknown = root
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor
}

/** 该路径是否被用户在设置文档里显式覆盖过。 */
function isOverridden(view: NamespaceView, path: readonly string[]): boolean {
  if (view.user === undefined) return false
  return readPath(view.user, path) !== undefined
}

/** 取路径末段的 schema 节点，用来在清单没给控件提示时按类型推断。 */
function nodeAt(schema: SchemaEnvelope, path: readonly string[]): SchemaNode | undefined {
  let node = schema.refs[String(schema.uid)]
  for (const key of path) {
    if (node?.dict === undefined) return undefined
    const next = node.dict[key]
    if (next === undefined) return undefined
    node = schema.refs[String(next)]
  }
  return node
}

/** 清单没给 widget 时，按 schema 类型推断一个合理的控件。 */
function inferWidget(node: SchemaNode | undefined, value: unknown): string {
  if (node !== undefined) {
    if (node.type === 'boolean') return 'switch'
    if (node.type === 'number') return 'number'
    if (node.type === 'array') return 'list'
    if (node.type === 'object') return 'object'
  }
  if (typeof value === 'boolean') return 'switch'
  if (typeof value === 'number') return 'number'
  if (Array.isArray(value)) return 'list'
  return 'text'
}

/** 折叠态摘要：用分组里第一个有值的字段凑一句，好过写死一句可能与实际不符的话。 */
function summarize(manifest: PanelManifest, view: NamespaceView | undefined, groupId: string): string {
  const group = manifest.groups.find((g) => g.id === groupId)
  if (view === undefined || group === undefined) return ''
  const bits: string[] = []
  for (const field of group.fields) {
    const value = readPath(view.value, field.path)
    const label = field.label ?? field.path[field.path.length - 1]!
    if (typeof value === 'boolean') bits.push(`${label}${value ? '开' : '关'}`)
    else if (Array.isArray(value)) bits.push(`${label} ${value.length}`)
    else if (typeof value === 'string' && value !== '') bits.push(`${label} ${value}`)
  }
  return bits.slice(0, 2).join(' · ')
}

// ── 面板 ───────────────────────────────────────────────────────────────────

function VoidSection(): React.ReactElement {
  const [plugins, setPlugins] = useState<PluginState[] | null>(null)
  const [manifests, setManifests] = useState<Record<string, PanelManifest>>({})
  const [views, setViews] = useState<Record<string, NamespaceView>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [openPlugin, setOpenPlugin] = useState<string | null>(null)
  const [openGroup, setOpenGroup] = useState<string | null>(null)
  /**
   * 各命名空间的未保存改动。
   *
   * 官方设置卡片的规则是「只有用户保存时才写入」，所以输入只落到这里，不发请求。
   * 这样从结构上就不存在「半成品值上线」——P4 时那些逐个控件的绕法（失焦提交、空行
   * 过滤）都不再需要。
   */
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  // 写回时要读最新视图，但不想让 `edit` 依赖 `views` 而频繁重建。
  const viewsRef = useRef<Record<string, NamespaceView>>({})
  viewsRef.current = views

  /** 重读所有命名空间，写入冲突时也走这里（revision 已经变了）。 */
  const refreshViews = useCallback(async () => {
    const outcome = await describeNamespaces()
    if (!outcome.ok) {
      setError(outcome.message)
      return
    }
    const next: Record<string, NamespaceView> = {}
    for (const view of outcome.value) next[view.ns] = view
    setViews(next)
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/void/api/status').then((r) => r.json() as Promise<{ plugins?: PluginState[] }>),
      fetch('/void/api/panels').then((r) => r.json() as Promise<{ panels?: Record<string, PanelManifest> }>),
    ])
      .then(([status, panels]) => {
        if (cancelled) return
        const list = status.plugins ?? []
        setPlugins(list)
        setManifests(panels.panels ?? {})
        setOpenPlugin(list.find((p) => p.toggleable)?.id ?? null)
      })
      .catch(() => {
        if (!cancelled) setPlugins([])
      })
    void refreshViews()
    return () => {
      cancelled = true
    }
  }, [refreshViews])

  const applyEnabled = (ids: string[], enabled: boolean) => {
    setPlugins((ps) => (ps ?? []).map((p) => (ids.includes(p.id) ? { ...p, enabled } : p)))
  }

  const toggle = (id: string, enabled: boolean) => {
    setBusy(id)
    setError(null)
    fetch('/void/api/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pluginId: id, enabled }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? `HTTP ${r.status}`)
        applyEnabled([id], enabled)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null))
  }

  /** 把一次输入写进草稿——只动本地状态，不发请求。 */
  const edit = (ns: string, path: readonly string[], value: unknown) => {
    const revision = viewsRef.current[ns]?.revision ?? 0
    setDrafts((current) => ({ ...current, [ns]: editDraft(current[ns], path, value, revision) }))
    setError(null)
  }

  const discard = (ns: string) => {
    setDrafts((current) => {
      const next = { ...current }
      delete next[ns]
      return next
    })
    setError(null)
  }

  /**
   * 保存一个命名空间的草稿。
   *
   * 以**草稿开始编辑时**的 revision 设栅，所以一个已经与文档脱节的表单会被
   * `settings/conflict` 拒绝，而不是盖掉并发发生的改动。被拒时保留草稿并重读，
   * 让用户核对后再存——而不是替他重试。
   */
  const save = async (ns: string) => {
    const draft = drafts[ns]
    const view = views[ns]
    if (draft === undefined || view === undefined) return
    const widgets = manifestWidgets(manifests, ns)
    const ops = draftOps(draft, widgets, view.value) as PathOp[]
    if (ops.length === 0) {
      discard(ns)
      return
    }
    setBusy(`${ns}:save`)
    setError(null)
    const outcome = await mutateNamespace(ns, ops, draft.revision)
    setBusy(null)
    if (outcome.ok) {
      setViews((current) => ({ ...current, [ns]: outcome.value }))
      discard(ns)
      return
    }
    // 失败保留草稿：用户改的东西不能因为一次失败就没了。
    setError(
      outcome.code === 'settings/conflict'
        ? '配置已被别处改动，已重新读取。请核对下面的值后再保存。'
        : `写入被拒绝：${outcome.message}`,
    )
    await refreshViews()
    // 重读之后把设栅推到新 revision：用户已经看到了刷新后的值，再存一次是他明确的意思。
    setDrafts((current) => {
      const held = current[ns]
      return held === undefined ? current : { ...current, [ns]: { ...held, revision: viewsRef.current[ns]?.revision ?? held.revision } }
    })
  }

  const list = plugins ?? []
  const toggleable = list.filter((p) => p.toggleable)
  const allEnabled = toggleable.length > 0 && toggleable.every((p) => p.enabled)
  const filtered =
    query.trim() === ''
      ? list
      : list.filter((p) =>
          `${p.name} ${p.id} ${p.description}`.toLowerCase().includes(query.trim().toLowerCase()),
        )

  const toggleAll = () => {
    const target = !allEnabled
    const ids = toggleable.map((p) => p.id)
    setBusy('all')
    setError(null)
    Promise.all(
      toggleable.map((p) =>
        p.enabled === target
          ? Promise.resolve()
          : fetch('/void/api/toggle', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pluginId: p.id, enabled: target }),
            }).then(async (r) => {
              if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? `HTTP ${r.status}`)
            }),
      ),
    )
      .then(() => applyEnabled(ids, target))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null))
  }

  return h('div', { 'data-void-entry': '', style: { display: 'flex', flexDirection: 'column' } },
    // ── 状态条：计数 + 整套开关，压成一行，把纵向空间让给配置 ─────────────
    h('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        paddingBottom: 12,
        borderBottom: `1px solid ${BORDER}`,
        marginBottom: 12,
      },
    },
      h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 } },
        h(StateDot, {
          state: plugins === null ? 'ongoing' : list.length > 0 ? 'done' : 'idle',
          size: 8,
        }),
        h('span', null, plugins === null ? '正在读取…' : `${list.length} 个插件已安装`),
      ),
      h('span', { style: { flex: 1 } }),
      list.length > 0
        ? h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 } },
            h('span', { style: { color: TEXT_SECONDARY } }, allEnabled ? '整套已开启' : '整套已关闭'),
            h(Switch, {
              checked: allEnabled,
              disabled: busy === 'all' || toggleable.length === 0,
              label: '整套开关',
              onChange: toggleAll,
            }),
          )
        : null,
    ),

    list.length > 1
      ? h('div', { style: { marginBottom: 12 } },
          h(Input, {
            icon: h(IconSearchOutline16, { size: 16 }),
            placeholder: '搜索插件…',
            value: query,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value),
          }),
        )
      : null,

    plugins === null
      ? h(EmptyHint, { text: '正在读取当前 profile 的 Void 插件…' })
      : list.length === 0
        ? h(EmptyHint, {
            text: '当前 profile 还没有安装任何 Void 插件。用 dsh plugin add 安装后会出现在这里。',
          })
        : filtered.length === 0
          ? h(EmptyHint, { text: `没有匹配「${query}」的插件。` })
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              ...filtered.map((plugin) =>
                h(PluginCard, {
                  key: plugin.id,
                  plugin,
                  manifest: manifests[plugin.id],
                  view: manifests[plugin.id] ? views[manifests[plugin.id]!.namespace] : undefined,
                  busy,
                  open: openPlugin === plugin.id,
                  openGroup: openPlugin === plugin.id ? openGroup : null,
                  onToggleOpen: () => {
                    setOpenPlugin(openPlugin === plugin.id ? null : plugin.id)
                    setOpenGroup(null)
                  },
                  onToggleGroup: (gid: string) => setOpenGroup(openGroup === gid ? null : gid),
                  onToggleEnabled: (next: boolean) => toggle(plugin.id, next),
                  draft: manifests[plugin.id] ? drafts[manifests[plugin.id]!.namespace] : undefined,
                  onEdit: (path, value) => edit(manifests[plugin.id]!.namespace, path, value),
                  onSave: () => void save(manifests[plugin.id]!.namespace),
                  onDiscard: () => discard(manifests[plugin.id]!.namespace),
                }),
              ),
            ),

    error
      ? h('div', { style: { marginTop: 12 } }, h(Hint, { text: error, tone: 'danger' }))
      : null,
  )
}

/**
 * 插件卡片：折叠态显示 名称 + 包名 + 状态点 + 开关；展开后是该插件的配置分组。
 *
 * 两个关键取舍：
 * - **名字只渲染一次**。`DisclosureRow` 自带的 `title` 已经是插件名，附加信息
 *   （包名、状态点、开关）放在 `collapsedContent` 里，不要再重复名字。
 * - **开关必须常驻**。`collapsedContent` 默认只在收起时显示，开关会随展开一起
 *   消失——而开关插件是最常见的动作。用 `keepContentWhenOpen` 让两种状态都在。
 */
function PluginCard(props: {
  plugin: PluginState
  manifest: PanelManifest | undefined
  view: NamespaceView | undefined
  busy: string | null
  open: boolean
  openGroup: string | null
  onToggleOpen: () => void
  onToggleGroup: (id: string) => void
  onToggleEnabled: (next: boolean) => void
  /** 该命名空间的未保存改动。 */
  draft: Draft | undefined
  onEdit: (path: readonly string[], value: unknown) => void
  onSave: () => void
  onDiscard: () => void
}): React.ReactElement {
  const { plugin, manifest, view, busy, open, openGroup, draft } = props
  const blockers = saveBlockers(draft, manifestWidgets(manifest ? { [plugin.id]: manifest } : {}, manifest?.namespace ?? ''))
  const dirty = draft !== undefined && Object.keys(draft.values).length > 0
  const groups = manifest?.groups ?? []
  const expandable = groups.length > 0

  // DisclosureRow 的行高是固定的 24px chrome，所以 extras 必须是**单行**：把包名与
  // 状态点、开关挤在一行，说明文字下沉到正文——塞两行会被行高裁掉。
  const extras = h('span', {
    style: { display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, marginLeft: 8 },
  },
    h('code', {
      style: {
        fontSize: 11,
        color: TEXT_SECONDARY,
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
    }, plugin.id),
    h(StateDot, { state: plugin.enabled ? 'done' : 'idle', size: 8 }),
    plugin.toggleable
      ? h(Switch, {
          checked: plugin.enabled,
          disabled: busy === plugin.id,
          label: `${plugin.name} 开关`,
          onChange: props.onToggleEnabled,
        })
      : h('span', { style: { fontSize: 12, color: TEXT_SECONDARY, whiteSpace: 'nowrap' } }, '不可关闭'),
  )

  // 保存条常驻在卡片正文顶部：改动只落在草稿里，不给一个显眼的保存入口等于让用户以为
  // 改丢了。有阻塞项时保存禁用并说明原因——「字段不接受的草稿会阻塞保存，而不是被丢弃」。
  const saveBar = dirty
    ? h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          margin: '0 0 8px 24px',
          padding: '6px 10px',
          borderRadius: 8,
          background: WARN_SURFACE,
          border: `1px solid ${WARN}`,
        },
      },
        h(StateDot, { state: 'warning', size: 8 }),
        h('span', { style: { fontSize: 12, flex: 1, minWidth: 0 } },
          blockers.length > 0 ? blockers.join(' ') : '有未保存的改动。'),
        h(Button, { variant: 'ghost', size: 'sm', disabled: busy !== null, onClick: props.onDiscard }, '放弃'),
        h(Button, {
          variant: 'primary',
          size: 'sm',
          disabled: busy !== null || blockers.length > 0,
          onClick: props.onSave,
        }, busy === `${manifest?.namespace}:save` ? '保存中…' : '保存'),
      )
    : null

  const body = expandable
    ? h('div', { style: { display: 'flex', flexDirection: 'column' } },
        plugin.description
          ? h('div', { style: { fontSize: 12, color: TEXT_SECONDARY, padding: '0 0 6px 24px' } }, plugin.description)
          : null,
        saveBar,
        ...groups.map((group) =>
          h(Group, {
            key: group.id,
            title: group.title,
            summary: group.summary ?? summarize(manifest!, view, group.id),
            open: openGroup === group.id,
            onToggle: () => props.onToggleGroup(group.id),
          },
            // 警示行放在分组**最上面**：这类内容要在用户动手之前看到，滚到底才出现就晚了。
            group.notice ? h(Hint, { text: group.notice, tone: 'danger' }) : null,
            ...group.fields.map((field) =>
              h(FieldControl, {
                key: field.path.join('.'),
                field,
                view,
                manifest: manifest!,
                busy,
                draft,
                onEdit: props.onEdit,
              }),
            ),
            group.block === 'connect' && manifest?.connect
              ? h(ConnectBlock, {
                  path: manifest.connect.path,
                  transport: manifest.connect.transport,
                  // 调用方列表也读草稿：用户刚加的一行没保存时，配置片段里就该出现它。
                  callers: Array.isArray(shownValue(view?.value, draft, ['tokens']))
                    ? (shownValue(view?.value, draft, ['tokens']) as TokenRow[])
                    : [],
                })
              : null,
          ),
        ),
      )
    : h('div', { style: { fontSize: 12, color: TEXT_SECONDARY, padding: '4px 0 4px 24px' } },
        plugin.description || '这个插件没有可配置项。')

  return h('div', {
    style: { border: `1px solid ${BORDER}`, borderRadius: 10, overflow: 'hidden' },
  },
    h(DisclosureRow, {
      icon: h(IconCordisPluginOutline14, { size: 14 }),
      title: plugin.name,
      // 卡片标题加粗，与分组标题一致——两级标题都靠这张注入的样式表。
      titleClassName: ROW_TITLE_CLASS,
      open,
      expandable,
      expandOnRowClick: true,
      keepContentWhenOpen: true,
      onToggle: props.onToggleOpen,
      collapsedContent: extras,
    }, body),
  )
}

/**
 * 按清单提示（缺省时按 schema 类型）渲染一个字段。
 *
 * `readOnly` 字段只展示当前值并说明它由组合入口决定——绝不渲染成可编辑控件，否则
 * 用户会改一个写了不生效的东西，那是最糟的面板 bug，因为它看起来像是成功了。
 */
function FieldControl(props: {
  field: PanelField
  view: NamespaceView | undefined
  manifest: PanelManifest
  busy: string | null
  /** 该命名空间的未保存改动；字段展示时草稿优先。 */
  draft: Draft | undefined
  onEdit: (path: readonly string[], value: unknown) => void
}): React.ReactElement {
  const { field, view, draft } = props
  // 运行时字段（启用/路径/账本/传输）不在设置命名空间里，只能从清单读；它们一律只读，
  // 不参与草稿。
  const value =
    field.source === 'runtime'
      ? readPath(props.manifest.runtime, field.path)
      : shownValue(view?.value, draft, field.path)
  const label = field.label ?? field.path[field.path.length - 1]!
  // 「已自定义」说的是服务端解析结果里有这一层；「已修改」说的是草稿里有。两者不同：
  // 前者表示这个值不再来自默认，后者表示这次改动还没保存。
  const overridden = view === undefined ? false : isOverridden(view, field.path)
  const dirty = isDirty(draft, field.path)
  const node = view === undefined ? undefined : nodeAt(view.schema, field.path)
  const widget = field.widget ?? inferWidget(node, value)
  const disabled = field.source === 'runtime' ? true : view === undefined || props.busy !== null
  const set = (next: unknown) => props.onEdit(field.path, next)

  if (field.readOnly === true) {
    return h('div', { style: { padding: '6px 0 6px 24px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h('span', { style: { fontSize: 13 } }, label),
        h('span', {
          style: { fontSize: 11, color: TEXT_SECONDARY, border: `1px solid ${TEXT_SECONDARY}`, borderRadius: 4, padding: '0 4px' },
        }, '只读'),
        // 字符串直接显示，不要 JSON.stringify——那会把 path 渲染成 "/mcp/x"（带引号），
        // 看起来像值里真有引号。只有数组/对象这类需要界定边界的值才用 JSON。
        h('code', { style: { fontSize: 12 } }, readonlyText(value)),
      ),
      field.help ? h('div', { style: { fontSize: 11, color: TEXT_SECONDARY, marginTop: 4 } }, field.help) : null,
    )
  }

  switch (widget) {
    case 'switch': {
      const on = value === true
      // 危险开关只拦「打开」这一个方向：关掉它是收紧权限，再拦一次纯属打扰。
      if (field.danger === true && !on) {
        return h(DangerSwitch, {
          label,
          help: field.help,
          overridden,
          dirty,
          disabled,
          onConfirm: () => void set(true),
        })
      }
      return h(SwitchField, {
        label,
        help: field.help,
        value: on,
        overridden,
        dirty,
        disabled,
        onChange: (next) => void set(next),
      })
    }
    case 'choices':
      return h(ChoicesField, {
        label,
        help: field.help,
        value: Array.isArray(value) ? (value as string[]) : [],
        options: field.options ?? [],
        overridden,
        dirty,
        onChange: (next) => void set(next),
      })
    case 'rules':
      return h(RulesField, {
        label,
        help: field.help,
        value: Array.isArray(value) ? (value as DocumentRuleRow[]) : [],
        overridden,
        dirty,
        onChange: (next) => void set(next),
      })
    case 'patterns':
      return h(PatternListField, {
        label,
        help: field.help,
        value: Array.isArray(value) ? (value as string[]) : [],
        overridden,
        dirty,
        onChange: (next) => void set(next),
      })
    case 'number':
      return h(NumberField, {
        label,
        help: field.help,
        value: typeof value === 'number' ? value : 0,
        overridden,
        dirty,
        onChange: (next) => void set(next),
      })
    case 'operations':
      return h(OperationsField, {
        label,
        help: field.help,
        value: Array.isArray(value) ? (value as string[]) : [],
        vocabulary: props.manifest.operations ?? [],
        overridden,
        dirty,
        onChange: (next) => void set(next),
      })
    case 'tokens':
      return h(TokensField, {
        label,
        help: field.help,
        value: Array.isArray(value) ? (value as TokenRow[]) : [],
        vocabulary: props.manifest.operations ?? [],
        overridden,
        dirty,
        onChange: (next) => void set(next),
      })
    case 'list':
      return h(ListField, {
        label,
        help: field.help,
        value: Array.isArray(value) ? (value as string[]) : [],
        overridden,
        dirty,
        onChange: (next) => void set(next),
      })
    case 'object':
      // 没有专用控件的对象（如任务文档要求）先只读展示，避免渲染出一个改不动的表单。
      return h('div', { style: { padding: '6px 0 6px 24px' } },
        h('div', { style: { fontSize: 13 } }, label),
        h('pre', {
          style: { fontSize: 11, color: TEXT_SECONDARY, whiteSpace: 'pre-wrap', margin: '4px 0 0' },
        }, JSON.stringify(value, null, 2)),
        field.help ? h('div', { style: { fontSize: 11, color: TEXT_SECONDARY, marginTop: 4 } }, field.help) : null,
      )
    default:
      return h(TextField, {
        label,
        help: field.help,
        value: typeof value === 'string' ? value : '',
        overridden,
        dirty,
        multiline: Array.isArray(value) === false && typeof value === 'string' && value.length > 60,
        onChange: (next) => void set(next),
      })
  }
}

/** 空态/加载态的统一呈现。 */
/**
 * 字段路径键 → 清单里的控件类型。
 *
 * 保存路径要靠它决定怎么规整值（空行怎么算），而不是去猜路径名的含义——哪个字段是
 * 数组、元素长什么样，是清单说了算。
 *
 * @param manifests - 包名 → 清单。
 * @param ns - 命名空间。
 * @returns 路径键到控件类型的映射。
 */
function manifestWidgets(manifests: Record<string, PanelManifest>, ns: string): Record<string, string | undefined> {
  const manifest = Object.values(manifests).find((m) => m.namespace === ns)
  const out: Record<string, string | undefined> = {}
  for (const group of manifest?.groups ?? []) {
    for (const field of group.fields) out[field.path.join('.')] = field.widget
  }
  return out
}
function EmptyHint(props: { text: string }): React.ReactElement {
  return h('div', {
    style: { display: 'flex', alignItems: 'center', gap: 10, padding: '20px 4px', color: TEXT_SECONDARY, fontSize: 13 },
  },
    h(IconQuestionOutline14, { size: 14 }),
    h('span', null, props.text),
  )
}

/**
 * 危险开关：打开前先过一道二次确认。
 *
 * 用宿主的 `RiskConfirmation`——它要求用户**主动勾选**「我已了解」才让主按钮可用，
 * 这比一个「确定/取消」弹窗更难误点。文案由这里给，宿主不内置。
 */
function DangerSwitch(props: {
  label: string
  help?: string
  overridden?: boolean
  /** 有未保存的改动。 */
  dirty?: boolean
  disabled?: boolean
  onConfirm: () => void
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  return h('div', null,
    h(SwitchField, {
      label: props.label,
      help: props.help,
      value: false,
      overridden: props.overridden,
      dirty: props.dirty,
      disabled: props.disabled,
      // 开关本身不直接写回：先弹确认，确认后才提交。
      onChange: () => {
        setAcknowledged(false)
        setOpen(true)
      },
    }),
    h(RiskConfirmation, {
      open,
      title: `确认开启「${props.label}」`,
      // 正文就是字段说明本身——两处各写一段会读起来像重复。
      description: props.help ?? '',
      acknowledgeLabel: '我已了解风险，确认开启',
      cancelLabel: '取消',
      closeLabel: '关闭',
      confirmLabel: '开启',
      acknowledged,
      onAcknowledgedChange: setAcknowledged,
      onCancel: () => setOpen(false),
      onConfirm: () => {
        setOpen(false)
        props.onConfirm()
      },
    }),
  )
}