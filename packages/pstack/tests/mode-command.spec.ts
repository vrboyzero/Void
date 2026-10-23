import { describe, expect, it } from "vitest";
import { parseModeCommand, registerModeCommand, type PstackCommandRuntime } from "../src/mode-command.js";
import type { PotetoModeSections, PstackPromptAgent } from "../src/prompt.js";

/** 一个只会记账的段控制器。 */
function fakeSections(on = true): PotetoModeSections & { enabled: string[]; disabled: string[] } {
  const enabled: string[] = [];
  const disabled: string[] = [];
  const on_ = new Set<string>(on ? ["s1"] : []);
  return {
    enabled,
    disabled,
    enable(agent) {
      enabled.push(agent.id);
      on_.add(agent.id);
    },
    disable(id) {
      disabled.push(id);
      return on_.delete(id);
    },
    has: (id) => on_.has(id),
  };
}

function mount(sections: PotetoModeSections) {
  let definition: Parameters<PstackCommandRuntime["register"]>[0] | undefined;
  const registry: PstackCommandRuntime = {
    register(def) {
      definition = def;
      return () => undefined;
    },
  };
  registerModeCommand({ commands: registry, sections, logger: { info: () => undefined, warn: () => undefined } });
  if (definition === undefined) throw new Error("没有注册命令");
  return definition;
}

const AGENT = { id: "s1", ctx: { systemPrompt: { section: () => () => undefined } } } as PstackPromptAgent;

describe("parseModeCommand", () => {
  it("treats an empty argument as status", () => {
    expect(parseModeCommand("")).toBe("status");
    expect(parseModeCommand("   ")).toBe("status");
  });

  it("accepts the long forms too", () => {
    expect(parseModeCommand(" enable")).toBe("on");
    expect(parseModeCommand("Disable")).toBe("off");
  });

  it("returns undefined for anything it does not understand", () => {
    expect(parseModeCommand("maybe")).toBeUndefined();
  });
});

describe("/pstack-mode handler", () => {
  it("registers under the hyphenated name the composer resolves", () => {
    const sections = fakeSections();
    expect(mount(sections).name).toBe("pstack-mode");
  });

  it("turns the section on for the receiving agent", () => {
    const sections = fakeSections(false);
    const result = mount(sections).handler({ agent: AGENT, rawInput: " on" });
    expect(result.kind).toBe("success");
    expect(sections.enabled).toEqual(["s1"]);
  });

  it("reports a no-op off honestly instead of claiming it turned something off", () => {
    const sections = fakeSections(false);
    const result = mount(sections).handler({ agent: AGENT, rawInput: " off" });
    expect(result.kind).toBe("success");
    expect(result.kind === "success" ? result.text : "").toContain("本来就没开");
  });

  it("reports on, off, and errors for bad input", () => {
    const sections = fakeSections();
    const definition = mount(sections);
    expect(definition.handler({ agent: AGENT, rawInput: " status" })).toEqual({
      kind: "success",
      text: "poteto-mode 常驻段：开。",
    });
    const bad = definition.handler({ agent: AGENT, rawInput: " 42" });
    expect(bad.kind).toBe("error");
  });
});
