/**
 * Client-side structural types + Context augmentation. A third-party plugin
 * resolves outside the DSH monorepo's single cordis instance, so the runtime
 * service augmentations (ctx.slots 等) do not reach this Context. We restate
 * the slots face structurally (mirror of @deepseek-ai/dsh-client-ui-slots).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { VoidWidgetsService } from './widgets.ts'

export interface VoidSlotRegisterOptions {
  name: string
  /** `list` 槽位的单元 id（同一 id 的条目按 priority 遮蔽）。 */
  id?: string
  /**
   * `keyed` 槽位的单元 key。
   *
   * `'main'` 就是 keyed 槽位：`key` 决定它是哪一个主面板，而
   * `sidebar.panellist` 的 `id` 要与它相等才能配对（侧栏按 id 选中主面板）。
   */
  key?: string
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
    /** 壳 A widget 注册表（由 void-entry client 半 `ctx.provide` 发布）。 */
    voidWidgets: VoidWidgetsService
  }
}

export type { Context }
