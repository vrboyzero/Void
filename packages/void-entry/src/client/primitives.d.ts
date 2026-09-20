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
 * 声明逐字抄自 npm 上**与宿主同版**的 `@deepseek-ai/dsh-client-ui-primitives@0.1.5-rc.2`
 * 的 `lib/types/**`。宿主升级时改脚本里的 `HOST_VERSION` 再重跑。
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
   * @param props.size - 'md' 36px capsule (figma Button) or 'sm' 28px compact.
   * @param props.icon - optional leading 16px icon node.
   * @returns the button element; native button attributes pass through.
   */
  export function Button({ variant, size, icon, className, children, ...rest }: {
      variant?: ButtonVariant;
      size?: 'md' | 'sm';
      icon?: ReactNode;
      className?: string | undefined;
      children?: ReactNode;
  } & ButtonHTMLAttributes<HTMLButtonElement>): import("react").JSX.Element;

  /** Visual variant, each backed by its --dsw-alias-button-* token family. */
  export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar';

  /**
   * Render one disclosure header and its controlled expanded content.
   * @param props - Visual content, controlled state, and interaction policy.
   * @returns the disclosure row.
   */
  export function DisclosureRow({ icon, title, open, expandable, onToggle, expandOnRowClick, previewChevron, keepContentWhenOpen, collapsedContent, children, className, rowClassName, leadingClassName, chevronClassName, titleClassName, }: DisclosureRowProps): import("react").JSX.Element;

  /** Shared 24px disclosure chrome for compact flow rows. */
  export interface DisclosureRowProps {
      icon: ReactNode;
      title: string;
      open: boolean;
      expandable: boolean;
      onToggle: () => void;
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
      leadingClassName?: string | undefined;
      chevronClassName?: string | undefined;
      titleClassName?: string | undefined;
  }

  /** ic_ds_cordis_plugin_outline_14 */
  export const IconCordisPluginOutline14: ({ size, className }: IconProps) => import("react").JSX.Element;

  /** ic_ds_plus_outline_16 */
  export const IconPlusOutline16: ({ size, className }: IconProps) => import("react").JSX.Element;

  /** Shared props for every ic_ds_* icon component. */
  export interface IconProps {
      /** Square edge in px; defaults to the glyph's own drawn size. */
      size?: number | undefined;
      /** Extra class for layout placement; color rides currentColor.
       * (`| undefined` for exactOptionalPropertyTypes: callers forward their own optional prop.) */
      className?: string | undefined;
  }

  /** ic_ds_question_outline_14 (figma extract): ring + question glyph. */
  export const IconQuestionOutline14: ({ size, className }: IconProps) => import("react").JSX.Element;

  /** ic_ds_search_outline_16 */
  export const IconSearchOutline16: ({ size, className }: IconProps) => import("react").JSX.Element;

  /** ic_ds_settings_outline_16 */
  export const IconSettingsOutline16: ({ size, className }: IconProps) => import("react").JSX.Element;

  /** ic_ds_trash_outline_16 */
  export const IconTrashOutline16: ({ size, className }: IconProps) => import("react").JSX.Element;

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
   * @param props.size - outer diameter in px (default 10, the figma size).
   * @param props.className - extra class for layout placement.
   * @returns the dot element (aria-hidden; pair with text for accessibility).
   */
  export function StateDot({ state, size, className }: {
      state: StateDotState;
      size?: number | undefined;
      className?: string | undefined;
  }): import("react").JSX.Element;

  /**
   * State semantic: green done / amber user-attention / blue running ring /
   * red error / grey idle for a tracked subject with nothing in progress.
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
