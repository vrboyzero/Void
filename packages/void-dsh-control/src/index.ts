/**
 * `@void/void-dsh-control` — Lingbang (灵榜) control plane.
 *
 * A Cordis function plugin that runs inside the DeepSeek Harness Web profile and
 * exposes that same profile's Workspace, Session and Agent capability to external
 * agents over an MCP Streamable HTTP endpoint.
 *
 * Composition order (plan §12):
 * 1. resolve configuration, tokens, allowed roots and the caller policy;
 * 2. open the control-plane ledger;
 * 3. build the host ports, orchestrator and control service;
 * 4. subscribe to the host events that drive task status;
 * 5. register the MCP route on the existing `webServer`.
 *
 * Everything is registered as one Cordis effect, so unloading the plugin stops
 * new requests, quiesces the orchestrator and removes the route.
 *
 * @module @void/void-dsh-control
 */
import { type Context, type Volatile } from "@deepseek-ai/cordis";
// Type-only side-effect imports: they load the `declare module` augmentations
// that put `webServer` / `settings` on `Context`.
import type {} from "@deepseek-ai/dsh-host-webserver";
import type {} from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";
import { Authenticator, describeTokenSetup, readTokenGrants, userEnvFilePath, type AuthPolicy } from "./auth.js";
import { WebhookCallbackDispatcher, resolveCallbackUrl } from "./callback.js";
import { LEGION_RUN_TERMINAL_EVENT, LegionRunDelivery } from "./legion-delivery.js";
import type { LegionServiceLike } from "./legion-delivery.js";
import { CONTROL_OPERATIONS, ControlError, SETTINGS_NAMESPACE, type ControlOperation } from "./protocol.js";
import { compilePolicy, EMPTY_CALLER_POLICY, type CallerPolicy, type CompiledCallerPolicy } from "./policy.js";
import { MemoryControlLedger, StorageControlLedger, type ControlLedger } from "./ledger.js";
import { controlDomainSpec } from "./ledger.js";
import { createHostPorts } from "./hosts.js";
import { registerVoidPanel } from "./panel.js";
import { ControlOrchestrator } from "./orchestrator.js";
import { createMcpHttpHandler } from "./mcp.js";
import { DshControl } from "./service.js";
import { resolveAllowedRoots } from "./workspace.js";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  isNewerSessionSeq,
  signalFromAgentError,
  signalFromAgentStatus,
  signalsFromSessionEvent,
  type SessionEventLike,
} from "./events.js";

/** Runtime name of the plugin. */
export const name = "void-dsh-control";

/** Services that must be present before the control plane can start. */
export const inject = ["webServer", "sessionController", "workspaceController"];

/** One configured machine token. */
export interface TokenConfig {
  /** Stable caller identity used for idempotency scoping and auditing. */
  callerId: string;
  /** Environment variable holding the raw token. Never inline the value here. */
  tokenEnv: string;
  /** Operations this token may perform. */
  operations: string[];
}

/**
 * One required-document rule, **as parsed**.
 *
 * 四个字段在 schema 里都带 `.default()`，所以解析结果里它们一律存在——写成可选会让
 * `Config` 与 `z.object(...)` 的实际输出对不上（`skipLibCheck` 之外的类型检查会拦下）。
 */
export interface DocumentRuleConfig {
  id: string;
  description: string;
  required: boolean;
  /** Empty string means "any path satisfies this rule". */
  pathPattern: string;
}

/**
 * Optional HMAC-signed callback webhook (plan §9.2). Disabled by default.
 *
 * 同上：全字段是**解析后**的形状，schema 的 `.default()` 保证了它们存在。
 */
export interface CallbackConfig {
  enabled: boolean;
  url: string;
  secretEnv: string;
  events: string[];
  timeoutMs: number;
  maxAttempts: number;
  /** Host allowlist; empty means "accept the configured URL as written". */
  allowedHosts: string[];
  /** Whether the payload may carry model-produced assistant text. */
  includeAssistantSummary: boolean;
  /**
   * Whether legion run-terminal events ride the same webhook (plan §16.2 L9).
   *
   * One switch on the existing target: same URL, secret, allowlist, timeout,
   * retry budget and event filter. Legion is not required — without it the
   * adapter simply never mounts.
   */
  includeLegionRuns: boolean;
}

/**
 * Plugin configuration, as written in a profile's `cordis.patch.yml`.
 *
 * **两类字段的区别是有意的，不是疏漏。** `enabled` / `transport` / `path` / `ledger` 是
 * 启动项——它们决定插件是否加载、挂在哪个路径、账本落在哪里，改一次要重启，所以是普通值。
 * 其余字段在 schema 里标了 `.volatile()`，宿主把它们包成**稳定引用**（`get()` 取当前快照，
 * 引用本身不变、值就地更新），所以面板改完下一次读取就生效、不用重启。
 *
 * 这个划分同时决定设置面板里能看见什么：dsh 0.2.0 的表单由入口的 `Config` 派生，
 * **且只暴露 volatile 字段**——启动项因此自动不出现在表单里，由面板的只读区展示。
 */
export interface Config {
  /** Master switch. `false` keeps the plugin inert so rollback is one line. */
  enabled: boolean;
  /** Transport. Only `streamable-http` is accepted; the schema rejects anything else. */
  transport: "streamable-http";
  /** Absolute endpoint path registered on the existing WebServer. */
  path: string;
  /** Machine tokens. An empty list plus `allowAnonymous: false` refuses every caller. */
  tokens: Volatile<TokenConfig[]>;
  /** Grant every configured operation without a token. Loopback smoke tests only. */
  allowAnonymous: Volatile<boolean>;
  /** Roots a caller may address by path. Empty disables path addressing entirely. */
  allowedRoots: Volatile<string[]>;
  /** Operations granted when a token omits its own list. */
  allowedOperations: Volatile<string[]>;
  /** Ledger backend. `memory` loses task history on restart and is not for production. */
  ledger: "storage" | "memory";
  /** Free-form instructions returned by `dsh_control_info`. */
  callerInstructions: Volatile<string>;
  /** Metadata fields every dispatch must supply non-empty. */
  requiredFields: Volatile<string[]>;
  /** Document requirements every dispatch must satisfy. */
  requiredDocumentRules: Volatile<DocumentRuleConfig[]>;
  /** Regular expressions whose match anywhere in caller text is rejected. */
  forbiddenPatterns: Volatile<string[]>;
  /** Monotonic version the user bumps when the rules change. */
  instructionsVersion: Volatile<number>;
  /** Optional callback webhook; disabled by default. */
  callback: Volatile<CallbackConfig>;
}

/**
 * Schemastery schema for {@link Config}.
 *
 * **注解写成 `z<any, Config>` 是刻意的**：schemastery 的默认导出同时是类型
 * `Schema<S, T, Mode>` 和值，`z<Config>` 展开即 `Schema<Config, Config, 'plain'>`。
 * 但带 `.volatile()` 的 schema，其输入面（用户写进 `cordis.patch.yml` 的裸形状）与输出面
 * （解析后带 `Volatile` 引用）**并不相同**，`z<Config>` 要求两者都是 `Config`，必然对不上
 * ——宿主自家的 `web-search-deepseek` 等带 volatile 字段的插件同样不写单参形式。
 * 这里放开输入面、钉住输出面 `Config`，顺带让生成出的 `.d.ts` 有个可命名的类型
 * （否则 TS2742：推断类型会引用我们并未直接依赖的 `cosmokit`）。
 * `Config` 接口仍是 `apply` 的入参类型。
 */
export const Config: z<any, Config> = z.object({
  enabled: z.boolean().default(true).description("主开关。设为 false 时插件完全不注册端点，回滚只需改这一行。"),
  // 只有 Streamable HTTP 实现了，而**没有任何代码读这个值**（路由那边直接构造
// StreamableHTTPServerTransport）。自由字符串意味着 `transport: sse` 会被静默接受、
// 然后什么都不发生。改成常量，配错在加载时就被 schema 拒绝。
transport: z.const("streamable-http").default("streamable-http").description("传输方式，目前只实现 Streamable HTTP。"),
  path: z.string().default("/mcp/dsh-agent-control").description("挂到现有 WebServer 上的精确路径。"),
  tokens: z
    .array(
      z.object({
        callerId: z.string().required().description("调用方身份，用于幂等作用域与审计。"),
        tokenEnv: z.string().required().description("保存 token 的环境变量名；不要把 token 本身写进配置。"),
        operations: z.array(z.string()).default([]).description("该 token 允许的操作；留空则用 allowedOperations。"),
      }),
    )
    .default([])
    .volatile()
    .description("机器调用凭据。token 只从环境变量读取。"),
  allowAnonymous: z.boolean().default(false).volatile().description("允许无 token 调用。仅用于本机 smoke 测试，默认关闭。"),
  allowedRoots: z.array(z.string()).default([]).volatile().description("允许按路径寻址的根目录。留空则完全禁用路径寻址。"),
  allowedOperations: z
    .array(z.string())
    .default(["workspace.read", "workspace.open", "session.list", "session.create", "session.prompt", "session.plan", "session.observe"])
    .volatile()
    .description("token 未显式声明 operations 时使用的默认授权集合。"),
  ledger: z.union([z.const("storage"), z.const("memory")]).default("storage").description("账本后端。memory 重启即丢，不用于生产。"),
  callerInstructions: z.string().default("").volatile().description("dsh_control_info 返回给外部 Agent 的调用约束正文。"),
  requiredFields: z.array(z.string()).default([]).volatile().description("每次下单必须非空提供的 metadata 字段。"),
  requiredDocumentRules: z
    .array(
      z.object({
        id: z.string().required(),
        description: z.string().default(""),
        required: z.boolean().default(true),
        pathPattern: z.string().default("").description("匹配工作区相对路径的正则；留空表示任意路径都满足。"),
      }),
    )
    .default([])
    .volatile()
    .description("任务文档要求。"),
  forbiddenPatterns: z.array(z.string()).default([]).volatile().description("命中即拒绝的正则；用于禁止密钥等内容进入会话。"),
  instructionsVersion: z.natural().default(0).volatile().description("规则版本号，用户改动规则时递增。"),
  callback: z
    .object({
      enabled: z.boolean().default(false),
      url: z.string().default(""),
      secretEnv: z.string().default("VOID_DSH_CONTROL_CALLBACK_SECRET"),
      events: z.array(z.string()).default(["completed", "failed", "cancelled"]),
      timeoutMs: z.natural().default(10_000),
      maxAttempts: z.natural().default(5),
      allowedHosts: z.array(z.string()).default([]).description("回调 URL 主机白名单；留空表示接受配置里写的地址。"),
      includeAssistantSummary: z.boolean().default(false).description("是否把模型产出的助手摘要放进回调负载（默认不发送）。"),
      includeLegionRuns: z.boolean().default(false).description("是否把军团的运行终态也投给同一个 webhook（默认关闭）。"),
    })
    .default({
      enabled: false,
      url: "",
      secretEnv: "VOID_DSH_CONTROL_CALLBACK_SECRET",
      events: ["completed", "failed", "cancelled"],
      timeoutMs: 10_000,
      maxAttempts: 5,
      allowedHosts: [],
      includeAssistantSummary: false,
      includeLegionRuns: false,
    })
    .volatile()
    .description("可选回调 webhook，默认关闭。"),
});

/**
 * Parse a configured operation list, failing loud on an unknown name.
 *
 * @param values - Configured operation names.
 * @param what - Configuration field name, for the error message.
 * @returns The validated operations.
 * @throws ControlError `dsh-control/internal` on an unknown operation.
 */
function parseOperations(values: readonly string[], what: string): ControlOperation[] {
  const known = new Set<string>(CONTROL_OPERATIONS);
  const out: ControlOperation[] = [];
  for (const value of values) {
    if (!known.has(value)) {
      throw new ControlError("dsh-control/internal", `${what} names an unknown operation`, { operation: value });
    }
    out.push(value as ControlOperation);
  }
  return out;
}

/**
 * Resolved shape of the `dsh-agent-control` settings section.
 *
 * Distinct from {@link CallerPolicy} because a settings document always carries
 * every field (schema defaults fill the gaps), while the policy type models an
 * omitted `pathPattern` as absent.
 *
 * **What is deliberately absent**: `enabled`, `transport`, `path` and `ledger`.
 * Those decide whether the plugin loads at all, which path it mounts on, and
 * which ledger backend holds the task records — they are composition-entry
 * concerns (plan §11). dsh's settings service declares one `applies` per
 * namespace, so mixing them in would either mislabel them as live or label the
 * whole section restart-only; the settings panel renders them read-only with a
 * pointer to the composition file instead (plan §29.4).
 */
interface ControlSection {
  allowedOperations: string[];
  allowAnonymous: boolean;
  tokens: { callerId: string; tokenEnv: string; operations: string[] }[];
  allowedRoots: string[];
  callerInstructions: string;
  requiredFields: string[];
  requiredDocumentRules: { id: string; description: string; required: boolean; pathPattern: string }[];
  forbiddenPatterns: string[];
  instructionsVersion: number;
  callback: {
    enabled: boolean;
    url: string;
    secretEnv: string;
    events: string[];
    timeoutMs: number;
    maxAttempts: number;
    allowedHosts: string[];
    includeAssistantSummary: boolean;
    includeLegionRuns: boolean;
  };
}

/**
 * Reject a section the plugin could not act on.
 *
 * 0.1.x 时这段跑在 `installSection` 的 `validate` 钩子上，所以面板**存不进**运行时无法
 * 接受的值。0.2.0 的写入路径只按 schema 逐字段验，没有跨字段钩子，于是校验挪到**读取点**
 * （见 `createConfigSource` 的 `read`）：坏值仍会大声失败，只是失败点从「写入时」后移到
 * 「最接近使用的地方」。
 *
 * Cross-field rules live here because schemastery cannot express them; the regex and
 * operation-name checks reuse the same parsers the runtime uses, so a stored value
 * cannot make the endpoint behave differently from what the panel showed.
 *
 * @param value - The resolved section, schema-valid by construction.
 * @throws ControlError when the section is unusable.
 */
function validateSection(value: ControlSection): void {
  parseOperations(value.allowedOperations, "allowedOperations");
  for (const token of value.tokens) {
    if (token.operations.length > 0) {
      parseOperations(token.operations, `tokens[${token.callerId}].operations`);
    }
  }
  compilePolicy({
    callerInstructions: value.callerInstructions,
    requiredFields: value.requiredFields,
    requiredDocumentRules: value.requiredDocumentRules.map((rule) => ({
      id: rule.id,
      description: rule.description,
      required: rule.required,
      ...(rule.pathPattern === "" ? {} : { pathPattern: rule.pathPattern }),
    })),
    forbiddenPatterns: value.forbiddenPatterns,
    instructionsVersion: value.instructionsVersion,
  });
  // resolveCallbackUrl is what the dispatcher calls per delivery, so validating
  // through it makes a stored value that would throw on the next event
  // unwritable in the first place.
  resolveCallbackUrl(value.callback, process.env[value.callback.secretEnv] ?? "");

  // A root that does not exist is skipped at activation with only a log line, so
  // a typo looks like it took effect until path addressing mysteriously fails.
  // Refusing it at the write is what makes the panel the place the mistake is
  // caught. Synchronous because `validate` is; `resolveAllowedRoots` still does
  // the realpath pass at activation.
  const badRoots = value.allowedRoots.filter((root) => !isAbsolute(root) || !existsSync(root));
  if (badRoots.length > 0) {
    throw new ControlError(
      "dsh-control/internal",
      `allowedRoots entries must be existing absolute directories: ${badRoots.join(", ")}`,
    );
  }
}

/** Live view of the configuration, plus the compiled pieces derived from it. */
interface ConfigSource {
  /** The section in force right now. */
  live: () => ControlSection;
  /** Caller policy compiled from {@link live}, memoized on the raw value. */
  policy: () => CompiledCallerPolicy;
  /** Authentication policy, with token values re-read from the environment. */
  auth: () => AuthPolicy;
  /**
   * Subscribe to section changes: an attach, a detach, or a committed edit.
   *
   * A listener added while no settings provider is attached still gets called if
   * one attaches later, so callers do not have to re-subscribe.
   */
  watch: (listener: () => void) => void;
}

/**
 * Create the live configuration accessors.
 *
 * **dsh 0.2.0 起热改值由 `Config` 里的 `.volatile()` 承载**：宿主把解析结果包成稳定引用
 * 就地更新，`get()` 永远拿到当前值（含 profile patch 里的用户覆盖）。所以 0.1.x 那套
 * `installSection` + `setSource` 的分层不再需要——**引用本身就是要读的东西**。
 *
 * 访问器照旧是惰性的：per request / per delivery 才读，所以面板改完下一次调用就生效，
 * 既不重注册也不重启。`watch()` 的变更通知走宿主的 `settings/document-updated`——它在
 * **引用已更新之后**才发，所以监听者读到的一定是新值；先按 `ns` 过滤，别人的编辑不吵醒我们。
 *
 * `validateSection` 是跨字段校验（未知操作名、正则能否编译、回调 URL 能否解析）。0.2.0 的
 * 写入路径只按 schema 逐字段验，没有跨字段钩子，所以把它挪到**读取点**：坏值在最接近使用
 * 的地方大声失败，而不是静默存下、等到某次请求才炸。
 *
 * @param ctx - Plugin context.
 * @param config - Parsed plugin configuration; `.volatile()` fields are live references.
 * @returns The accessors.
 */
function createConfigSource(ctx: Context, config: Config): ConfigSource {
  const listeners = new Set<() => void>();

  /**
   * 把引用投影成一份**可变副本**。
   *
   * 宿主给的是递归只读的冻结快照，而下游（策略编译、鉴权、工具输出）按普通值用，所以这里
   * 解一层；顺带让每次调用都拿到独立数据，没有人能改到宿主的快照。
   */
  const read = (): ControlSection => {
    const callback = config.callback.get();
    const section: ControlSection = {
      allowedOperations: [...config.allowedOperations.get()],
      allowAnonymous: config.allowAnonymous.get(),
      tokens: config.tokens.get().map((token) => ({
        callerId: token.callerId,
        tokenEnv: token.tokenEnv,
        operations: [...token.operations],
      })),
      allowedRoots: [...config.allowedRoots.get()],
      callerInstructions: config.callerInstructions.get(),
      requiredFields: [...config.requiredFields.get()],
      requiredDocumentRules: config.requiredDocumentRules.get().map((rule) => ({
        id: rule.id,
        description: rule.description,
        required: rule.required,
        pathPattern: rule.pathPattern,
      })),
      forbiddenPatterns: [...config.forbiddenPatterns.get()],
      instructionsVersion: config.instructionsVersion.get(),
      callback: {
        enabled: callback.enabled,
        url: callback.url,
        secretEnv: callback.secretEnv,
        events: [...callback.events],
        timeoutMs: callback.timeoutMs,
        maxAttempts: callback.maxAttempts,
        allowedHosts: [...callback.allowedHosts],
        includeAssistantSummary: callback.includeAssistantSummary,
        includeLegionRuns: callback.includeLegionRuns,
      },
    };
    validateSection(section);
    return section;
  };

  // 宿主每次提交编辑后发一次。先按 ns 过滤：别的插件的编辑不该唤醒我们的监听者。
  ctx.on("settings/document-updated", (ns) => {
    if (ns !== SETTINGS_NAMESPACE) return;
    for (const listener of listeners) listener();
  });

  // Memoized on the raw value so an unchanged document never recompiles its
  // regular expressions on a hot path (the same reasoning as before P2).
  let lastPolicyRaw = "";
  let lastPolicy = compilePolicy(policyFromSection(read()));
  const policy = (): CompiledCallerPolicy => {
    const current = policyFromSection(read());
    const raw = JSON.stringify(current);
    if (raw !== lastPolicyRaw) {
      lastPolicy = compilePolicy(current);
      lastPolicyRaw = raw;
    }
    return lastPolicy;
  };

  // Token values live in environment variables, never in the settings document,
  // so they are re-read here rather than stored. Memoized per request batch on
  // the raw token spec, which is what makes `readTokenGrants` cheap enough to
  // run on the authentication path.
  // 初值只是占位：下面的 `raw` 从空串起步，第一次调用必然重算，所以不必在这里先读一次配置。
  let lastAuthRaw = "";
  let lastAuth: AuthPolicy = { tokens: [], allowAnonymous: false };
  const auth = (): AuthPolicy => {
    const section = read();
    const raw = JSON.stringify([section.tokens, section.allowedOperations, section.allowAnonymous]);
    if (raw !== lastAuthRaw) {
      const defaultOperations = parseOperations(section.allowedOperations, "allowedOperations");
      const specs = section.tokens.map((token) => ({
        callerId: token.callerId,
        tokenEnv: token.tokenEnv,
        operations:
          token.operations.length > 0
            ? parseOperations(token.operations, `tokens[${token.callerId}].operations`)
            : defaultOperations,
      }));
      lastAuth = { tokens: readTokenGrants(specs).grants, allowAnonymous: section.allowAnonymous };
      lastAuthRaw = raw;
    }
    return lastAuth;
  };

  return {
    live: read,
    policy,
    auth,
    watch: (listener) => {
      listeners.add(listener);
    },
  };
}

/**
 * Project the settings section onto {@link CallerPolicy}.
 *
 * @param section - Resolved settings section.
 * @returns The policy as written by the user.
 */
function policyFromSection(section: ControlSection): CallerPolicy {
  return {
    callerInstructions: section.callerInstructions,
    requiredFields: section.requiredFields,
    requiredDocumentRules: section.requiredDocumentRules.map((rule) => ({
      id: rule.id,
      description: rule.description,
      required: rule.required,
      ...(rule.pathPattern === "" ? {} : { pathPattern: rule.pathPattern }),
    })),
    forbiddenPatterns: section.forbiddenPatterns,
    instructionsVersion: section.instructionsVersion,
  };
}

/**
 * Open the control-plane ledger.
 *
 * @param ctx - Plugin context.
 * @param config - Plugin configuration.
 * @returns The opened ledger.
 * @throws ControlError when `ledger: 'storage'` is requested but no storage domain is mounted.
 */
async function openLedger(ctx: Context, config: Config): Promise<ControlLedger> {
  const facility = ctx.get("storageDomain");
  if (config.ledger === "memory" || facility === undefined) {
    if (config.ledger === "storage") {
      throw new ControlError(
        "dsh-control/internal",
        "ledger 'storage' requires ctx.storageDomain; mount @deepseek-ai/dsh-storage-domain or set ledger: 'memory'",
      );
    }
    return new MemoryControlLedger();
  }
  const domain = await facility.open(controlDomainSpec);
  return new StorageControlLedger(domain);
}

/**
 * Activate the Lingbang control plane.
 *
 * @param ctx - Plugin context with the required services already available.
 * @param config - Validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) {
    ctx.logger("void-dsh-control").info("disabled by configuration; no MCP endpoint registered");
    return;
  }

  // 先建访问器：启动检查与请求路径走的是**同一个投影**，所以两者永远不会给出不同答案。
  const source = createConfigSource(ctx, config);

  // Validate everything the schema cannot express BEFORE the async effect, so a
  // configuration the plugin cannot honour fails plugin startup loudly instead
  // of leaving a half-built endpoint behind (plan §11, stage 0 verification).
  // 跨字段校验落在 `source.live()` 里（见 `createConfigSource`）：0.2.0 的写入路径只有
  // 逐字段的 schema 校验，所以坏值是在这里——最接近使用的地方——被拦下的。
  const entrySection = source.live();
  const callbackUrl = resolveCallbackUrl(
    entrySection.callback,
    entrySection.callback.enabled ? (process.env[entrySection.callback.secretEnv] ?? "") : "",
  );

  // Contribute the configuration panel to the Void entry, when one is installed.
  // Outside the async effect: registration is synchronous and must not wait on
  // the ledger or the host ports.
  registerVoidPanel(ctx, {
        enabled: config.enabled,
        path: config.path,
        ledger: config.ledger,
        transport: config.transport,
      });

  void ctx.effect(async () => {
    const log = ctx.logger("void-dsh-control");

    const { policy } = source;

    const section = source.live();
    const initialAuth = source.auth();
    for (const token of section.tokens) {
      if ((process.env[token.tokenEnv] ?? "") === "") {
        // A token whose variable is unset silently authenticates nobody; say so
        // rather than letting the operator discover it through a 401.
        log.warn(`token environment variable ${token.tokenEnv} is unset; that caller cannot authenticate`);
      }
    }
    if (initialAuth.tokens.length === 0 && !section.allowAnonymous) {
      const unset = section.tokens.map((token) => token.tokenEnv).filter((name) => (process.env[name] ?? "") === "");
      const guidance = describeTokenSetup(unset, userEnvFilePath());
      // Two sinks on purpose. `ctx.logger` is the structured channel dsh
      // surfaces in the Web UI, but no Node-side package registers a console
      // exporter, so an operator watching the terminal never sees it. dsh's own
      // `loadLayeredEnv` writes boot misconfiguration straight to stderr; this is
      // the case that leaves the endpoint completely dead, so it goes to both
      // (plan §27.6).
      log.warn(guidance);
      const banner = guidance
        .split("\n")
        .map((line) => `[void-dsh-control] ${line}`)
        .join("\n");
      process.stderr.write(`\n${banner}\n\n`);
    }

    // `allowedRoots` is the only field needing asynchronous work (realpath), so
    // it is resolved into a snapshot here and refreshed whenever the section
    // changes. `currentRoots()` stays synchronous because the HTTP guard runs on
    // every path-addressed request.
    let roots: readonly string[] = [];
    let rootsRaw = "";
    const refreshRoots = async (): Promise<void> => {
      const configured = source.live().allowedRoots;
      const raw = JSON.stringify(configured);
      if (raw === rootsRaw) return;
      const resolved = await resolveAllowedRoots(configured);
      if (resolved.length !== configured.length) {
        log.warn(
          `allowedRoots: ${configured.length - resolved.length} configured root(s) were skipped because they are not existing absolute directories`,
        );
      }
      roots = resolved;
      rootsRaw = raw;
    };
    const currentRoots = (): readonly string[] => roots;
    await refreshRoots();
    // Any later section edit re-resolves the snapshot. `watch` fires only for
    // the settings document; the composition entry cannot change while the
    // process runs, so there is no second source to observe.
    //
    // 这个 `catch` 不是装饰。0.2.0 的写入路径**不做跨字段校验**，所以面板可以存下一个
    // schema 合法、跨字段非法的值（写错一个操作名、坏正则、不存在的目录、错误的回调 URL）。
    // 那时 `source.live()` 会在读取点抛错，而这里是 fire-and-forget——拒绝一旦逃逸就是
    // unhandledRejection，dsh 的 `installFailLoud` 把它判成致命加载失败并 `proc.exit(1)`：
    // **一次误改配置足以把宿主整个干掉**。降级成「放弃这次刷新 + 大声记一笔」，
    // `roots` 因此保留上一次的好值；其余读取点仍会在各自的请求里如实报错。
    source.watch(() => {
      void refreshRoots().catch((error: unknown) => {
        log.warn(
          `settings refresh rejected; keeping the previous root snapshot: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });

    const ledger = await openLedger(ctx, config);
    const hosts = createHostPorts(ctx);

    // Recovery adjudicates against the host before declaring an orphan failed:
    // the ledger knows a message was queued, only the Session knows whether it
    // was received (plan §10.3).
    const recovery = await ledger.init({
      sessionExists: async (sessionId) => (await hosts.inspectSession(sessionId)).exists,
    });
    if (recovery.orphanedTaskIds.length > 0) {
      log.warn(
        `recovered ${recovery.orphanedTaskIds.length} task(s) left non-terminal by an earlier process` +
          (recovery.deliveredTaskIds.length > 0
            ? `; ${recovery.deliveredTaskIds.length} of them had already delivered their message`
            : ""),
      );
    }

    // The callback target and its secret are read per delivery, so the panel can
    // retarget, disable, or rotate the webhook without a restart. Resuming
    // pending deliveries still uses the activation-time target: an earlier
    // process left those owed to *that* receiver.
    const callback = new WebhookCallbackDispatcher({
      target: () => source.live().callback,
      ledger,
      secretSource: () => process.env[source.live().callback.secretEnv] ?? "",
    });
    if (callbackUrl !== undefined) {
      log.info(`callback webhook enabled for statuses: ${entrySection.callback.events.join(", ")}`);
      // Deliveries left pending by an earlier process resume now; the ledger
      // keeps the attempt count so a receiver is never notified twice for one
      // event (plan §10.3).
      const resumed = await callback.resumePending();
      if (resumed > 0) log.info(`re-scheduled ${resumed} pending callback delivery(ies)`);
    }

    // Legion run-terminal delivery (plan §16.2 L9). Optional and mounted
    // reactively: `ctx.inject` only runs while a legion service exists, so
    // installing or removing legion never touches this plugin's own injection
    // list, and unmounting drains the adapter before the ledger closes. The
    // adapter rides the same webhook target as the task callbacks — one target,
    // one secret, one retry budget, one event filter.
    const legionDeliveryEnabled = (): boolean => source.live().callback.includeLegionRuns === true;
    ctx.inject(["voidTeam"], (legionCtx) => {
      // The legion service publishes its notification store; the store — not the
      // service — is the host this adapter talks to, because the store is what
      // owns the durable file and the `delivery` bookkeeping. Restated
      // structurally on purpose: control never imports legion's source, and a
      // legion installed without a data root exposes no store at all, in which
      // case there is nowhere to record a delivery and the adapter stays off.
      const service = legionCtx.get("voidTeam") as unknown as LegionServiceLike | undefined;
      const host = service?.notifications;
      if (host === undefined || typeof host.list !== "function" || typeof host.markDelivery !== "function") {
        log.warn("legion service is present but publishes no notification store; run-terminal delivery stays off");
        return;
      }
      const delivery = new LegionRunDelivery({
        target: () => source.live().callback,
        host,
        secretSource: () => process.env[source.live().callback.secretEnv] ?? "",
        // Read per event, so flipping the switch in the panel takes effect on the
        // next terminal state instead of at the next restart.
        enabled: legionDeliveryEnabled,
        log: { warn: (message) => log.warn(message) },
      });
      ctx.on(LEGION_RUN_TERMINAL_EVENT, (event) => delivery.onTerminal(event), { global: true });
      log.info("legion run-terminal delivery mounted");
      // Catch up on terminal states nobody was listening for: an endpoint that
      // was down, or a process that died before the delivery landed. Delivery
      // never changes a run outcome and never re-runs a member task (L9), and
      // the switch still applies — a disabled adapter schedules nothing.
      void delivery.start().then(
        (scheduled) => {
          if (scheduled > 0) log.info(`re-scheduled ${scheduled} legion run notification(s)`);
        },
        () => undefined,
      );
      return () => delivery.drain();
    });

    const orchestrator = new ControlOrchestrator({
      ledger,
      hosts,
      policy,
      onEvent: (record, event) => callback.onTaskEvent(record, event),
    });

    // Authentication is re-derived per request from the live section, so a
    // permission or token-binding edit in the panel takes effect on the next
    // call (plan §29.7 P2).
    const authenticator = new Authenticator(() => source.auth());

    const handler = createMcpHttpHandler({
      authenticator,
      deps: {
        orchestrator,
        authenticator,
        hosts,
        policy,
        // The guard is rebuilt per request for the same reason. `allowedRoots`
        // is the one field needing asynchronous work (realpath), so it is
        // resolved once at activation and re-resolved whenever the section
        // changes; the guard then reads the current snapshot synchronously.
        guard: () => ({ allowedRoots: currentRoots() }),
        identity: { name: name, version: PLUGIN_VERSION },
      },
    });

    const unregisterRoute = ctx.webServer.register({ kind: "exact", path: config.path, handler });

    // Host events drive task status. Every subscription is registered on this
    // effect, so disposal detaches all of them together.
    const sessionSequences = new Map<string, number>();
    ctx.on("session/event", (session, event) => {
      const sessionId = String(session.id);
      const like: SessionEventLike = {
        type: String(event.type),
        seq: Number(event.seq),
        time: Number(event.time),
        data: event.data,
      };
      const signals = signalsFromSessionEvent(like);
      if (signals.length === 0) return;
      if (!isNewerSessionSeq(sessionSequences.get(sessionId), like.seq)) return;
      sessionSequences.set(sessionId, like.seq);
      for (const signal of signals) void orchestrator.applySignal(sessionId, signal);
    }, { global: true });
    ctx.on("agent/status", (payload) => {
      const sessionId = String(payload.agent.session.id);
      void orchestrator.applySignal(sessionId, signalFromAgentStatus(payload.status === "running"));
    }, { global: true });
    ctx.on("agent/error", (payload) => {
      const sessionId = String(payload.agent.session.id);
      const message = payload.error instanceof Error ? payload.error.message : String(payload.error);
      void orchestrator.applySignal(sessionId, signalFromAgentError(message));
    }, { global: true });
    ctx.on("session/disposed", (session) => {
      sessionSequences.delete(String(session.id));
    }, { global: true });

    const service = new DshControl(ctx, {
      orchestrator,
      ledger,
      hosts,
      authenticator,
      policy,
      guard: () => ({ allowedRoots: currentRoots() }),
      endpointPath: config.path,
    });
    void service;

    await ledger.putPolicyMeta({
      instructionsVersion: policy().instructionsVersion,
      publishedAt: new Date().toISOString(),
      summary: `requiredFields=${policy().requiredFields.length} documentRules=${policy().requiredDocumentRules.length}`,
    });

    log.info(
      `control plane active at ${config.path} (callers=${initialAuth.tokens.length}, allowedRoots=${currentRoots().length}, ledger=${ledger.constructor.name})`,
    );

    return async () => {
      // Ordered teardown: stop accepting, wait for every accepted admission
      // chain to settle, then quiesce the notifier, then release the route and
      // the ledger. Nothing may still be writing to storage when the ledger
      // closes (plan §7.3, §12, §16).
      unregisterRoute();
      await orchestrator.drain();
      await callback.drain();
      await ledger.close();
      log.info("control plane stopped");
    };
  }, "void-dsh-control");
}

/** Plugin version reported over MCP; kept in sync with package.json. */
export const PLUGIN_VERSION = "0.1.0";

export { DshControl } from "./service.js";
export { ControlOrchestrator } from "./orchestrator.js";
export { createMcpHttpHandler, createControlMcpServer } from "./mcp.js";
export { createHostPorts } from "./hosts.js";
export { WebhookCallbackDispatcher, signCallbackBody, callbackPayload } from "./callback.js";
export {
  LEGION_RUN_TERMINAL_EVENT,
  LegionRunDelivery,
  legionCallbackPayload,
  type LegionCallbackPayload,
  type LegionDeliveryState,
  type LegionNotificationHost,
  type LegionRunDeliveryOptions,
  type LegionRunEvent,
  type LegionServiceLike,
} from "./legion-delivery.js";
export { EMPTY_CALLER_POLICY };
