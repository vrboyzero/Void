/**
 * Service Definition for the Lingbang control plane.
 *
 * Registering the control plane as a Cordis service (rather than keeping it
 * private to the MCP route) means another plugin, a test, or a future transport
 * can drive the same orchestrator without going through HTTP — and it keeps the
 * MCP layer a pure consumer, exactly as DSH's composition rules require.
 *
 * @module @void/void-dsh-control/service
 */
import { Service, type Context } from "@deepseek-ai/cordis";
import type { Authenticator } from "./auth.js";
import type { CompiledCallerPolicy } from "./policy.js";
import type { ControlLedger } from "./ledger.js";
import type { ControlOrchestrator, HostPorts } from "./orchestrator.js";
import type { PathGuard } from "./workspace.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Host control plane for the running Web profile. */
    voidDshControl: DshControl;
  }
}

/** Composition facts the control plane exposes to other consumers. */
export interface DshControlOptions {
  readonly orchestrator: ControlOrchestrator;
  readonly ledger: ControlLedger;
  readonly hosts: HostPorts;
  readonly authenticator: Authenticator;
  /** Live policy accessor; settings changes are visible without a reload. */
  readonly policy: () => CompiledCallerPolicy;
  /** Live path guard accessor. */
  readonly guard: () => PathGuard;
  /** MCP endpoint path actually registered, for diagnostics and docs. */
  readonly endpointPath: string;
}

/** Host control plane service backing `ctx.voidDshControl`. */
export class DshControl extends Service {
  /** Task/workspace/session orchestration. */
  readonly orchestrator: ControlOrchestrator;
  /** Control-plane persistence. */
  readonly ledger: ControlLedger;
  /** Host adapter the orchestrator talks through. */
  readonly hosts: HostPorts;
  /** Bearer-token authentication and operation grants. */
  readonly authenticator: Authenticator;
  /** MCP path this control plane is served on. */
  readonly endpointPath: string;

  private readonly policyAccessor: () => CompiledCallerPolicy;
  private readonly guardAccessor: () => PathGuard;

  /**
   * @param ctx - Context that owns the service registration.
   * @param options - Composition facts gathered by the plugin entry.
   */
  constructor(ctx: Context, options: DshControlOptions) {
    super(ctx, "voidDshControl");
    this.orchestrator = options.orchestrator;
    this.ledger = options.ledger;
    this.hosts = options.hosts;
    this.authenticator = options.authenticator;
    this.endpointPath = options.endpointPath;
    this.policyAccessor = options.policy;
    this.guardAccessor = options.guard;
  }

  /** The user's currently resolved caller policy. */
  get policy(): CompiledCallerPolicy {
    return this.policyAccessor();
  }

  /** The currently resolved path policy. */
  get guard(): PathGuard {
    return this.guardAccessor();
  }
}

export default DshControl;
