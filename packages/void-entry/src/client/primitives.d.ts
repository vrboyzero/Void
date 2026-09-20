/**
 * Ambient types for `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * 这个包在运行时由**宿主的冻结模块表**提供（前端 bundle 里以
 * `"@deepseek-ai/dsh-client-ui-primitives"` 注册），**不装在 node_modules 里**，
 * 所以浏览器 bundle 必须把它当 external（见 `tsdown.config.ts` 的 `external`）。
 *
 * 为什么不直接当 devDependency 装进来取类型：它的 peerDependencies 是
 * `@deepseek-ai/cordis@^4.0.2`，而本 workspace 固定在 4.0.1。装进来会让 pnpm 把
 * 既有包的 peer 提升到 4.0.2，使 void-tools / void-legion / void-memory 报
 * `does not provide an export named 'CallId' / 'isJsonValue'`（方案文档 §20.1 的
 * 同一个陷阱）。
 *
 * 签名抄自 npm 上**与宿主同版**的 `@deepseek-ai/dsh-client-ui-primitives@0.1.5-rc.2`
 * 的 `lib/types/**`（下载 tarball 读取，未安装）。只声明本插件用到的成员；新增用法时
 * 请同样从该版本的类型文件里取，不要凭印象写。
 */

declare module "@deepseek-ai/dsh-client-ui-primitives" {
  import type {
    ButtonHTMLAttributes,
    InputHTMLAttributes,
    ReactElement,
    ReactNode,
  } from "react";

  export function Button(props: {
    variant?: "primary" | "ghost" | "outline" | "toolbar";
    size?: "md" | "sm";
    icon?: ReactNode;
    className?: string | undefined;
    children?: ReactNode;
  } & ButtonHTMLAttributes<HTMLButtonElement>): ReactElement;

  export function Input(props: {
    icon?: ReactNode;
    className?: string;
  } & InputHTMLAttributes<HTMLInputElement>): ReactElement;

  /**
   * 胶囊标签。给了 `onClick` 就是可点的（渲染成 button），否则是静态 span。
   * 用来做配置形态切换那一排。
   */
  export function Pill(props: {
    active?: boolean;
    className?: string | undefined;
    children?: ReactNode;
  } & ButtonHTMLAttributes<HTMLButtonElement>): ReactElement;

  /**
   * 受控开关。`label` 是无障碍名称，由调用方给本地化文案。
   */
  export function Switch(props: {
    checked: boolean;
    onChange: (next: boolean) => void;
    label: string;
    disabled?: boolean;
    title?: string | undefined;
    className?: string | undefined;
  }): ReactElement;

  /** 语义色点：绿=done / 琥珀=warning / 蓝环=ongoing / 红=error / 灰=idle。 */
  export type StateDotState = "done" | "warning" | "ongoing" | "error" | "idle";

  export function StateDot(props: {
    state: StateDotState;
    size?: number | undefined;
    className?: string | undefined;
  }): ReactElement;

  /**
   * 24px 折叠行外壳。`title` 是纯字符串；`collapsedContent` 在收起时显示
   * （用来放摘要），`children` 是展开后的内容。
   */
  export interface DisclosureRowProps {
    icon: ReactNode;
    title: string;
    open: boolean;
    expandable: boolean;
    onToggle: () => void;
    expandOnRowClick?: boolean | undefined;
    previewChevron?: boolean | undefined;
    keepContentWhenOpen?: boolean | undefined;
    collapsedContent?: ReactNode;
    children?: ReactNode;
    className?: string | undefined;
    rowClassName?: string | undefined;
    leadingClassName?: string | undefined;
    chevronClassName?: string | undefined;
    titleClassName?: string | undefined;
  }

  export function DisclosureRow(props: DisclosureRowProps): ReactElement;

  export function Tooltip(props: {
    label: string | (() => string);
    side?: "right" | "bottom" | "top";
    delayMs?: number;
    disabled?: boolean;
    maxWidth?: number;
    children: ReactElement;
  }): ReactElement;

  /**
   * 页内二次确认：主操作在调用方控制的勾选框被勾上前不可用。
   *
   * 四项文案（acknowledge / cancel / close / confirm）都由调用方给本地化值，宿主不
   * 内置文案。
   */
  export interface RiskConfirmationProps {
    open: boolean;
    title: string;
    description: string;
    acknowledgeLabel: string;
    cancelLabel: string;
    closeLabel: string;
    confirmLabel: string;
    acknowledged: boolean;
    disabled?: boolean;
    onAcknowledgedChange: (acknowledged: boolean) => void;
    onCancel: () => void;
    onConfirm: () => void;
  }

  export function RiskConfirmation(props: RiskConfirmationProps): ReactElement;

  /** 所有 `Icon*` 的共享 props；颜色跟随 `currentColor`。 */
  export interface IconProps {
    size?: number | undefined;
    className?: string | undefined;
  }

  /**
   * 写入宿主剪贴板：优先用异步 Clipboard API，在缺少它的宿主（jsdom、非安全上下文）
   * 上回退到 `execCommand('copy')`。
   *
   * @param text - 要放到剪贴板上的**原文**。
   * @returns 仅在宿主接受写入时为 true。
   */
  export function writeClipboard(text: string): Promise<boolean>;

  export function IconCordisPluginOutline14(props: IconProps): ReactElement;
  export function IconChevronDownOutline14(props: IconProps): ReactElement;
  export function IconChevronRightOutline14(props: IconProps): ReactElement;
  export function IconPlusOutline16(props: IconProps): ReactElement;
  export function IconTrashOutline16(props: IconProps): ReactElement;
  export function IconSearchOutline16(props: IconProps): ReactElement;
  export function IconWarningOutline16(props: IconProps): ReactElement;
  export function IconSparkle16(props: IconProps): ReactElement;
  export function IconQuestionOutline14(props: IconProps): ReactElement;
  export function IconSettingsOutline16(props: IconProps): ReactElement;
}
