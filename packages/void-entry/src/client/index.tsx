import { createElement as h, useCallback, useEffect, useState } from 'react'
import type { Context } from './context-types.ts'
import { createVoidWidgetsService } from './widgets.js'
import {
  DisclosureRow,
  IconCordisPluginOutline14,
  IconQuestionOutline14,
  IconSearchOutline16,
  Input,
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
import {
  Group,
  Hint,
  ListField,
  NumberField,
  OperationsField,
  SwitchField,
  TextField,
  TokensField,
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

const MUTED = '#888'

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
  help?: string
  danger?: boolean
  readOnly?: boolean
}

interface PanelManifest {
  namespace: string
  groups: Array<{ id: string; title: string; summary?: string; fields: PanelField[] }>
  operations?: OperationEntry[]
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

  /**
   * 写回一组字段。
   *
   * 乐观更新 + 冲突重读：服务端用 `expectedRevision` 拒绝陈旧编辑器，被拒时说明
   * 别处改过配置，此时**必须重新读取再让用户重试**，而不是重试写入——否则就把
   * 别人的改动盖掉了。
   */
  const commit = async (ns: string, ops: PathOp[]) => {
    const view = views[ns]
    if (view === undefined) return
    setBusy(`${ns}:${ops.map((op) => op.path.join('.')).join(',')}`)
    setError(null)
    const outcome = await mutateNamespace(ns, ops, view.revision)
    setBusy(null)
    if (outcome.ok) {
      setViews((current) => ({ ...current, [ns]: outcome.value }))
      return
    }
    setError(
      outcome.code === 'settings/conflict'
        ? '配置已被别处改动，已重新读取；请确认后重试。'
        : `写入被拒绝：${outcome.message}`,
    )
    await refreshViews()
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
        borderBottom: '1px solid rgba(128,128,128,0.18)',
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
            h('span', { style: { color: MUTED } }, allEnabled ? '整套已开启' : '整套已关闭'),
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
                  onCommit: commit,
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
  onCommit: (ns: string, ops: PathOp[]) => Promise<void>
}): React.ReactElement {
  const { plugin, manifest, view, busy, open, openGroup } = props
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
        color: MUTED,
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
      : h('span', { style: { fontSize: 12, color: MUTED, whiteSpace: 'nowrap' } }, '不可关闭'),
  )

  const body = expandable
    ? h('div', { style: { display: 'flex', flexDirection: 'column' } },
        plugin.description
          ? h('div', { style: { fontSize: 12, color: MUTED, padding: '0 0 6px 24px' } }, plugin.description)
          : null,
        ...groups.map((group) =>
          h(Group, {
            key: group.id,
            title: group.title,
            summary: group.summary ?? summarize(manifest!, view, group.id),
            open: openGroup === group.id,
            onToggle: () => props.onToggleGroup(group.id),
          },
            ...group.fields.map((field) =>
              h(FieldControl, {
                key: field.path.join('.'),
                field,
                view,
                manifest: manifest!,
                busy,
                onCommit: (ops) => props.onCommit(manifest!.namespace, ops),
              }),
            ),
          ),
        ),
      )
    : h('div', { style: { fontSize: 12, color: MUTED, padding: '4px 0 4px 24px' } },
        plugin.description || '这个插件没有可配置项。')

  return h('div', {
    style: { border: '1px solid rgba(128,128,128,0.18)', borderRadius: 10, overflow: 'hidden' },
  },
    h(DisclosureRow, {
      icon: h(IconCordisPluginOutline14, { size: 14 }),
      title: plugin.name,
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
  onCommit: (ops: PathOp[]) => Promise<void>
}): React.ReactElement {
  const { field, view } = props
  const value = view === undefined ? undefined : readPath(view.value, field.path)
  const label = field.label ?? field.path[field.path.length - 1]!
  const overridden = view === undefined ? false : isOverridden(view, field.path)
  const node = view === undefined ? undefined : nodeAt(view.schema, field.path)
  const widget = field.widget ?? inferWidget(node, value)
  const disabled = view === undefined || props.busy !== null
  const set = (next: unknown) => props.onCommit([{ op: 'set', path: field.path, value: next }])

  if (field.readOnly === true) {
    return h('div', { style: { padding: '6px 0 6px 24px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h('span', { style: { fontSize: 13 } }, label),
        h('span', {
          style: { fontSize: 11, color: MUTED, border: `1px solid ${MUTED}`, borderRadius: 4, padding: '0 4px' },
        }, '只读'),
        h('code', { style: { fontSize: 12 } }, value === undefined ? '—' : JSON.stringify(value)),
      ),
      field.help ? h('div', { style: { fontSize: 11, color: MUTED, marginTop: 4 } }, field.help) : null,
    )
  }

  switch (widget) {
    case 'switch':
      return h(SwitchField, {
        label,
        help: field.help,
        value: value === true,
        overridden,
        disabled,
        onChange: (next) => void set(next),
      })
    case 'number':
      return h(NumberField, {
        label,
        help: field.help,
        value: typeof value === 'number' ? value : 0,
        overridden,
        onChange: (next) => void set(next),
      })
    case 'operations':
      return h(OperationsField, {
        label,
        help: field.help,
        value: Array.isArray(value) ? (value as string[]) : [],
        vocabulary: props.manifest.operations ?? [],
        overridden,
        onChange: (next) => void set(next),
      })
    case 'tokens':
      return h(TokensField, {
        label,
        help: field.help,
        value: Array.isArray(value) ? (value as TokenRow[]) : [],
        vocabulary: props.manifest.operations ?? [],
        overridden,
        onChange: (next) => void set(next),
      })
    case 'list':
      return h(ListField, {
        label,
        help: field.help,
        value: Array.isArray(value) ? (value as string[]) : [],
        overridden,
        onChange: (next) => void set(next),
      })
    case 'object':
      // 没有专用控件的对象（如任务文档要求）先只读展示，避免渲染出一个改不动的表单。
      return h('div', { style: { padding: '6px 0 6px 24px' } },
        h('div', { style: { fontSize: 13 } }, label),
        h('pre', {
          style: { fontSize: 11, color: MUTED, whiteSpace: 'pre-wrap', margin: '4px 0 0' },
        }, JSON.stringify(value, null, 2)),
        field.help ? h('div', { style: { fontSize: 11, color: MUTED, marginTop: 4 } }, field.help) : null,
      )
    default:
      return h(TextField, {
        label,
        help: field.help,
        value: typeof value === 'string' ? value : '',
        overridden,
        multiline: Array.isArray(value) === false && typeof value === 'string' && value.length > 60,
        onChange: (next) => void set(next),
      })
  }
}

/** 空态/加载态的统一呈现。 */
function EmptyHint(props: { text: string }): React.ReactElement {
  return h('div', {
    style: { display: 'flex', alignItems: 'center', gap: 10, padding: '20px 4px', color: MUTED, fontSize: 13 },
  },
    h(IconQuestionOutline14, { size: 14 }),
    h('span', null, props.text),
  )
}
