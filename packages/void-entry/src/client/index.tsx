import { createElement as h, useEffect, useState } from 'react'
import type { Context } from './context-types.ts'
import { createVoidWidgetsService } from './widgets.js'
import {
  DisclosureRow,
  IconCordisPluginOutline14,
  IconQuestionOutline14,
  IconSearchOutline16,
  IconSettingsOutline16,
  Input,
  StateDot,
  Switch,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { PRIMITIVE_GAPS } from './primitives-probe.js'

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

/** 卡片内的配置分组。P1 只渲染骨架与摘要占位，P3 接真数据。 */
interface ConfigGroup {
  id: string
  title: string
  /** 折叠态显示的一行摘要。 */
  summary: string
  /** 展开后是否已有内容；false 显示「待接入」。 */
  ready: boolean
}

/**
 * P1 的分组骨架。分组名与方案 §29.4 的配置项落位表一致；P3 由 host 半边的
 * `/void/api/panels` 下发真实清单替换这里。
 */
function placeholderGroups(plugin: PluginState): ConfigGroup[] {
  // 只有真正的功能插件才有可配项；入口自身没有配置。
  if (!plugin.toggleable) return []
  return [
    { id: 'basic', title: '基本', summary: '启用状态 · 端点路径 · 账本后端', ready: false },
    { id: 'permissions', title: '权限', summary: '允许对方办哪些业务', ready: false },
    { id: 'callers', title: '调用方', summary: '凭据与环境变量名', ready: false },
    { id: 'workspaces', title: '工作区根目录', summary: '允许按路径寻址的目录', ready: false },
    { id: 'requirements', title: '任务要求', summary: '必填字段 · 文档要求 · 禁用正则', ready: false },
    { id: 'callback', title: '回调通知', summary: '未启用', ready: false },
    { id: 'advanced', title: '高级', summary: '传输方式 · 规则版本号', ready: false },
  ]
}

function dotFor(plugin: PluginState): StateDotState {
  return plugin.enabled ? 'done' : 'idle'
}

/**
 * Client half：壳 A 的薄 UI 入口。
 *
 * 1. 发布 `ctx.voidWidgets` 服务（借鉴 dsh-better-sidebar 的 `ctx.betterSidebar`：
 *    在挂载任何 panel 之前 `ctx.provide`，消费者 `inject = ["voidWidgets"]` 时已就绪）。
 *    这是壳 A 的服务化扩展点：void-legion 组织图 / 各插件进度视图通过
 *    `ctx.voidWidgets.registerWidget(...)` 注册，与内置 widget 能力对等。
 * 2. 把「虚空（Void）」目录挂进 DSH 设置 shell 的 settings.section slot。
 *
 * 目录的成员**由 host 半边扫描 loader 得出**，client 只负责渲染与调开关接口；
 * 因此新装一个 `@void/*` 插件就会自动出现在这里，不需要改这一侧。
 *
 * 布局目标（方案 §29.3）：给具体功能插件的配置留出纵深——总开关压进状态条，每个插件
 * 一张可折叠卡片，卡片内按语义分组，折叠时也显示摘要。
 */
export function apply(ctx: Context): void {
  // 服务化扩展点：先于一切 UI 发布。
  ctx.provide('voidWidgets', createVoidWidgetsService())

  if (PRIMITIVE_GAPS.length > 0) {
    // 宿主原语缺失（旧版 dsh）：不致命——面板会回退到手写 HTML，仍然可用。
    // 只提示，不阻断注册。
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

function VoidSection(): React.ReactNode {
  const [plugins, setPlugins] = useState<PluginState[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // 展开的插件卡片；默认展开第一个可开关的插件，让用户一进来就看到内容。
  const [openPlugin, setOpenPlugin] = useState<string | null>(null)
  const [openGroup, setOpenGroup] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/void/api/status')
      .then((r) => r.json())
      .then((d: { plugins?: PluginState[] }) => {
        if (cancelled) return
        const list = d.plugins ?? []
        setPlugins(list)
        setOpenPlugin(list.find((p) => p.toggleable)?.id ?? null)
      })
      .catch(() => {
        // 读不到就当空目录，而不是无限 loading——用户至少能看到提示。
        if (!cancelled) setPlugins([])
      })
    return () => {
      cancelled = true
    }
  }, [])

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
            h('span', { style: { color: '#888' } }, allEnabled ? '整套已开启' : '整套已关闭'),
            h(Switch, {
              checked: allEnabled,
              disabled: busy === 'all' || toggleable.length === 0,
              label: '整套开关',
              onChange: toggleAll,
            }),
          )
        : null,
    ),

    // ── 搜索（插件多起来以后才有意义，P1 先接上） ─────────────────────────
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

    // ── 三态 ─────────────────────────────────────────────────────────────
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
                  busy: busy === plugin.id,
                  open: openPlugin === plugin.id,
                  openGroup: openPlugin === plugin.id ? openGroup : null,
                  onToggleOpen: () => {
                    setOpenPlugin(openPlugin === plugin.id ? null : plugin.id)
                    setOpenGroup(null)
                  },
                  onToggleGroup: (gid: string) => setOpenGroup(openGroup === gid ? null : gid),
                  onToggleEnabled: (next: boolean) => toggle(plugin.id, next),
                }),
              ),
            ),

    error
      ? h('p', { style: { color: '#d33', marginTop: 12, fontSize: 13 } }, `操作失败：${error}`)
      : null,
  )
}

/**
 * 插件卡片：折叠态显示 名称 + 包名 + 状态点 + 开关；展开后是该插件的配置分组。
 *
 * 两个关键取舍：
 * - **名字只渲染一次**。`DisclosureRow` 自带的 `title` 已经是插件名，附加信息（包名、
 *   说明、状态点、开关）放在 `collapsedContent` 里，不要再重复一遍名字，否则折叠态会
 *   两处叠在同一行上。
 * - **开关必须常驻**。`collapsedContent` 默认只在收起时显示，开关会随展开一起消失——
 *   而开关插件是最常见的动作。用 `keepContentWhenOpen` 让它两种状态都在。
 */
function PluginCard(props: {
  plugin: PluginState
  busy: boolean
  open: boolean
  openGroup: string | null
  onToggleOpen: () => void
  onToggleGroup: (id: string) => void
  onToggleEnabled: (next: boolean) => void
}): React.ReactNode {
  const { plugin, busy, open, openGroup } = props
  const groups = placeholderGroups(plugin)
  const expandable = groups.length > 0

  // DisclosureRow 的行高是固定的 24px chrome，所以 extras 必须是**单行**：把包名与
  // 状态点、开关挤在一行，说明文字下沉到正文（展开时可见）——塞两行会被行高裁掉。
  const extras = h('span', {
    style: { display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, marginLeft: 8 },
  },
    h('code', {
      style: {
        fontSize: 11,
        color: '#888',
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
    }, plugin.id),
    h(StateDot, { state: dotFor(plugin), size: 8 }),
    plugin.toggleable
      ? h(Switch, {
          checked: plugin.enabled,
          disabled: busy,
          label: `${plugin.name} 开关`,
          onChange: props.onToggleEnabled,
        })
      : h('span', { style: { fontSize: 12, color: '#888', whiteSpace: 'nowrap' } }, '不可关闭'),
  )

  const body = expandable
    ? h('div', { style: { display: 'flex', flexDirection: 'column' } },
        plugin.description
          ? h('div', { style: { fontSize: 12, color: '#888', padding: '0 0 6px 24px' } }, plugin.description)
          : null,
        ...groups.map((group) =>
          h(GroupRow, {
            key: group.id,
            group,
            open: openGroup === group.id,
            onToggle: () => props.onToggleGroup(group.id),
          }),
        ),
      )
    : h('div', { style: { fontSize: 12, color: '#888', padding: '4px 0 4px 24px' } },
        plugin.description || '这是 Void 套装入口，没有可配置项。')

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

/** 卡片内的一个配置分组：折叠态显示摘要，展开后 P3 接真实表单。 */
function GroupRow(props: { group: ConfigGroup; open: boolean; onToggle: () => void }): React.ReactNode {
  const { group } = props
  return h(DisclosureRow, {
    icon: h(IconSettingsOutline16, { size: 16 }),
    title: group.title,
    open: props.open,
    expandable: true,
    expandOnRowClick: true,
    onToggle: props.onToggle,
    collapsedContent: h('span', { style: { fontSize: 12, color: '#888', marginLeft: 8 } }, group.summary),
  },
    group.ready
      ? null
      : h('div', { style: { fontSize: 12, color: '#888', padding: '4px 0 8px 24px' } },
          '配置表单将在下一阶段接入（方案 §29.7 P3）。'),
  )
}

/** 空态/加载态的统一呈现。 */
function EmptyHint(props: { text: string }): React.ReactNode {
  return h('div', {
    style: { display: 'flex', alignItems: 'center', gap: 10, padding: '20px 4px', color: '#888', fontSize: 13 },
  },
    h(IconQuestionOutline14, { size: 14 }),
    h('span', null, props.text),
  )
}
