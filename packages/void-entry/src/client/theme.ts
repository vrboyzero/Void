/**
 * 宿主主题令牌。
 *
 * 颜色一律走 `--dsw-alias-*`：它们在 `body` 上定义、随主题切换，**写死的颜色不会**。
 * 我们最初用 `#888` 表示弱化文字——深色下勉强能读，浅色下对比度只有 3.54:1（WCAG AA 对
 * 正文要求 4.5:1），再叠上未授权行的 `opacity: 0.55` 后降到约 1.9:1，看起来就是失效态。
 *
 * 令牌名取自 dsh 0.1.5-rc.2 的宿主实现；升级宿主时按 `AGENTS.md` §1 的办法重新核对。
 *
 * @module @void/void-entry/src/client/theme
 */

/** 次要文字。浅色下 5.8:1，可用于需要阅读的内容（英文操作名走这一级）。 */
export const TEXT_SECONDARY = 'var(--dsw-alias-label-secondary)';

/**
 * 没有第三档弱化色。
 *
 * 宿主还有 `label-tertiary`（浅色 3.71:1）与 `label-caption`（2.13:1），但两者都低于
 * WCAG AA 对正文的 4.5:1。我们试过用它做帮助文字，结果是整块面板有 14 处文字不达标——
 * 而且这些恰恰是用户必须读的内容（字段说明、操作名、调用方提示）。所以这一层不提供：
 * 需要更弱的层级时，先确认对比度，再往这里加。
 */

/** 卡片与分区的边框。 */
export const BORDER = 'var(--dsw-alias-border-l2)';

/** 更淡的内部边框（输入框、代码块）。 */
export const BORDER_SOFT = 'var(--dsw-alias-border-l1)';

/** 悬停/嵌入底色（代码块）。 */
export const SURFACE_HOVER = 'var(--dsw-alias-interactive-bg-hover)';

/** 错误态。 */
export const DANGER = 'var(--dsw-alias-state-error-primary)';

/** 警告态（未保存标记、保存条边框）。 */
export const WARN = 'var(--dsw-alias-state-warn-primary)';

/** 警告态底色（保存条）。 */
export const WARN_SURFACE = 'var(--dsw-alias-state-warn-tertiary)';

/**
 * 行标题的类名。
 *
 * `DisclosureRow` 的 `title` 只收字符串、样式只能通过 `titleClassName` 传，所以加粗必须落
 * 到一张宿主样式表之外的插件样式上——见 {@link ensureStyles}。
 */
export const ROW_TITLE_CLASS = 'void-entry-row-title';

const STYLE_ID = 'void-entry-styles';

/**
 * 注入插件自己的样式表。幂等：重复调用只会命中一次。
 *
 * 加粗行标题只能这么做——`DisclosureRow` 没有 weight 参数，`title` 也不是 ReactNode。
 * 样式表挂在 `head` 末尾，同优先级下按顺序胜过宿主样式。
 */
export function ensureStyles(): void {
  if (typeof document === 'undefined') return;
  // HMR 会重新执行模块，先查 id 避免累积多张表。
  if (document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  // 600 与宿主自己的标题字重一致，不改动行高。
  style.textContent = `.${ROW_TITLE_CLASS}{font-weight:600}`;
  document.head.append(style);
}
