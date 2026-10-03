/**
 * Ambient types for `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * **这个文件是生成的，不要手改。** 改用法后重跑：
 *
 * ```sh
 * node scripts/gen-primitives-types.mjs
 * ```
 *
 * 校验是否最新：`node scripts/gen-primitives-types.mjs --check`（落后则退出码 1）。
 *
 * 生成它的原因：该包在运行时由**宿主的冻结模块表**提供（前端 bundle 里以
 * `"@deepseek-ai/dsh-client-ui-primitives"` 注册），**不能装进 node_modules**——它的 peerDependencies 是
 * `@deepseek-ai/cordis@^4.0.2`，而本 workspace 固定在 4.0.1，装进来会把既有包的 peer
 * 提升到 4.0.2，使 void-tools / void-legion / void-memory 报
 * `does not provide an export named 'CallId' / 'isJsonValue'`（方案文档 §20.1）。
 *
 * 声明逐字抄自宿主同版的 `@deepseek-ai/dsh-client-ui-primitives` 的 `lib/types/**`：默认读**本机已装**
 * 的那份（可用环境变量 `DSH_HOST_PRIMITIVES_DIR` 指定），读不到才按 `HOST_VERSION`
 * 去 npm 取。宿主升级后重跑本脚本即可，不必先改常量。
 */

declare module "@deepseek-ai/dsh-client-ui-primitives" {
  import type {
    ButtonHTMLAttributes,
    InputHTMLAttributes,
    ReactNode,
  } from "react";

  /**
   * Render a button.
   * @param props.variant - visual family (default 'ghost').
   * @param props.size - 'md' 36px control with 12px corners or 'sm' 28px control with 8px corners.
   * @param props.icon - optional leading 16px icon node.
   * @param ref - native button for focus management and overlay anchors.
   * @returns the button element; native button attributes pass through.
   */
  export const Button: import("react").ForwardRefExoticComponent<{
      variant?: ButtonVariant;
      size?: "md" | "sm";
      icon?: ReactNode;
      className?: string | undefined;
      children?: ReactNode;
  } & ButtonHTMLAttributes<HTMLButtonElement> & import("react").RefAttributes<HTMLButtonElement>>;

  /** Visual variant, each backed by its --dsw-alias-button-* token family. */
  export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar';

  /**
   * Render one disclosure header and its controlled expanded content.
   * Shallow prop comparison requires stable callbacks and React nodes to skip unchanged renders.
   * @param props - Visual content, controlled state, and interaction policy.
   * @returns the disclosure row.
   */
  export const DisclosureRow: import("react").MemoExoticComponent<({ icon, title, open, expandable, onToggle, running, expandOnRowClick, previewChevron, keepContentWhenOpen, collapsedContent, children, className, rowClassName, contentClassName, contentLayoutClassName, leadingClassName, chevronClassName, titleClassName, }: DisclosureRowProps) => import("react").JSX.Element>;

  /** Shared 24px disclosure chrome for compact flow rows. */
  export interface DisclosureRowProps {
      icon: ReactNode;
      title: string;
      open: boolean;
      expandable: boolean;
      onToggle: () => void;
      /** Animate the complete header while its owning operation is running. */
      running?: boolean | undefined;
      /** Makes the complete title row the disclosure target. */
      expandOnRowClick?: boolean | undefined;
      /** Replaces the collapsed icon with a chevron while the row is hovered. */
      previewChevron?: boolean | undefined;
      /** Keeps `collapsedContent` inline while open. */
      keepContentWhenOpen?: boolean | undefined;
      collapsedContent?: ReactNode;
      children?: ReactNode;
      className?: string | undefined;
      rowClassName?: string | undefined;
      /** Sizing class for the header text area, beside the leading icon. */
      contentClassName?: string | undefined;
      /** Layout class shared by the header text and its decorative copy. */
      contentLayoutClassName?: string | undefined;
      leadingClassName?: string | undefined;
      chevronClassName?: string | undefined;
      titleClassName?: string | undefined;
  }

  /** Regular one-pixel IconCordisPluginOutline artwork. */
  export const IconCordisPluginOutlineRegular: (props: IconProps) => import("react").JSX.Element;

  /** Regular one-pixel IconPlusOutline artwork. */
  export const IconPlusOutlineRegular: (props: IconProps) => import("react").JSX.Element;

  /** Shared props for every product icon component. */
  export interface IconProps {
      /** Square edge in px; defaults to the glyph's own drawn size. */
      size?: number | undefined;
      /** Extra class for layout placement; color rides currentColor.
       * (`| undefined` for exactOptionalPropertyTypes: callers forward their own optional prop.) */
      className?: string | undefined;
  }

  /** Regular one-pixel IconQuestionOutline artwork. */
  export const IconQuestionOutlineRegular: (props: IconProps) => import("react").JSX.Element;

  /** Regular one-pixel IconSearchOutline artwork. */
  export const IconSearchOutlineRegular: (props: IconProps) => import("react").JSX.Element;

  /** Regular one-pixel IconSettingsOutline artwork. */
  export const IconSettingsOutlineRegular: (props: IconProps) => import("react").JSX.Element;

  /** Regular one-pixel IconTrashOutline artwork. */
  export const IconTrashOutlineRegular: (props: IconProps) => import("react").JSX.Element;

  /**
   * Render a text input with an optional leading icon.
   * @param props.icon - optional 16px leading icon node.
   * @returns wrapper span containing the native input; input attributes pass through.
   */
  export function Input({ icon, className, ...rest }: {
      icon?: ReactNode;
      className?: string;
  } & InputHTMLAttributes<HTMLInputElement>): import("react").JSX.Element;

  /**
   * Render a pill chip. Interactive when onClick is supplied (renders a button);
   * otherwise a static span.
   * @param props.active - selected/active visual state.
   * @returns pill element.
   */
  export function Pill({ active, className, children, onClick, ...rest }: {
      active?: boolean;
      className?: string | undefined;
      children?: ReactNode;
  } & ButtonHTMLAttributes<HTMLButtonElement>): import("react").JSX.Element;

  /**
   * Render one in-page confirmation whose primary action is unavailable until
   * the caller-controlled acknowledgement is checked.
   */
  export function RiskConfirmation({ open, title, description, acknowledgeLabel, cancelLabel, closeLabel, confirmLabel, acknowledged, disabled, onAcknowledgedChange, onCancel, onConfirm, }: RiskConfirmationProps): import("react").JSX.Element;

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

  /**
   * Render a state dot.
   * @param props.state - which of `done`, `warning`, `ongoing`, `error`, or `idle` to show.
   * @param props.size - outer diameter in px; defaults to 14 for ongoing and 10 for solid states.
   * @param props.className - extra class for layout placement.
   * @param props.appearance - compact dot by default; step uses a filled check or hollow pending circle.
   * @returns the dot element (aria-hidden; pair with text for accessibility).
   */
  export function StateDot({ state, size, className, appearance }: {
      state: StateDotState;
      size?: number | undefined;
      className?: string | undefined;
      appearance?: 'dot' | 'step';
  }): import("react").JSX.Element;

  /**
   * State semantic: green done / amber user-attention / tertiary-grey loading /
   * red error / neutral-grey idle for a tracked subject with nothing in progress.
   */
  export type StateDotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle';

  /**
   * Render a toggle switch.
   * @param props.checked - the current state; the control is fully controlled.
   * @param props.onChange - called with the state the click asks for.
   * @param props.label - localized accessible name, owned by the render site.
   * @param props.disabled - whether the control refuses input; owners also set it
   * while a write is in flight, not only when a deployment locks the toggle.
   * @param props.title - localized hover text, typically why the toggle is locked.
   * @param props.className - extra class for layout placement.
   * @returns the switch element.
   */
  export function Switch({ checked, onChange, label, disabled, title, className }: {
      checked: boolean;
      onChange: (next: boolean) => void;
      label: string;
      disabled?: boolean;
      title?: string | undefined;
      className?: string | undefined;
  }): import("react").JSX.Element;

  /**
   * Write text to the host clipboard, preferring the async Clipboard API and
   * falling back to `execCommand('copy')` on hosts (jsdom, insecure contexts)
   * that omit it.
   * @param text - the exact text to place on the clipboard.
   * @returns true only when the host accepted the write.
   */
  export function writeClipboard(text: string): Promise<boolean>;
}
