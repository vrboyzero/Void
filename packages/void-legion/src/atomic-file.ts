/**
 * 落盘的唯一写法：同目录临时文件 + rename。
 *
 * 队伍配置和运行记录都要写盘，两处各写一份实现迟早会分叉（一处忘了 mkdir，
 * 一处忘了清理临时文件），所以收在这里。读者要么看到旧版本，要么看到新版本，
 * 不会读到半截——军团的状态文件被读到半截，等于把「跑到哪了」判断错。
 *
 * 两条保证，缺一不可：
 * 1. **每次调用用自己的临时文件名**（进程号 + 序号）。共用同一个临时名时，两次并发
 *    写入会互相踩：一个把另一个的内容追加进去，rename 出来的就是坏 JSON
 *    （真出现过「Unexpected non-whitespace character after JSON」）。
 * 2. **同一个目标文件按调用顺序串行**。派活之后的状态更新是「不等落盘」发出的，
 *    并发 rename 的完成顺序不保证等于调用顺序；不串行就可能把**旧快照**盖在新快照上，
 *    磁盘上的进度比内存里还旧——那比不落盘更坏。
 * 3. **rename 遇到 Windows 上的临时占用要重试**。杀毒、索引器、另一个句柄短暂按住目标
 *    文件时，`rename` 会以 `EPERM`/`EBUSY`/`EACCES` 失败——这类失败是暂时的，重试几次
 *    就过去了。全量回归里真的红过一次：`EPERM: operation not permitted, rename
 *    '...\.legion-demo.json.35812.11.tmp' -> '...\legion-demo.json'`，单跑该文件却是绿的。
 *
 * @module @void/void-legion/atomic-file
 */
import { mkdirSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

let sequence = 0;

/** rename 的尝试次数与退避步长（只作用于失败路径，成功路径不加延迟）。 */
const RENAME_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 20;

/** 值得重试的 errno：都是「别人暂时占着」，不是「这次写入本身不合法」。 */
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameWithRetry(temporary: string, target: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(temporary, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (attempt >= RENAME_ATTEMPTS || code === undefined || !TRANSIENT_RENAME_CODES.has(code)) throw error;
      await delay(RENAME_BACKOFF_MS * attempt);
    }
  }
}

/** 每个目标文件一条写入链：前一次写完了才轮到下一次。 */
const chains = new Map<string, Promise<void>>();

export async function writeFileAtomic(target: string, content: string): Promise<void> {
  const previous = chains.get(target) ?? Promise.resolve();
  // 前一次失败不影响这一次：链上只借「顺序」，不继承错误。
  const current = previous.catch(() => undefined).then(() => writeOnce(target, content));
  const guarded = current.catch(() => undefined);
  chains.set(target, guarded);
  try {
    await current;
  } finally {
    // 链尾还是自己时清掉，别让这张表随着运行次数长。
    if (chains.get(target) === guarded) chains.delete(target);
  }
}

async function writeOnce(target: string, content: string): Promise<void> {
  const directory = path.dirname(target);
  mkdirSync(directory, { recursive: true });
  sequence += 1;
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${sequence}.tmp`);
  try {
    await writeFile(temporary, content, "utf8");
    await renameWithRetry(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
