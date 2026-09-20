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
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

/**
 * Expand the same tilde prefixes dsh accepts in a configured harness home.
 * @param path - Configured path that may begin with `~`, `~/` or `~\`.
 * @returns The expanded path, or the input when no supported prefix is present.
 */
function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Resolve the user-level `.env` dsh reads on every launch.
 *
 * Mirrors `resolveDshHome()` from `@deepseek-ai/dsh-home-paths` so the printed
 * remediation points at a real file. It is deliberately a mirror rather than a
 * dependency: the message is advisory, and an extra peer dependency (with its
 * own version contract, and one more entry in every install's peer warning)
 * buys nothing a four-line computation does not.
 *
 * @param env - Environment source, injectable for tests.
 * @returns Absolute path of `<harness home>/.env`.
 */
export function userEnvFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["DSH_HOME"]?.trim();
  const home = configured !== undefined && configured.length > 0 ? configured : join(homedir(), ".dsh");
  return join(resolve(expandHomePath(home)), ".env");
}

/**
 * Compose the copy-paste fix for the platform the plugin is running on.
 *
 * The plugin runs inside the dsh process, so `process.platform` is the shell the
 * operator is actually looking at: under WSL dsh is a Linux process and its
 * operator types POSIX shell, not PowerShell. Printing one dialect everywhere
 * would hand half the users a command that cannot run.
 *
 * @param variable - Environment variable name the caller must set.
 * @param envFile - Absolute path of the user-level `.env`.
 * @param platform - Target platform, from `process.platform`.
 * @returns Two command lines, one that makes a secret and one that stores it.
 */
function tokenFixCommands(
  variable: string,
  envFile: string,
  platform: NodeJS.Platform,
): string[] {
  if (platform === "win32") {
    return [
      `    $t = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })`,
      `    Add-Content "${envFile}" "${variable}=$t"`,
    ];
  }
  // `od` + `tr` are in POSIX and every Linux distribution, so this needs no
  // openssl/python. The directory is created because a freshly installed WSL
  // home may not have been booted yet, and `>>` would then create a file in the
  // wrong place (or fail).
  return [
    `    t=$(od -An -tx1 -N32 /dev/urandom | tr -d ' \\n')`,
    `    mkdir -p "${dirname(envFile)}" && printf '%s\\n' "${variable}=$t" >> "${envFile}"`,
  ];
}

/**
 * Compose the operator-facing remediation printed when nothing can authenticate.
 *
 * The control plane fails closed on purpose, but a bare 401 tells an operator
 * nothing about *why* every request is refused, and the docs are a separate
 * repository read. This message carries the diagnosis, the exact one-line fix,
 * and where the full procedure lives, so the failure is self-service.
 *
 * The value is never included and never generated here: tokens stay a
 * user-supplied secret (plan §11), and guidance is not an exception.
 *
 * @param missingEnv - Configured token variables that were absent at activation.
 * @param envFile - User-level `.env` path, from {@link userEnvFilePath}.
 * @param platform - Target platform, from `process.platform`.
 * @returns A multi-line warning body containing no secret material.
 */
export function describeTokenSetup(
  missingEnv: readonly string[],
  envFile: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const names = missingEnv.length > 0 ? missingEnv.join(", ") : "the configured token variable";
  // A deployment normally configures one caller; naming that variable keeps the
  // copy-paste command correct for a custom `tokenEnv`.
  const variable = missingEnv[0] ?? "VOID_DSH_CONTROL_TOKEN";
  return [
    `no usable machine token (${names} unset) and allowAnonymous is false:`,
    "every request to the control endpoint will be rejected with 401",
    `  fix it once — dsh reads this file no matter which directory it is launched from:`,
    ...tokenFixCommands(variable, envFile, platform),
    `  then restart dsh; full procedure: docs/灵榜会话功能实现方案计划.md §25.3`,
  ].join("\n");
}
