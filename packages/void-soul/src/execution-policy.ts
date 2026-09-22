import { SoulProfileError } from "./profile.js";

export interface ExecutionIsolation {
  readIsolated: boolean;
  writeIsolated: boolean;
}

/**
 * 执行面策略：与工具入口门禁同一套判定的入参。
 *
 * 有两道门禁拦「起进程」这件事——模型工具入口（`entry-policy.ts`，拦 `pwsh`/`bash` 这类
 * 工具名）和底层 shell 服务（`shell-guard.ts`，拦真正落到宿主 `shell.run`/`start` 的调用）。
 * 两道门禁必须用同一个函数回答「这里允许原始执行吗」，否则会出现分叉：配置里声明了读隔离
 * 之后工具门禁按声明放行，底层 shell 门禁却还按「本机没有隔离」拒掉，人工清单第 4 条
 * （把 `entryPolicy.isolation.readIsolated` 打开后重跑写/执行入口）永远验不过。
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
