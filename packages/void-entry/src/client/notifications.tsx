/**
 * 通知栏：断线补进度的那一半（§16.2 L9 第五条）。
 *
 * 为什么要有它：运行结束发生在面板没开、甚至浏览器没开的时候。宿主把终态落成持久通知，
 * 面板**重新连上就必须把它们显示出来**——只靠「打开面板时读一次运行记录」会漏掉
 * 「跑完了但没看成」这件事，而人真正想知道的就是这个。
 *
 * 补读走三条路，缺一不可：
 * 1. 挂载就读一次（刚打开面板）；
 * 2. 浏览器 `online` 或标签页重新可见时再读（**这才是「重连」**：断网、休眠、切走再回来）；
 * 3. 页面一直开着时按 15 秒轮询（人在看着面板，不该等刷新）。
 *
 * 读不到的时候**不假装没有通知**：保留上一次读到的内容，并在上方写清「这是旧的、
 * 重连后会自动补上」。把失败显示成空列表，等于告诉人「什么都没发生」。
 *
 * @module @void/void-entry/src/client/notifications
 */
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { VOID_REQUEST_HEADER } from './details.js'
import { BORDER, BORDER_SOFT, DANGER, TEXT_SECONDARY, WARN } from './theme.js'

type Result<T> = { ok: true; value: T } | { ok: false; message: string }

/** 面板需要的来源目录项（`/void/api/panels` 的 `notifications` 字段）。 */
export interface NotificationSourceManifest {
  id: string
  title: string
}

/** 一条通知（入口聚合后带上来源）。 */
export interface NotificationItem {
  id: string
  source: string
  sourceTitle: string
  title: string
  summary?: string
  at: string
  level?: 'info' | 'warn' | 'danger'
  meta?: Record<string, string>
  read?: boolean
}

/** `GET /void/api/notifications` 的响应。 */
export interface NotificationFeed {
  items: NotificationItem[]
  unread: number
  sources: NotificationSourceManifest[]
  notes: string[]
}

async function readResult<T>(response: Response): Promise<Result<T>> {
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload !== null && typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : `HTTP ${response.status}`
    return { ok: false, message }
  }
  return { ok: true, value: payload as T }
}

/** 读全部来源的通知（补读）。 */
export async function loadNotifications(): Promise<Result<NotificationFeed>> {
  const response = await fetch('/void/api/notifications', { headers: { accept: 'application/json' } })
  const outcome = await readResult<NotificationFeed>(response)
  if (!outcome.ok) return outcome
  return {
    ok: true,
    value: {
      items: outcome.value.items ?? [],
      unread: outcome.value.unread ?? 0,
      sources: outcome.value.sources ?? [],
      notes: outcome.value.notes ?? [],
    },
  }
}

/** 标记已读。回来源真正标了几条（来源算不出来时不带这个字段）。 */
export async function markNotificationsRead(
  source: string,
  ids: string[],
): Promise<Result<{ requested: number; marked?: number }>> {
  const response = await fetch('/void/api/notifications', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [VOID_REQUEST_HEADER]: '1' },
    body: JSON.stringify({ op: 'read', source, ids }),
  })
  return readResult<{ requested: number; marked?: number }>(response)
}

/** 时间给人看：解析不出来就原样显示，不显示 `Invalid Date`。 */
function timeText(at: string): string {
  const parsed = new Date(at)
  if (Number.isNaN(parsed.getTime())) return at
  return parsed.toLocaleString()
}

function levelColor(level: NotificationItem['level']): string {
  if (level === 'danger') return DANGER
  if (level === 'warn') return WARN
  return 'inherit'
}

const smallButton: React.CSSProperties = {
  border: `1px solid ${BORDER}`,
  borderRadius: 8,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 12,
  padding: '4px 12px',
}

/**
 * 通知栏。
 *
 * `sources` 为空（没有插件登记通知来源）时**整栏不画**：空的通知条只会占地方。
 */
export function VoidNotifications(props: { sources: NotificationSourceManifest[] }): React.ReactElement | null {
  const { sources } = props
  const [feed, setFeed] = useState<NotificationFeed | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [open, setOpen] = useState(true)
  // 卸载后不能再 setState：轮询回调可能在组件已经不在的时候才回来。
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    const outcome = await loadNotifications()
    if (!alive.current) return
    if (!outcome.ok) {
      setError(outcome.message)
      return
    }
    setError(null)
    setFeed(outcome.value)
  }, [])

  useEffect(() => {
    alive.current = true
    void refresh()
    const onOnline = () => void refresh()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)
    const timer = window.setInterval(() => void refresh(), 15000)
    return () => {
      alive.current = false
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
      window.clearInterval(timer)
    }
  }, [refresh])

  const markOne = useCallback(
    async (item: NotificationItem) => {
      setNotice(null)
      setBusy(`${item.source}:${item.id}`)
      const outcome = await markNotificationsRead(item.source, [item.id])
      setBusy(null)
      if (!outcome.ok) {
        setNotice(`标记已读没成功：${outcome.message}`)
        return
      }
      await refresh()
    },
    [refresh],
  )

  const markAll = useCallback(async () => {
    const unread = (feed?.items ?? []).filter((item) => item.read !== true)
    if (unread.length === 0) return
    setNotice(null)
    setBusy('all')
    const bySource = new Map<string, string[]>()
    for (const item of unread) {
      bySource.set(item.source, [...(bySource.get(item.source) ?? []), item.id])
    }
    const failures: string[] = []
    for (const [source, ids] of bySource) {
      const outcome = await markNotificationsRead(source, ids)
      if (!outcome.ok) failures.push(`${source}: ${outcome.message}`)
    }
    setBusy(null)
    if (failures.length > 0) setNotice(`有一部分没标上：${failures.join('；')}`)
    await refresh()
  }, [feed, refresh])

  if (sources.length === 0) return null

  const items = feed?.items ?? []
  const unread = feed?.unread ?? 0
  const notes = [...(feed?.notes ?? []), ...(notice === null ? [] : [notice])]

  return h(
    'div',
    {
      'data-void-notifications': '1',
      style: {
        border: `1px solid ${BORDER}`,
        borderRadius: 8,
        padding: 8,
        marginBottom: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      },
    },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
      h('span', { style: { fontSize: 12 } }, '通知'),
      h(
        'span',
        {
          'data-void-notifications-unread': String(unread),
          style: { color: unread > 0 ? WARN : TEXT_SECONDARY, fontSize: 12 },
        },
        unread > 0 ? `${unread} 条未读` : '没有未读',
      ),
      h(
        'button',
        {
          type: 'button',
          'data-void-notifications-toggle': '1',
          onClick: () => setOpen((current) => !current),
          style: smallButton,
        },
        open ? '收起' : '展开',
      ),
      unread === 0
        ? null
        : h(
            'button',
            {
              type: 'button',
              'data-void-notifications-read-all': '1',
              disabled: busy !== null,
              onClick: () => void markAll(),
              style: smallButton,
            },
            busy === 'all' ? '标记中…' : '全部标为已读',
          ),
    ),
    // 读不到就说读不到。有旧内容时说清「这是旧的」，一条都没有时说清「会自动补读」。
    error === null
      ? null
      : h(
          'div',
          { 'data-void-notifications-error': '1', style: { color: DANGER, fontSize: 12 } },
          feed === null
            ? `读不到通知：${error}。面板重新连上宿主后会自动补读。`
            : `刚刚没读到最新通知（${error}）：下面是上次读到的内容，重连后会自动补上。`,
        ),
    ...notes.map((note, index) =>
      h(
        'div',
        { key: `note-${index}`, 'data-void-notifications-note': String(index), style: { color: TEXT_SECONDARY, fontSize: 12 } },
        note,
      ),
    ),
    open
      ? h(
          'div',
          { 'data-void-notifications-list': '1', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          ...items.map((item) =>
            h(
              'div',
              {
                key: `${item.source}:${item.id}`,
                'data-void-notification': `${item.source}:${item.id}`,
                style: {
                  borderTop: `1px solid ${BORDER_SOFT}`,
                  paddingTop: 4,
                  opacity: item.read === true ? 0.75 : 1,
                },
              },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h('span', { style: { fontSize: 12, color: levelColor(item.level) } }, item.title),
                h(
                  'span',
                  { style: { color: TEXT_SECONDARY, fontSize: 12 } },
                  `${item.sourceTitle} · ${timeText(item.at)}`,
                ),
                item.read === true
                  ? null
                  : h(
                      'button',
                      {
                        type: 'button',
                        'data-void-notification-read': `${item.source}:${item.id}`,
                        disabled: busy !== null,
                        onClick: () => void markOne(item),
                        style: smallButton,
                      },
                      busy === `${item.source}:${item.id}` ? '标记中…' : '标记已读',
                    ),
              ),
              item.summary === undefined
                ? null
                : h('div', { style: { color: TEXT_SECONDARY, fontSize: 12 } }, item.summary),
              item.meta === undefined
                ? null
                : h(
                    'div',
                    { style: { color: TEXT_SECONDARY, fontSize: 12 } },
                    Object.entries(item.meta)
                      .map(([key, value]) => `${key}: ${value}`)
                      .join(' · '),
                  ),
            ),
          ),
          items.length === 0
            ? h('div', { style: { color: TEXT_SECONDARY, fontSize: 12 } }, '没有通知。')
            : null,
        )
      : null,
  )
}
