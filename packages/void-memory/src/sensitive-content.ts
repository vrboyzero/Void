/**
 * 写入前的敏感内容闸门。
 *
 * 记忆正文一旦落盘就会被索引、被检索、被后续的梦与军团读取，因此敏感内容必须在
 * 触碰磁盘之前就拒绝：正文、临时文件、备份和索引里都不允许出现已知密钥。
 * 拒绝信息只带类型与位置，绝不回显命中的原文。
 */

export class SensitiveContentError extends Error {
  readonly kind: string;

  constructor(kind: string) {
    super(`记忆正文含疑似敏感内容（${kind}），已拒绝写入`);
    this.name = "SensitiveContentError";
    this.kind = kind;
  }
}

export interface SensitiveFinding {
  kind: string;
  /** 命中片段在正文中的起始下标。 */
  offset: number;
  /** 命中片段长度，用于诊断，不含原文。 */
  length: number;
}

interface SensitivePattern {
  kind: string;
  pattern: RegExp;
}

/**
 * 已知密钥的高置信度特征。刻意只收窄口径明确的凭证形态，避免把普通叙述
 * （例如“密码提示：找回邮箱”）当成密钥拦下。
 */
const PATTERNS: readonly SensitivePattern[] = [
  { kind: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { kind: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { kind: "github-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { kind: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { kind: "bearer-token", pattern: /\b[Bb]earer\s+[A-Za-z0-9._-]{20,}/ },
  {
    kind: "assigned-credential",
    pattern: /(?:password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9!@#$%^&*._-]{8,}/i,
  },
];

/** 扫描正文，返回全部命中。同一类型只报第一处，避免长文刷屏。 */
export function scanSensitiveContent(text: string): SensitiveFinding[] {
  const findings: SensitiveFinding[] = [];
  const seen = new Set<string>();
  for (const { kind, pattern } of PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    if (seen.has(kind)) continue;
    seen.add(kind);
    findings.push({ kind, offset: match.index, length: match[0].length });
  }
  return findings;
}

/** 命中即抛错，错误信息不含原文。正文必须在写盘之前过这道闸门。 */
export function assertNoSensitiveContent(text: string): void {
  const [first] = scanSensitiveContent(text);
  if (first) throw new SensitiveContentError(first.kind);
}
