/**
 * pstack 的两个子代理：`poteto-agent`（写代码的委派）与 `comment-sicko`（只读评论审查）。
 *
 * **为什么不直接挂 `dsh-tool-subagent` 的实例**：那个包的工具集是**每实例固定**的（要另一个
 * persona 就得另一个名字的工具），所以两种角色本来就要两个工具。直接调 `ctx.subagents` 少一层
 * 配置转译，也让「技能根目录」这类本包才知道的信息能拼进子代理的提示词。
 *
 * ## 对着哪个版本写的（2026-10-12 核对）
 *
 * 本机已装宿主是 **0.2.1-rc.2**，而仓库 `参考项目/` 里最新的快照是 `0.2.0-rc.2`。这两版的子代理
 * API **不兼容**，照快照写会得到一个运行期 `start is not a function`：
 *
 * | 0.2.0-rc.2 | 0.2.1-rc.2（本机，权威） |
 * |---|---|
 * | `ctx.subagents.start(name, request)` | **删了**，改为 `startActivation(spec)` |
 * | `SubagentStartRequest.persona` | **删了** |
 * | `SubagentStartRequest.toolFilter` | **删了**，换成 `agentPreset` |
 * | `SubagentRun.result` | `SubagentActivation.result` |
 *
 * 证据：`%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-subagent\lib\types\`
 * 的 `index.d.ts:135`（只有 `startActivation`）与 `types.d.ts:25-45`（`SubagentActivationSpec`）。
 *
 * ## 两处与 pstack 原文不同的取舍
 *
 * 1. persona 文本**拼进提示词**（`request.prompt`），不用宿主的人设机制。0.2.1 里要换人设只能走
 *    `agentPreset`，而 preset 会**影子覆盖**子代理的 `deployment:persona-prefix` 段——那一层是
 *    宿主的身份底线，为一份工作风格丢掉它不划算。拼进提示词的效果一样：子代理照样先看到角色说明。
 * 2. 只读性**不在本包里强制**。0.2.0 有 `toolFilter`，0.2.1 删掉后唯一的路是 `agentPreset` + 一个
 *    自己写的 `tools.restrict()` row 插件（宿主没有现成的）。本包只提供 `commentSickoPreset`
 *    透传：部署方把那条路搭起来就填 preset id。默认不填，因为**给一个约束起不到作用还装作起了作用，
 *    比没有这个约束更糟**。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import { PSTACK_SKILLS_DIR } from "./skill-loader.js";
import { PSTACK_PROMPTS_DIR, type PstackLogger } from "./prompt.js";

/** 子代理提示词里出现的一段文本。 */
interface TextBlock {
  readonly type: "text"
  readonly text: string
}

/** 子代理的终态结果。 */
export interface PstackSubagentResult {
  readonly output: readonly { readonly type: string; readonly text?: string }[]
  readonly stopReason: string
  readonly diagnostic?: string
}

/** `ctx.subagents.startActivation()` 的返回值里本模块会用到的部分。 */
export interface PstackSubagentActivation {
  readonly childId: string
  readonly messageId?: string
  readonly result: Promise<PstackSubagentResult>
  dispose(): Promise<void>
}

/** 启动请求里本模块会写的字段。 */
export interface PstackSubagentStartRequest {
  readonly prompt: readonly TextBlock[]
  readonly parent: unknown
  /** 子代理要挂的组合 preset；0.2.1 起这是换人设与换工具面的唯一入口。 */
  readonly agentPreset?: string
}

/** `startActivation` 的入参。 */
export interface PstackSubagentActivationSpec {
  readonly provider: string
  readonly label: string
  readonly request: PstackSubagentStartRequest
  readonly signal: AbortSignal
  /** `caller` 只把结果交回调用方；`parent` 还会给父会话投递一条结算通知。 */
  readonly delivery: "parent" | "caller"
}

/** `ctx.subagents` 的窄面。结构类型，避免把 `@deepseek-ai/dsh-subagent` 拖进依赖图。 */
export interface PstackSubagentRuntime {
  startActivation(spec: PstackSubagentActivationSpec): Promise<PstackSubagentActivation>
}

/** 注册两个工具所需的全部外部输入。 */
export interface PstackSubagentToolsOptions {
  readonly subagents: PstackSubagentRuntime
  /** 走哪个子代理提供方；默认 `spawn`（进程内、全新子代理）。 */
  readonly provider: string
  /** `comment-sicko` 要挂的 preset id；空表示不挂，见文件头的取舍说明。 */
  readonly commentSickoPreset?: string
  readonly skillsDir?: string
  readonly promptsDir?: string
  readonly logger: PstackLogger
}

/**
 * 检查子代理服务是不是本模块支持的那一版。
 *
 * 宿主 0.2.0 → 0.2.1 把 `start()` 换成了 `startActivation()`。少了这道检查，版本不匹配的表现是
 * 「调用工具时才炸」，而且报错在离原因很远的地方（`start is not a function` 出现在一次模型调用里）。
 */
export function isCompatibleSubagentRuntime(runtime: unknown): runtime is PstackSubagentRuntime {
  return (
    typeof runtime === "object" &&
    runtime !== null &&
    typeof (runtime as { startActivation?: unknown }).startActivation === "function"
  );
}

/** 把子代理输出块里的文本拼起来；非文本块（图片等）只计数，不塞进结果。 */
export function flattenSubagentOutput(output: PstackSubagentResult["output"]): string {
  const texts: string[] = [];
  let others = 0;
  for (const block of output) {
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    else others += 1;
  }
  const body = texts.join("\n").trim();
  if (others === 0) return body;
  return body.length === 0 ? `（只有 ${others} 个非文本块，无法转成文字）` : `${body}\n\n（另有 ${others} 个非文本块未展开）`;
}

function readPrompt(promptsDir: string, file: string): string {
  const path = join(promptsDir, file);
  const text = readFileSync(path, "utf8").trim();
  if (text.length === 0) throw new Error(`pstack: 提示词文件是空的: ${path}`);
  return text;
}

/**
 * 子代理共用的「技能在哪」说明。
 *
 * 这一段是本移植的关键：pstack 的技能全标了 `disable-model-invocation`，模型面的目录里**看不见**
 * 它们，子代理没法用 `skill` 工具自取。pstack 原文的解法就是「父代理把绝对路径写进委派提示词」，
 * 这里照做，并把根目录一次给全，省掉逐个列举。
 */
function skillsLocationBlock(skillsDir: string): string {
  return [
    "## pstack 技能路径",
    "",
    "这些技能在模型面目录里是隐藏的，按绝对路径直接读文件。",
    "",
    `- 技能根目录：\`${skillsDir}\``,
    `- 任意技能正文：\`${skillsDir}/<技能名>/SKILL.md\``,
    `- poteto-mode 入口：\`${skillsDir}/poteto-mode/SKILL.md\`，playbook 在 \`${skillsDir}/poteto-mode/playbooks/<名>.md\``,
  ].join("\n");
}

/** 一个委派工具的输出契约：终态原因加可读文本。 */
const DELEGATION_OUTPUT = {
  schema: {
    type: "object" as const,
    properties: {
      stopReason: { type: "string" as const },
      output: { type: "string" as const },
    },
    additionalProperties: false,
  },
  render: (_args: unknown, value: { stopReason: string; output: string }) => [
    {
      type: "text" as const,
      text:
        value.output.length > 0
          ? value.output
          : `（子代理没有产出文字，stopReason: ${value.stopReason}）`,
    },
  ],
};

/**
 * 建两个工具定义。返回值交给 `ctx.tools.register()`——注册是副作用，随插件 fiber 一起装卸。
 */
export function buildPstackSubagentTools(options: PstackSubagentToolsOptions) {
  const skillsDir = options.skillsDir ?? PSTACK_SKILLS_DIR;
  const promptsDir = options.promptsDir ?? PSTACK_PROMPTS_DIR;
  const agentPersona = readPrompt(promptsDir, "agent-poteto.md");
  const sickoPersona = readPrompt(promptsDir, "agent-comment-sicko.md");

  const run = async (
    parent: unknown,
    signal: AbortSignal,
    label: string,
    prompt: TextBlock[],
    agentPreset: string | undefined,
  ): Promise<{ stopReason: string; output: string }> => {
    const started = await options.subagents.startActivation({
      provider: options.provider,
      label,
      request: { prompt, parent, ...(agentPreset === undefined ? {} : { agentPreset }) },
      signal,
      // 结果直接交给本次调用；再给父会话投一条结算通知只会让同一件事出现两遍。
      delivery: "caller",
    });
    try {
      const settled = await started.result;
      if (settled.diagnostic !== undefined && settled.diagnostic.length > 0) {
        options.logger.warn(`pstack: 子代理 ${started.childId} 以 ${settled.stopReason} 结束: ${settled.diagnostic}`);
      }
      return { stopReason: settled.stopReason, output: flattenSubagentOutput(settled.output) };
    } finally {
      // activation 必须 dispose，否则它持有的 child handle 与容量槽都留在原地。
      await started.dispose();
    }
  };

  const agentTool = defineTool({
    name: "pstack_agent",
    description:
      "Delegate code-writing or helper work to a poteto-mode subagent. Use it for delegates inside a playbook step, not to run the playbook itself. It reads the poteto-mode skill in full before working, so it starts slowly and only pays off for a self-contained task. Give it the whole task: it cannot ask you questions.",
    parameters: {
      description: { type: "string", required: true, description: "Short task label shown in the transcript." },
      prompt: {
        type: "string",
        required: true,
        description:
          "The complete task: goal, constraints, files, and how the result will be checked. Consolidate every directive into it, because the delegate cannot ask follow-ups.",
      },
    },
    output: DELEGATION_OUTPUT,
    async execute(args, exec) {
      if (exec.agent === undefined) {
        throw new Error("pstack_agent: 这次调用没有 agent，无法确定委派的父级");
      }
      return run(
        exec.agent,
        exec.signal,
        args.description,
        [{ type: "text", text: [agentPersona, skillsLocationBlock(skillsDir), "## Task", args.prompt].join("\n\n") }],
        undefined,
      );
    },
  });

  const sickoTool = defineTool({
    name: "pstack_comment_sicko",
    description:
      "Delegate a comment review to comment-sicko, a reviewer that reports deletions and refactor flags and is instructed never to touch code. Give it files or a diff. Use it before review, or when a file feels comment-heavy.",
    parameters: {
      description: { type: "string", required: true, description: "Short task label shown in the transcript." },
      prompt: {
        type: "string",
        required: true,
        description: "Which files or diff to review, and the scope it may flag. It reports only; it never edits.",
      },
    },
    output: DELEGATION_OUTPUT,
    async execute(args, exec) {
      if (exec.agent === undefined) {
        throw new Error("pstack_comment_sicko: 这次调用没有 agent，无法确定委派的父级");
      }
      return run(
        exec.agent,
        exec.signal,
        args.description,
        [{ type: "text", text: [sickoPersona, skillsLocationBlock(skillsDir), "## Task", args.prompt].join("\n\n") }],
        options.commentSickoPreset,
      );
    },
  });

  return { agentTool, sickoTool };
}

/** 把两个工具注册进 `ctx.tools`。 */
export function registerPstackSubagentTools(ctx: Context, options: PstackSubagentToolsOptions): void {
  const { agentTool, sickoTool } = buildPstackSubagentTools(options);
  ctx.tools.register(agentTool);
  ctx.tools.register(sickoTool);
}
