import type { Context } from "@deepseek-ai/cordis";
import type { InvariantInstaller } from "@deepseek-ai/dsh-invariants";

const PACKAGE_NAME = "@void/void-memory";

export const name = "void-memory-invariant";
export const inject = ["invariants"];

/**
 * No runtime invariant for the PoC store: it owns a per-instance in-memory
 * SQLite handle with no cross-session event protocol yet. Retrieval/store
 * semantics are exercised by the REAL-composition specs.
 */
const install: InvariantInstaller = () => {};

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
