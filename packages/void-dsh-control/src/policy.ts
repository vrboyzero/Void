/**
 * User-owned caller policy for the Lingbang control plane (plan §9.1).
 *
 * The policy is the authority on what an external caller must submit. It is
 * read from DSH settings, never from the request: an external caller cannot
 * weaken, extend or override it. Violations become stable error codes so a
 * caller can fix its request without guessing.
 *
 * @module @void/void-dsh-control/policy
 */
import { ControlError, type ControlErrorCode } from "./protocol.js";

/** One document the user requires a caller to reference. */
export interface RequiredDocumentRule {
  /** Stable rule identity, reported in violations. */
  readonly id: string;
  /** Human-readable requirement, echoed back to the caller. */
  readonly description: string;
  /** Whether a matching document reference is mandatory. */
  readonly required: boolean;
  /**
   * Regular expression source matched against a workspace-relative document
   * path. Absent means "any path satisfies this rule".
   */
  readonly pathPattern?: string;
}

/** User-authored caller constraints, as written in DSH settings. */
export interface CallerPolicy {
  /** Free-form instructions returned by `dsh_control_info`. */
  readonly callerInstructions: string;
  /** Metadata fields every dispatch request must supply non-empty. */
  readonly requiredFields: readonly string[];
  /** Document requirements every dispatch request must satisfy. */
  readonly requiredDocumentRules: readonly RequiredDocumentRule[];
  /** Regular expressions whose match anywhere in caller text is rejected. */
  readonly forbiddenPatterns: readonly string[];
  /** Monotonic version the user bumps when the rules change. */
  readonly instructionsVersion: number;
}

/** A policy with every regular expression compiled once at load time. */
export interface CompiledCallerPolicy {
  readonly callerInstructions: string;
  readonly requiredFields: readonly string[];
  readonly requiredDocumentRules: readonly CompiledDocumentRule[];
  readonly forbiddenPatterns: readonly RegExp[];
  readonly instructionsVersion: number;
  /** Whether any rule declares a path pattern; drives `policy-document-invalid`. */
  readonly restrictsDocumentPaths: boolean;
}

/** One compiled document rule. */
export interface CompiledDocumentRule extends Omit<RequiredDocumentRule, "pathPattern"> {
  readonly pathPattern?: RegExp;
}

/** The empty policy: no requirements, version 0. */
export const EMPTY_CALLER_POLICY: CallerPolicy = Object.freeze({
  callerInstructions: "",
  requiredFields: [],
  requiredDocumentRules: [],
  forbiddenPatterns: [],
  instructionsVersion: 0,
});

/**
 * Compile a user policy, failing loud on an unusable pattern.
 *
 * Compilation happens once at plugin activation rather than per request, so a
 * typo in settings surfaces as a startup error instead of as a mysterious
 * request-time rejection.
 *
 * @param policy - Policy as written in settings.
 * @returns The compiled policy.
 * @throws ControlError `dsh-control/internal` when a pattern is not a valid RegExp.
 */
export function compilePolicy(policy: CallerPolicy): CompiledCallerPolicy {
  const compile = (source: string, what: string): RegExp => {
    try {
      return new RegExp(source, "u");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ControlError("dsh-control/internal", `invalid ${what} regular expression`, { source, reason });
    }
  };

  const rules = policy.requiredDocumentRules.map((rule) => ({
    id: rule.id,
    description: rule.description,
    required: rule.required,
    ...(rule.pathPattern === undefined ? {} : { pathPattern: compile(rule.pathPattern, `pathPattern of rule "${rule.id}"`) }),
  }));

  return Object.freeze({
    callerInstructions: policy.callerInstructions,
    requiredFields: Object.freeze([...policy.requiredFields]),
    requiredDocumentRules: Object.freeze(rules),
    forbiddenPatterns: Object.freeze(policy.forbiddenPatterns.map((pattern) => compile(pattern, "forbiddenPatterns"))),
    instructionsVersion: policy.instructionsVersion,
    restrictsDocumentPaths: rules.some((rule) => rule.pathPattern !== undefined),
  });
}

/** One policy violation, ready to be turned into a control error. */
export interface PolicyViolation {
  readonly code: ControlErrorCode;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

/** Everything a policy check may inspect about one request. */
export interface PolicyCheckInput {
  /** Caller-supplied audit metadata. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Workspace-relative document paths referenced by the request. */
  readonly documentPaths?: readonly string[];
  /** Every text the request would deliver to the session. */
  readonly texts: readonly string[];
}

/**
 * Whether a metadata value counts as supplied.
 *
 * `undefined`, `null`, an empty or whitespace-only string and an empty array all
 * count as missing: a caller must not satisfy a required field with a
 * placeholder.
 *
 * @param value - Metadata value to test.
 * @returns True when the value carries content.
 */
function isSupplied(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Evaluate a request against the compiled policy.
 *
 * Returns every violation rather than the first, so one round trip tells the
 * caller everything it must fix. An empty array means the request may proceed.
 *
 * @param policy - Compiled user policy.
 * @param input - Request facts to check.
 * @returns Violations in a stable order: required fields, documents, content.
 */
export function checkPolicy(policy: CompiledCallerPolicy, input: PolicyCheckInput): readonly PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const documentPaths = input.documentPaths ?? [];

  const missingFields = policy.requiredFields.filter((field) => !isSupplied(input.metadata?.[field]));
  if (missingFields.length > 0) {
    violations.push({
      code: "dsh-control/policy-required-field",
      message: `missing required metadata field(s): ${missingFields.join(", ")}`,
      details: { missingFields, requiredFields: policy.requiredFields },
    });
  }

  for (const rule of policy.requiredDocumentRules) {
    if (!rule.required) continue;
    const matched = documentPaths.some((path) => rule.pathPattern === undefined || rule.pathPattern.test(path));
    if (!matched) {
      violations.push({
        code: "dsh-control/policy-document-missing",
        message: `required document rule "${rule.id}" is not satisfied: ${rule.description}`,
        details: {
          ruleId: rule.id,
          description: rule.description,
          ...(rule.pathPattern === undefined ? {} : { pathPattern: rule.pathPattern.source }),
          providedPaths: documentPaths,
        },
      });
    }
  }

  if (policy.restrictsDocumentPaths) {
    const unrecognized = documentPaths.filter(
      (path) => !policy.requiredDocumentRules.some((rule) => rule.pathPattern?.test(path)),
    );
    if (unrecognized.length > 0) {
      violations.push({
        code: "dsh-control/policy-document-invalid",
        message: "document reference does not match any configured document rule",
        details: {
          unrecognizedPaths: unrecognized,
          allowedPatterns: policy.requiredDocumentRules
            .map((rule) => rule.pathPattern?.source)
            .filter((source): source is string => source !== undefined),
        },
      });
    }
  }

  const scanned = [...input.texts, ...collectMetadataStrings(input.metadata)];
  for (const pattern of policy.forbiddenPatterns) {
    const hit = scanned.find((value) => pattern.test(value));
    if (hit === undefined) continue;
    violations.push({
      code: "dsh-control/policy-forbidden-content",
      message: "request contains content forbidden by the configured caller policy",
      // The offending text is deliberately not echoed: it is exactly the content
      // the user asked never to have copied into logs or responses.
      details: { pattern: pattern.source, source: "request-content" },
    });
  }

  return violations;
}

/**
 * Flatten metadata string values for forbidden-content scanning.
 *
 * @param metadata - Caller metadata.
 * @returns Every string reachable in the metadata tree.
 */
function collectMetadataStrings(metadata: Readonly<Record<string, unknown>> | undefined): string[] {
  if (metadata === undefined) return [];
  const out: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6) return;
    if (typeof value === "string") {
      out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const item of Object.values(value)) visit(item, depth + 1);
    }
  };
  visit(metadata, 0);
  return out;
}

/**
 * Turn the first policy violation into a thrown control error.
 *
 * @param violations - Result of {@link checkPolicy}.
 * @throws ControlError carrying the first violation's stable code.
 */
export function throwOnViolations(violations: readonly PolicyViolation[]): void {
  const first = violations[0];
  if (first === undefined) return;
  throw new ControlError(first.code, first.message, { ...first.details, violationCount: violations.length });
}

/**
 * Project the compiled policy into the `dsh_control_info` response body.
 *
 * The response is the authoritative, live view of the rules (plan §9.1): tool
 * descriptions only hint at them because settings can change under HMR.
 *
 * @param policy - Compiled user policy.
 * @returns A JSON-safe projection.
 */
export function describePolicy(policy: CompiledCallerPolicy): Record<string, unknown> {
  return {
    callerInstructions: policy.callerInstructions,
    instructionsVersion: policy.instructionsVersion,
    requiredFields: [...policy.requiredFields],
    requiredDocumentRules: policy.requiredDocumentRules.map((rule) => ({
      id: rule.id,
      description: rule.description,
      required: rule.required,
      ...(rule.pathPattern === undefined ? {} : { pathPattern: rule.pathPattern.source }),
    })),
    forbiddenPatternCount: policy.forbiddenPatterns.length,
  };
}
