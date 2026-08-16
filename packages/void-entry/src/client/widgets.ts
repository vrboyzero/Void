/**
 * 壳 A 服务化 widget 扩展点（借鉴 dsh-better-sidebar 的 `ctx.betterSidebar` 模式）。
 *
 * 目的：让 void-legion（组织图）、各 void 插件（工具卡片 / 进度视图）通过
 * `ctx.voidWidgets.registerWidget(...)` 注册自己的 UI 扩展，而不是各自硬编码
 * 挂 slot。内置 widget 与第三方 widget 走同一注册表，能力完全对等。
 *
 * 关键设计（对齐文档 11.10 / 11.11 P2）：
 * - 服务工厂是纯逻辑（Map + listener set），不依赖 React / DOM，可脱离渲染单测；
 * - `component` 字段用结构无关的 `unknown`，不绑定 React 类型——复杂 widget 后续
 *   优先 Web Component，React 壳用薄 wrapper 挂载；
 * - `registerWidget` 返回 disposer，由 `ctx.effect` 包裹即 HMR-safe。
 */

export interface VoidWidgetDescriptor {
  /** 唯一 id，建议带包前缀：'void-legion:org-chart'。 */
  id: string;
  /** 标题（i18n 友好：字符串或返回字符串的函数）。 */
  title: string | (() => string);
  /** 排序（升序）；默认 100。 */
  order?: number;
  /** 渲染体。结构无关：React 壳传 ReactNode，Web Component 壳传元素工厂。 */
  component: unknown;
}

export interface VoidWidgetsService {
  /** 注册一个 widget；返回 disposer（重复 id 抛错）。 */
  registerWidget(descriptor: VoidWidgetDescriptor): () => void;
  /** 当前已注册 widget 快照（按 order 升序）。 */
  getWidgets(): readonly VoidWidgetDescriptor[];
  /** 订阅注册表变化（register/dispose 时触发）；返回 disposer。 */
  subscribe(listener: () => void): () => void;
}

/**
 * 创建壳 A 的 widget 注册表服务。纯逻辑，无副作用；发布侧用
 * `ctx.provide("voidWidgets", createVoidWidgetsService())` 挂到 client context。
 */
export function createVoidWidgetsService(): VoidWidgetsService {
  const widgets = new Map<string, VoidWidgetDescriptor>();
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  return {
    registerWidget(descriptor) {
      if (widgets.has(descriptor.id)) {
        throw new Error(`void widget "${descriptor.id}" already registered`);
      }
      widgets.set(descriptor.id, descriptor);
      emit();
      return () => {
        widgets.delete(descriptor.id);
        emit();
      };
    },
    getWidgets() {
      return [...widgets.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
