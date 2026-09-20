import { createElement, useEffect, useState } from 'react'
import type { Context } from './context-types.ts'
import { createVoidWidgetsService } from './widgets.js'

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
 * 注意：widget 的可见渲染容器（组织图 / 进度视图面板）不在本轮落地——它属于壳 A
 * 完整面板，等 host voidTeam → client 的数据路由定型后，按文档 11.10「复杂 widget
 * 优先 Web Component」再实现。本轮只验证「树外插件能暴露 ctx.* 服务 + 类型合并 +
 * 返回 disposer 的注册 API」这条 P1 关键路径。
 */
export function apply(ctx: Context): void {
  // 服务化扩展点：先于一切 UI 发布。
  ctx.provide('voidWidgets', createVoidWidgetsService())

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

  useEffect(() => {
    let cancelled = false
    fetch('/void/api/status')
      .then((r) => r.json())
      .then((d: { plugins?: PluginState[] }) => {
        if (!cancelled) setPlugins(d.plugins ?? [])
      })
      .catch(() => {
        // 读不到就把目录当成空的，而不是无限 loading——用户至少能看到提示。
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

  return createElement('div', { 'data-void-entry': '' },
    createElement('h3', { style: { margin: '0 0 4px' } }, SECTION_LABEL),
    createElement('p', { style: { color: '#888', margin: '0 0 16px', fontSize: 13 } },
      '这里汇总当前 profile 里已安装的 Void 插件。开关立刻生效，但只在本次运行期间有效——重启 dsh 后会恢复；要永久关闭请改 profile 的 cordis.patch.yml。'),

    plugins === null
      ? createElement('p', { style: { color: '#888' } }, '正在读取…')
      : list.length === 0
        ? createElement('p', { style: { color: '#888' } },
            '当前 profile 还没有安装任何 Void 插件。用 dsh plugin add 安装后会出现在这里。')
        : createElement('div', null,
            createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 } },
              createElement('input', {
                type: 'checkbox',
                checked: allEnabled,
                disabled: busy === 'all' || toggleable.length === 0,
                onChange: toggleAll,
              }),
              createElement('strong', null, allEnabled ? '整套已开启' : '整套已关闭'),
            ),
            ...list.map((plugin) => createElement('div', {
              key: plugin.id,
              style: { display: 'flex', alignItems: 'flex-start', gap: 8, margin: '8px 0' },
            },
              createElement('input', {
                type: 'checkbox',
                checked: plugin.enabled,
                disabled: !plugin.toggleable || busy === plugin.id,
                onChange: () => toggle(plugin.id, !plugin.enabled),
                style: { marginTop: 3 },
              }),
              createElement('span', null,
                createElement('strong', null, plugin.name),
                createElement('span', { style: { color: '#888', marginLeft: 8, fontSize: 12 } }, plugin.id),
                plugin.description
                  ? createElement('div', { style: { color: '#888', fontSize: 12, marginTop: 2 } }, plugin.description)
                  : null,
              ),
            )),
          ),

    error ? createElement('p', { style: { color: '#d33', marginTop: 12 } }, `操作失败：${error}`) : null,
  )
}
