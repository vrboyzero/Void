/**
 * 「客户端接入」区块。
 *
 * 面板在这里做的事，静态文档做不到：**值是真的**。地址取自浏览器当前位置（面板与
 * 端点同源，所以端口必然正确），路径取自插件清单，变量名与授权范围取自当前 live
 * settings。用户看到的不是一份「概念配置」，而是粘上去就能用的那一份。
 *
 * 暗号的值永远不出现——只出现变量名。这和插件「token 只从环境变量读」的契约一致，
 * 也让这个区块可以安全截图、安全分享。
 *
 * @module @void/void-entry/client/connect
 */
import { createElement as h, useState } from 'react'
import { TEXT_SECONDARY, BORDER, BORDER_SOFT, SURFACE_HOVER, DANGER, WARN, WARN_SURFACE } from './theme.js'
import {
  Button,
  Pill,
  StateDot,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { CLIENT_RECIPES, endpointUrl, serverName, smokeCommand } from './client-configs.js'
import type { TokenRow } from './controls.js'


/** 该调用方实际使用的变量名；没填就退回默认名，好让配置至少形状正确。 */
function tokenEnvName(caller: TokenRow): string {
  return caller.tokenEnv === '' ? 'VOID_DSH_CONTROL_TOKEN' : caller.tokenEnv
}
const CODE_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/** 复制按钮：点一下变成「已复制」，2 秒后复原。 */
function CopyButton(props: { text: string; label: string }): React.ReactElement {
  const [done, setDone] = useState(false)
  return h(Button, {
    variant: 'ghost',
    size: 'sm',
    onClick: () => {
      void writeClipboard(props.text).then((ok) => {
        if (!ok) return
        setDone(true)
        setTimeout(() => setDone(false), 2000)
      })
    },
  }, done ? '已复制' : props.label)
}

/**
 * 渲染接入说明。
 *
 * @param props.path - 清单里的端点路径。
 * @param props.transport - 传输方式，仅用于标注。
 * @param props.callers - 当前配置里的调用方（来自 live settings）。
 */
export function ConnectBlock(props: {
  path: string
  transport?: string
  callers: TokenRow[]
}): React.ReactElement {
  const url = endpointUrl(props.path)
  // 没有调用方时给一个占位身份，好让用户至少能复制出一份形状正确的配置。
  const callers: TokenRow[] =
    props.callers.length > 0 ? props.callers : [{ callerId: 'default', tokenEnv: 'VOID_DSH_CONTROL_TOKEN', operations: [] }]
  const [callerIndex, setCallerIndex] = useState(0)
  const [recipeId, setRecipeId] = useState(CLIENT_RECIPES[0]!.id)
  const caller = callers[Math.min(callerIndex, callers.length - 1)]!
  const recipe = CLIENT_RECIPES.find((r) => r.id === recipeId) ?? CLIENT_RECIPES[0]!
  const body = recipe.render({
    url,
    tokenEnv: tokenEnvName(caller),
    callerId: caller.callerId,
  })

  return h('div', { style: { padding: '6px 0 8px 24px', display: 'flex', flexDirection: 'column', gap: 10 } },
    // ── 端点 ──────────────────────────────────────────────────────────────
    h('div', null,
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
        h('span', { style: { fontSize: 13 } }, '端点'),
        h('code', { style: { fontSize: 11, color: TEXT_SECONDARY } }, props.transport ?? 'streamable-http'),
      ),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
        h('code', {
          style: {
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            fontFamily: CODE_FONT,
            background: SURFACE_HOVER,
            borderRadius: 6,
            padding: '4px 8px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
        }, url),
        h(CopyButton, { text: url, label: '复制地址' }),
      ),
    ),

    // ── 调用方 ────────────────────────────────────────────────────────────
    h('div', null,
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
        h('span', { style: { fontSize: 13 } }, '调用方'),
        h('span', { style: { fontSize: 11, color: TEXT_SECONDARY } }, '每个调用方用自己那行配置和暗号'),
      ),
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
        ...callers.map((row, index) =>
          h(Pill, {
            key: `${row.callerId}-${index}`,
            active: index === Math.min(callerIndex, callers.length - 1),
            onClick: () => setCallerIndex(index),
          },
            row.tokenEnv === '' ? `${row.callerId}（未设变量）` : row.callerId,
          ),
        ),
      ),
      caller.tokenEnv === ''
        ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: DANGER, marginTop: 4 } },
            h(StateDot, { state: 'warning', size: 8 }),
            h('span', null, '这个调用方还没填 token 变量名，下面的配置里用了占位名。'),
          )
        : null,
    ),

    // ── 配置形态切换 ──────────────────────────────────────────────────────
    h('div', null,
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 } },
        ...CLIENT_RECIPES.map((r) =>
          h(Pill, { key: r.id, active: r.id === recipe.id, onClick: () => setRecipeId(r.id) },
            r.recommended === true ? `${r.label} ★` : r.label,
          ),
        ),
      ),
      h('div', {
        style: {
          border: `1px solid ${BORDER_SOFT}`,
          borderRadius: 8,
          overflow: 'hidden',
        },
      },
        h('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '5px 8px',
            borderBottom: `1px solid ${BORDER}`,
            background: SURFACE_HOVER,
          },
        },
          h('code', { style: { fontSize: 11, color: TEXT_SECONDARY, flex: 1, minWidth: 0 } }, recipe.location),
          h(CopyButton, { text: body, label: '复制配置' }),
        ),
        h('pre', {
          style: {
            margin: 0,
            padding: '8px 10px',
            fontSize: 11.5,
            fontFamily: CODE_FONT,
            whiteSpace: 'pre',
            overflowX: 'auto',
            lineHeight: 1.5,
          },
        }, body),
      ),
      // Claude Desktop 的写法需要一个额外的派生变量（整段 Bearer 放进去以绕开 Windows
      // 的 args 空格问题）。不写清值长什么样，用户会只填裸 token 然后收到 401。
      recipe.id === 'claude-desktop'
        ? h('div', {
            style: {
              fontSize: 11,
              marginTop: 6,
              padding: '6px 8px',
              borderRadius: 6,
              background: WARN_SURFACE,
              border: `1px solid ${WARN}`,
            },
          },
            h('div', { style: { marginBottom: 2 } },
              `需要先设好环境变量 ${tokenEnvName(caller)}_AUTH，值是完整的：`),
            h('code', { style: { fontFamily: CODE_FONT } }, `Bearer <你的暗号>`),
            h('div', { style: { color: TEXT_SECONDARY, marginTop: 2 } },
              '注意连 "Bearer " 前缀和它后面那个空格一起放进去——这是绕开 Windows 上参数空格不转义的方式。'),
          )
        : null,
      recipe.note
        ? h('div', { style: { fontSize: 11, color: TEXT_SECONDARY, marginTop: 4 } }, recipe.note)
        : null,
    ),

    // ── 自检 ──────────────────────────────────────────────────────────────
    h('div', null,
      h('div', { style: { fontSize: 13, marginBottom: 4 } }, '自检'),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
        h('code', {
          style: {
            flex: 1,
            minWidth: 0,
            fontSize: 11.5,
            fontFamily: CODE_FONT,
            background: SURFACE_HOVER,
            borderRadius: 6,
            padding: '4px 8px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
        }, smokeCommand(url, tokenEnvName(caller))),
        h(CopyButton, { text: smokeCommand(url, tokenEnvName(caller)), label: '复制命令' }),
      ),
      h('div', { style: { fontSize: 11, color: TEXT_SECONDARY, marginTop: 4 } },
        `在仓库根目录跑。暗号从 ${tokenEnvName(caller)} 环境变量读，命令历史里记的是变量名而不是暗号本身；` +
          '报错说明端点或暗号还没配好。'),
    ),
  )
}
