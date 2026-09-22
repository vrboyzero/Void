/**
 * 落盘的唯一写法：同目录临时文件 + rename。
 *
 * 灵魂档案、模组、`state.json`、会话绑定都要写盘，各写一份实现迟早会分叉（一处忘了建目录，
 * 一处忘了清理临时文件），所以收在这里。读者要么看到旧版本，要么看到新版本，不会读到半截
 * ——档案被读到半截，等于把「玩家是谁、装了哪个模组」判断错。
 *
 * 两条保证，缺一不可：
 * 1. **每次调用用自己的临时文件名**（进程号 + 序号）。共用同一个临时名时，两次并发写入会
 *    互相踩，rename 出来的就是坏 JSON。
 * 2. **rename 遇到 Windows 上的临时占用要重试**。杀毒、索引器、另一个句柄短暂按住目标文件
 *    时，`rename` 会以 `EPERM`/`EBUSY`/`EACCES` 失败——这类失败是暂时的，重试几次就过去了。
 *    全量回归里真的红过一次：`EPERM: operation not permitted, rename
 *    '...\agents\小贝\state.json.tmp' -> '...\agents\小贝\state.json'`，单跑该文件却是绿的。
 *
 * 与军团那份（`@void/void-legion/atomic-file`）的差别只有一条：这里**不做按目标的串行**。
 * 灵魂侧的写入都由人的动作驱动（点保存、点标记完成），一次一个，没有军团那种「不等落盘就
 * 往下跑」的连发；多一层等待只会让面板的手感变钝。
 *
 * @module @void/void-soul/atomic-file
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

/** 覆盖写一个文件：先写同目录临时文件，再改名到目标（目录不存在就建）。 */
export async function writeFileAtomic(target: string, content: string): Promise<void> {
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
