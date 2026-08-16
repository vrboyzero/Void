export type MemoryModelEndpointTrust = "local" | "trusted_remote" | "untrusted_remote";
export type MemoryPrivateSummaryJobFamily = "dream" | "idle_summary" | "durable_extraction";
export type MemoryModelRedactor = (text: string) => string;

export const MEMORY_MODEL_MAX_REQUEST_BYTES = 1024 * 1024;

export type MemoryModelPrivacySnapshot = {
  jobFamily: MemoryPrivateSummaryJobFamily;
  dataClass: "private_summary";
  trustProfile: MemoryModelEndpointTrust;
  redactorStatus: "off" | "not_applied_local" | "applied";
  requestBytes: number;
};

export type MemoryModelPrivacyObservation = {
  id: number;
  jobFamily: MemoryPrivateSummaryJobFamily;
};

export type MemoryModelPrivacyDoctorItem = {
  jobFamily: MemoryPrivateSummaryJobFamily;
  dataClass: "private_summary";
  trustProfile: MemoryModelEndpointTrust;
  leavesLocalMachine: boolean;
  redactorStatus: "off" | "enabled";
  requestBytes: number;
  responseBytes: number;
  status: "idle" | "prepared" | "succeeded" | "failed";
  httpStatus?: number;
};

export type MemoryModelPrivacyDoctorReport = {
  dataClass: "private_summary";
  items: MemoryModelPrivacyDoctorItem[];
};

export class MemoryModelPrivacyRuntime {
  private readonly trustedRemoteHosts: readonly string[];
  private readonly redactor?: MemoryModelRedactor;
  private readonly entries = new Map<MemoryPrivateSummaryJobFamily, MemoryModelPrivacyDoctorItem>();
  private readonly currentObservationIds = new Map<MemoryPrivateSummaryJobFamily, number>();
  private nextObservationId = 1;

  constructor(options: {
    trustedRemoteHosts?: readonly string[];
    redactor?: MemoryModelRedactor;
  } = {}) {
    this.trustedRemoteHosts = options.trustedRemoteHosts ?? [];
    this.redactor = options.redactor;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): MemoryModelPrivacyRuntime {
    const trustedRemoteHosts = String(
      env.BELLDANDY_MEMORY_PRIVATE_SUMMARY_TRUSTED_HOSTS ?? "",
    )
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const redactorMode = String(
      env.BELLDANDY_MEMORY_PRIVATE_SUMMARY_REDACTOR ?? "off",
    ).trim().toLowerCase();
    return new MemoryModelPrivacyRuntime({
      trustedRemoteHosts,
      ...(redactorMode === "basic" ? { redactor: redactPrivateSummaryText } : {}),
    });
  }

  registerEndpoint(jobFamily: MemoryPrivateSummaryJobFamily, baseUrl: string): void {
    if (this.entries.has(jobFamily)) return;
    const trustProfile = resolveMemoryModelEndpointTrust(baseUrl, this.trustedRemoteHosts);
    this.entries.set(jobFamily, this.createDoctorItem(jobFamily, trustProfile));
  }

  prepareRequest(input: {
    jobFamily: MemoryPrivateSummaryJobFamily;
    baseUrl: string;
    payload: Record<string, unknown>;
    maxRequestBytes?: number;
  }): ReturnType<typeof preparePrivateSummaryModelRequest> & {
    observation: MemoryModelPrivacyObservation;
  } {
    const prepared = preparePrivateSummaryModelRequest({
      ...input,
      trustedRemoteHosts: this.trustedRemoteHosts,
      redactor: this.redactor,
    });
    const observation = {
      id: this.nextObservationId++,
      jobFamily: input.jobFamily,
    };
    this.currentObservationIds.set(input.jobFamily, observation.id);
    this.entries.set(input.jobFamily, {
      ...this.createDoctorItem(input.jobFamily, prepared.snapshot.trustProfile),
      requestBytes: prepared.snapshot.requestBytes,
      status: "prepared",
    });
    return { ...prepared, observation };
  }

  completeRequest(
    observation: MemoryModelPrivacyObservation,
    result: { httpStatus: number; responseBytes: number },
  ): void {
    this.updateObservation(observation, {
      httpStatus: result.httpStatus,
      responseBytes: normalizeObservedBytes(result.responseBytes),
      status: result.httpStatus >= 200 && result.httpStatus < 300 ? "succeeded" : "failed",
    });
  }

  failRequest(
    observation: MemoryModelPrivacyObservation,
    result: { httpStatus?: number; responseBytes?: number } = {},
  ): void {
    this.updateObservation(observation, {
      ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
      responseBytes: normalizeObservedBytes(result.responseBytes),
      status: "failed",
    });
  }

  getDoctorReport(): MemoryModelPrivacyDoctorReport {
    return {
      dataClass: "private_summary",
      items: [...this.entries.values()]
        .sort((left, right) => left.jobFamily.localeCompare(right.jobFamily))
        .map((item) => ({ ...item })),
    };
  }

  private createDoctorItem(
    jobFamily: MemoryPrivateSummaryJobFamily,
    trustProfile: MemoryModelEndpointTrust,
  ): MemoryModelPrivacyDoctorItem {
    return {
      jobFamily,
      dataClass: "private_summary",
      trustProfile,
      leavesLocalMachine: trustProfile !== "local",
      redactorStatus: this.redactor ? "enabled" : "off",
      requestBytes: 0,
      responseBytes: 0,
      status: "idle",
    };
  }

  private updateObservation(
    observation: MemoryModelPrivacyObservation,
    patch: Pick<MemoryModelPrivacyDoctorItem, "responseBytes" | "status"> & { httpStatus?: number },
  ): void {
    if (this.currentObservationIds.get(observation.jobFamily) !== observation.id) return;
    const current = this.entries.get(observation.jobFamily);
    if (!current) return;
    this.entries.set(observation.jobFamily, {
      ...current,
      ...patch,
    });
  }
}

export function preparePrivateSummaryModelRequest(input: {
  jobFamily: MemoryPrivateSummaryJobFamily;
  baseUrl: string;
  payload: Record<string, unknown>;
  trustedRemoteHosts: readonly string[];
  redactor?: MemoryModelRedactor;
  maxRequestBytes?: number;
}): {
  payload: Record<string, unknown>;
  body: string;
  snapshot: MemoryModelPrivacySnapshot;
} {
  const trustProfile = resolveMemoryModelEndpointTrust(input.baseUrl, input.trustedRemoteHosts);
  const redactor = input.redactor;
  const shouldRedact = trustProfile !== "local" && redactor !== undefined;
  const payload = shouldRedact
    ? redactPayloadCopy(input.payload, redactor)
    : input.payload;
  const body = JSON.stringify(payload);
  const requestBytes = Buffer.byteLength(body, "utf8");
  const maxRequestBytes = normalizeByteLimit(input.maxRequestBytes, MEMORY_MODEL_MAX_REQUEST_BYTES);
  if (requestBytes > maxRequestBytes) {
    throw new Error(`Private summary model request exceeds ${maxRequestBytes} byte limit.`);
  }
  return {
    payload,
    body,
    snapshot: {
      jobFamily: input.jobFamily,
      dataClass: "private_summary",
      trustProfile,
      redactorStatus: shouldRedact
        ? "applied"
        : input.redactor
          ? "not_applied_local"
          : "off",
      requestBytes,
    },
  };
}

export function resolveMemoryModelEndpointTrust(
  baseUrl: string,
  trustedRemoteHosts: readonly string[],
): MemoryModelEndpointTrust {
  const hostname = normalizeHostname(new URL(baseUrl).hostname);
  if (
    hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "[::1]"
    || hostname === "::1"
  ) {
    return "local";
  }
  if (trustedRemoteHosts.some((candidate) => normalizeHostname(candidate) === hostname)) {
    return "trusted_remote";
  }
  return "untrusted_remote";
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/u, "");
}

function normalizeByteLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function normalizeObservedBytes(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

const REDACTED_PAYLOAD_KEYS = new Set([
  "apiKey",
  "content",
  "conversation",
  "input",
  "message",
  "prompt",
  "summary",
  "text",
]);

function redactPrivateSummaryText(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[REDACTED_EMAIL]")
    .replace(/\bsk-[A-Z0-9_-]{8,}\b/giu, "[REDACTED_SECRET]");
}

function redactPayloadCopy(
  payload: Record<string, unknown>,
  redactor: MemoryModelRedactor,
): Record<string, unknown> {
  return copyJsonValue(payload, redactor, false) as Record<string, unknown>;
}

function copyJsonValue(
  value: unknown,
  redactor: MemoryModelRedactor,
  redactStrings: boolean,
): unknown {
  if (typeof value === "string") {
    return redactStrings ? redactor(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => copyJsonValue(item, redactor, redactStrings));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      copyJsonValue(item, redactor, redactStrings || REDACTED_PAYLOAD_KEYS.has(key)),
    ]));
  }
  return value;
}
