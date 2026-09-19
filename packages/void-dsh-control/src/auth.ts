/**
 * Machine-caller authentication and authorization for the Lingbang control
 * plane (plan §11).
 *
 * Tokens come from the environment only. They are never read from
 * `settings.yaml`, `cordis.patch.yml` or the session log, and they are compared
 * in constant time over fixed-length digests so neither the value nor its length
 * leaks through timing. A failed authentication returns one generic
 * `unauthorized` error regardless of the reason.
 *
 * @module @void/void-dsh-control/auth
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { ControlError, expandOperations, type ControlOperation } from "./protocol.js";

/** One configured machine token and the identity it authenticates as. */
export interface TokenGrant {
  /** Stable caller identity used for idempotency scoping and auditing. */
  readonly callerId: string;
  /** Raw bearer token value, read from an environment variable at activation. */
  readonly token: string;
  /** Operations this token may perform. */
  readonly operations: readonly ControlOperation[];
}

/** Authentication policy for the MCP endpoint. */
export interface AuthPolicy {
  readonly tokens: readonly TokenGrant[];
  /**
   * Allow unauthenticated access. Exists only so a loopback smoke test can run
   * without minting a secret; it is never enabled by default and never grants
   * more than the caller configured.
   */
  readonly allowAnonymous: boolean;
}

/** An authenticated caller. */
export interface CallerIdentity {
  readonly callerId: string;
  readonly operations: ReadonlySet<ControlOperation>;
}

/** Digest helper: fixed-length input for {@link timingSafeEqual}. */
function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Compare two secrets without leaking length or prefix through timing.
 *
 * @param provided - Value presented by the caller.
 * @param expected - Configured value.
 * @returns True when the values are identical.
 */
export function constantTimeEquals(provided: string, expected: string): boolean {
  return timingSafeEqual(digest(provided), digest(expected));
}

/** Resolves bearer credentials to caller identities and enforces operations. */
export class Authenticator {
  private readonly policy: AuthPolicy;

  constructor(policy: AuthPolicy) {
    this.policy = policy;
  }

  /** Whether any token is configured, i.e. whether the endpoint can authenticate. */
  get hasTokens(): boolean {
    return this.policy.tokens.length > 0;
  }

  /**
   * Authenticate an `Authorization` header.
   *
   * @param header - Raw header value, or `undefined` when absent.
   * @returns The authenticated caller.
   * @throws ControlError `dsh-control/unauthorized` for every failure mode.
   */
  authenticate(header: string | undefined): CallerIdentity {
    const presented = extractBearer(header);

    if (presented === undefined) {
      if (this.policy.allowAnonymous) {
        return { callerId: "anonymous", operations: expandOperations(this.unionOfOperations()) };
      }
      throw unauthorized();
    }

    // Every configured token is compared, and the loop does not exit early on a
    // match, so the number of comparisons does not depend on which token matched.
    let matched: TokenGrant | undefined;
    for (const grant of this.policy.tokens) {
      if (constantTimeEquals(presented, grant.token)) matched = grant;
    }

    if (matched === undefined) {
      if (this.policy.allowAnonymous && this.policy.tokens.length === 0) {
        return { callerId: "anonymous", operations: expandOperations(this.unionOfOperations()) };
      }
      throw unauthorized();
    }

    return { callerId: matched.callerId, operations: expandOperations(matched.operations) };
  }

  /**
   * Assert that an authenticated caller holds an operation.
   *
   * @param identity - Authenticated caller.
   * @param operation - Operation the tool needs.
   * @throws ControlError `dsh-control/forbidden-operation` when the grant is missing.
   */
  require(identity: CallerIdentity, operation: ControlOperation): void {
    if (identity.operations.has(operation)) return;
    throw new ControlError("dsh-control/forbidden-operation", `caller is not permitted to perform ${operation}`, {
      operation,
    });
  }

  /** Operations any configured token holds; used only for anonymous mode. */
  private unionOfOperations(): ControlOperation[] {
    const out = new Set<ControlOperation>();
    for (const grant of this.policy.tokens) {
      for (const operation of grant.operations) out.add(operation);
    }
    return [...out];
  }
}

/**
 * Extract a bearer token from an `Authorization` header value.
 *
 * @param header - Raw header value.
 * @returns The token, or `undefined` when the header is absent or malformed.
 */
export function extractBearer(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token === undefined || token.length === 0 ? undefined : token;
}

/**
 * Build the single generic authentication failure.
 *
 * @returns The error to throw; it never states whether a token exists.
 */
function unauthorized(): ControlError {
  return new ControlError("dsh-control/unauthorized", "missing or invalid credentials");
}

/**
 * Read token grants from the environment.
 *
 * A grant whose environment variable is unset is dropped. Dropping is reported
 * by the caller so an operator sees that a token silently has no effect instead
 * of discovering it through a 401.
 *
 * @param specs - Configured `callerId` / environment-variable-name / operations triples.
 * @param env - Environment source, injectable for tests.
 * @returns Resolved grants plus the names that were absent.
 */
export function readTokenGrants(
  specs: readonly { callerId: string; tokenEnv: string; operations: readonly ControlOperation[] }[],
  env: NodeJS.ProcessEnv = process.env,
): { grants: TokenGrant[]; missingEnv: string[] } {
  const grants: TokenGrant[] = [];
  const missingEnv: string[] = [];
  for (const spec of specs) {
    const token = env[spec.tokenEnv];
    if (token === undefined || token.trim().length === 0) {
      missingEnv.push(spec.tokenEnv);
      continue;
    }
    grants.push({ callerId: spec.callerId, token: token.trim(), operations: spec.operations });
  }
  return { grants, missingEnv };
}
