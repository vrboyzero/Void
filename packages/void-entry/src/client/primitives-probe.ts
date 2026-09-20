/**
 * 宿主原语可用性探测。
 *
 * `@deepseek-ai/dsh-client-ui-primitives` 由宿主的冻结模块表在运行时提供，**模块本身
 * 一定能解析**（否则 import 阶段就抛错，那是宿主版本问题，本插件无能为力）；但旧版宿主
 * 可能解析得到模块却没有某些具名导出。这里把「本插件依赖哪些成员」显式列出来，缺失时
 * 由调用方降级，而不是让渲染抛错把整个设置弹窗弄白。
 *
 * 做法与 `dshmarket` 的 `missingPrimitives()` 一致（见方案 §29.1 的 ②）。
 *
 * 注意：`primitives-probe` 必须与 UI 分开，好让探测结果能在 `apply()` 里被读取——
 * `apply()` 早于任何渲染执行，能在注册 slot 之前决定降级策略。
 */
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

/** 本插件渲染所必需的宿主原语。缺任何一个都要降级。 */
const REQUIRED_PRIMITIVES = [
  'DisclosureRow',
  'Switch',
  'StateDot',
  'Input',
] as const

/**
 * 缺失的宿主原语名。空数组表示宿主完整支持本插件的渲染需求。
 */
export const PRIMITIVE_GAPS: string[] = REQUIRED_PRIMITIVES.filter(
  (name) => (primitives as unknown as Record<string, unknown>)[name] === undefined,
)
