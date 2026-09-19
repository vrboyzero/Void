/**
 * Shared test double for {@link HostPorts}.
 *
 * Deliberately faithful to the port contract rather than to a specific test: it
 * records every delivery so a spec can assert that a rejected request never
 * reached the session, which is the property most of the security scenarios
 * depend on.
 */
import { ControlError } from "../../src/protocol.js";
import type { HostPorts, HostSession, HostWorkspace } from "../../src/orchestrator.js";

/** One delivery the orchestrator asked the host to perform. */
export interface RecordedDelivery {
  readonly kind: "prompt" | "inject" | "cancel";
  readonly sessionId: string;
  readonly requestId: string;
  readonly mode?: string;
  readonly text?: string;
}

/** In-memory stand-in for the DSH Workspace/Session/Agent controllers. */
export class FakeHosts implements HostPorts {
  readonly workspaces = new Map<string, HostWorkspace>();
  readonly sessions = new Map<string, HostSession>();
  readonly deliveries: RecordedDelivery[] = [];
  readonly registeredPaths: string[] = [];
  private counter = 0;
  /**
   * Gate that holds every prompt delivery open.
   *
   * Concurrency and shutdown tests need a delivery that has *started* but not
   * finished, which is exactly the window a race has to be observed in.
   */
  private promptGate: Promise<void> | undefined;

  /** Hold every subsequent prompt delivery until {@link releasePrompts}. */
  holdPrompts(): void {
    this.promptGate = new Promise<void>((resolve) => {
      this.releasePrompts = resolve;
    });
  }

  /** Let held prompt deliveries proceed. */
  releasePrompts: () => void = () => {};

  /**
   * Prompt deliveries that have *entered* the host.
   *
   * Counted before the gate so a test can wait for a delivery to be genuinely
   * in flight rather than merely scheduled.
   */
  startedPrompts = 0;

  /** Number of prompt deliveries that have entered the host. */
  get promptCount(): number {
    return this.deliveries.filter((delivery) => delivery.kind === "prompt").length;
  }

  seedWorkspace(path: string, sessionIds: string[] = []): HostWorkspace {
    const workspace: HostWorkspace = {
      workspaceId: `workspace-${++this.counter}`,
      path,
      title: path,
      sessionIds,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    this.workspaces.set(workspace.workspaceId, workspace);
    return workspace;
  }

  seedSession(sessionId: string, cwd: string, running = false): HostSession {
    const session: HostSession = { sessionId, cwd, running, blank: false, updatedAt: Date.parse("2026-01-02T00:00:00.000Z") };
    this.sessions.set(sessionId, session);
    return session;
  }

  async openWorkspace(path: string): Promise<HostWorkspace> {
    this.registeredPaths.push(path);
    const existing = [...this.workspaces.values()].find((workspace) => workspace.path === path);
    if (existing !== undefined) return existing;
    return this.seedWorkspace(path);
  }

  async listWorkspaces(): Promise<readonly HostWorkspace[]> {
    return [...this.workspaces.values()];
  }

  async getWorkspace(workspaceId: string): Promise<HostWorkspace | undefined> {
    return this.workspaces.get(workspaceId);
  }

  async listSessions(): Promise<readonly HostSession[]> {
    return [...this.sessions.values()];
  }

  async createSession(request: { workspaceId?: string; cwd?: string }): Promise<{ sessionId: string }> {
    const sessionId = `session-${++this.counter}`;
    const workspace = request.workspaceId === undefined ? undefined : this.workspaces.get(request.workspaceId);
    if (workspace !== undefined) {
      this.workspaces.set(workspace.workspaceId, { ...workspace, sessionIds: [...workspace.sessionIds, sessionId] });
    }
    this.seedSession(sessionId, request.cwd ?? workspace?.path ?? "");
    return { sessionId };
  }

  async forkSession(request: { sessionId: string }): Promise<{ sessionId: string }> {
    const source = this.sessions.get(request.sessionId);
    if (source === undefined) throw new ControlError("dsh-control/session-not-found", "no such session");
    const sessionId = `session-${++this.counter}`;
    this.seedSession(sessionId, source.cwd ?? "");
    return { sessionId };
  }

  async inspectSession(sessionId: string): Promise<{ exists: boolean; cwd?: string }> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return { exists: false };
    return { exists: true, ...(session.cwd === undefined ? {} : { cwd: session.cwd }) };
  }

  async promptSession(request: { requestId: string; sessionId: string; mode: "queue" | "steer"; text: string }): Promise<void> {
    this.startedPrompts += 1;
    const gate = this.promptGate;
    if (gate !== undefined) await gate;
    this.deliveries.push({
      kind: "prompt",
      sessionId: request.sessionId,
      requestId: request.requestId,
      mode: request.mode,
      text: request.text,
    });
  }

  async injectContext(request: { sessionId: string; text: string; requestId: string }): Promise<void> {
    this.deliveries.push({ kind: "inject", sessionId: request.sessionId, requestId: request.requestId, text: request.text });
  }

  async cancelSession(sessionId: string): Promise<void> {
    this.deliveries.push({ kind: "cancel", sessionId, requestId: "" });
  }
}
