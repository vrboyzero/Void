import { SoulProfileError } from "./profile.js";

export interface ExecutionIsolation {
  readIsolated: boolean;
  writeIsolated: boolean;
}

/**
 * 执行面策略：拦「起进程」这件事的几个消费者共用的判定。
 *
 * 现在的消费者是 `entry-policy.ts`（按工具名 / 契约判模型的工具入口）与 `command-gate.ts`
 * （`runGuardedCommand`）。它们必须用同一个函数回答「这里允许原始执行吗」，否则会出现分叉：
 * 配置里声明了读隔离之后工具门禁按声明放行，另一处却还按「本机没有隔离」拒掉。
 *
 * **2026-10-03 删掉了原先的第三个消费者 `shell-guard.ts`**：它包的是宿主 `shell.run` /
 * `shell.start`，而 `ShellExecutor` 只有 `resolve` + `execute`（`0.1.7-rc.2` 起就是如此），
 * 所以那个包装从来没装上过。要恢复「拦所有 raw 执行」这条更强的路，得先有读隔离环境。
 */
export interface ExecutionPolicy {
  /** 当前执行环境的隔离能力。没提供就当作完全没有隔离。 */
  isolation?: ExecutionIsolation | undefined;
  /** 显式开关：读隔离落地前，在受控环境里恢复写/执行入口。默认关闭。 */
  allowUnisolated?: boolean | undefined;
}

/** 允许原始执行吗：`allowUnisolated` 放行，或者读写都声明了隔离。 */
export function isExecutionAllowed(policy: ExecutionPolicy | undefined): boolean {
  if (policy?.allowUnisolated === true) return true;
  const isolation = policy?.isolation;
  return isolation?.readIsolated === true && isolation.writeIsolated === true;
}

/** 原始命令必须同时具备读隔离和写隔离（或在受控环境里被显式放行）。只限制写入不够。 */
export function assertRawCommandAllowed(policy: ExecutionPolicy | undefined): void {
  if (!isExecutionAllowed(policy)) {
    throw new SoulProfileError("原始命令缺少读隔离，已拒绝执行");
  }
}
