/**
 * 禁用正则的即时反馈。
 *
 * 单独成模块而不是留在控件文件里，有两个原因：它是这一块唯一有判断逻辑的地方，
 * 拆出来就能直接单测；而且它不 import 宿主 UI 原语——那些在 node_modules 里不存在，
 * 混在一起会让整个测试文件的加载失败。
 *
 * @module @void/void-entry/client/patterns
 */

/** 一条正则的检查结果。 */
export interface PatternCheck {
  source: string;
  /** 无法编译时的引擎错误消息；可编译时为 undefined。 */
  error?: string;
  /**
   * 试匹配文本是否命中。
   *
   * 没有给试匹配文本时为 undefined——那种情况下**不能**报「未命中」，否则用户会
   * 以为正则不生效。
   */
  matched?: boolean;
}

/**
 * 检查一组正则的合法性，并可选地用一段样例文本试匹配。
 *
 * @param patterns - 正则源串。
 * @param sample - 试匹配文本；留空则只做语法检查。
 * @returns 每条正则在界面上的状态，顺序与输入一致。
 */
export function checkPatterns(patterns: readonly string[], sample: string): PatternCheck[] {
  return patterns.map((source) => {
    // 空串是「刚点添加、还没填」的中间状态，不该显示成错误。
    if (source === "") return { source };
    let compiled: RegExp;
    try {
      compiled = new RegExp(source);
    } catch (error) {
      return { source, error: error instanceof Error ? error.message : String(error) };
    }
    return sample === "" ? { source } : { source, matched: compiled.test(sample) };
  });
}

/**
 * 编译一条路径正则，返回错误消息。
 *
 * 任务文档要求的 `pathPattern` 用它当场校验：写错了立刻标红，而不是等运行时
 * `compilePolicy` 抛错。空串表示「任意路径都满足」，不是错误。
 *
 * @param source - 正则源串。
 * @returns 错误消息，或 undefined 表示可用。
 */
export function pathPatternError(source: string): string | undefined {
  if (source === "") return undefined;
  try {
    new RegExp(source);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
