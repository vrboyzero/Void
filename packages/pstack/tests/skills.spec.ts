import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePstackConfig } from "../src/config.js";
import { PSTACK_SKILLS } from "../src/skills/index.generated.js";
import { PSTACK_SKILLS_DIR, loadPstackSkills, stripFrontmatter } from "../src/skill-loader.js";
import { contributeSkills, type PstackSkillRegistration, type PstackSkillRegistry } from "../src/skills-contribute.js";

/** 收下注册的假注册表；只需要 `register` 这一个方法。 */
function fakeRegistry(): { registry: PstackSkillRegistry; registered: PstackSkillRegistration[] } {
  const registered: PstackSkillRegistration[] = [];
  return {
    registered,
    registry: {
      register(skill) {
        registered.push(skill);
        return () => undefined;
      },
    },
  };
}

describe("vendored skill index", () => {
  it("carries all 55 vendored skills", () => {
    expect(PSTACK_SKILLS).toHaveLength(55);
  });

  it("gives every skill a kebab-case name, a description, and a SKILL.md on disk", () => {
    for (const entry of PSTACK_SKILLS) {
      expect(entry.name, entry.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(entry.description.length, entry.name).toBeGreaterThan(0);
      expect(existsSync(join(PSTACK_SKILLS_DIR, entry.name, "SKILL.md")), entry.name).toBe(true);
    }
  });

  it("keeps the generated invocation policy: only setup-pstack is model-invocable", () => {
    const modelInvocable = PSTACK_SKILLS.filter((entry) => entry.modelInvocable).map((entry) => entry.name);
    expect(modelInvocable).toEqual(["setup-pstack"]);
    expect(PSTACK_SKILLS.every((entry) => entry.userInvocable)).toBe(true);
  });
});

describe("loadPstackSkills", () => {
  it("loads every body without its frontmatter", () => {
    const skills = loadPstackSkills();
    expect(skills).toHaveLength(PSTACK_SKILLS.length);
    for (const skill of skills) {
      expect(skill.content.startsWith("---"), skill.name).toBe(false);
      expect(skill.content.length, skill.name).toBeGreaterThan(0);
      expect(skill.directory.endsWith(skill.name), skill.name).toBe(true);
    }
  });

  it("keeps poteto-mode's routing table reachable through resourceBase neighbours", () => {
    const poteto = loadPstackSkills().find((skill) => skill.name === "poteto-mode");
    expect(poteto).toBeDefined();
    expect(poteto!.content).toContain("## Playbooks");
    // playbook 与 references 必须在同一个目录里，宿主的 relative-resource 引导才解析得到。
    expect(existsSync(join(poteto!.directory, "playbooks", "shipping.md"))).toBe(true);
    expect(existsSync(join(poteto!.directory, "references", "bugbot-triage.md"))).toBe(true);
  });
});

describe("stripFrontmatter", () => {
  it("returns the body after the closing fence", () => {
    expect(stripFrontmatter("---\nname: x\n---\n\n# Title\nbody\n")).toBe("# Title\nbody");
  });

  it("keeps a document that has no frontmatter", () => {
    expect(stripFrontmatter("# Title\n\n---\n\nbody")).toBe("# Title\n\n---\n\nbody");
  });

  it("keeps horizontal rules out of the frontmatter cut", () => {
    expect(stripFrontmatter("---\na: 1\n---\n\nx\n\n---\n\ny\n")).toBe("x\n\n---\n\ny");
  });
});

describe("contributeSkills", () => {
  it("registers all 55 under their own names with a directory resource base", () => {
    const { registry, registered } = fakeRegistry();
    const result = contributeSkills(registry, resolvePstackConfig(), loadPstackSkills());
    expect(result.registered).toHaveLength(55);
    expect(result.renamed).toEqual([]);
    expect(result.skipped).toEqual([]);
    const names = registered.map((skill) => skill.name).sort();
    expect(names).toEqual([...result.registered].sort());
    for (const skill of registered) {
      expect(skill.source).toBe("runtime");
      expect(skill.resourceBase?.kind).toBe("directory");
      expect(skill.path?.endsWith("SKILL.md"), skill.name).toBe(true);
      expect(skill.invocation?.userInvocable).toBe(true);
    }
  });

  it("carries the invocation policy through to the registrar", () => {
    const { registry, registered } = fakeRegistry();
    contributeSkills(registry, resolvePstackConfig(), loadPstackSkills());
    const poteto = registered.find((skill) => skill.name === "poteto-mode");
    const setup = registered.find((skill) => skill.name === "setup-pstack");
    expect(poteto?.invocation).toEqual({ modelInvocable: false, userInvocable: true });
    expect(setup?.invocation).toEqual({ modelInvocable: true, userInvocable: true });
  });

  it("renames and skips exactly what the config names", () => {
    const { registry, registered } = fakeRegistry();
    const result = contributeSkills(
      registry,
      resolvePstackConfig({ renameSkills: { tdd: "pstack-tdd", teach: "pstack-teach" }, skipSkills: ["bro"] }),
      loadPstackSkills(),
    );
    const names = registered.map((skill) => skill.name);
    expect(names).toContain("pstack-tdd");
    expect(names).toContain("pstack-teach");
    expect(names).not.toContain("tdd");
    expect(names).not.toContain("bro");
    expect(result.renamed).toEqual([
      ["tdd", "pstack-tdd"],
      ["teach", "pstack-teach"],
    ]);
    expect(result.skipped).toEqual(["bro"]);
  });

  it("fails loud when two renames collapse onto one name", () => {
    const { registry } = fakeRegistry();
    expect(() =>
      contributeSkills(registry, resolvePstackConfig({ renameSkills: { tdd: "how" } }), loadPstackSkills()),
    ).toThrow(/重名/);
  });
});

describe("generated index freshness", () => {
  it("matches what the generator would write for the current skills/ tree", () => {
    // 这条与 scripts/gen-pstack-skills.mjs --check 同源：打包门禁在外面跑，测试里再钉一次，
    // 免得只跑 pnpm test 的人看不到「技能目录换了版本但索引没重生」。
    const file = readFileSync(join(PSTACK_SKILLS_DIR, "..", "src", "skills", "index.generated.ts"), "utf8");
    const rows = file.split("\n").filter((line) => line.trimStart().startsWith("{ name:"));
    expect(rows).toHaveLength(PSTACK_SKILLS.length);
    for (const entry of PSTACK_SKILLS) {
      expect(file).toContain(`{ name: ${JSON.stringify(entry.name)},`);
    }
  });
});
