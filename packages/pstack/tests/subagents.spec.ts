import { describe, expect, it } from "vitest";
import {
  buildPstackSubagentTools,
  flattenSubagentOutput,
  isCompatibleSubagentRuntime,
  type PstackSubagentActivation,
  type PstackSubagentActivationSpec,
  type PstackSubagentResult,
  type PstackSubagentRuntime,
} from "../src/subagents.js";
import { PSTACK_SKILLS_DIR } from "../src/skill-loader.js";
import type { PstackLogger } from "../src/prompt.js";

interface Harness {
  runtime: PstackSubagentRuntime
  specs: PstackSubagentActivationSpec[]
  disposed: string[]
  logs: string[]
}

const DONE: PstackSubagentResult = { output: [{ type: "text", text: "done" }], stopReason: "completed" };

function harness(settle: PstackSubagentResult | Error = DONE): Harness {
  const specs: PstackSubagentActivationSpec[] = [];
  const disposed: string[] = [];
  const logs: string[] = [];
  const runtime: PstackSubagentRuntime = {
    async startActivation(spec): Promise<PstackSubagentActivation> {
      specs.push(spec);
      return {
        childId: "child-1",
        result: settle instanceof Error ? Promise.reject(settle) : Promise.resolve(settle),
        async dispose() {
          disposed.push("child-1");
        },
      };
    },
  };
  return { runtime, specs, disposed, logs };
}

function toolsOf(h: Harness, preset?: string) {
  return buildPstackSubagentTools({
    subagents: h.runtime,
    provider: "spawn",
    ...(preset === undefined ? {} : { commentSickoPreset: preset }),
    logger: { info: (m) => h.logs.push(m), warn: (m) => h.logs.push(m) } satisfies PstackLogger,
  });
}

/** 工具体只读 `exec.agent` 与 `exec.signal`；真实 ToolRunContext 的其余字段与本测试无关。 */
function execOf(agent: unknown = { id: "parent" }, signal = new AbortController().signal) {
  return { agent, signal } as never;
}

/** 没有 agent 的那条路：不能用 `execOf(undefined)`，那会命中默认参数。 */
function execWithoutAgent() {
  return { signal: new AbortController().signal } as never;
}

const ARGS = { description: "label", prompt: "TASK BODY" };

describe("isCompatibleSubagentRuntime", () => {
  it("accepts the 0.2.1 shape and rejects the removed 0.2.0 method", () => {
    expect(isCompatibleSubagentRuntime({ startActivation: async () => undefined })).toBe(true);
    // 0.2.0 的 `start()` 在 0.2.1 里被删掉了；只有它时必须判为不兼容，否则调用期才炸。
    expect(isCompatibleSubagentRuntime({ start: async () => undefined })).toBe(false);
    expect(isCompatibleSubagentRuntime(undefined)).toBe(false);
    expect(isCompatibleSubagentRuntime({})).toBe(false);
  });
});

describe("flattenSubagentOutput", () => {
  it("joins text blocks", () => {
    expect(flattenSubagentOutput([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
  });

  it("returns an empty string when there is nothing", () => {
    expect(flattenSubagentOutput([])).toBe("");
  });

  it("counts non-text blocks instead of dropping them silently", () => {
    expect(flattenSubagentOutput([{ type: "image" }])).toContain("1 个非文本块");
    expect(flattenSubagentOutput([{ type: "text", text: "a" }, { type: "image" }])).toContain("另有 1 个非文本块");
  });
});

describe("buildPstackSubagentTools", () => {
  it("builds the two pstack delegates with their pstack names", () => {
    const h = harness();
    const { agentTool, sickoTool } = toolsOf(h);
    expect(agentTool.name).toBe("pstack_agent");
    expect(sickoTool.name).toBe("pstack_comment_sicko");
    for (const tool of [agentTool, sickoTool]) {
      const schema = JSON.stringify(tool.parameters);
      expect(schema).toContain("prompt");
      expect(schema).toContain("description");
    }
  });

  it("gives poteto-agent the persona, the skills root, and the task", async () => {
    const h = harness({ output: [{ type: "text", text: "delegate output" }], stopReason: "completed" });
    const { agentTool } = toolsOf(h);
    const value = await agentTool.execute(ARGS, execOf());
    expect(value).toEqual({ stopReason: "completed", output: "delegate output" });
    const text = h.specs[0]?.request.prompt[0]?.text ?? "";
    expect(text).toContain("You are operating as poteto-mode's full agent style");
    expect(text).toContain(PSTACK_SKILLS_DIR);
    expect(text).toContain("poteto-mode/SKILL.md");
    expect(text).toContain("TASK BODY");
  });

  it("calls the host's startActivation with a caller-delivered result", async () => {
    const h = harness();
    const { agentTool } = toolsOf(h);
    await agentTool.execute(ARGS, execOf());
    expect(h.specs[0]?.provider).toBe("spawn");
    expect(h.specs[0]?.label).toBe("label");
    // caller 交付：结果直接回来，不再给父会话投一条重复的结算通知。
    expect(h.specs[0]?.delivery).toBe("caller");
  });

  it("does not send an agentPreset when none is configured", async () => {
    const h = harness();
    const { agentTool, sickoTool } = toolsOf(h);
    await agentTool.execute(ARGS, execOf());
    await sickoTool.execute(ARGS, execOf());
    expect(h.specs[0]?.request.agentPreset).toBeUndefined();
    expect(h.specs[1]?.request.agentPreset).toBeUndefined();
  });

  it("passes the configured preset to comment-sicko only", async () => {
    const h = harness();
    const { agentTool, sickoTool } = toolsOf(h, "void-pstack:reader");
    await agentTool.execute(ARGS, execOf());
    await sickoTool.execute(ARGS, execOf());
    expect(h.specs[0]?.request.agentPreset).toBeUndefined();
    expect(h.specs[1]?.request.agentPreset).toBe("void-pstack:reader");
  });

  it("uses comment-sicko's own persona", async () => {
    const h = harness();
    const { sickoTool } = toolsOf(h);
    await sickoTool.execute(ARGS, execOf());
    expect(h.specs[0]?.request.prompt[0]?.text).toContain("I hate comments");
  });

  it("passes the calling agent as the delegation parent", async () => {
    const h = harness();
    const { agentTool } = toolsOf(h);
    const parent = { id: "parent-agent" };
    await agentTool.execute(ARGS, execOf(parent));
    expect(h.specs[0]?.request.parent).toBe(parent);
  });

  it("refuses to delegate without an agent instead of guessing a parent", async () => {
    const h = harness();
    const { agentTool, sickoTool } = toolsOf(h);
    await expect(agentTool.execute(ARGS, execWithoutAgent())).rejects.toThrow(/没有 agent/);
    await expect(sickoTool.execute(ARGS, execWithoutAgent())).rejects.toThrow(/没有 agent/);
    expect(h.specs).toEqual([]);
  });

  it("always disposes the activation, including when the child rejects", async () => {
    const h = harness(new Error("child blew up"));
    const { agentTool } = toolsOf(h);
    await expect(agentTool.execute(ARGS, execOf())).rejects.toThrow(/child blew up/);
    expect(h.disposed).toEqual(["child-1"]);
  });

  it("reports a non-empty diagnostic as a warning", async () => {
    const h = harness({ output: [], stopReason: "error", diagnostic: "model transport failed" });
    const { agentTool } = toolsOf(h);
    const value = await agentTool.execute(ARGS, execOf());
    expect(value).toEqual({ stopReason: "error", output: "" });
    expect(h.logs.some((line) => line.includes("model transport failed"))).toBe(true);
  });

  it("keeps a failed child's partial output instead of reporting success", async () => {
    const h = harness({ output: [{ type: "text", text: "half a report" }], stopReason: "max-tokens" });
    const { agentTool } = toolsOf(h);
    expect(await agentTool.execute(ARGS, execOf())).toEqual({ stopReason: "max-tokens", output: "half a report" });
  });

  it("forwards the caller's abort signal to the host", async () => {
    const h = harness();
    const { agentTool } = toolsOf(h);
    const controller = new AbortController();
    await agentTool.execute(ARGS, execOf({ id: "parent" }, controller.signal));
    expect(h.specs[0]?.signal).toBe(controller.signal);
  });
});
