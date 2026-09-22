/**
 * 本机抓取工具：只读、只发 GET、只去操作者显式写进白名单的本机地址。
 *
 * 为什么单开一个工具而不是放开宿主的 `web_fetch`：宿主对非公网地址是硬拒绝且没有开关
 * （`@deepseek-ai/dsh-web-fetch-http/lib/index.js` 的 `isNonPublicIpLiteral`），而模型
 * 确实需要读本机面板/服务的状态。开口子的正确做法是把「去哪里」写死在 profile 配置里，
 * 由这个工具自己把关：
 *
 * - 地址必须**逐条**命中白名单（主机 + 端口），白名单只收本机地址（`127.x.x.x` / `::1` /
 *   `localhost`），写别的地址在**装载时**就报错，不给「先跑起来再说」的机会；
 * - 方法只能是 `GET`，没有请求体，不接受自定义请求头（除 `Accept`）；
 * - 重定向**每一跳**都重新过一遍白名单，想借 302 跳到别处就当场停手；
 * - 响应有字节上限与超时，二进制正文不往上下文里灌（只回一句说明）；
 * - 白名单为空时工具照常注册，但**任何调用都被拒**（fail-closed），不会静默放行。
 *
 * 审计：每次放行与每次拒绝都写宿主日志（logger 名 `void-tools`），拒绝原因同时回给模型。
 *
 * @module @void/void-tools/local-fetch
 */
import { request as httpRequest } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { VoidToolContracts } from "./registry.js";

export const name = "void-tools-local-fetch";
export const inject = ["tools"];

/** 模型看到的工具名。入口策略按名字把它当只读工具（见 `@void/void-soul/entry-policy`）。 */
export const LOCAL_FETCH_TOOL_NAME = "local_fetch";

export const DEFAULT_LOCAL_FETCH_MAX_BYTES = 256 * 1024;
export const MAX_LOCAL_FETCH_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_LOCAL_FETCH_TIMEOUT_MS = 5_000;
export const MAX_LOCAL_FETCH_TIMEOUT_MS = 120_000;
export const DEFAULT_LOCAL_FETCH_MAX_REDIRECTS = 3;
export const MAX_LOCAL_FETCH_MAX_REDIRECTS = 10;

/** 白名单里的一条：本机主机 + 端口。`note` 只是给人看的备注。 */
export interface LocalFetchTarget {
  host: string;
  port: number;
  note?: string | undefined;
}

export interface LocalFetchConfig {
  /** 允许去的本机地址。留空 = 谁都不许去（工具仍然注册，但每次都拒）。 */
  allow?: readonly LocalFetchTarget[] | undefined;
  /** 单次响应最多读多少字节，默认 256 KiB，上限 8 MiB。 */
  maxBytes?: number | undefined;
  /** 单次请求超时（毫秒），默认 5000，上限 120000。 */
  timeoutMs?: number | undefined;
  /** 最多跟几次重定向，默认 3，上限 10；0 表示不跟。 */
  maxRedirects?: number | undefined;
}

/** 配置解析后的形状：白名单已规范化成 `主机:端口` 的查表。 */
export interface ResolvedLocalFetchPolicy {
  targets: ReadonlyMap<string, LocalFetchTarget>;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
}

/** 配置写错（非本机主机、端口越界、上限越界）——装载时就抛，不留给运行期。 */
export class LocalFetchConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalFetchConfigError";
  }
}

/** 调用被拒（地址不在白名单、重定向逃逸、超时、连不上）。 */
export class LocalFetchRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalFetchRefusal";
  }
}

export interface LocalFetchInput {
  url: string;
  accept?: string | undefined;
  maxBytes?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface LocalFetchResult {
  /** 真正取到的地址（跟过重定向之后）。 */
  url: string;
  status: number;
  contentType?: string | undefined;
  bytes: number;
  truncated: boolean;
  /** 跟过的重定向地址，按顺序。 */
  redirects: string[];
  body?: string | undefined;
  binary?: boolean | undefined;
  note?: string | undefined;
}

/**
 * 把主机名规范成本机地址；不是本机就返回 `undefined`。
 *
 * 只认三种写法：`127.x.x.x`（整个回环段，逐段规范化掉前导零）、`::1`（带不带方括号都行）、
 * `localhost`（一律按 `127.0.0.1` 处理——不查 DNS，也就没有 DNS 重绑定的余地）。
 */
export function canonicalLoopbackHost(host: unknown): string | undefined {
  if (typeof host !== "string") return undefined;
  const trimmed = host.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;
  const bare = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  if (bare === "localhost") return "127.0.0.1";
  if (bare === "::1") return "::1";
  const parts = bare.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    octets.push(value);
  }
  if (octets[0] !== 127) return undefined;
  return octets.join(".");
}

/** 白名单的查表键，也是报错时给人看的写法。 */
export function localFetchTargetKey(host: string, port: number): string {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function readLimit(value: unknown, fallback: number, max: number, label: string, min: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new LocalFetchConfigError(`本机抓取的 ${label} 必须是 ${min}..${max} 之间的整数，收到 ${String(value)}`);
  }
  return value;
}

/**
 * 解析并校验配置。
 *
 * @throws {LocalFetchConfigError} 白名单条目不是对象、主机不是本机、端口/上限越界。
 */
export function parseLocalFetchConfig(config: LocalFetchConfig | undefined = {}): ResolvedLocalFetchPolicy {
  const raw = config ?? {};
  const allow = raw.allow ?? [];
  if (!Array.isArray(allow)) throw new LocalFetchConfigError("本机抓取的 allow 必须是数组，每一项写 { host, port }");
  const targets = new Map<string, LocalFetchTarget>();
  allow.forEach((entry, index) => {
    const position = `本机抓取白名单第 ${index + 1} 条`;
    if (typeof entry !== "object" || entry === null) throw new LocalFetchConfigError(`${position}不是对象：每项要写 { host, port }`);
    const host = canonicalLoopbackHost((entry as LocalFetchTarget).host);
    if (host === undefined) {
      throw new LocalFetchConfigError(`${position}的主机只能是本机地址（127.x.x.x / ::1 / localhost），收到 ${String((entry as LocalFetchTarget).host)}`);
    }
    const port = (entry as LocalFetchTarget).port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new LocalFetchConfigError(`${position}的端口必须在 1..65535，收到 ${String(port)}`);
    }
    const note = (entry as LocalFetchTarget).note;
    const key = localFetchTargetKey(host, port);
    if (targets.has(key)) return;
    targets.set(key, { host, port, ...(typeof note === "string" && note.trim().length > 0 ? { note: note.trim() } : {}) });
  });
  return {
    targets,
    maxBytes: readLimit(raw.maxBytes, DEFAULT_LOCAL_FETCH_MAX_BYTES, MAX_LOCAL_FETCH_MAX_BYTES, "maxBytes", 1),
    timeoutMs: readLimit(raw.timeoutMs, DEFAULT_LOCAL_FETCH_TIMEOUT_MS, MAX_LOCAL_FETCH_TIMEOUT_MS, "timeoutMs", 1),
    maxRedirects: readLimit(raw.maxRedirects, DEFAULT_LOCAL_FETCH_MAX_REDIRECTS, MAX_LOCAL_FETCH_MAX_REDIRECTS, "maxRedirects", 0),
  };
}

interface TargetUrl {
  /** 规范化后的完整地址，报错与回话都用它。 */
  url: string;
  host: string;
  port: number;
  path: string;
  key: string;
}

function parseTargetUrl(raw: unknown, policy: ResolvedLocalFetchPolicy): TargetUrl {
  if (typeof raw !== "string" || raw.trim().length === 0) throw new LocalFetchRefusal("本机抓取要一个地址：url 不能为空");
  const text = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new LocalFetchRefusal(`本机抓取看不懂这个地址：${text}`);
  }
  if (parsed.protocol !== "http:") {
    throw new LocalFetchRefusal(`本机抓取只支持 http:// 的本机地址，收到 ${parsed.protocol}//`);
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new LocalFetchRefusal("本机抓取不允许带用户名密码的地址");
  }
  const host = canonicalLoopbackHost(parsed.hostname);
  if (host === undefined) {
    throw new LocalFetchRefusal(`本机抓取只去本机地址（127.x.x.x / ::1 / localhost），收到 ${parsed.hostname}`);
  }
  const port = parsed.port.length === 0 ? 80 : Number(parsed.port);
  const key = localFetchTargetKey(host, port);
  if (policy.targets.size === 0) {
    throw new LocalFetchRefusal(`本机抓取没有配白名单，${key} 不放行（在 profile 里给 void-tools-local-fetch 写 allow）`);
  }
  if (!policy.targets.has(key)) {
    throw new LocalFetchRefusal(`本机抓取只允许白名单里的地址，${key} 不在白名单里`);
  }
  return { url: parsed.toString(), host, port, path: `${parsed.pathname}${parsed.search}`, key };
}

function resolveRedirect(from: string, location: string, policy: ResolvedLocalFetchPolicy): TargetUrl {
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    throw new LocalFetchRefusal(`本机抓取看不懂重定向给的地址：${location}`);
  }
  try {
    return parseTargetUrl(next.toString(), policy);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new LocalFetchRefusal(`本机抓取跟着重定向走到了白名单外的地址，已停手：${next.toString()}（${reason}）`);
  }
}

const TEXTUAL_CONTENT_TYPE = /^(text\/|application\/(json|xml|javascript|ecmascript|x-www-form-urlencoded|ld\+json|yaml|x-yaml|graphql|problem\+json)|.+\+(json|xml)$)/;

function mimeOf(contentType: string | undefined): string | undefined {
  if (contentType === undefined) return undefined;
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return mime.length === 0 ? undefined : mime;
}

function isTextual(contentType: string | undefined): boolean {
  const mime = mimeOf(contentType);
  return mime === undefined ? true : TEXTUAL_CONTENT_TYPE.test(mime);
}

interface RawResponse {
  status: number;
  contentType?: string | undefined;
  location?: string | undefined;
  body: Buffer;
  bytes: number;
  truncated: boolean;
}

function hostHeader(host: string, port: number): string {
  const written = host.includes(":") ? `[${host}]` : host;
  return port === 80 ? written : `${written}:${port}`;
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function requestOnce(target: TargetUrl, options: { accept: string; maxBytes: number; timeoutMs: number; signal?: AbortSignal | undefined }): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    let settled = false;
    const done = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      settle();
    };
    const request = httpRequest(
      {
        host: target.host,
        port: target.port,
        path: target.path,
        method: "GET",
        headers: { host: hostHeader(target.host, target.port), accept: options.accept, "user-agent": "void-local-fetch/0.1" },
        signal: combineSignals(options.signal, options.timeoutMs),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        let truncated = false;
        const contentType = response.headers["content-type"];
        const build = (): RawResponse => {
          const location = response.headers.location;
          return {
            status: response.statusCode ?? 0,
            ...(typeof contentType === "string" ? { contentType } : {}),
            ...(typeof location === "string" ? { location } : {}),
            body: Buffer.concat(chunks),
            bytes,
            truncated,
          };
        };
        response.on("data", (chunk: Buffer) => {
          if (truncated) return;
          const remaining = options.maxBytes - bytes;
          if (chunk.length <= remaining) {
            chunks.push(chunk);
            bytes += chunk.length;
            return;
          }
          if (remaining > 0) {
            chunks.push(chunk.subarray(0, remaining));
            bytes += remaining;
          }
          truncated = true;
          response.destroy();
          done(() => resolve(build()));
        });
        response.on("end", () => done(() => resolve(build())));
        response.on("error", (error: Error) =>
          done(() => reject(describeTransportError(error, target, options.timeoutMs, options.signal))),
        );
      },
    );
    request.on("error", (error: Error) => done(() => reject(describeTransportError(error, target, options.timeoutMs, options.signal))));
    request.end();
  });
}

/**
 * 分清楚「谁停的手」：调用方（会话被中断、军团运行被取消）停的就写取消，
 * 只有自己那条超时才写超时。合成信号分不出这两者，所以回头问调用方那条信号。
 */
function describeTransportError(
  error: unknown,
  target: TargetUrl,
  timeoutMs: number,
  callerSignal?: AbortSignal | undefined,
): LocalFetchRefusal {
  const named = error as { name?: string; code?: string } | null;
  if (named?.name === "TimeoutError" || named?.name === "AbortError" || named?.code === "ABORT_ERR") {
    if (callerSignal?.aborted === true) {
      return new LocalFetchRefusal(`本机抓取被取消（上层停手了）：${target.url}`);
    }
    return new LocalFetchRefusal(`本机抓取超时（${timeoutMs}ms）：${target.url}`);
  }
  const detail = named?.code ?? (error instanceof Error ? error.message : String(error));
  return new LocalFetchRefusal(`本机抓取连不上 ${target.key}（${detail}）`);
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * 执行一次本机抓取。所有拒绝都是 `LocalFetchRefusal`，消息里带够线索（去了哪、为什么）。
 *
 * @throws {LocalFetchRefusal} 地址不在白名单、重定向逃逸、超时、连不上。
 */
export async function localFetch(input: LocalFetchInput, policy: ResolvedLocalFetchPolicy): Promise<LocalFetchResult> {
  const accept = input.accept === undefined || input.accept.trim().length === 0 ? "*/*" : input.accept.trim();
  if (/[\r\n]/.test(accept)) throw new LocalFetchRefusal("本机抓取的 accept 不能带换行");
  const requested = input.maxBytes;
  const maxBytes =
    requested === undefined || requested === null
      ? policy.maxBytes
      : Math.max(1, Math.min(policy.maxBytes, Number.isInteger(requested) ? requested : policy.maxBytes));

  let target = parseTargetUrl(input.url, policy);
  const redirects: string[] = [];
  for (let hop = 0; ; hop += 1) {
    const response = await requestOnce(target, {
      accept,
      maxBytes,
      timeoutMs: policy.timeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (isRedirect(response.status) && response.location !== undefined) {
      if (hop >= policy.maxRedirects) {
        throw new LocalFetchRefusal(`本机抓取跟重定向跟了 ${policy.maxRedirects} 次还没到，已停手：${target.url}`);
      }
      redirects.push(target.url);
      target = resolveRedirect(target.url, response.location, policy);
      continue;
    }
    const base = {
      url: target.url,
      status: response.status,
      ...(response.contentType === undefined ? {} : { contentType: response.contentType }),
      bytes: response.bytes,
      truncated: response.truncated,
      redirects,
    };
    if (!isTextual(response.contentType)) {
      return { ...base, binary: true, note: `响应是 ${mimeOf(response.contentType) ?? "未知类型"}，正文没有装进上下文（本机抓取只带文本）` };
    }
    return { ...base, body: response.body.toString("utf8") };
  }
}

function renderJson(value: unknown): { type: "text"; text: string }[] {
  return [{ type: "text", text: JSON.stringify(value) }];
}

/**
 * Consumer：注册模型可见的本机抓取工具，并把它的契约登记给工具治理层（有注册表才登记）。
 *
 * @throws {LocalFetchConfigError} 配置写错时装载即失败——白名单写错不该等到第一次调用才发现。
 */
export function apply(ctx: Context, config: LocalFetchConfig = {}): void {
  const policy = parseLocalFetchConfig(config);
  const log = ctx.logger("void-tools");
  const contracts = ctx.get("voidToolContracts") as VoidToolContracts | undefined;
  contracts?.register({ name: LOCAL_FETCH_TOOL_NAME, family: "network-read", isReadOnly: true, needsPermission: false, riskLevel: "low" });

  ctx.tools.register(defineTool({
    name: LOCAL_FETCH_TOOL_NAME,
    description: "读操作者显式加进白名单的本机地址（只发 GET，只读）。白名单在 profile 里配置，名单外的地址、非本机地址、带用户名密码的地址一律拒绝；重定向每一跳都重新校验。",
    parameters: {
      url: { type: "string", required: true, description: "本机地址，例如 http://127.0.0.1:3080/void/api/status。" },
      accept: { type: "string", description: "可选的 Accept 头，默认 */*。" },
      maxBytes: { type: "integer", description: "本次最多读多少字节；只能比配置的上限更小。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          status: { type: "integer", required: true },
          contentType: { type: "string" },
          bytes: { type: "integer", required: true },
          truncated: { type: "boolean", required: true },
          redirects: { type: "array", items: { type: "string" } },
          body: { type: "string" },
          binary: { type: "boolean" },
          note: { type: "string" },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const { url, accept, maxBytes } = args as { url: string; accept?: string; maxBytes?: number };
      const sessionId = exec.agent?.id;
      try {
        const result = await localFetch(
          {
            url,
            ...(accept === undefined ? {} : { accept }),
            ...(maxBytes === undefined ? {} : { maxBytes }),
            // 宿主把「这次调用可以被打断」放在 exec.signal 上（ToolDefinition.execute 的约定：
            // async work must observe or forward `exec.signal`）。不接它，面板上停一次全队
            // 之后，卡在慢页面上的子代理还要把这次抓取睡满才肯落定——2026-09-23 真机量到
            // 整整 100 秒；接上之后取消信号一到就断。
            ...(exec.signal === undefined ? {} : { signal: exec.signal }),
          },
          policy,
        );
        log.info(`本机抓取 ${result.url} → ${result.status}（${result.bytes} 字节${result.truncated ? "，已截断" : ""}）${sessionId === undefined ? "" : ` 会话=${sessionId}`}`);
        return result;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log.warn(`本机抓取被拒：${reason}${sessionId === undefined ? "" : ` 会话=${sessionId}`}`);
        throw error;
      }
    },
  }));
}
