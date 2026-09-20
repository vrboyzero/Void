import type { Context } from "@deepseek-ai/cordis";

/**
 * Minimal in-memory stand-in for `ctx.settings`.
 *
 * Mirrors the three behaviours this plugin depends on, and nothing else:
 *
 * - `installSection(owner, ns, schema, entry, hooks)` resolves schema defaults →
 *   composition `entry` → user section, in that order, and drives the consumer
 *   through `setSource`/`onChange` at attach and at detach;
 * - reads re-resolve every time, so a test can prove a value written mid-flight
 *   is picked up without re-registration;
 * - a section the registrant's `validate` refuses is **not stored** and no
 *   listener fires — which is what lets a test assert that the panel cannot
 *   persist something the runtime would reject.
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
   * Attach one consumer through the official section hook.
   *
   * The real provider layers the consumer's composition `entry` under the user
   * document while it is present, and hands back the bare `entry` when it
   * detaches — notifying through `setSource` before each `onChange`. Modelled
   * here so the plugin's use of the official API is exercised rather than a
   * private stand-in with the same name.
   *
   * @param owner - Consumer context; its unload detaches the section.
   * @param ns - Consumer-owned namespace.
   * @param schema - Schema resolving the namespace.
   * @param entry - Composition entry used as base and fallback.
   * @param hooks - Source sink, change notification, and optional validation.
   */
  installSection<Value>(
    owner: Context,
    ns: string,
    schema: (value: unknown) => Value,
    entry: Value,
    hooks: {
      setSource: (current: () => Value) => void;
      onChange: () => void;
      validate?: (value: Value) => void;
    },
  ): void {
    if (this.registrations.has(ns)) throw new Error(`settings namespace "${ns}" is already registered`);
    const registration: Registration = {
      ns,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schemastery's callable schema is untyped here.
      schema: schema as (value: unknown) => any,
      base: entry as Record<string, unknown>,
      validate: hooks.validate as ((value: unknown) => void) | undefined,
      user: undefined,
      listeners: new Set(),
    };
    this.registrations.set(ns, registration);
    // Attach: the resolved scope becomes the source, then the consumer is told.
    hooks.setSource(() => resolve(registration) as Value);
    hooks.onChange();
    // Detach when the consumer unloads: authority returns to the entry.
    owner.effect(() => () => {
      this.registrations.delete(ns);
      hooks.setSource(() => entry);
      hooks.onChange();
    }, `fake-settings: ${ns}`);
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

  /** Whether a namespace is currently registered. */
  has(ns: string): boolean {
    return this.registrations.has(ns);
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
