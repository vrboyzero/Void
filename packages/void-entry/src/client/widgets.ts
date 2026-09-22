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
  /** 只读文本。入口只显示，不提供编辑或保存。 */
  lines?: readonly string[];
  agentId?: string;
  selectionRevision?: number;
  /** 渲染体。结构无关：React 壳传 ReactNode，Web Component 壳传元素工厂。 */
  component: unknown;
}

/** 只读文本节点。用普通对象避开客户端渲染依赖，页面只负责原样显示。 */
export interface ReadOnlyWidgetNode {
  id: string;
  title: string;
  lines: readonly string[];
  agentId?: string;
  selectionRevision?: number;
}

/** 把已登记小部件收成只读行。没有 lines 的小部件不在这个列表里显示。 */
/** 只接受带 id、标题和非空文本行的响应。其他字段丢弃，避免接口夹带可执行内容。 */
export function parseFacetVersionPayload(payload: unknown): readonly ReadOnlyWidgetNode[] {
  if (typeof payload !== "object" || payload === null || !("versions" in payload) || !Array.isArray(payload.versions)) return [];
  return payload.versions.flatMap((item) => {
    if (typeof item !== "object" || item === null || !("id" in item) || !("title" in item) || !("lines" in item)) return [];
    const { id, title, lines } = item as { id: unknown; title: unknown; lines: unknown };
    if (typeof id !== "string" || typeof title !== "string" || !Array.isArray(lines) || lines.some((line) => typeof line !== "string") || lines.length === 0) return [];
    const agentId = "agentId" in item && typeof item.agentId === "string" ? item.agentId : undefined;
    const selectionRevision = "selectionRevision" in item && typeof item.selectionRevision === "number" ? item.selectionRevision : undefined;
    return [{ id, title, lines: lines as string[], ...(agentId ? { agentId } : {}), ...(selectionRevision !== undefined ? { selectionRevision } : {}) }];
  });
}

export function readOnlyWidgetLines(service: VoidWidgetsService): readonly ReadOnlyWidgetNode[] {
  return service.getWidgets().flatMap((widget) => {
    if (!widget.lines || widget.lines.length === 0) return [];
    const title = typeof widget.title === "function" ? widget.title() : widget.title;
    return [{
      id: widget.id,
      title,
      lines: widget.lines,
      ...("agentId" in widget && typeof widget.agentId === "string" ? { agentId: widget.agentId } : {}),
      ...("selectionRevision" in widget && typeof widget.selectionRevision === "number" ? { selectionRevision: widget.selectionRevision } : {}),
    }];
  });
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
