import type { Context } from "@deepseek-ai/cordis";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { evaluateRolePolicy, type ToolContract, type RolePolicy } from "./contract.js";

export const name = "void-tools-policy";
export const inject = ["tools", "voidToolContracts"];

export interface VoidToolPolicyConfig {
  contracts?: ToolContract[];
  rolePolicy?: RolePolicy;
}

/**
 * Consumer: applies Star's role policy (family × risk) to the dsh tool
 * pipeline through `ctx.tools.guard`. The guard returns a deny reason string
 * or `undefined` (allow). This is the concrete mapping of
 * `evaluateLaunchRolePolicy` onto dsh's enforcement point.
 */
export function apply(ctx: Context, config: VoidToolPolicyConfig = {}): void {
  const contracts = config.contracts ?? [];
  const rolePolicy = config.rolePolicy ?? {};
  for (const contract of contracts) {
    ctx.voidToolContracts.register(contract);
  }
  ctx.tools.guard((exec: Readonly<ToolExecution>) => {
    const contract = ctx.voidToolContracts.get(exec.name);
    if (!contract) return undefined;
    const decision = evaluateRolePolicy(contract, rolePolicy);
    return decision.allowed ? undefined : decision.reason;
  });
}
