import { assertRawCommandAllowed, type ExecutionPolicy } from "./execution-policy.js";

export interface RawCommandRequest { command: string }

/** 先检查隔离，再调用原执行器。拒绝时原执行器不会被调用。 */
export async function runGuardedCommand<T>(input: {
  policy: ExecutionPolicy | undefined;
  request: RawCommandRequest;
  execute: (request: RawCommandRequest) => Promise<T>;
}): Promise<T> {
  assertRawCommandAllowed(input.policy);
  return input.execute(input.request);
}
