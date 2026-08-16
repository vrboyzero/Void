import { createElement, useEffect, useState } from 'react'
import type { Context } from './context-types.ts'
import { createVoidWidgetsService } from './widgets.js'

export const inject = ['slots']

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
 * 2. 把「Void 套装」开关挂进 DSH 设置 shell 的 settings.section slot（原有）。
 *
 * 注意：widget 的可见渲染容器（组织图 / 进度视图面板）不在本轮落地——它属于壳 A
 * 完整面板，等 host voidTeam → client 的数据路由定型后，按文档 11.10「复杂 widget
 * 优先 Web Component」再实现。本轮只验证「树外插件能暴露 ctx.* 服务 + 类型合并 +
 * 返回 disposer 的注册 API」这条 P1 关键路径。
 */
export function apply(ctx: Context): void {
  // 服务化扩展点：先于一切 UI 发布。
  ctx.provide('voidWidgets', createVoidWidgetsService());

  // 设置页开关（原有，保持不回归）。
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'void-entry',
    order: 100,
    label: () => 'Void 套装',
  }, VoidSection));
}

function VoidSection(): React.ReactNode {
  const [plugins, setPlugins] = useState<PluginState[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/void/api/status')
      .then((r) => r.json())
      .then((d: { plugins?: PluginState[] }) => { if (!cancelled) setPlugins(d.plugins ?? []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const toggle = (id: string, enabled: boolean) => {
    setBusy(id)
    fetch('/void/api/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pluginId: id, enabled }),
    })
      .then((r) => r.json())
      .then(() => setPlugins((ps) => ps.map((p) => (p.id === id ? { ...p, enabled } : p))))
      .catch(() => {})
      .finally(() => setBusy(null))
  }

  const toggleable = plugins.filter((p) => p.toggleable)
  const allEnabled = toggleable.length > 0 && toggleable.every((p) => p.enabled)

  const toggleAll = () => {
    const target = !allEnabled
    setBusy('all')
    Promise.all(toggleable.map((p) => p.enabled === target
      ? Promise.resolve()
      : fetch('/void/api/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pluginId: p.id, enabled: target }),
        })))
      .then(() => setPlugins((ps) => ps.map((p) => (p.toggleable ? { ...p, enabled: target } : p))))
      .catch(() => {})
      .finally(() => setBusy(null))
  }

  return createElement('div', { 'data-void-entry': '' },
    createElement('h3', null, 'Void 套装'),
    createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 } },
      createElement('input', {
        type: 'checkbox',
        checked: allEnabled,
        disabled: busy === 'all' || toggleable.length === 0,
        onChange: toggleAll,
      }),
      createElement('strong', null, allEnabled ? '整套已开启' : '整套已关闭'),
    ),
    ...plugins.map((plugin) => createElement('div', { key: plugin.id, style: { display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0' } },
      createElement('input', {
        type: 'checkbox',
        checked: plugin.enabled,
        disabled: !plugin.toggleable || busy === plugin.id,
        onChange: () => toggle(plugin.id, !plugin.enabled),
      }),
      createElement('span', null,
        createElement('strong', null, plugin.name),
        createElement('span', { style: { color: '#666' } }, ` — ${plugin.description}`),
      ),
    )),
  )
}
