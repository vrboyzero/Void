/**
 * 把 vendored 的 pstack 技能从包内 `skills/` 读进内存，交给 `ctx.skills.register()`。
 *
 * **为什么不用 `@deepseek-ai/dsh-skill-filesystem` 的 `bundledSkillDir`**：那条路要求部署方在
 * profile 里再挂一个文件系统提供方实例并给出本包的绝对安装路径，本包的「自带技能」就变成了
 * 「用户配置对才有的技能」。运行期贡献（`ctx.skills.register`）是注册表公开的另一条路，
 * 随插件 fiber 一起装卸，不依赖任何外部路径配置。
 *
 * **代价**：注册时就要给出正文，所以正文在 `apply()` 期间一次性读盘（55 个文件 ≈ 600 KB，
 * 毫秒级）。改了 `SKILL.md` 需要重载插件，不像文件系统提供方那样现读现用——vendored 内容
 * 本来也不该在运行期被人改。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PSTACK_SKILLS, type PstackSkillEntry } from "./skills/index.generated.js";

/**
 * 包内 `skills/` 的绝对路径。
 *
 * 本模块编译到 `lib/skill-loader.js`，所以 `../skills/` 指向包根的同级目录——workspace 里是
 * `packages/pstack/skills/`，装进 profile 后是 `node_modules/@void/pstack/skills/`。两种布局
 * 都成立，这正是它不写成 `./skills/` 的原因。
 */
export const PSTACK_SKILLS_DIR = fileURLToPath(new URL("../skills/", import.meta.url));

/** 一个已读入正文的技能。 */
export interface LoadedPstackSkill extends PstackSkillEntry {
  /** `SKILL.md` 的绝对路径；宿主拿它在侧栏做文件预览。 */
  readonly skillFile: string
  /** 技能目录的绝对路径；作为 `resourceBase` 让 playbooks/references 的相对引用可解析。 */
  readonly directory: string
  /** 去掉 frontmatter 之后的 Markdown 正文。 */
  readonly content: string
}

/**
 * 切掉 YAML frontmatter，只留正文。
 *
 * 生成器已经把 frontmatter 里的元数据解析成了索引，这里只需要「第二个 `---` 之后的部分」。
 * 不做 YAML 解析：正文里出现的 `---` 是 Markdown 的分隔线，按行精确匹配才不会切错。
 */
export function stripFrontmatter(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return text.trim();
  const end = lines.indexOf("---", 1);
  if (end === -1) return text.trim();
  return lines.slice(end + 1).join("\n").trim();
}

/**
 * 读入全部 vendored 技能。
 *
 * 读不到文件就抛——生成物与 `skills/` 不一致是打包期就该拦住的事（`gen-pstack-skills.mjs --check`），
 * 真漏到这里说明包本身是坏的，没有「跳过它继续跑」的合理语义。
 */
export function loadPstackSkills(root: string = PSTACK_SKILLS_DIR): readonly LoadedPstackSkill[] {
  return PSTACK_SKILLS.map((entry) => {
    const directory = join(root, entry.name);
    const skillFile = join(directory, "SKILL.md");
    const content = stripFrontmatter(readFileSync(skillFile, "utf8"));
    if (content.length === 0) throw new Error(`pstack: 技能 ${entry.name} 的正文是空的: ${skillFile}`);
    return { ...entry, skillFile, directory, content };
  });
}
