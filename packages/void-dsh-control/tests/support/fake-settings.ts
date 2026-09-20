import type { Context } from "@deepseek-ai/cordis";

/**
 * Minimal in-memory stand-in for `ctx.settings`.
 *
 * Mirrors the three behaviours this plugin depends on, and nothing else:
 *
 * - `register(ns, schema, options)` resolves schema defaults → composition
 *   `base` → user section, in that order;
 * - the returned scope's `get()` re-resolves on every read, so a test can prove
 *   a value written mid-flight is picked up without re-registration;
 * - `watch()` fires after a write, and a section the registrant's `validate`
 *   refuses is **not stored** — which is what lets a test assert that the panel
 *   cannot persist something the runtime would reject.
 *
 * Deliberately not modelled: the raw document, revisions, secret redaction and
 * the `applies` timing. Those belong to the settings provider, and the plugin
 * reads none of them.
 */
export class FakeSettings {
  readonly registrations = new Map<string, Registration>();

  register<Value>(
    ns: string,
    schema: (value: unknown) => Value,
    options: { base?: Value; applies?: "live" | "restart"; validate?: (value: Value) => void } = {},
  ): { get: () => Value; watch: (listener: () => void) => () => void } {
    if (this.registrations.has(ns)) throw new Error(`settings namespace "${ns}" is already registered`);
    const registration: Registration = {
      ns,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schemastery's callable schema is untyped here.
      schema: schema as (value: unknown) => any,
      base: (options.base ?? {}) as Record<string, unknown>,
      validate: options.validate as ((value: unknown) => void) | undefined,
      user: undefined,
      listeners: new Set(),
    };
    this.registrations.set(ns, registration);
    return {
      get: () => resolve(registration) as Value,
      watch: (listener) => {
        registration.listeners.add(listener);
        return () => registration.listeners.delete(listener);
      },
    };
  }

  /**
   * Merge a section into the user layer, exactly as a settings-panel write would.
   *
   * @param ns - Namespace to write.
   * @param section - Fields to merge.
   * @throws Error when the registrant's `validate` refuses the result, in which
   *   case nothing is stored and no watcher fires.
   */
  update(ns: string, section: Record<string, unknown>): void {
    const registration = this.registrations.get(ns);
    if (registration === undefined) throw new Error(`settings namespace "${ns}" is not registered`);
    const next = { ...(registration.user ?? {}), ...section };
    const candidate = resolve({ ...registration, user: next });
    registration.validate?.(candidate);
    registration.user = next;
    for (const listener of registration.listeners) listener();
  }

  /** The stored user section, or `undefined` when nothing has been written. */
  user(ns: string): Record<string, unknown> | undefined {
    return this.registrations.get(ns)?.user;
  }

  /** The schema the plugin registered, for coverage assertions. */
  schemaOf(ns: string): ((value: unknown) => unknown) | undefined {
    return this.registrations.get(ns)?.schema;
  }
}

interface Registration {
  ns: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see register().
  schema: (value: unknown) => any;
  base: Record<string, unknown>;
  validate: ((value: unknown) => void) | undefined;
  user: Record<string, unknown> | undefined;
  listeners: Set<() => void>;
}

function resolve(registration: Registration): unknown {
  // schemastery fills defaults for absent keys and throws on an invalid value,
  // which is exactly the resolution order the real provider applies.
  return registration.schema({ ...registration.base, ...(registration.user ?? {}) });
}

/**
 * Provide a {@link FakeSettings} on a context.
 *
 * Uses `ctx.provide` rather than `ctx.plugin` because the plugin under test
 * reads settings through `ctx.get("settings")` — a non-requiring read — so the
 * service only has to exist before `apply` runs.
 *
 * @param ctx - Context to attach to.
 * @param settings - The fake.
 */
export function provideSettings(ctx: Context, settings: FakeSettings): void {
  ctx.provide("settings", settings as unknown as Parameters<Context["provide"]>[1]);
}
