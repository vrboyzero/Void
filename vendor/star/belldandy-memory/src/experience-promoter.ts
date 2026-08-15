import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ExperienceCandidate,
  ExperienceDedupCheckResult,
  ExperienceCandidateType,
  ExperiencePromoteResult,
  ExperienceSourceTaskDetail,
  ExperienceSourceTaskSnapshot,
} from "./experience-types.js";
import { evaluateExperienceDedup } from "./experience-dedup.js";
import {
  buildExperienceCandidateSlug,
  buildExperienceSkillMachineName,
  EXPERIENCE_METHOD_REQUIRED_HEADINGS,
  EXPERIENCE_SKILL_REQUIRED_HEADINGS,
} from "./experience-publish-rules.js";
import { MemoryStore } from "./store.js";

const EXPERIENCE_TEMPLATE_DIRNAME = "experience-templates";

export class ExperiencePromoter {
  constructor(
    private readonly store: MemoryStore,
    private readonly publishStateDir: string,
  ) { }

  checkTaskDuplicate(taskId: string, type: ExperienceCandidateType): ExperienceDedupCheckResult | null {
    const prepared = this.prepareTaskPromotion(taskId, type);
    if (!prepared) return null;

    return {
      taskId,
      type,
      title: prepared.title,
      slug: prepared.slug,
      summary: prepared.summary,
      decision: prepared.dedup.decision,
      exactMatch: prepared.dedup.exactMatch,
      similarMatches: prepared.dedup.similarMatches,
    };
  }

  promoteTask(taskId: string, type: ExperienceCandidateType): ExperiencePromoteResult | null {
    const existing = this.store.findExperienceCandidateByTaskAndType(taskId, type);
    if (existing) {
      return { candidate: existing, reusedExisting: true };
    }

    const prepared = this.prepareTaskPromotion(taskId, type);
    if (!prepared) return null;

    const now = new Date().toISOString();
    const { detail, snapshot, title, slug, summary, dedup } = prepared;

    if (dedup.decision === "duplicate_existing" && dedup.exactMatch?.candidateId) {
      const matched = this.store.getExperienceCandidate(dedup.exactMatch.candidateId);
      if (matched) {
        return {
          candidate: matched,
          reusedExisting: true,
          dedupDecision: dedup.decision,
          exactMatch: dedup.exactMatch,
          similarMatches: dedup.similarMatches,
        };
      }
    }

    const candidate: ExperienceCandidate = {
      id: `exp_${randomUUID().slice(0, 8)}`,
      taskId,
      type,
      status: "draft",
      title,
      slug,
      content: type === "method"
        ? buildMethodDraft(this.publishStateDir, title, summary, detail, snapshot, now)
        : buildSkillDraft(this.publishStateDir, title, slug, summary, detail, snapshot),
      summary,
      qualityScore: scoreCandidate(detail),
      sourceTaskSnapshot: snapshot,
      createdAt: now,
    };

    this.store.createExperienceCandidate(candidate);
    return {
      candidate,
      reusedExisting: false,
      dedupDecision: dedup.decision,
      exactMatch: dedup.exactMatch,
      similarMatches: dedup.similarMatches,
    };
  }

  private prepareTaskPromotion(taskId: string, type: ExperienceCandidateType) {
    const task = this.store.getTask(taskId);
    if (!task) return null;

    const detail: ExperienceSourceTaskDetail = {
      ...task,
      memoryLinks: this.store.listTaskMemoryLinks(taskId),
    };
    const snapshot = buildSnapshot(detail);
    const title = buildCandidateTitle(type, detail);
    const slug = buildCandidateSlug(type, detail);
    const summary = buildCandidateSummary(detail);
    const dedup = evaluateExperienceDedup({
      store: this.store,
      publishStateDir: this.publishStateDir,
      type,
      taskId,
      title,
      slug,
      summary,
    });

    return {
      detail,
      snapshot,
      title,
      slug,
      summary,
      dedup,
    };
  }
}

function buildSnapshot(task: ExperienceSourceTaskDetail): ExperienceSourceTaskSnapshot {
  return {
    taskId: task.id,
    conversationId: task.conversationId,
    agentId: task.agentId,
    source: task.source,
    status: task.status,
    title: task.title,
    objective: task.objective,
    summary: task.summary,
    reflection: task.reflection,
    outcome: task.outcome,
    toolCalls: task.toolCalls?.length ? task.toolCalls : undefined,
    artifactPaths: task.artifactPaths?.length ? task.artifactPaths : undefined,
    memoryLinks: task.memoryLinks?.length ? task.memoryLinks : undefined,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
  };
}

function buildCandidateTitle(type: ExperienceCandidateType, task: ExperienceSourceTaskDetail): string {
  return sanitizeDocumentTitle(type, pickTaskHeadline(task));
}

function buildCandidateSlug(type: ExperienceCandidateType, task: ExperienceSourceTaskDetail): string {
  return buildExperienceCandidateSlug(type, {
    title: pickTaskHeadline(task),
    fallback: task.id,
    objective: task.objective,
    summary: task.summary,
  });
}

function buildCandidateSummary(task: ExperienceSourceTaskDetail): string {
  const source = firstNonEmpty(
    task.summary,
    task.reflection,
    task.outcome,
    task.objective,
    task.title,
    `基于任务 ${task.id} 生成的经验候选`,
  );
  return collapseWhitespace(source).slice(0, 180);
}

function buildMethodDraft(
  publishStateDir: string,
  title: string,
  summary: string,
  task: ExperienceSourceTaskDetail,
  snapshot: ExperienceSourceTaskSnapshot,
  now: string,
): string {
  const template = resolveExperienceDraftTemplate(publishStateDir, "method");
  if (isTemplateUsable(template.skeleton, EXPERIENCE_METHOD_REQUIRED_HEADINGS)) {
    return buildMethodTemplateDraft(title, summary, task, snapshot, now, template.path);
  }
  return buildLegacyMethodDraft(title, summary, task, snapshot, now);
}

function buildLegacyMethodDraft(
  title: string,
  summary: string,
  task: ExperienceSourceTaskDetail,
  snapshot: ExperienceSourceTaskSnapshot,
  now: string,
): string {
  const toolNames = uniqueStrings(task.toolCalls?.map((item) => item.toolName));
  const artifacts = uniqueStrings(task.artifactPaths);
  const memoryRefs = snapshot.memoryLinks ?? [];
  const reflection = firstNonEmpty(task.reflection, task.summary, task.outcome, "待补充复盘结论。");
  const date = now.slice(0, 10);
  const methodId = buildMethodIdentifier(task.id);
  const scenario = firstNonEmpty(task.objective, task.title, "处理与来源任务相近的问题。");
  const goal = firstNonEmpty(task.summary, task.objective, task.outcome, "沉淀出可复用、可审阅的方法草稿。");
  const toolTable = buildMethodToolTable(toolNames, artifacts, task);
  const failureExperience = buildFailureExperience(date, reflection);
  const successCase = buildSuccessCase(task, toolNames);
  const relatedResources = buildRelatedResourceLines(artifacts, memoryRefs);

  const lines = [
    "---",
    `summary: "${escapeQuoted(summary)}"`,
    'status: "draft"',
    'version: "0.1.0-draft"',
    `createdAt: "${now}"`,
    `updatedAt: "${now}"`,
    "readWhen:",
    '  - "遇到相似目标、工具链或交付约束时"',
    "tags:",
    '  - "task-derived"',
    '  - "method-draft"',
    `  - "${task.source}"`,
    "---",
    "",
    `# ${title}`,
    "",
    `> ${firstNonEmpty(summary, "从来源任务中提炼出的执行方法草稿，供人工审阅后发布。")}`,
    "",
    "---",
    "",
    "## 0. 元信息",
    "| 属性 | 内容 |",
    "|------|------|",
    `| 方法编号 | ${methodId} |`,
    "| 版本 | v0.1-draft |",
    `| 创建日期 | ${date} |`,
    `| 更新日期 | ${date} |`,
    `| 来源任务 | ${task.id} |`,
    `| 适用对象 | ${scenario} |`,
    `| 核心目标 | ${goal} |`,
    "",
    "## 1. 触发条件",
    ...buildMethodTriggers(task, toolNames, artifacts, reflection),
    "",
    "## 2. 适用场景",
    ...buildMethodScenarioLines(task, artifacts, goal),
    "",
    "## 3. 执行步骤",
    ...buildMethodSteps(task),
    "",
    "## 4. 工具选择",
    ...toolTable,
    "",
    "## 5. 失败经验",
    ...failureExperience,
    "",
    "## 6. 成功案例",
    ...successCase,
    "",
    "## 7. 相关资源",
    ...relatedResources,
    "",
    "## 8. 更新记录",
    "| 日期 | 版本 | 变更 |",
    "|------|------|------|",
    `| ${date} | v0.1-draft | 根据任务 ${task.id} 自动生成初稿 |`,
  ];

  return lines.filter(Boolean).join("\n");
}

function buildMethodSteps(task: ExperienceSourceTaskDetail): string[] {
  const toolNames = uniqueStrings(task.toolCalls?.map((item) => item.toolName));
  const executionPath = toolNames.length > 0
    ? `优先按 ${toolNames.join(" -> ")} 的顺序推进主路径。`
    : "优先按当前项目中最小可验证闭环推进主路径。";
  const verificationTarget = firstNonEmpty(task.outcome, task.summary, "至少得到一个可检查的结果或产物。");

  return [
    `1. [ ] 目标澄清：确认本次任务要解决的问题、完成标准和边界，避免把临时诉求误沉淀成通用方法。`,
    `2. [ ] 输入盘点：核对已有上下文、历史经验、产物路径和可用工具，缺关键输入时先补齐再执行。`,
    `3. [ ] 主路径执行：${executionPath}`,
    `4. [ ] 结果校验：检查输出是否满足“${verificationTarget}”，并记录关键产物或证据路径。`,
    `5. [ ] 复盘沉淀：把有效判断标准、失败原因和例外条件写回方法，无法复用的细节不要提升为通用规则。`,
  ];
}

function buildSkillDraft(
  publishStateDir: string,
  title: string,
  slug: string,
  summary: string,
  task: ExperienceSourceTaskDetail,
  snapshot: ExperienceSourceTaskSnapshot,
): string {
  const template = resolveExperienceDraftTemplate(publishStateDir, "skill");
  if (isTemplateUsable(template.skeleton, EXPERIENCE_SKILL_REQUIRED_HEADINGS)) {
    return buildSkillTemplateDraft(title, slug, summary, task, snapshot, template.path);
  }
  return buildLegacySkillDraft(title, slug, summary, task, snapshot);
}

function buildLegacySkillDraft(
  title: string,
  slug: string,
  summary: string,
  task: ExperienceSourceTaskDetail,
  snapshot: ExperienceSourceTaskSnapshot,
): string {
  const toolNames = uniqueStrings(task.toolCalls?.map((item) => item.toolName));
  const artifacts = uniqueStrings(task.artifactPaths);
  const skillName = buildExperienceSkillMachineName({
    name: slug,
    title,
    fallback: task.id,
  });
  const description = buildSkillDescription(task, toolNames);
  const lines = [
    "---",
    `name: "${escapeQuoted(skillName)}"`,
    `description: "${escapeQuoted(description)}"`,
    'version: "0.1.0-draft"',
    'tags: ["task-derived", "draft", "skill-draft", "' + task.source + '"]',
    "priority: normal",
    ...(toolNames.length > 0 ? [
      "eligibility:",
      "  tools:",
      ...toolNames.map((toolName) => `    - "${escapeQuoted(toolName)}"`),
    ] : []),
    "---",
    "",
    `# ${title}`,
    "",
    `> ${firstNonEmpty(summary, "把来源任务中的稳定做法收敛为 skill 草稿，供人工审阅后发布。")}`,
    "",
    "## 快速开始",
    "1. 先确认任务目标、约束和预期交付物是否与来源任务相近。",
    toolNames.length > 0
      ? `2. 优先沿用来源任务验证过的工具链：${toolNames.join(" -> ")}。`
      : "2. 优先沿用当前项目中已验证的最小闭环执行路径。",
    "3. 遇到偏差时，先回看来源任务复盘，再决定是最小调整、人工审阅还是生成新的 candidate。",
    "",
    "## 决策路由",
    `- 如果任务仍属于“${firstNonEmpty(task.objective, task.title, task.id)}”这一类问题，优先复用本 skill，而不是重新从零组织流程。`,
    toolNames.length > 0
      ? `- 如果主路径依赖 ${toolNames.join(" / ")} 这组工具，优先复用已有顺序和检查点。`
      : "- 如果任务只需要当前项目里已有的最小闭环，优先复用本 skill，再按上下文做局部调整。",
    "- 如果输入约束、目标产物或边界条件明显变化，先人工审阅 candidate，不要直接发布到正式技能。",
    "- 如果现有 method / skill 已经覆盖问题，优先复用现有资产，避免重复生成。",
    "",
    "## 输入",
    `- 任务目标：${firstNonEmpty(task.objective, task.title, task.id)}`,
    `- 关键约束：${firstNonEmpty(task.reflection, task.summary, "待人工补充约束信息。")}`,
    toolNames.length > 0
      ? `- 可用工具：${toolNames.join(" / ")}`
      : "- 可用工具：沿用当前项目已验证的最小执行路径",
    "",
    "## 输出",
    artifacts.length > 0
      ? `- 预期产物：${artifacts.slice(0, 3).join(" / ")}`
      : `- 预期产物：${firstNonEmpty(task.outcome, task.summary, "至少形成一个可检查的执行结果。")}`,
    "- 执行结果应包含：关键步骤、验证点、异常分支处理。",
    "- 如果结果不足以复用，应停留在 candidate 层，不要冒进发布。",
    "",
    "## 参考指引",
    `- 来源任务：${task.id}`,
    `- 来源结论：${firstNonEmpty(task.summary, task.outcome, "待人工补充。")}`,
    ...(artifacts.length > 0 ? artifacts.slice(0, 4).map((item) => `- 相关产物：${item}`) : ["- 相关产物：无"]),
    ...(snapshot.memoryLinks?.length
      ? snapshot.memoryLinks.slice(0, 4).map((item) => `- 关联记忆：${[item.relation, item.sourcePath, item.chunkId].filter(Boolean).join(" | ")}`)
      : ["- 关联记忆：无"]),
    "",
    "## NEVER",
    "- 不要把来源任务按时间顺序原样抄成流水账教程。",
    "- 不要把一次性的临时 workaround 直接写成通用规则。",
    "- 不要绕过人工审阅直接覆盖正式 skill 资产。",
    `- 如果出现新约束或新工具组合，不要假装本 skill 仍然适用；应回到 candidate 层重新沉淀。`,
  ];
  return lines.join("\n");
}

function buildMethodTemplateDraft(
  title: string,
  summary: string,
  task: ExperienceSourceTaskDetail,
  snapshot: ExperienceSourceTaskSnapshot,
  now: string,
  templatePath: string | null,
): string {
  const toolNames = uniqueStrings(task.toolCalls?.map((item) => item.toolName));
  const artifacts = uniqueStrings(task.artifactPaths);
  const memoryRefs = snapshot.memoryLinks ?? [];
  const headline = firstNonEmpty(task.title, task.objective, task.id);
  const objective = firstNonEmpty(task.objective, task.title, task.id);
  const reflection = firstNonEmpty(task.reflection, task.summary, task.outcome, "待补充复盘结论。");
  const result = firstNonEmpty(task.outcome, task.summary, "至少形成一个可检查的执行结果。");
  const date = now.slice(0, 10);
  const references = uniqueStrings([
    templatePath ?? undefined,
    ...artifacts,
    ...memoryRefs.map((item) => item.sourcePath || item.chunkId),
  ]);

  return [
    `# ${title}`,
    "",
    `> ${firstNonEmpty(summary, "从来源任务中提炼出的执行方法草稿，供人工审阅后发布。")}`,
    "",
    "## 0. 元信息",
    `- 方法定位：从任务 ${task.id} 的执行轨迹中提炼出的可复用方法草稿，优先沉淀目标、工具选择和复盘信号。`,
    `- 适用对象：需要处理“${objective}”这一类问题，并希望复用已验证闭环的执行者或 reviewer。`,
    "- 维护建议：后续若出现返工、新约束或新工具组合，应优先更新失败经验、工具选择与成功案例。",
    "",
    "## 1. 触发条件",
    `- 需要重复解决“${objective}”这一类目标，而不是一次性临时请求。`,
    toolNames.length > 0
      ? `- 当前仍可复用已验证工具链：${toolNames.join(" / ")}。`
      : "- 当前任务仍能复用已验证的最小执行闭环。",
    `- 希望直接沿用已有成功/失败信号，避免重复试错：${truncateText(reflection, 100)}`,
    "",
    "## 2. 适用场景",
    `- 场景摘要：${firstNonEmpty(task.summary, task.objective, task.outcome, "沉淀出可复用、可审阅的方法草稿。")}`,
    artifacts.length > 0
      ? `- 典型产物：${artifacts.slice(0, 3).join(" / ")}`
      : `- 典型产物：${result}`,
    `- 来源任务：${task.id}${task.conversationId ? ` / ${task.conversationId}` : ""}`,
    "",
    "## 3. 执行步骤",
    ...buildMethodSteps(task),
    "",
    "## 4. 工具选择",
    toolNames.length > 0
      ? `- 首选工具：${toolNames.join(" / ")}`
      : "- 首选工具：沿用当前项目中已验证的最小执行路径。",
    artifacts.length > 0
      ? `- 替代工具：若首选工具不可用，先以人工方式校对并补齐 ${artifacts.slice(0, 2).join(" / ")} 等关键产物。`
      : "- 替代工具：若首选工具不可用，先用人工最小闭环完成验证，再补工具化。",
    toolNames.length > 0
      ? `- 选择依据：这些工具已在来源任务“${headline}”中成功完成关键步骤，并产出了可回看的结果。`
      : `- 选择依据：来源任务“${headline}”已证明该类问题可通过最小闭环推进。`,
    "",
    "## 5. 失败经验",
    "- 常见误区：把一次性的 workaround、未回归的结论或缺少证据的操作直接沉淀成通用方法。",
    `- 失败信号：${truncateText(reflection, 120)}`,
    "- 规避方式：先补齐验收证据、关键产物和异常分支，再决定是否继续发布或复用。",
    "",
    "## 6. 成功案例",
    `- 案例背景：${headline}`,
    toolNames.length > 0
      ? `- 做法摘要：按 ${toolNames.join(" -> ")} 的顺序推进关键子步骤，并持续记录可验证产物。`
      : "- 做法摘要：按最小闭环推进执行，并在关键节点记录结果与证据。",
    `- 结果与启示：${result}`,
    "",
    "## 7. 相关资源",
    `- 相关技能：${toolNames.length > 0 ? `待人工补充；可优先回看与 ${toolNames.join(" / ")} 对应的 skill。` : "待人工补充；当前未记录明确 skill 依赖。"}`,
    "- 相关方法：待人工补充；如果后续出现稳定变体，可拆分为更细的方法资产。",
    `- 相关文档 / 路径：${references.length > 0 ? references.join(" / ") : "无"}`,
    "",
    "## 8. 更新记录",
    `- ${date}：基于任务 ${task.id} 生成初版草稿。`,
    "",
  ].join("\n");
}

function buildSkillTemplateDraft(
  title: string,
  slug: string,
  summary: string,
  task: ExperienceSourceTaskDetail,
  snapshot: ExperienceSourceTaskSnapshot,
  templatePath: string | null,
): string {
  const toolNames = uniqueStrings(task.toolCalls?.map((item) => item.toolName));
  const artifacts = uniqueStrings(task.artifactPaths);
  const memoryRefs = snapshot.memoryLinks ?? [];
  const skillName = buildExperienceSkillMachineName({
    name: slug,
    title,
    fallback: task.id,
  });
  const objective = firstNonEmpty(task.objective, task.title, task.id);
  const result = firstNonEmpty(task.outcome, task.summary, "至少形成一个可检查的执行结果。");
  const references = uniqueStrings([
    templatePath ?? undefined,
    ...artifacts,
    ...memoryRefs.map((item) => item.sourcePath || item.chunkId),
  ]);

  return [
    "---",
    `name: "${escapeQuoted(skillName)}"`,
    `description: "${escapeQuoted(firstNonEmpty(summary, buildSkillDescription(task, toolNames)))}"`,
    "---",
    "",
    `# ${title}`,
    "",
    "## 快速开始",
    `- 这个技能适合：处理与“${objective}”相近、需要稳定执行路径的多步骤任务。`,
    toolNames.length > 0
      ? `- 使用前提：当前仍可复用 ${toolNames.join(" / ")} 这组已验证工具链。`
      : "- 使用前提：当前仍能沿用来源任务已验证的最小执行闭环。",
    "- 典型收益：把来源任务中已经做成的步骤、检查点和边界直接复用到同类任务里。",
    "",
    "## 决策路由",
    `- 应该使用：当前问题与“${objective}”的目标、输入边界和交付物高度相似时。`,
    "- 不该使用：任务目标、风险边界、核心工具链或产物要求已经明显变化时。",
    "- 遇到冲突时优先：先复用已有正式 method / skill；若现有资产不覆盖，再回到 candidate 层人工审阅。",
    "",
    "## 输入",
    `- 必要输入：任务目标=${objective}；关键约束=${firstNonEmpty(task.reflection, task.summary, "待人工补充约束信息。")}`,
    `- 可选输入：${toolNames.length > 0 ? `工具链=${toolNames.join(" / ")}` : "额外工具链信息暂缺"}`,
    "- 输入质量要求：至少能说明目标产物、主要限制和最小可验证结果，避免只有模糊意图。",
    "",
    "## 输出",
    `- 直接产物：${artifacts.length > 0 ? artifacts.slice(0, 3).join(" / ") : result}`,
    "- 副产物：关键步骤摘要、验证点、异常分支处理与后续复用建议。",
    "- 质量门槛：结果必须可检查、可回顾，且不能绕过人工审阅直接视为正式资产。",
    "",
    "## 参考指引",
    `- 推荐流程：${toolNames.length > 0 ? `优先按 ${toolNames.join(" -> ")} 的顺序推进，并同步记录产物与验证结果。` : "优先按来源任务验证过的最小执行路径推进，再补齐关键验证点。"}`,
    `- 常见变体：${artifacts.length > 0 ? `最终产物可能落在 ${artifacts.slice(0, 3).join(" / ")} 等相近路径。` : "当前未记录固定产物路径，发布前应补充更稳定的交付样式。"}`,
    `- 关联文件 / 模板 / 文档：${references.length > 0 ? references.join(" / ") : "无"}`,
    "",
    "## NEVER",
    "- 不要：把一次性的临时 workaround 或无验证结论直接固化成通用技能规则。",
    "- 禁止：绕过人工审阅直接覆盖正式 skill 资产，或忽略现有 method / skill 重复造轮子。",
    "- 高风险边界：当核心工具组合、输入约束或目标产物已经变化时，不要假装本 candidate 仍然适用。",
    "",
  ].join("\n");
}

function scoreCandidate(task: ExperienceSourceTaskDetail): number {
  let score = 10;
  if (task.title || task.objective) score += 15;
  if (task.summary) score += 20;
  if (task.reflection) score += 20;
  if (task.outcome) score += 10;
  if (task.toolCalls?.length) score += 15;
  if (task.artifactPaths?.length) score += 5;
  if (task.memoryLinks?.length) score += 5;
  return Math.min(100, score);
}

function pickTaskHeadline(task: ExperienceSourceTaskDetail): string {
  return firstNonEmpty(
    task.title,
    task.objective,
    task.summary,
    task.reflection,
    task.id,
  );
}

function sanitizeDocumentTitle(type: ExperienceCandidateType, value: string): string {
  const normalized = collapseWhitespace(value)
    .replace(/\b(?:方法候选|技能草稿)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized) {
    return normalized;
  }
  return type === "method" ? "任务方法草稿" : "任务技能草稿";
}

function buildMethodIdentifier(taskId: string): string {
  const token = normalizeAsciiToken(taskId, "task").replace(/-/g, "").toUpperCase().slice(0, 6) || "TASK";
  return `METH-TASK-${token}`;
}

function buildMethodTriggers(
  task: ExperienceSourceTaskDetail,
  toolNames: string[],
  artifacts: string[],
  reflection: string,
): string[] {
  const lines = [
    "| 条件 | 说明 | 来源信号 |",
    "|------|------|----------|",
    `| 同类目标再次出现 | 需要解决与来源任务同类的问题，而不是临时一次性请求 | ${escapeTableCell(firstNonEmpty(task.objective, task.title, task.id))} |`,
    toolNames.length > 0
      ? `| 工具链仍然成立 | 本次任务仍依赖 ${escapeTableCell(toolNames.join(" / "))} 这组工具配合 | 工具调用记录存在 |`
      : "| 需要可复用闭环 | 虽然没有明确工具链，但已经形成可复用执行顺序 | 来源任务已成功完成 |",
  ];
  if (artifacts.length > 0) {
    lines.push(`| 交付格式相近 | 需要复用相同或相近的交付格式、文档结构或产物路径 | ${escapeTableCell(artifacts.slice(0, 2).join(" / "))} |`);
  }
  lines.push(`| 需要规避已知失败 | 希望直接沿用已经验证过的避坑结论，而不是再次试错 | ${escapeTableCell(truncateText(reflection, 80))} |`);
  return lines;
}

function buildMethodScenarioLines(
  task: ExperienceSourceTaskDetail,
  artifacts: string[],
  goal: string,
): string[] {
  const outputHint = artifacts.length > 0
    ? `优先产出与 ${artifacts.slice(0, 2).join(" / ")} 相同类型的结果。`
    : "至少能产出一个可检查的文档、结果或状态变更。";
  return [
    `- 适合：${firstNonEmpty(task.objective, task.title, task.id)} 这一类目标清晰、边界可描述的任务。`,
    `- 输入：需要有基本上下文、关键约束，以及至少一条可执行主路径。`,
    `- 输出：${outputHint}`,
    `- 完成标准：${goal}`,
    "- 不适合：探索性极强、没有稳定判断标准、或依赖临场创意而非流程约束的任务。",
  ];
}

function buildMethodToolTable(
  toolNames: string[],
  artifacts: string[],
  task: ExperienceSourceTaskDetail,
): string[] {
  const lines = [
    "| 工具 | 使用时机 | 选择原因 |",
    "|------|----------|----------|",
  ];
  if (toolNames.length === 0) {
    lines.push(`| 待补充 | 需要进一步拆分执行链路时 | 本次任务没有明确工具调用记录，发布前应人工补齐工具选择依据 |`);
    return lines;
  }
  toolNames.forEach((toolName, index) => {
    lines.push(
      `| \`${toolName}\` | 第 ${index + 1} 个关键子步骤 | ${artifacts[index]
        ? `该步骤会直接影响 ${escapeTableCell(artifacts[index])} 一类产物`
        : `来源任务在该节点使用过此工具，且成功完成 ${escapeTableCell(firstNonEmpty(task.outcome, task.summary, "目标"))}` } |`,
    );
  });
  return lines;
}

function buildFailureExperience(date: string, reflection: string): string[] {
  return [
    "| 时间 | 问题 | 原因 | 解决方案 |",
    "|------|------|------|----------|",
    `| ${date} | 执行过程中需要人工复盘收敛 | 自动生成仅保留了来源任务中的显性信号 | ${escapeTableCell(truncateText(reflection, 120))} |`,
  ];
}

function buildSuccessCase(task: ExperienceSourceTaskDetail, toolNames: string[]): string[] {
  const caseTitle = firstNonEmpty(task.title, task.objective, task.id);
  return [
    `### 案例 1：${caseTitle}（${task.finishedAt?.slice(0, 10) || task.startedAt.slice(0, 10)}）`,
    `- 任务：${firstNonEmpty(task.objective, task.title, task.id)}`,
    toolNames.length > 0
      ? `- 步骤：按 ${toolNames.join(" -> ")} 顺序完成核心子步骤。`
      : "- 步骤：按最小闭环完成执行并记录关键产物。",
    `- 结果：${firstNonEmpty(task.outcome, task.summary, "任务成功完成。")}`,
    `- 结论：${firstNonEmpty(task.reflection, task.summary, "本次流程可以沉淀为候选方法。")}`,
  ];
}

function buildRelatedResourceLines(
  artifacts: string[],
  memoryRefs: ExperienceSourceTaskSnapshot["memoryLinks"],
): string[] {
  const lines: string[] = [];
  if (artifacts.length > 0) {
    artifacts.slice(0, 6).forEach((item) => {
      lines.push(`- 相关产物：${item}`);
    });
  }
  if (memoryRefs && memoryRefs.length > 0) {
    memoryRefs.slice(0, 6).forEach((item) => {
      const meta = [item.relation, item.sourcePath].filter(Boolean).join(" | ");
      lines.push(`- 关联记忆：${meta || item.chunkId}`);
    });
  }
  if (lines.length === 0) {
    lines.push("- 待补充相关资源。");
  }
  return lines;
}

function buildSkillDescription(task: ExperienceSourceTaskDetail, toolNames: string[]): string {
  const scenario = firstNonEmpty(task.objective, task.title, task.id);
  const toolClause = toolNames.length > 0
    ? ` (2) 需要复用 ${toolNames.join(" / ")} 这一组已验证工具链时`
    : " (2) 需要复用该任务已经验证过的最小执行闭环时";
  return `将与 ${scenario} 相近的问题收敛为可复用执行路由，明确输入、步骤、检查点与禁忌。使用场景：(1) 需要处理同类目标或交付物时,${toolClause}, (3) 需要把一次成功任务沉淀为可审阅 skill candidate 时。`;
}

function truncateText(value: string, maxLength: number): string {
  const normalized = collapseWhitespace(value);
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function normalizeAsciiToken(value: string, fallback: string): string {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function uniqueStrings(values?: Array<string | undefined>): string[] {
  return [...new Set((values ?? []).map((item) => String(item ?? "").trim()).filter(Boolean))];
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function resolveExperienceDraftTemplate(
  publishStateDir: string,
  type: ExperienceCandidateType,
): { path: string | null; skeleton: string | null } {
  const fileName = type === "skill" ? "skill-synthesis.md" : "method-synthesis.md";
  const candidatePaths = [
    path.join(publishStateDir, EXPERIENCE_TEMPLATE_DIRNAME, fileName),
    path.resolve(process.cwd(), "docs", EXPERIENCE_TEMPLATE_DIRNAME, fileName),
  ];
  for (const candidatePath of candidatePaths) {
    const content = readTextFileIfExists(candidatePath);
    if (!content.trim()) {
      continue;
    }
    return {
      path: candidatePath,
      skeleton: extractExperienceTemplateMarkdownSkeleton(content),
    };
  }
  return {
    path: null,
    skeleton: null,
  };
}

function readTextFileIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function extractExperienceTemplateMarkdownSkeleton(templateContent: string): string | null {
  const matched = String(templateContent ?? "").match(/```(?:md|markdown)\s*([\s\S]*?)```/i);
  const skeleton = matched?.[1]?.trim();
  return skeleton ? skeleton : null;
}

function isTemplateUsable(skeleton: string | null, requiredHeadings: readonly string[]): boolean {
  if (!skeleton) return false;
  return requiredHeadings.every((heading) => skeleton.includes(heading));
}
