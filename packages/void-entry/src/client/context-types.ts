/**
 * Client-side structural types + Context augmentation. A third-party plugin
 * resolves outside the DSH monorepo's single cordis instance, so the runtime
 * service augmentations (ctx.slots 等) do not reach this Context. We restate
 * the slots face structurally (mirror of @deepseek-ai/dsh-client-ui-slots).
 */
import type { Context } from '@deepseek-ai/cordis'

export interface VoidSlotRegisterOptions {
  name: string
  id?: string
  order?: number
  label?: string | (() => string)
  inject?: (...args: unknown[]) => Record<string, unknown>
  children?: Record<string, unknown>
}

export interface VoidSlotsService {
  register(options: VoidSlotRegisterOptions, component: unknown): () => void
  /** Wait for a slot's declaration lifetime; no-op while undeclared. */
  inject(key: string, callback: () => () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: VoidSlotsService
  }
}

export type { Context }
