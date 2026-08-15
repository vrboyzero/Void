import type { Context } from "@deepseek-ai/cordis";
import type { InvariantInstaller } from "@deepseek-ai/dsh-invariants";

const PACKAGE_NAME = "@void/void-seam-demo";

/** Cordis companion plugin name. */
export const name = "void-seam-demo-invariant";
/** Service required before the companion can reserve package ownership. */
export const inject = ["invariants"];

/**
 * No runtime invariant: the seam demo owns no service state or event protocol
 * of its own — the greeter service and `void_greet` tool are pure
 * request/response, and their lifecycle is exercised by the REAL-composition
 * specs (registration + HMR-safe disposal).
 */
const install: InvariantInstaller = () => {};

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
