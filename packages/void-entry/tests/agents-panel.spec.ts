import { describe, expect, it } from 'vitest'
import {
  facetOption,
  isCurrentSession,
  parseAgentCards,
  parseFacetOptions,
  PROFILES_VIEW_ID,
  VOID_AGENTS_LABEL,
  VOID_AGENTS_PANEL_ID,
  NO_FACET_VALUE,
} from '../src/client/agents-panel.js'
import {
  BORDER,
  BORDER_SOFT,
  BRAND,
  BUTTON_FILL,
  DANGER,
  SURFACE_HOVER,
  SURFACE_PANEL,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
} from '../src/client/theme.js'

/**
 * P1 只读面板的纯函数：把 `/void/api/detail?view=void-soul:profiles` 的响应
 * 解析成卡片。
 *
 * 这里钉的是**健壮性**而不是形状：宿主接口加字段、少字段、或者某个档案的条目坏掉，
 * 都不该让整块面板白屏——渲染期抛错会打掉整个 slot 条目，这是 0.1.7 白屏事故的形态。
 */
describe('parseAgentCards', () => {
  it('正常响应：取 id / 显示名 / 组合行 / 修订行', () => {
    const payload = {
      view: 'void-soul:profiles',
      title: '灵魂档案',
      items: [
        {
          id: 'belldandy',
          title: '贝露丹蒂',
          summary: 'belldandy · 最佳拍档 · 1 个会话',
          meta: '修订 ad22e54ee4633d14',
        },
      ],
    }
    expect(parseAgentCards(payload)).toEqual([
      {
        id: 'belldandy',
        name: '贝露丹蒂',
        summary: 'belldandy · 最佳拍档 · 1 个会话',
        meta: '修订 ad22e54ee4633d14',
        suspended: false,
        boundSessions: [],
      },
    ])
  })

  it('P3 的外加字段：选择修订号、当前模组、绑定会话', () => {
    const cards = parseAgentCards({
      items: [{
        id: 'belldandy',
        title: '贝露丹蒂',
        summary: 'belldandy · 开发专家 · 1 个会话',
        meta: '修订 abc',
        selectionRevision: 6,
        facetId: 'kaifazhuanjia',
        facetName: '开发专家',
        boundSessions: ['s-1', 's-2'],
      }],
    })
    expect(cards[0]).toMatchObject({
      selectionRevision: 6,
      facetId: 'kaifazhuanjia',
      facetName: '开发专家',
      boundSessions: ['s-1', 's-2'],
    })
  })

  it('外加字段缺席也照常出卡片（老宿主 / 别的视图不给这些字段）', () => {
    const cards = parseAgentCards({ items: [{ id: 'x', title: 'X' }] })
    expect(cards).toHaveLength(1)
    expect(cards[0]?.selectionRevision).toBeUndefined()
    expect(cards[0]?.facetId).toBeUndefined()
    expect(cards[0]?.boundSessions).toEqual([])
  })

  it('没装模组时 facetId/facetName 是 null——不能被当成缺席', () => {
    const cards = parseAgentCards({ items: [{ id: 'x', facetId: null, facetName: null }] })
    expect(cards[0]?.facetId).toBeNull()
    expect(cards[0]?.facetName).toBeNull()
  })

  it('boundSessions 里混进非字符串就丢掉，不整条卡片作废', () => {
    const cards = parseAgentCards({ items: [{ id: 'x', boundSessions: ['s-1', 42, null] }] })
    expect(cards[0]?.boundSessions).toEqual(['s-1'])
  })

  it('停用档案从 meta 里认出来（接口只给文本，没有布尔位）', () => {
    const cards = parseAgentCards({
      items: [{ id: 'x', title: 'X', summary: '', meta: '修订 abc · 已停用' }],
    })
    expect(cards[0]?.suspended).toBe(true)
  })

  it('认不出的条目跳过，不抛——一个坏条目不该让整块面板白屏', () => {
    const cards = parseAgentCards({
      items: [
        null,
        'not-an-object',
        { title: '缺 id' },
        { id: 42, title: 'id 不是字符串' },
        { id: 'ok', title: '唯一活下来的' },
      ],
    })
    expect(cards.map((card) => card.id)).toEqual(['ok'])
  })

  it('缺显示名时退回用 id，卡片不会只剩一个空标题', () => {
    const cards = parseAgentCards({ items: [{ id: 'only-id' }] })
    expect(cards[0]?.name).toBe('only-id')
  })

  it('空表 / 形状不对一律回空表，不抛', () => {
    expect(parseAgentCards({ items: [] })).toEqual([])
    expect(parseAgentCards({})).toEqual([])
    expect(parseAgentCards(null)).toEqual([])
    expect(parseAgentCards(undefined)).toEqual([])
    expect(parseAgentCards('nope')).toEqual([])
    expect(parseAgentCards({ items: 'not-an-array' })).toEqual([])
  })
})

/**
 * 「当前会话」的判定。
 *
 * `'main'` 是 root 作用域，面板拿不到 `SessionStandardProps.sessionId`；URL 也不带
 * （纯 SPA，2026-09-26 实测）。可用的公开信号是 `GlobalStandardProps.useSessionRetainInfo`
 * 给出的 `retainedBy`——主列正在看的那个会话有 `mainView > 0`。
 * 隔离实例实测：10 个会话里恰好一个命中。
 */
describe('isCurrentSession', () => {
  it('mainView > 0 就是当前会话', () => {
    expect(isCurrentSession({ retainedBy: { mainView: 1, sidebarView: 1 } })).toBe(true)
  })

  it('别的保留源（单独 sidebarView）不算——侧栏选中不等于主列在看', () => {
    expect(isCurrentSession({ retainedBy: { sidebarView: 1 } })).toBe(false)
  })

  it('没有任何保留源的会话不算（列表里有，但没被打开）', () => {
    expect(isCurrentSession({ retainedBy: {} })).toBe(false)
    expect(isCurrentSession(undefined)).toBe(false)
    expect(isCurrentSession({})).toBe(false)
  })

  it('mainView 是 0 也不算——计数为 0 与缺席同义', () => {
    expect(isCurrentSession({ retainedBy: { mainView: 0 } })).toBe(false)
  })
})

/**
 * 下拉选项必须自带底色与文字色。
 *
 * 2026-09-26 用户截图报的 bug：原生 `<select>` 弹出列表里的选项**看不见**。原因不是样式
 * 没写，而是写在了外层 `<select>` 上——**弹出列表不吃外层的 `color: inherit`**，
 * `<option>` 用的还是系统默认白底，继承来的浅色文字落在上面就是白字白底。
 * 这条测试钉住「色必须显式落在 option 上」，谁改回裸 `option` 谁红灯。
 */
describe('facetOption', () => {
  const styleOf = (value: string, label: string) => {
    const el = facetOption(value, label) as unknown as {
      props: { style: Record<string, string>; value: string; children: string }
    }
    return el.props
  }

  it('选项自带底色与文字色，且走主题令牌（深浅色都跟着走）', () => {
    const props = styleOf('kaifazhuanjia', '开发专家')
    expect(props.style.background).toContain('--dsw-alias-')
    expect(props.style.color).toContain('--dsw-alias-')
  })

  it('底色是不透明的 surface，不能拿半透明的 hover 色顶替', () => {
    const props = styleOf('x', 'X')
    // interactive-bg-hover 是 #ffffff14，拿它当弹出层底会透出后面的内容
    expect(props.style.background).toBe('var(--dsw-alias-bg-layer-1)')
    expect(props.style.background).not.toContain('interactive-bg-hover')
  })

  it('文字色是正文级，不是次要级', () => {
    expect(styleOf('x', 'X').style.color).toBe('var(--dsw-alias-label-primary)')
  })

  it('值与文案原样带上，label 直接是纯文本', () => {
    const props = styleOf('', '（不装模组）')
    expect(props.value).toBe('')
    expect(props.children).toBe('（不装模组）')
  })
})

/**
 * 主题令牌。
 *
 * 2026-09-26 连着踩了两个坑，两条都要钉住：
 * 1. 令牌**名字写错**不会报错——`var(--dsw-alias-label-inverse, inherit)` 里的
 *    `label-inverse` 在宿主里**根本不存在**，兜底值 `inherit` 悄悄生效，于是浅色文字落在
 *    白底按钮上、字看不见；
 * 2. 令牌**用错场合**也不报错——`brand-primary` 在深色下是 `#f9fafb` 近白，做描边行、
 *    做填充就是一块白板。按钮填充必须走 `button-elevated-fill`（`#43454a`）。
 */
describe('主题令牌', () => {
  it('按钮填充不能拿品牌色顶替——后者是近白，只适合描边', () => {
    expect(BUTTON_FILL).not.toBe(BRAND)
    expect(BUTTON_FILL).toBe('var(--dsw-alias-button-elevated-fill)')
    expect(BRAND).toBe('var(--dsw-alias-brand-primary)')
  })

  it('所有令牌都是 var(--dsw-alias-*) 形式，没有裸色值', () => {
    const tokens = [
      TEXT_PRIMARY, TEXT_SECONDARY, SURFACE_PANEL, SURFACE_HOVER,
      BUTTON_FILL, BRAND, BORDER, BORDER_SOFT, DANGER,
    ]
    for (const token of tokens) {
      expect(token).toMatch(/^var\(--dsw-alias-[a-z0-9-]+\)$/)
    }
  })
})

describe('槽位配对常量', () => {
  it('「不装模组」用一个空串哨兵，不跟真模组 id 撞', () => {
    // 模组 id 的规则要求首字符是字母或数字（`^[A-Za-z0-9]...`），空串不可能是合法 id。
    expect(NO_FACET_VALUE).toBe('')
  })
  it('下拉的选项来自模组库视图', () => {
    expect(parseFacetOptions({ items: [{ id: 'kaifazhuanjia', title: '开发专家' }] }))
      .toEqual([{ id: 'kaifazhuanjia', name: '开发专家' }])
  })
  it('模组库解析也认不出的条目跳过，不抛', () => {
    expect(parseFacetOptions({ items: [null, { title: '缺 id' }, { id: 'ok' }] }))
      .toEqual([{ id: 'ok', name: 'ok' }])
    expect(parseFacetOptions(undefined)).toEqual([])
    expect(parseFacetOptions({ items: 'nope' })).toEqual([])
  })
  it('面板 id 与侧栏行 id 用同一个值——这是主面板与侧栏行的配对本身', () => {
    // 'main' 是 keyed 槽位（key），sidebar.panellist 是 list 槽位（id），
    // 侧栏按 id 选中主面板，两个值必须相等。
    expect(VOID_AGENTS_PANEL_ID).toBe('void-agents')
  })

  it('侧栏文案按用户 2026-09-26 定稿写全', () => {
    expect(VOID_AGENTS_LABEL).toBe('虚空(Void) Agents')
  })

  it('绑会话的动作挂在档案视图上', () => {
    // P2 的点击处理要 POST 到 /void/api/detail，itemId = 卡片 id，
    // actionId = 'bind-session'（宿主 detail-view 的条目级动作）。
    expect(PROFILES_VIEW_ID).toBe('void-soul:profiles')
  })
})
