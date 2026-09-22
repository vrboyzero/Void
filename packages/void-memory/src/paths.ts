import { existsSync } from "node:fs";
import path from "node:path";
import { assertPathInsideRoots, assertRealPathInsideRootsSync } from "@void/void-soul";

/**
 * 人格记忆的路径守卫：先按字符串比一次，再看穿链接比一次。
 *
 * 正文层（`documents.ts`）的 `contain` 只做 `path.relative` 字符串判定。档案注册表与
 * 模组库在 2026-09-22 已经补上 realpath 二次确认，记忆侧当时只列为后续项：本机被放上
 * 链接时越界读取同样成立——把 `memory/` 整层换成指向数据根外的 junction，字符串检查
 * 看不出任何问题，真正读写的却是根外的文件。
 *
 * 目标还不存在时（首次写入）不能直接放行：那种情况下真正会被跟着走的是**最近的已存在
 * 祖先**，所以这里从目标往上找到第一个存在的路径再看一次。
 *
 * @module @void/void-memory/paths
 */

export class MemoryPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryPathError";
  }
}

/** 只要求 store 里用得到的判定，方便直接把 `Dirent` 传进来。 */
export interface MemoryPathEntry {
  name: string;
  isSymbolicLink(): boolean;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 从目标往上找第一个存在的路径；一路到盘根都不存在就返回最顶上那个。 */
function nearestExisting(target: string): string {
  let current = target;
  for (;;) {
    if (existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/**
 * 规范化并确认目标落在数据根内（含看穿链接）。
 *
 * @returns 规范化后的目标路径；调用方应该用返回值，而不是原始输入。
 * @throws {MemoryPathError} 越界、别名无法规范化，或链接指向根外。
 */
export function assertMemoryPathInside(dataRoot: string, target: string, label = "记忆路径"): string {
  let inside: string;
  try {
    inside = assertPathInsideRoots(target, { roots: [dataRoot] });
  } catch (error) {
    throw new MemoryPathError(`${label}越界: ${target} 不在数据根 ${dataRoot} 内（${reasonOf(error)}）`);
  }
  // 检查用锚点（目标本身，或它最近的存在祖先），但返回给调用方的仍是目标路径：
  // 目标还没建出来时，祖先的真实位置不等于目标的真实位置。
  try {
    assertRealPathInsideRootsSync(nearestExisting(inside), { roots: [dataRoot] });
  } catch (error) {
    throw new MemoryPathError(`${label}经链接后越界: ${target}（${reasonOf(error)}）`);
  }
  return inside;
}

/**
 * 列目录时遇到链接直接拒绝。
 *
 * Windows 上 junction 的 `isDirectory()` 是 false，只按目录过滤会把它**静默跳过**，
 * 看起来就像记忆凭空丢了。宁可当场报错，也不要让人对着空列表猜。
 */
export function assertMemoryEntryNotLink(entry: MemoryPathEntry, parent: string): void {
  if (entry.isSymbolicLink()) {
    throw new MemoryPathError(`记忆目录里有链接，拒绝读入: ${path.resolve(parent, entry.name)}`);
  }
}
