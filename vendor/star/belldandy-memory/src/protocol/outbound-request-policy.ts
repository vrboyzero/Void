import { lookup as lookupDns } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import { Readable } from "node:stream";
import ipaddr from "ipaddr.js";

export type OutboundAddress = {
  address: string;
  family: 4 | 6;
};

export type OutboundRequestPolicyErrorCode =
  | "invalid_url"
  | "unsupported_scheme"
  | "insecure_scheme"
  | "userinfo_not_allowed"
  | "host_denied"
  | "host_not_allowed"
  | "private_network_not_allowed"
  | "dns_unavailable"
  | "redirect_limit"
  | "redirect_without_location"
  | "idle_timeout";

export class OutboundRequestPolicyError extends Error {
  readonly name = "OutboundRequestPolicyError";

  constructor(
    readonly code: OutboundRequestPolicyErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type OutboundRequestInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | Readable;
  signal?: AbortSignal;
  maxRedirects?: number;
  idleTimeoutMs?: number;
};

export type OutboundRequestAdapterInput = {
  url: URL;
  addresses: readonly OutboundAddress[];
  init: OutboundRequestInit;
};

export type OutboundRequestAdapter = (input: OutboundRequestAdapterInput) => Promise<Response>;
export type OutboundDnsLookup = (hostname: string) => Promise<OutboundAddress[]>;

export type OutboundRequestPolicyOptions = {
  allowInsecureHttp?: boolean;
  allowPrivateNetwork?: boolean;
  allowedHosts?: string[];
  deniedHosts?: string[];
  maxRedirects?: number;
  dnsLookup?: OutboundDnsLookup;
  requestAdapter?: OutboundRequestAdapter;
};

export type OutboundRequestResult = {
  response: Response;
  url: URL;
  addresses: readonly OutboundAddress[];
  redirectCount: number;
};

const DEFAULT_MAX_REDIRECTS = 5;

/**
 * 对外网络请求的统一信任边界。默认 profile 只允许公网 HTTPS；本地服务必须
 * 由调用方显式创建 trusted-private profile，不能因为一次 DNS 异常而 fail-open。
 */
export class OutboundRequestPolicy {
  private readonly allowInsecureHttp: boolean;
  private readonly allowPrivateNetwork: boolean;
  private readonly allowedHosts: string[];
  private readonly deniedHosts: string[];
  private readonly maxRedirects: number;
  private readonly dnsLookup: OutboundDnsLookup;
  private readonly requestAdapter: OutboundRequestAdapter;

  constructor(options: OutboundRequestPolicyOptions = {}) {
    this.allowInsecureHttp = options.allowInsecureHttp === true;
    this.allowPrivateNetwork = options.allowPrivateNetwork === true;
    this.allowedHosts = normalizeHostRules(options.allowedHosts);
    this.deniedHosts = normalizeHostRules(options.deniedHosts);
    this.maxRedirects = normalizePositiveInteger(options.maxRedirects, DEFAULT_MAX_REDIRECTS);
    this.dnsLookup = options.dnsLookup ?? lookupAllAddresses;
    this.requestAdapter = options.requestAdapter ?? requestWithPinnedAddress;
  }

  async request(input: { url: string | URL } & OutboundRequestInit): Promise<OutboundRequestResult> {
    let currentUrl = parseUrl(input.url);
    let method = input.method ?? "GET";
    let body = input.body;
    const originalBody = input.body;
    const redirectLimit = normalizePositiveInteger(input.maxRedirects, this.maxRedirects);

    try {
      for (let redirectCount = 0; ; redirectCount += 1) {
        const addresses = await this.resolveAllowedAddresses(currentUrl);
        const response = await this.requestAdapter({
          url: currentUrl,
          addresses,
          init: { ...input, method, body },
        });

        if (!isRedirect(response.status)) {
          return { response, url: currentUrl, addresses, redirectCount };
        }

        if (redirectCount >= redirectLimit) {
          await cancelResponseBody(response);
          throw new OutboundRequestPolicyError("redirect_limit", "Outbound redirect limit exceeded.");
        }

        const location = response.headers.get("location");
        if (!location) {
          await cancelResponseBody(response);
          throw new OutboundRequestPolicyError("redirect_without_location", "Outbound redirect did not provide a location.");
        }

        await cancelResponseBody(response);
        currentUrl = parseUrl(location, currentUrl);
        if (response.status === 301 || response.status === 302 || response.status === 303) {
          method = "GET";
          body = undefined;
        } else if (body instanceof Readable) {
          throw new OutboundRequestPolicyError(
            "redirect_limit",
            "Outbound redirect cannot replay a streaming request body.",
          );
        }
      }
    } catch (error) {
      if (originalBody instanceof Readable && !originalBody.destroyed) originalBody.destroy();
      throw error;
    }
  }

  async resolveAllowedAddresses(input: string | URL): Promise<ReadonlyArray<OutboundAddress>> {
    const url = parseUrl(input);
    this.assertUrlPolicy(url);

    const hostname = normalizeHostname(url.hostname);
    const literalAddress = parseIpAddress(hostname);
    let addresses: OutboundAddress[];
    if (literalAddress) {
      addresses = [{ address: hostname, family: literalAddress.kind() === "ipv4" ? 4 : 6 }];
    } else {
      try {
        addresses = await this.dnsLookup(hostname);
      } catch {
        throw new OutboundRequestPolicyError("dns_unavailable", "Outbound DNS resolution is unavailable.");
      }
    }

    if (addresses.length === 0 || addresses.some((entry) => !isValidAddress(entry))) {
      throw new OutboundRequestPolicyError("dns_unavailable", "Outbound DNS did not return a usable address.");
    }
    const restrictedAddresses = addresses.filter((entry) => isRestrictedAddress(entry.address));
    const allowDnsProxySyntheticAddresses = !literalAddress
      && this.allowedHosts.length > 0
      && matchesHostRule(hostname, this.allowedHosts)
      && restrictedAddresses.every((entry) => isDnsProxySyntheticAddress(entry.address));
    if (!this.allowPrivateNetwork && restrictedAddresses.length > 0 && !allowDnsProxySyntheticAddresses) {
      throw new OutboundRequestPolicyError("private_network_not_allowed", "Outbound private or reserved network targets are not allowed.");
    }
    return addresses.map((entry) => ({ ...entry }));
  }

  private assertUrlPolicy(url: URL): void {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new OutboundRequestPolicyError("unsupported_scheme", "Outbound requests only support HTTP(S) URLs.");
    }
    if (url.username || url.password) {
      throw new OutboundRequestPolicyError("userinfo_not_allowed", "Outbound URLs must not include userinfo.");
    }

    const hostname = normalizeHostname(url.hostname);
    if (!hostname) {
      throw new OutboundRequestPolicyError("invalid_url", "Outbound URL hostname is required.");
    }
    if (matchesHostRule(hostname, this.deniedHosts)) {
      throw new OutboundRequestPolicyError("host_denied", "Outbound hostname is denied by policy.");
    }
    if (this.allowedHosts.length > 0 && !matchesHostRule(hostname, this.allowedHosts)) {
      throw new OutboundRequestPolicyError("host_not_allowed", "Outbound hostname is not in the allowlist.");
    }
    if (!this.allowPrivateNetwork && isLocalhostName(hostname)) {
      throw new OutboundRequestPolicyError("private_network_not_allowed", "Outbound localhost targets are not allowed.");
    }
    if (!this.allowPrivateNetwork && parseIpAddress(hostname) && isRestrictedAddress(hostname)) {
      throw new OutboundRequestPolicyError("private_network_not_allowed", "Outbound private or reserved network targets are not allowed.");
    }
    if (url.protocol === "http:" && !this.allowInsecureHttp) {
      throw new OutboundRequestPolicyError("insecure_scheme", "Outbound HTTP requires explicit opt-in.");
    }
  }
}

function parseUrl(value: string | URL, base?: URL): URL {
  try {
    return new URL(value.toString(), base);
  } catch {
    throw new OutboundRequestPolicyError("invalid_url", "Outbound URL is invalid.");
  }
}

async function lookupAllAddresses(hostname: string): Promise<OutboundAddress[]> {
  const records = await lookupDns(hostname, { all: true, verbatim: true });
  return records.map((record) => ({
    address: record.address,
    family: record.family === 6 ? 6 : 4,
  }));
}

async function requestWithPinnedAddress(input: OutboundRequestAdapterInput): Promise<Response> {
  const selectedAddress = input.addresses[0];
  if (!selectedAddress) {
    throw new OutboundRequestPolicyError("dns_unavailable", "Outbound DNS did not return a usable address.");
  }

  const url = input.url;
  const client = url.protocol === "https:" ? https : http;
  const requestOptions: http.RequestOptions = {
    protocol: url.protocol,
    hostname: normalizeHostname(url.hostname),
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    method: input.init.method ?? "GET",
    headers: input.init.headers,
  };
  const pinnedLookup: NonNullable<http.RequestOptions["lookup"]> = (_hostname, options, callback) => {
    const address: LookupAddress = {
      address: selectedAddress.address,
      family: selectedAddress.family,
    };
    if (options.all) {
      callback(null, [address]);
      return;
    }
    callback(null, address.address, address.family);
  };
  requestOptions.lookup = pinnedLookup;

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let responseStream: http.IncomingMessage | undefined;
    const signal = input.init.signal;
    const streamingBody = input.init.body instanceof Readable ? input.init.body : undefined;
    const finish = () => {
      signal?.removeEventListener("abort", abortRequest);
    };
    const abortRequest = () => {
      if (streamingBody && !streamingBody.destroyed) streamingBody.destroy();
      request.destroy(signal?.reason instanceof Error ? signal.reason : new Error("Outbound request aborted."));
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      if (streamingBody && !streamingBody.destroyed) streamingBody.destroy();
      finish();
      reject(error);
    };
    const request = client.request(requestOptions, (incoming) => {
      responseStream = incoming;
      const cleanupResponse = () => finish();
      incoming.once("end", cleanupResponse);
      incoming.once("error", cleanupResponse);
      incoming.once("close", cleanupResponse);
      if (settled) {
        incoming.destroy();
        return;
      }
      settled = true;
      const status = incoming.statusCode && incoming.statusCode >= 200 ? incoming.statusCode : 502;
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (typeof value === "undefined") continue;
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const body = status === 204 || status === 205 || status === 304
        ? null
        : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      resolve(new Response(body, { status, statusText: incoming.statusMessage, headers }));
    });

    request.once("error", (error) => rejectOnce(error));
    if (input.init.idleTimeoutMs && input.init.idleTimeoutMs > 0) {
      request.setTimeout(input.init.idleTimeoutMs, () => {
        request.destroy(new OutboundRequestPolicyError("idle_timeout", "Outbound request timed out while idle."));
      });
    }
    if (signal?.aborted) {
      abortRequest();
      return;
    }
    signal?.addEventListener("abort", abortRequest, { once: true });
    if (streamingBody) {
      streamingBody.once("error", (error) => request.destroy(error));
      streamingBody.pipe(request);
    } else if (input.init.body !== undefined) {
      request.write(input.init.body);
      request.end();
    } else {
      request.end();
    }
  });
}

function normalizeHostRules(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? [])
    .map((value) => normalizeHostname(value))
    .filter(Boolean)));
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function matchesHostRule(hostname: string, rules: readonly string[]): boolean {
  return rules.some((rule) => hostname === rule || hostname.endsWith(`.${rule}`));
}

function isLocalhostName(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function isValidAddress(entry: OutboundAddress): boolean {
  const parsed = parseIpAddress(entry.address);
  return parsed !== undefined
    && (entry.family === 4 || entry.family === 6)
    && (parsed.kind() === "ipv4" ? 4 : 6) === entry.family;
}

function isRestrictedAddress(address: string): boolean {
  const parsed = parseIpAddress(address);
  if (!parsed) return true;

  // IPv4-mapped IPv6 沿用内嵌 IPv4 分类，保持公网 mapped 地址兼容。
  if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) {
    return parsed.toIPv4Address().range() !== "unicast";
  }
  return parsed.range() !== "unicast";
}

function isDnsProxySyntheticAddress(address: string): boolean {
  const parsed = parseIpAddress(address);
  if (!parsed) return false;
  const ipv4 = parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()
    ? parsed.toIPv4Address()
    : parsed;
  if (!(ipv4 instanceof ipaddr.IPv4)) return false;

  // RFC 2544 benchmarking addresses are commonly used by local DNS proxy fake-IP modes.
  const [firstOctet, secondOctet] = ipv4.toByteArray();
  return firstOctet === 198 && (secondOctet === 18 || secondOctet === 19);
}

function parseIpAddress(address: string) {
  try {
    return ipaddr.parse(normalizeHostname(address));
  } catch {
    return undefined;
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Redirect 中的旧响应已不再消费，取消失败不应绕过下一跳 policy 校验。
  }
}
