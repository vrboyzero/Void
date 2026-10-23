/** Caller Workspace/Session boundaries, shared by MCP preparation and orchestration. */
import { realpath } from "node:fs/promises";
import type { CallerIdentity } from "./auth.js";
import type { HostPorts, HostWorkspace } from "./orchestrator.js";
import { ControlError } from "./protocol.js";
import { comparisonKey, type PathGuard } from "./workspace.js";

/** Omitted scope is reserved for trusted in-process callers; HTTP always supplies a list. */
export function hasWorkspaceScope(identity: CallerIdentity): boolean {
  return identity.workspaceIds !== undefined && !identity.workspaceIds.includes("*");
}

export function permitsWorkspace(identity: CallerIdentity, workspaceId: string | undefined): boolean {
  return !hasWorkspaceScope(identity) || (workspaceId !== undefined && identity.workspaceIds!.includes(workspaceId));
}

export function requireWorkspace(identity: CallerIdentity, workspaceId: string | undefined): void {
  if (!permitsWorkspace(identity, workspaceId)) throw scopeDenied();
}

function scopeDenied(): ControlError {
  return new ControlError("dsh-control/workspace-not-allowed", "target is outside the caller's workspace scope");
}

/** Query only explicitly granted registry entries, before any target Session is inspected. */
export async function scopedWorkspaces(identity: CallerIdentity, hosts: HostPorts): Promise<readonly HostWorkspace[]> {
  if (!hasWorkspaceScope(identity)) return await hosts.listWorkspaces();
  const items: HostWorkspace[] = [];
  for (const id of new Set(identity.workspaceIds)) {
    const item = await hosts.getWorkspace(id);
    if (item !== undefined) items.push(item);
  }
  return items;
}

/** Scoped path addressing may resolve an existing granted Workspace, never register a new one. */
export async function requireWorkspacePath(identity: CallerIdentity, hosts: HostPorts, path: string): Promise<HostWorkspace | undefined> {
  if (!hasWorkspaceScope(identity)) return undefined;
  const candidate = await realpath(path).catch(() => undefined);
  for (const item of await scopedWorkspaces(identity, hosts)) {
    const root = await realpath(item.path).catch(() => undefined);
    if (candidate !== undefined && root !== undefined && comparisonKey(candidate) === comparisonKey(root)) return item;
  }
  throw scopeDenied();
}

/** Registry membership is authoritative; a caller cannot substitute another Session's cwd. */
export async function requireSession(identity: CallerIdentity, hosts: HostPorts, sessionId: string): Promise<HostWorkspace | undefined> {
  if (!hasWorkspaceScope(identity)) return undefined;
  const workspace = (await scopedWorkspaces(identity, hosts)).find(item => item.sessionIds.includes(sessionId));
  if (workspace === undefined) throw scopeDenied();
  return workspace;
}

/** A scoped caller's document references stay in the selected Workspace. */
export function documentGuard(identity: CallerIdentity, guard: PathGuard): PathGuard {
  return hasWorkspaceScope(identity) ? { allowedRoots: [] } : guard;
}
