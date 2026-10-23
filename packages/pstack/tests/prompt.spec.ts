import { describe, expect, it, vi } from "vitest";
import {
  POTETO_MODE_SECTION_NAME,
  POTETO_MODE_SECTION_ORDER,
  createPotetoModeSections,
  loadPotetoModeStandingText,
  type PstackAgentEvents,
  type PstackLogger,
  type PstackPromptAgent,
  type PstackPromptSection,
} from "../src/prompt.js";

interface Harness {
  events: PstackAgentEvents
  emit(name: "agent/created" | "agent/disposed", agent: PstackPromptAgent): void
  sections: Map<string, PstackPromptSection[]>
  disposals: string[]
  logs: string[]
}

function harness(): Harness {
  const listeners = { "agent/created": [] as ((p: { agent: PstackPromptAgent }) => void)[], "agent/disposed": [] as ((p: { agent: PstackPromptAgent }) => void)[] };
  const sections = new Map<string, PstackPromptSection[]>();
  const disposals: string[] = [];
  const logs: string[] = [];
  return {
    sections,
    disposals,
    logs,
    events: {
      on(name, listener) {
        listeners[name].push(listener);
        return () => undefined;
      },
    },
    emit(name, agent) {
      for (const listener of listeners[name]) listener({ agent });
    },
  };
}

function agentOf(id: string, h: Harness): PstackPromptAgent {
  return {
    id,
    ctx: {
      systemPrompt: {
        section(input) {
          sectionsOf(h, id).push(input);
          return () => {
            h.disposals.push(id);
          };
        },
      },
    },
  };
}

function sectionsOf(h: Harness, id: string): PstackPromptSection[] {
  const list = h.sections.get(id) ?? [];
  h.sections.set(id, list);
  return list;
}

function loggerOf(h: Harness): PstackLogger {
  return { info: (m) => h.logs.push(m), warn: (m) => h.logs.push(m) };
}

describe("loadPotetoModeStandingText", () => {
  it("returns the shipped standing text", () => {
    const text = loadPotetoModeStandingText();
    expect(text).toContain("poteto-mode");
    expect(text).toContain("pstack-dsh-harness");
    // 常驻段是压缩版，不该把整份 20 KB 的 SKILL.md 塞进每一轮。
    expect(text.length).toBeLessThan(8000);
  });
});

describe("createPotetoModeSections", () => {
  it("installs one section per agent at the fixed name and order", () => {
    const h = harness();
    const sections = createPotetoModeSections({ events: h.events, text: "STANDING", logger: loggerOf(h), always: false });
    const agent = agentOf("s1", h);
    sections.enable(agent);
    expect(h.sections.get("s1")).toEqual([
      { name: POTETO_MODE_SECTION_NAME, order: POTETO_MODE_SECTION_ORDER, text: "STANDING" },
    ]);
    expect(sections.has("s1")).toBe(true);
  });

  it("is idempotent: a second enable does not add a second section", () => {
    const h = harness();
    const sections = createPotetoModeSections({ events: h.events, text: "STANDING", logger: loggerOf(h), always: false });
    const agent = agentOf("s1", h);
    sections.enable(agent);
    sections.enable(agent);
    expect(h.sections.get("s1")).toHaveLength(1);
  });

  it("disables by disposing the section, and reports a second disable as a no-op", () => {
    const h = harness();
    const sections = createPotetoModeSections({ events: h.events, text: "STANDING", logger: loggerOf(h), always: false });
    sections.enable(agentOf("s1", h));
    expect(sections.disable("s1")).toBe(true);
    expect(h.disposals).toEqual(["s1"]);
    expect(sections.has("s1")).toBe(false);
    expect(sections.disable("s1")).toBe(false);
  });

  it("does not install on new agents when always is off", () => {
    const h = harness();
    const sections = createPotetoModeSections({ events: h.events, text: "STANDING", logger: loggerOf(h), always: false });
    h.emit("agent/created", agentOf("s1", h));
    expect(sections.has("s1")).toBe(false);
  });

  it("installs on every new agent when always is on, and says so in the log", () => {
    const h = harness();
    const sections = createPotetoModeSections({ events: h.events, text: "STANDING", logger: loggerOf(h), always: true });
    h.emit("agent/created", agentOf("s1", h));
    h.emit("agent/created", agentOf("s2", h));
    expect(sections.has("s1")).toBe(true);
    expect(sections.has("s2")).toBe(true);
    expect(h.logs.some((line) => line.includes("常驻段已开启"))).toBe(true);
  });

  it("forgets a disposed agent so a reused id starts clean", () => {
    const h = harness();
    const sections = createPotetoModeSections({ events: h.events, text: "STANDING", logger: loggerOf(h), always: false });
    sections.enable(agentOf("s1", h));
    h.emit("agent/disposed", agentOf("s1", h));
    expect(sections.has("s1")).toBe(false);
    // 宿主自己会摘掉段；我们只要不再认为自己装着它。
    expect(h.disposals).toEqual([]);
  });

  it("keeps working when the same session id comes back after disposal", () => {
    const h = harness();
    const sections = createPotetoModeSections({ events: h.events, text: "STANDING", logger: loggerOf(h), always: true });
    h.emit("agent/created", agentOf("s1", h));
    h.emit("agent/disposed", agentOf("s1", h));
    h.emit("agent/created", agentOf("s1", h));
    expect(sections.has("s1")).toBe(true);
    expect(h.sections.get("s1")).toHaveLength(2);
  });
});
