/**
 * Minimal snapshot of Star belldandy-skills tool governance vocabulary.
 * Source: packages/belldandy-skills/src/tool-contract.ts + runtime-policy.ts.
 * Only the pure types + `evaluateRolePolicy` (family × risk) are carried; the
 * full ToolContract (channels/safeScopes/resultSchema/persistence/admission)
 * and the render/denied-reason helpers are deferred to the void-tools MVP.
 */

export type ToolContractFamily =
  | "network-read"
  | "workspace-read"
  | "workspace-write"
  | "patch"
  | "command-exec"
  | "process-control"
  | "session-orchestration"
  | "memory"
  | "browser"
  | "service-admin"
  | "goal-governance"
  | "other";

export type ToolContractRiskLevel = "low" | "medium" | "high" | "critical";

export type LaunchRole = "default" | "commander" | "coder" | "researcher" | "verifier";

export interface ToolContract {
  name: string;
  family: ToolContractFamily;
  isReadOnly: boolean;
  needsPermission: boolean;
  riskLevel: ToolContractRiskLevel;
}

export interface RolePolicy {
  role?: LaunchRole;
  allowedToolFamilies?: ToolContractFamily[];
  maxToolRiskLevel?: ToolContractRiskLevel;
}

const RISK_ORDER: readonly ToolContractRiskLevel[] = ["low", "medium", "high", "critical"];

/**
 * Mirror of Star `evaluateLaunchRolePolicy`: deny when the contract's family is
 * outside the allowed set, or its risk level exceeds the cap.
 */
export function evaluateRolePolicy(
  contract: ToolContract,
  policy: RolePolicy = {},
): { allowed: boolean; reason?: string } {
  if (policy.allowedToolFamilies && !policy.allowedToolFamilies.includes(contract.family)) {
    return {
      allowed: false,
      reason: `tool "${contract.name}" family "${contract.family}" is not allowed for role "${policy.role ?? "default"}"`,
    };
  }
  if (policy.maxToolRiskLevel && RISK_ORDER.indexOf(contract.riskLevel) > RISK_ORDER.indexOf(policy.maxToolRiskLevel)) {
    return {
      allowed: false,
      reason: `tool "${contract.name}" risk "${contract.riskLevel}" exceeds max "${policy.maxToolRiskLevel}"`,
    };
  }
  return { allowed: true };
}
