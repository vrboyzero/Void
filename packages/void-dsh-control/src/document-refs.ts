/**
 * Document-reference resolution for the Lingbang control plane (plan §8.2).
 *
 * Two modes exist and they are deliberately different:
 *
 * - `reference` names a workspace-relative path for the DSH agent to read with
 *   its own tools. The control plane only validates the path and never reads it.
 * - `inline` reads a bounded amount of text and embeds it in the same user
 *   message, recording the source path and a truncation marker so the session
 *   log stays self-describing.
 *
 * Sensitive files are refused in both modes: a machine token that inlines
 * `.env` would copy credentials into the session log, which the plan's security
 * rules forbid.
 *
 * @module @void/void-dsh-control/document-refs
 */
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { assertPathInsideWorkspace, toWorkspaceRelative, type PathGuard } from "./workspace.js";
import { ControlError, LIMITS, type DocumentRefMode } from "./protocol.js";

/** One document reference as received from a caller. */
export interface DocumentRefInput {
  readonly path: string;
  readonly mode: DocumentRefMode;
}

/** One validated document reference. */
export interface ResolvedDocumentRef {
  /** Workspace-relative path, forward slashes, safe to echo to the agent. */
  readonly relativePath: string;
  readonly mode: DocumentRefMode;
  /** Decoded text, present only for `inline`. */
  readonly text?: string;
  /** Bytes read, present only for `inline`. */
  readonly bytes?: number;
  /** Whether the inline text was cut at the configured bound. */
  readonly truncated?: boolean;
}

/**
 * File names and extensions that are never inlined automatically (plan §8.2).
 *
 * Matching is by exact name, by suffix, or by extension; it is intentionally
 * conservative because a false refusal costs a caller one message, while a false
 * accept copies a credential into a durable transcript.
 */
const SENSITIVE_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "credentials",
  "credentials.json",
  ".credentials.yaml",
  ".credentials.yml",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  ".git-credentials",
]);

/** Extensions that never carry inlineable context. */
const SENSITIVE_EXTENSIONS = [".pem", ".key", ".pfx", ".p12", ".keystore", ".jks", ".ppk"];

/**
 * Whether a file name is on the never-inline list.
 *
 * @param path - Workspace-relative or absolute path.
 * @returns True when the file must not be inlined.
 */
export function isSensitivePath(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (SENSITIVE_NAMES.has(name)) return true;
  if (name.startsWith(".env.")) return true;
  return SENSITIVE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/**
 * Resolve and validate every document reference of one message.
 *
 * Validation is all-or-nothing: a message either has every reference it asked
 * for or the request is rejected before anything reaches the session log, so a
 * partially delivered task can never happen.
 *
 * @param refs - References as received from the caller.
 * @param workspaceRoot - Canonical workspace root the references belong to.
 * @param guard - Configured path policy.
 * @returns Validated references in request order.
 * @throws ControlError on an unsafe path, a directory, a sensitive file or a size overrun.
 */
export async function resolveDocumentRefs(
  refs: readonly DocumentRefInput[],
  workspaceRoot: string,
  guard: PathGuard,
): Promise<readonly ResolvedDocumentRef[]> {
  const out: ResolvedDocumentRef[] = [];
  let inlineTotal = 0;

  for (const ref of refs) {
    const real = await assertPathInsideWorkspace(ref.path, workspaceRoot, guard);
    const info = await stat(real).catch(() => undefined);
    if (info === undefined || !info.isFile()) {
      throw new ControlError("dsh-control/policy-document-invalid", "document reference must be a regular file", {
        path: ref.path,
      });
    }

    const relativePath = toWorkspaceRelative(real, workspaceRoot);

    if (ref.mode === "reference") {
      out.push({ relativePath, mode: "reference" });
      continue;
    }

    if (isSensitivePath(relativePath)) {
      throw new ControlError(
        "dsh-control/policy-document-invalid",
        "refusing to inline a file that may contain credentials; use mode \"reference\" instead",
        { path: relativePath },
      );
    }

    if (info.size > LIMITS.maxInlineDocumentBytes) {
      throw new ControlError("dsh-control/limit-exceeded", "inline document exceeds the per-file byte limit", {
        path: relativePath,
        bytes: info.size,
        limit: LIMITS.maxInlineDocumentBytes,
      });
    }

    inlineTotal += info.size;
    if (inlineTotal > LIMITS.maxInlineTotalBytes) {
      throw new ControlError("dsh-control/limit-exceeded", "inline documents exceed the per-message byte limit", {
        limit: LIMITS.maxInlineTotalBytes,
      });
    }

    const buffer = await readFile(real);
    const text = buffer.toString("utf8");
    const truncated = text.length > LIMITS.maxInlineDocumentBytes;
    out.push({
      relativePath,
      mode: "inline",
      text: truncated ? text.slice(0, LIMITS.maxInlineDocumentBytes) : text,
      bytes: buffer.byteLength,
      truncated,
    });
  }

  return out;
}

/**
 * Render resolved references into the model-facing part of a user message.
 *
 * The rendered block states, for each reference, where it came from and whether
 * it was truncated, so the session log alone explains what the model saw
 * (plan §8.2). `reference` entries ask the agent to read the file itself.
 *
 * @param refs - Validated references.
 * @returns The text block to append, or an empty string when there are none.
 */
export function renderDocumentRefs(refs: readonly ResolvedDocumentRef[]): string {
  if (refs.length === 0) return "";

  const sections = refs.map((ref) => {
    if (ref.mode === "reference") {
      return `- 文档引用：\`${ref.relativePath}\`（请用你自己的文件工具读取）`;
    }
    const marker = ref.truncated === true ? "，已按大小上限截断" : "";
    return `- 文档内联：\`${ref.relativePath}\`（${ref.bytes ?? 0} 字节${marker}）\n\n\`\`\`\n${ref.text ?? ""}\n\`\`\``;
  });

  return ["", "--- 随本条消息附带的文档 ---", ...sections].join("\n");
}
