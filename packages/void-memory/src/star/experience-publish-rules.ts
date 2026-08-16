import type { ExperienceCandidateType } from "./experience-types.js";

const hasHanCharacterRegex = /\p{Script=Han}/u;
const canonicalMethodFilenameBaseRegex = /^[A-Za-z0-9_\p{Script=Han}]+-[A-Za-z0-9_\p{Script=Han}]+-[A-Za-z0-9_\p{Script=Han}]+$/u;
const genericSkillNames = new Set(["skill", "task", "candidate", "draft"]);

const chineseMethodActionRules = [
  { pattern: /(创建|新建|生成|编写|撰写|产出)/u, value: "创建" },
  { pattern: /(实现|落地|完成|搭建|构建)/u, value: "实现" },
  { pattern: /(查询|检索|搜索|查找)/u, value: "查询" },
  { pattern: /(读取|查看|浏览|审阅)/u, value: "读取" },
  { pattern: /(写入|保存|记录|回写)/u, value: "写入" },
  { pattern: /(修改|更新|编辑|改进|优化|补强|收紧)/u, value: "更新" },
  { pattern: /(删除|移除|清理)/u, value: "删除" },
  { pattern: /(发布|上线)/u, value: "发布" },
  { pattern: /(校验|验证|检查|预检|测试|回归)/u, value: "校验" },
  { pattern: /(梳理|总结|整理|分析|归纳|复盘)/u, value: "梳理" },
  { pattern: /(同步|迁移)/u, value: "同步" },
  { pattern: /(修复|排查)/u, value: "修复" },
] as const;

const chineseMethodDetailRules = [
  "闭环",
  "预检",
  "校验",
  "发布前",
  "去重",
  "命名",
  "模板",
  "规范",
  "索引",
  "入口",
  "总览",
  "确认",
  "工作区",
  "安全",
  "批量",
  "草稿",
  "回归",
  "测试",
  "修复",
  "迁移",
  "同步",
] as const;

const englishMethodActionRules = [
  { pattern: /create|build|make|generate|write|author/, value: "create" },
  { pattern: /implement|setup|establish|bootstrap/, value: "implement" },
  { pattern: /read|view|inspect|open/, value: "read" },
  { pattern: /query|search|find|lookup/, value: "query" },
  { pattern: /update|edit|modify|improve|optimize|tighten/, value: "update" },
  { pattern: /delete|remove|cleanup|clean/, value: "delete" },
  { pattern: /publish|release|ship/, value: "publish" },
  { pattern: /validate|verify|check|test|audit/, value: "validate" },
  { pattern: /review|summarize|analyze|organize/, value: "review" },
  { pattern: /sync|migrate/, value: "sync" },
  { pattern: /repair|fix|debug|troubleshoot/, value: "repair" },
] as const;

const englishStopwords = new Set([
  "a",
  "an",
  "and",
  "the",
  "to",
  "for",
  "of",
  "in",
  "on",
  "with",
  "from",
  "by",
  "or",
  "task",
  "method",
  "methods",
  "candidate",
  "draft",
  "workflow",
  "flow",
  "guide",
  "doc",
  "docs",
]);

export const EXPERIENCE_METHOD_REQUIRED_HEADINGS = [
  "## 0. 元信息",
  "## 1. 触发条件",
  "## 2. 适用场景",
  "## 3. 执行步骤",
  "## 4. 工具选择",
  "## 5. 失败经验",
  "## 6. 成功案例",
  "## 7. 相关资源",
  "## 8. 更新记录",
] as const;

export const EXPERIENCE_SKILL_REQUIRED_HEADINGS = [
  "## 快速开始",
  "## 决策路由",
  "## 输入",
  "## 输出",
  "## 参考指引",
  "## NEVER",
] as const;

export function buildExperienceCandidateSlug(
  type: ExperienceCandidateType,
  input: { title?: string; slug?: string; fallback: string; objective?: string; summary?: string },
): string {
  if (type === "method") {
    return buildExperienceMethodFilenameBase(input);
  }
  return buildExperienceSkillMachineName({
    name: input.slug,
    title: input.title,
    fallback: input.fallback,
  });
}

export function buildExperienceMethodFilenameBase(input: {
  title?: string;
  slug?: string;
  fallback: string;
  objective?: string;
  summary?: string;
}): string {
  const canonicalValues = [
    input.slug,
    input.title,
    input.objective,
  ];
  for (const value of canonicalValues) {
    const normalized = normalizeCanonicalMethodFilenameBase(stripMethodSlugPrefix(value));
    if (normalized) {
      return normalized;
    }
  }

  const mode = prefersChineseMethodFilename(input) ? "zh" : "en";
  return mode === "zh"
    ? buildChineseMethodFilenameBase(input)
    : buildEnglishMethodFilenameBase(input);
}

export function isCanonicalMethodFilenameBase(value: string | undefined): boolean {
  return Boolean(normalizeCanonicalMethodFilenameBase(value));
}

export function isCanonicalMethodFilename(value: string | undefined): boolean {
  const normalized = String(value ?? "").trim();
  if (!normalized.toLowerCase().endsWith(".md")) {
    return false;
  }
  return isCanonicalMethodFilenameBase(normalized.slice(0, -3));
}

export function appendMethodFilenameRevision(baseName: string, revision: string): string {
  const normalizedBase = normalizeCanonicalMethodFilenameBase(baseName);
  if (!normalizedBase) {
    return normalizeCanonicalMethodFilenameBase(`${baseName}-${revision}`) || normalizedBase || baseName;
  }

  const parts = normalizedBase.split("-");
  const suffix = String(revision ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  if (!suffix) {
    return normalizedBase;
  }
  parts[2] = `${parts[2]}_${suffix}`.replace(/_+/g, "_");
  return parts.join("-");
}

export function buildExperienceSkillMachineName(input: {
  name?: string;
  title?: string;
  slug?: string;
  fallback: string;
}): string {
  const candidates = [
    input.name,
    stripSkillSlugPrefix(input.slug),
    input.title,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeExperienceSkillMachineName(candidate);
    if (!normalized || genericSkillNames.has(normalized)) {
      continue;
    }
    return normalized;
  }

  return `skill-${normalizeAsciiToken(input.fallback, "task")}`;
}

export function normalizeExperienceSkillMachineName(value: string | undefined): string {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/\/skill\.md$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return normalized;
}

export function readFirstMarkdownTitle(content: string): string | undefined {
  return String(content ?? "").match(/^#\s+(.+)$/m)?.[1]?.trim();
}

export function validateMethodCandidateDraftForPublish(content: string): string[] {
  const issues: string[] = [];
  const title = readFirstMarkdownTitle(content);
  if (!title) {
    issues.push("缺少一级标题（# 标题）。");
  }

  for (const heading of EXPERIENCE_METHOD_REQUIRED_HEADINGS) {
    if (!content.includes(heading)) {
      issues.push(`缺少必需章节：${heading}`);
    }
  }

  return issues;
}

export function validateSkillCandidateDraftForPublish(content: string): string[] {
  const issues: string[] = [];
  const title = readFirstMarkdownTitle(content);
  if (!title) {
    issues.push("缺少一级标题（# 标题）。");
  }

  for (const heading of EXPERIENCE_SKILL_REQUIRED_HEADINGS) {
    if (!content.includes(heading)) {
      issues.push(`缺少必需章节：${heading}`);
    }
  }

  const raw = String(content ?? "");
  if (!/(?:^|\n)name:\s*["']?[^"\n']+["']?/i.test(raw)) {
    issues.push("缺少 frontmatter.name。");
  }
  if (!/(?:^|\n)description:\s*["']?[^"\n']+["']?/i.test(raw)) {
    issues.push("缺少 frontmatter.description。");
  }

  return issues;
}

function stripMethodDraftDecorators(value: string | undefined): string {
  return String(value ?? "")
    .replace(/(?:方法草稿|方法候选|草稿|候选)$/g, "")
    .trim();
}

function stripMethodSlugPrefix(value: string | undefined): string {
  return String(value ?? "")
    .replace(/^method-/i, "")
    .trim();
}

function stripSkillSlugPrefix(value: string | undefined): string {
  return String(value ?? "")
    .replace(/^skill-/i, "")
    .trim();
}

function normalizeCanonicalMethodFilenameBase(value: string | undefined): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\.md$/i, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!canonicalMethodFilenameBaseRegex.test(normalized)) {
    return "";
  }
  return normalized.toLowerCase();
}

function prefersChineseMethodFilename(input: {
  title?: string;
  slug?: string;
  fallback: string;
  objective?: string;
  summary?: string;
}): boolean {
  return [input.title, input.slug, input.objective, input.summary]
    .some((value) => hasHanCharacterRegex.test(String(value ?? "")));
}

function buildChineseMethodFilenameBase(input: {
  title?: string;
  slug?: string;
  fallback: string;
  objective?: string;
  summary?: string;
}): string {
  const sources = [
    stripMethodDraftDecorators(input.title),
    stripMethodSlugPrefix(input.slug),
    input.objective,
    input.summary,
  ].filter(Boolean) as string[];
  const objectSegment = normalizeChineseMethodSegment(
    extractChineseObjectSegment(sources),
    "任务",
    7,
  );
  const actionSegment = normalizeChineseMethodSegment(
    extractChineseActionSegment(sources),
    "处理",
    4,
  );
  const detailSegment = normalizeChineseMethodSegment(
    extractChineseDetailSegment(sources, objectSegment, actionSegment),
    "通用",
    4,
  );
  return `${objectSegment}-${actionSegment}-${detailSegment}`;
}

function buildEnglishMethodFilenameBase(input: {
  title?: string;
  slug?: string;
  fallback: string;
  objective?: string;
  summary?: string;
}): string {
  const rawSources = [
    stripMethodSlugPrefix(input.slug),
    stripMethodDraftDecorators(input.title),
    input.objective,
    input.summary,
    input.fallback,
  ].filter(Boolean) as string[];
  const action = extractEnglishActionSegment(rawSources);
  const tokens = rawSources.flatMap((value) => tokenizeEnglishWords(value));
  const filteredTokens = tokens.filter((token) => !englishStopwords.has(token));
  const actionSynonyms = collectEnglishActionSynonyms(action);
  const objectTokens = filteredTokens.filter((token) => !actionSynonyms.has(token));
  const objectSegment = buildEnglishMethodSegment(objectTokens, "task");
  const detailPool = objectTokens.filter((token) => !objectSegment.split("_").includes(token));
  const fallbackTokens = tokenizeEnglishWords(input.fallback);
  const detailSegment = buildEnglishMethodSegment(
    detailPool.length > 0 ? detailPool : fallbackTokens,
    "general",
  );
  return `${objectSegment}-${action}-${detailSegment}`;
}

function extractChineseActionSegment(values: string[]): string {
  const text = values.join(" ");
  for (const rule of chineseMethodActionRules) {
    if (rule.pattern.test(text)) {
      return rule.value;
    }
  }
  return "处理";
}

function extractChineseObjectSegment(values: string[]): string {
  const actionTokens = [
    ...chineseMethodActionRules.map((rule) => rule.value),
    "完成",
    "处理",
  ];
  const genericTokens = [
    "方法",
    "方案",
    "流程",
    "经验",
    "总结",
    "说明",
    "文档",
    "规则",
    "规范",
    "草稿",
    "最小",
    "自动",
    "自动化",
    "基础",
    "的",
  ];

  for (const value of values) {
    const sourceCandidates: string[] = [];
    const cleaned = String(value ?? "")
      .replace(/[A-Za-z0-9]+/g, " ")
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
      .replace(/[，。、“”‘’：；！!？?,（）()\[\]【】{}]/g, " ")
      .replace(/\s+/g, " ");
    const candidates = cleaned.match(/[\p{Script=Han}]{2,}/gu) ?? [];
    for (const candidate of candidates) {
      let normalized = candidate;
      for (const token of actionTokens) {
        normalized = normalized.replaceAll(token, "");
      }
      for (const token of genericTokens) {
        normalized = normalized.replaceAll(token, "");
      }
      normalized = normalized.trim();
      if (normalized.length >= 2) {
        sourceCandidates.push(normalized);
      }
    }
    const bestSourceCandidate = sourceCandidates.sort((left, right) => right.length - left.length)[0];
    if (bestSourceCandidate) {
      return bestSourceCandidate;
    }
  }
  return "任务";
}

function extractChineseDetailSegment(
  values: string[],
  objectSegment: string,
  actionSegment: string,
): string {
  const text = values.join(" ");
  for (const token of chineseMethodDetailRules) {
    if (text.includes(token) && token !== objectSegment && token !== actionSegment) {
      return token;
    }
  }

  for (const value of values) {
    const candidates = String(value ?? "").match(/[\p{Script=Han}]{2,}/gu) ?? [];
    for (const candidate of candidates) {
      if (candidate === objectSegment || candidate === actionSegment) {
        continue;
      }
      if (candidate.includes(objectSegment)) {
        const trimmed = candidate.replace(objectSegment, "").replace(actionSegment, "").trim();
        if (trimmed.length >= 2) {
          return trimmed;
        }
      }
    }
  }
  return "通用";
}

function normalizeChineseMethodSegment(value: string, fallback: string, maxLength: number): string {
  const normalized = String(value ?? "")
    .replace(/[^A-Za-z0-9_\p{Script=Han}]/gu, "")
    .trim();
  return (normalized || fallback).slice(0, maxLength) || fallback;
}

function extractEnglishActionSegment(values: string[]): string {
  const text = values.join(" ").toLowerCase();
  for (const rule of englishMethodActionRules) {
    if (rule.pattern.test(text)) {
      return rule.value;
    }
  }
  return "process";
}

function buildEnglishMethodSegment(tokens: string[], fallback: string): string {
  const unique = [...new Set(tokens.filter(Boolean))].slice(0, 2);
  const normalized = unique
    .map((token) => token.toLowerCase().replace(/[^a-z0-9]+/g, ""))
    .filter(Boolean)
    .join("_")
    .slice(0, 24);
  return normalized || fallback;
}

function collectEnglishActionSynonyms(action: string): Set<string> {
  const synonyms = new Set<string>([action]);
  for (const rule of englishMethodActionRules) {
    if (rule.value === action) {
      for (const token of rule.pattern.source.split("|")) {
        synonyms.add(token.replace(/[()]/g, ""));
      }
    }
  }
  return synonyms;
}

function tokenizeEnglishWords(value: string | undefined): string[] {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\.md$/i, "")
    .match(/[a-z0-9]+/g) ?? [];
}

function normalizeAsciiToken(value: string, fallback: string): string {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}
