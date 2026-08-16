/**
 * void-core 配置合同骨架（P0）。
 *
 * 定义七类分类、配置优先级、脱敏与解析机制。282 项 void_native 的逐项 Schema
 * 由 `config/void-capabilities.json` 承载（机器真源，脚本生成）；本文件提供
 * 运行时读取/校验/脱敏的稳定机制，避免 Settings、CLI、Doctor 各自维护字段清单。
 */

export type ConfigClassification =
  | "void_native"
  | "dsh_mapped"
  | "plugin_internal"
  | "adapter_credential"
  | "development_only"
  | "legacy_or_omit"
  | "defer";

/**
 * 配置优先级（文档 12.4）：安全默认值 → profile/persisted settings → VOID_*
 * 部署环境覆盖 → 单次运行参数。数组顺序即优先级（低 → 高）。
 */
export const CONFIG_PRECEDENCE = ["defaults", "profile", "env", "args"] as const;
export type ConfigPrecedence = (typeof CONFIG_PRECEDENCE)[number];

export type ReloadMode = "live" | "restart";

export type FailureMode = "degrade" | "fail_closed" | "block";

export interface ConfigField {
  /** Void 配置名，如 "feishu.appId" 或 "VOID_FEISHU_APP_ID"。 */
  key: string;
  classification: ConfigClassification;
  /** 所属 Module（void-core / void-memory / void-tools / void-legion / ...）。 */
  owner: string;
  sensitive: boolean;
  reloadMode: ReloadMode;
  failureMode: FailureMode;
  /** 安全默认值。 */
  default?: unknown;
}

export interface ConfigSchema {
  fields: ConfigField[];
}

/** 脱敏：凭据类只保留前 4 位 + 后 2 位，中间打码；短值整体打码。 */
export function maskSecret(value: string): string {
  if (value.length <= 8) return "***";
  return value.slice(0, 4) + "***" + value.slice(-2);
}

/**
 * 按优先级解析一个字段的最终值：args > env > profile > defaults。
 * CONFIG_PRECEDENCE 是「低 → 高」（defaults → args），故从后往前遍历。
 * 高优先级层返回 undefined 会落到下一层。
 */
export function resolveValue<T>(
  layers: Partial<Record<ConfigPrecedence, T | undefined>>,
  fallback?: T,
): T | undefined {
  for (let i = CONFIG_PRECEDENCE.length - 1; i >= 0; i--) {
    const value = layers[CONFIG_PRECEDENCE[i]];
    if (value !== undefined) return value;
  }
  return fallback;
}

/** 校验一个字段：敏感字段必须是 adapter_credential 分类。 */
export function assertConfigField(field: ConfigField): void {
  if (field.sensitive && field.classification !== "adapter_credential") {
    throw new Error(
      `config field "${field.key}" is sensitive but classified as "${field.classification}" (expected adapter_credential)`,
    );
  }
}
