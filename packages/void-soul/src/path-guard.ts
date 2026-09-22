/**
 * 路径别名与越界路径的拒绝。
 *
 * 方案文档 §17.2 的 P2 退出条件点名要求「路径别名」这类绕过用例被拒绝。光把
 * 用户给的字符串做一次 `startsWith` 是不够的：同一个文件在 Windows 上至少有
 * 十来种写法能绕过朴素的字符串比较，而每一种都能让「隔离」变成摆设。
 *
 * 这里只做**纯字符串层面的规范化与拒绝**，不碰文件系统，因此可以放心在派发前
 * 调用。真正的符号链接/junction 需要文件系统才能看穿，交给
 * {@link assertRealPathInsideRoots}（或同步版 {@link assertRealPathInsideRootsSync}）
 * 再查一次——两道都要过。
 *
 * @module @void/void-soul/path-guard
 */
import path from "node:path";
import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";

export class PathGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathGuardError";
  }
}

/** Windows 设备名：任何一段叫这些名字（可带扩展名）都不是普通文件。 */
const RESERVED_DEVICE_NAMES = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_unused, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_unused, index) => `lpt${index + 1}`),
]);

/**
 * 把宿主路径规范化成「可以用来比较」的形式。
 *
 * 规范化只做**确定安全**的改写（统一分隔符、去掉扩展长度前缀、解析 `..`）；
 * 一旦遇到需要真实文件系统才能确定含义的写法（8.3 短名、设备路径、数据流），
 * 直接拒绝而不是猜——猜错的方向永远是「比实际更宽」。
 */
export function normalizeHostPath(input: string, platform: NodeJS.Platform = process.platform): string {
  if (typeof input !== "string") throw new PathGuardError("路径必须是字符串");
  const raw = input.trim();
  if (raw.length === 0) throw new PathGuardError("路径为空");

  if (platform === "win32") {
    let value = raw.replace(/\//g, "\\");
    if (value.startsWith("\\\\?\\")) {
      // 扩展长度前缀只是写法，去掉后按普通路径处理。
      value = value.slice("\\\\?\\".length);
    } else if (value.startsWith("\\\\.\\")) {
      throw new PathGuardError(`拒绝设备路径: ${raw}`);
    } else if (value.startsWith("\\\\")) {
      throw new PathGuardError(`拒绝 UNC 网络路径: ${raw}`);
    }
    // `C:` 是盘符相对路径，含义取决于当前目录，无法静态判定。
    if (/^[A-Za-z]:$/.test(value)) throw new PathGuardError(`拒绝盘符相对路径: ${raw}`);
    // NTFS 数据流：盘符之后的第一个冒号就是 ADS。
    const afterDrive = value.slice(2);
    if (afterDrive.includes(":")) throw new PathGuardError(`拒绝 NTFS 数据流路径: ${raw}`);
    for (const component of value.split("\\")) {
      if (component.length === 0) continue;
      // `.` 与 `..` 由 path.resolve 归位，它们本身不是可疑分段。
      if (component === "." || component === "..") continue;
      if (component.endsWith(".") || component.endsWith(" ")) {
        throw new PathGuardError(`路径分段以点或空格结尾，含义不确定，拒绝: ${raw}`);
      }
      if (component.includes("~") && /\~\d/.test(component)) {
        throw new PathGuardError(`拒绝 8.3 短名路径: ${raw}`);
      }
      const bare = (component.split(".")[0] ?? "").toLowerCase();
      if (RESERVED_DEVICE_NAMES.has(bare)) throw new PathGuardError(`拒绝设备名路径: ${raw}`);
    }
    // 盘符大小写不影响含义，统一成大写，让 `c:` 与 `C:` 得到同一个规范形式。
    return path.win32.resolve(value).replace(/^([a-z]):/, (_match, drive: string) => `${drive.toUpperCase()}:`);
  }

  if (raw.includes("\0")) throw new PathGuardError("路径含空字节，拒绝");
  return path.posix.resolve(raw.replace(/\/+/g, "/"));
}

export interface PathGuardOptions {
  /** 允许的根目录（绝对路径）。空数组表示什么都不允许。 */
  roots: readonly string[];
  platform?: NodeJS.Platform | undefined;
}

function isInside(candidate: string, root: string, platform: NodeJS.Platform): boolean {
  const separator = platform === "win32" ? "\\" : "/";
  const normalizeCase = (value: string): string => (platform === "win32" ? value.toLowerCase() : value);
  const a = normalizeCase(candidate);
  const b = normalizeCase(root);
  return a === b || a.startsWith(b.endsWith(separator) ? b : `${b}${separator}`);
}

/**
 * 规范化并检查路径落在允许的根内。
 *
 * @returns 规范化后的路径（调用方应该用这个返回值，而不是原始输入）。
 * @throws {PathGuardError} 别名无法规范化、越界、根不合法。
 */
export function assertPathInsideRoots(input: string, options: PathGuardOptions): string {
  const platform = options.platform ?? process.platform;
  const candidate = normalizeHostPath(input, platform);
  if (options.roots.length === 0) throw new PathGuardError(`没有允许的根，拒绝访问: ${input}`);
  const roots = options.roots.map((root) => normalizeHostPath(root, platform));
  if (roots.some((root) => isInside(candidate, root, platform))) return candidate;
  throw new PathGuardError(`路径越界: ${candidate} 不在允许的根内（允许: ${roots.join(", ")}）`);
}

/**
 * 看穿符号链接/junction 之后再查一次。
 *
 * 字符串检查拦不住「先建一个指向外部的链接、再访问链接」这种写法，所以凡是要
 * 真正落盘的调用都得再走一遍这里。目标不存在时按 ENOENT 放行到调用方处理。
 */
export async function assertRealPathInsideRoots(input: string, options: PathGuardOptions): Promise<string> {
  const platform = options.platform ?? process.platform;
  const candidate = assertPathInsideRoots(input, options);
  let real: string;
  try {
    real = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
    throw new PathGuardError(`路径无法解析真实位置: ${candidate}（${error instanceof Error ? error.message : String(error)}）`);
  }
  const roots = await Promise.all(
    options.roots.map(async (root) => {
      const normalized = normalizeHostPath(root, platform);
      // 根自己也可能在链接下面（例如数据根落在 junction 里）。根不存在就按原样比。
      try {
        return normalizeHostPath(await realpath(normalized), platform);
      } catch {
        return normalized;
      }
    }),
  );
  if (roots.some((root) => isInside(real, root, platform))) return real;
  throw new PathGuardError(`路径经链接后越界: ${candidate} → ${real}`);
}

/**
 * 同 {@link assertRealPathInsideRoots}，只是走同步的 `realpathSync`。
 *
 * 给那些「拿不到 await 位置」的调用方用：例如 sqlite 句柄在构造函数里就同步打开，
 * 人格记忆的 store 工厂也是同步的。语义刻意与异步版逐条对齐（ENOENT 放行、根自己
 * 在链接下按原样比、越界抛同一条消息），免得同一个洞在两个版本里被查出两种结论。
 */
export function assertRealPathInsideRootsSync(input: string, options: PathGuardOptions): string {
  const platform = options.platform ?? process.platform;
  const candidate = assertPathInsideRoots(input, options);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
    throw new PathGuardError(`路径无法解析真实位置: ${candidate}（${error instanceof Error ? error.message : String(error)}）`);
  }
  const roots = options.roots.map((root) => {
    const normalized = normalizeHostPath(root, platform);
    try {
      return normalizeHostPath(realpathSync(normalized), platform);
    } catch {
      return normalized;
    }
  });
  if (roots.some((root) => isInside(real, root, platform))) return real;
  throw new PathGuardError(`路径经链接后越界: ${candidate} → ${real}`);
}
