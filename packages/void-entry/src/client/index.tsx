import { createElement, useEffect, useState } from 'react'
import type { Context } from './context-types.ts'

export const inject = ['slots']

interface PluginState {
  id: string
  name: string
  description: string
  enabled: boolean
  toggleable: boolean
}

/**
 * Client half：把「Void 套装」入口挂进 DSH 设置 shell 的 settings.section slot，
 * 渲染各插件的独立开关 + 一键整套开关，经 /void/api/* 路由读写 host 侧状态。
 */
export function apply(ctx: Context): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'void-entry',
    order: 100,
    label: () => 'Void 套装',
  }, VoidSection))
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
