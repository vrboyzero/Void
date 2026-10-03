/**
 * 宿主原语可用性探测与运行期兜底。
 *
 * `@deepseek-ai/dsh-client-ui-primitives` 由宿主的冻结模块表在运行时提供，**模块本身
 * 一定能解析**（否则 import 阶段就抛错，那是宿主版本问题，本插件无能为力）；但宿主
 * 可能解析得到模块却没有某些具名导出。
 *
 * 0.1.7-rc.1 就是这么坏的：产品图标从 `Icon<字形><尺寸>` 改名成 `Icon<字形>Regular` /
 * `Icon<字形>Medium`，尺寸改为 `size` prop。旧名字读出来是 `undefined`，把它交给
 * React 抛「element type is invalid」错误，打掉的是**整个 `settings.section` 条目**
 * ——用户看到的是设置面板全白，而不是少一个图标。所以图标不能裸用。
 *
 * 这里做两件事：
 *
 * 1. `PRIMITIVE_GAPS`：把本插件依赖的导出显式列出来，缺失时由 `apply()` 告警。
 * 2. `safeIcon()`：图标在模块作用域过一次兜底，缺失时退回一个什么都不画的组件。
 *
 * 首选防线仍在编译期：`scripts/gen-primitives-types.mjs --check` 拿宿主同版包核对
 * 声明，名字对不上直接让门禁失败。这里只是运行期兜底。
 *
 * 做法与 `dshmarket` 的 `missingPrimitives()` 一致（见方案 §29.1 的 ②）。
 *
 * 注意：`primitives-probe` 必须与 UI 分开，好让探测结果能在 `apply()` 里被读取——
 * `apply()` 早于任何渲染执行，能在注册 slot 之前决定降级策略。
 */
import type { ReactElement } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

/** 本插件用到的宿主具名导出。缺任何一个都要告警。 */
const REQUIRED_PRIMITIVES = [
  'Button',
  'DisclosureRow',
  'Input',
  'Pill',
  'RiskConfirmation',
  'StateDot',
  'Switch',
  'writeClipboard',
  'IconCordisPluginOutlineRegular',
  'IconPlusOutlineRegular',
  'IconQuestionOutlineRegular',
  'IconSearchOutlineRegular',
  'IconSettingsOutlineRegular',
  'IconTrashOutlineRegular',
] as const

/** 宿主导出表；宿主没有的名字读出来是 `undefined`。 */
const hostExports = primitives as unknown as Record<string, unknown>

/**
 * 缺失的宿主原语名。空数组表示宿主完整支持本插件的渲染需求。
 */
export const PRIMITIVE_GAPS: string[] = REQUIRED_PRIMITIVES.filter(
  (name) => hostExports[name] === undefined,
)

/** 宿主图标的 prop；`size` 不给时用宿主字形自己画的尺寸。 */
export interface HostIconProps {
  size?: number
  className?: string
}

/** 宿主图标的形状：一定可渲染。 */
export type HostIcon = (props: HostIconProps) => ReactElement | null

/** 缺失图标的兜底：什么都不画，占位为零。 */
const MISSING_ICON: HostIcon = () => null

/**
 * 把宿主图标包成「一定可渲染」的组件。
 *
 * 必须在**模块作用域**调用一次并存下结果，不要写在渲染里——每次渲染造一个新组件
 * 会让 React 重新挂载那棵子树并丢掉它的局部状态。
 *
 * 只把「名字取不到」判为缺失。不要改成 `typeof icon === 'function'`：宿主的图标
 * 可能是 `React.memo` / `forwardRef` 产物（同包的 `DisclosureRow` 在 0.1.7 就是
 * `MemoExoticComponent`），那类组件不是函数，会被这个判据误杀成空白图标。
 *
 * @param icon - 从宿主具名导入的图标；宿主改名后这里是 `undefined`。
 * @returns 原图标，或什么都不画的兜底组件。
 */
export function safeIcon(icon: unknown): HostIcon {
  return icon === undefined || icon === null ? MISSING_ICON : (icon as HostIcon)
}
