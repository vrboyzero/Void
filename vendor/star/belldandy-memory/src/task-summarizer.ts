import type { OutboundRequestPolicy } from "./protocol/index.js";

import type { TaskRecord, TaskToolCallSummary } from "./task-types.js";
import { requestTaskSummaryModel } from "./task-summary-model-request.js";

const DEFAULT_TASK_SUMMARY_TIMEOUT_MS = 120_000;

export interface TaskSummarizerOptions {
  enabled?: boolean;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  outboundRequestPolicy?: Pick<OutboundRequestPolicy, "request">;
}

export interface TaskSummaryPayload {
  title?: string;
  summary?: string;
  reflection?: string;
  outcome?: string;
  artifactPaths?: string[];
}

export class TaskSummarizer {
  private readonly enabled: boolean;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly outboundRequestPolicy?: Pick<OutboundRequestPolicy, "request">;

  constructor(options: TaskSummarizerOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.model = options.model ?? "";
    this.baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? "";
    this.timeoutMs = typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : DEFAULT_TASK_SUMMARY_TIMEOUT_MS;
    this.outboundRequestPolicy = options.outboundRequestPolicy;
  }

  get isEnabled(): boolean {
    return this.enabled && !!this.model && !!this.baseUrl && !!this.apiKey;
  }

  get modelName(): string | undefined {
    return this.model || undefined;
  }

  async summarizeTask(input: {
    task: TaskRecord;
    history: Array<{ role: "user" | "assistant"; content: string }>;
    toolCalls: TaskToolCallSummary[];
  }): Promise<TaskSummaryPayload | null> {
    if (!this.isEnabled) return null;

    const historyText = input.history
      .slice(-12)
      .map((item) => `${item.role === "user" ? "用户" : "助手"}: ${item.content}`)
      .join("\n\n")
      .slice(-6000);

    const toolText = input.toolCalls
      .slice(0, 20)
      .map((item) => {
        const parts = [
          item.toolName,
          item.success ? "success" : "failed",
          item.durationMs != null ? `${item.durationMs}ms` : "",
          item.artifactPaths?.length ? `artifacts=${item.artifactPaths.join(", ")}` : "",
        ].filter(Boolean);
        return `- ${parts.join(" | ")}`;
      })
      .join("\n");

    const prompt = [
      `任务目标: ${input.task.objective ?? "未记录"}`,
      `任务来源: ${input.task.source}`,
      `任务状态: ${input.task.status}`,
      input.task.durationMs != null ? `耗时: ${input.task.durationMs}ms` : "",
      input.task.tokenTotal != null ? `Token: ${input.task.tokenTotal}` : "",
      "",
      "工具摘要:",
      toolText || "- 无工具调用",
      "",
      "最近会话内容:",
      historyText || "无",
    ].filter(Boolean).join("\n");

    const data = await requestTaskSummaryModel({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      model: this.model,
      systemPrompt: [
        "你是任务总结器。",
        "根据任务目标、工具摘要和最近会话内容，输出一个 JSON 对象。",
        "字段：title, summary, reflection, outcome, artifact_paths。",
        "summary 侧重任务做了什么与最终结果；reflection 侧重可复用经验或失败教训。",
        "outcome 必须是 success / failed / partial 之一。",
        "artifact_paths 必须是字符串数组。",
        "只输出 JSON，不要额外解释。",
      ].join(" "),
      userPrompt: prompt,
      timeoutMs: this.timeoutMs,
      outboundRequestPolicy: this.outboundRequestPolicy,
    });
    const raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) return null;

    try {
      const jsonText = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      return {
        title: asOptionalString(parsed.title),
        summary: asOptionalString(parsed.summary),
        reflection: asOptionalString(parsed.reflection),
        outcome: asOptionalString(parsed.outcome),
        artifactPaths: Array.isArray(parsed.artifact_paths)
          ? parsed.artifact_paths.map((value) => String(value)).filter(Boolean)
          : undefined,
      };
    } catch {
      return null;
    }
  }

}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
