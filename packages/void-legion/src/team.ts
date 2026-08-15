/**
 * Minimal snapshot of Star delegation team topology vocabulary.
 * Source: packages/belldandy-skills/src/delegation-protocol.ts.
 * Only the roster/authority types are carried; the full DelegationProtocol
 * (intent/contextPolicy/expectedDeliverable/aggregationPolicy/launchDefaults)
 * is deferred to the void-legion MVP.
 */

export type DelegationTeamMode =
  | "parallel_subtasks"
  | "parallel_patch"
  | "research_grid"
  | "verify_swarm"
  | "plan_execute_verify";

export type LaunchRole = "default" | "commander" | "coder" | "researcher" | "verifier";

export type AuthorityRelation = "self" | "superior" | "peer" | "subordinate" | "unknown";

export interface DelegationTeamMember {
  laneId: string;
  agentId?: string;
  role?: LaunchRole;
  identityLabel?: string;
  authorityRelationToManager?: AuthorityRelation;
  reportsTo?: string[];
  mayDirect?: string[];
  scopeSummary?: string;
  dependsOn?: string[];
  handoffTo?: string[];
}

export interface DelegationTeamMetadata {
  id: string;
  mode: DelegationTeamMode;
  sharedGoal?: string;
  managerAgentId?: string;
  managerIdentityLabel?: string;
  currentLaneId?: string;
  memberRoster: DelegationTeamMember[];
}
