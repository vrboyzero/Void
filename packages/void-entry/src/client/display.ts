/**
 * 只读字段的展示文本。
 *
 * 单独成模块是为了可测：`JSON.stringify` 会把 `/mcp/x` 渲染成 `"/mcp/x"`——那是给数据看的
 * 写法，摆在界面上会让人以为值里真有引号。「基本」组的端点路径与账本后端都踩过这个。
 *
 * @module @void/void-entry/src/client/display
 */

/**
 * 把已解析的值渲染成给人看的文本。
 *
 * 字符串、数字、布尔原样显示；数组与对象才用 JSON，因为需要界定边界。
 *
 * @param value - 已解析的值。
 * @returns 展示文本。
 */
export function readonlyText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value === null) return 'null';
  if (value === undefined) return '—';
  return JSON.stringify(value);
}
