import { assertRawCommandAllowed, type ExecutionPolicy } from "./execution-policy.js";

export interface GuardedShell {
  run(spec: { command: string }): Promise<unknown>;
  start?(spec: { command: string }): unknown;
}

/**
 * 包住宿主 shell。隔离不够时不调用内层 run 或 start。
 *
 * 判定与工具入口门禁共用 `assertRawCommandAllowed`（见 `execution-policy.ts`）：两道门禁
 * 对同一份配置必须给同一个答案，否则会「工具放行、底层仍拒」。
 */
export function guardShell(inner: GuardedShell, policy: ExecutionPolicy | undefined): GuardedShell {
  return {
    async run(spec) {
      assertRawCommandAllowed(policy);
      return inner.run(spec);
    },
    start(spec) {
      assertRawCommandAllowed(policy);
      return inner.start?.(spec);
    },
  };
}

/**
 * 就地替换并在卸载时恢复，避免包装调用已经替换过的方法。
 *
 * 默认 `{}`＝按「完全没有隔离」处理，照旧拒绝；调用方（`plugin.ts`）只在
 * `entryPolicy.enabled === true` 时把配置里的隔离声明与 `allowUnisolated` 传进来。
 */
export function installShellReadGuard(shell: GuardedShell, policy: ExecutionPolicy = {}): () => void {
  const originalRun = shell.run.bind(shell);
  const originalStart = shell.start?.bind(shell);
  const guarded = guardShell({ run: originalRun, start: originalStart }, policy);
  shell.run = guarded.run;
  if (shell.start) shell.start = guarded.start;
  return () => {
    shell.run = originalRun;
    if (originalStart) shell.start = originalStart;
  };
}
