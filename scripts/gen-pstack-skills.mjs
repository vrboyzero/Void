#!/usr/bin/env node
/**
 * 从 vendored 的 pstack 技能目录生成 `packages/pstack/src/skills/index.generated.ts`。
 *
 * **为什么是生成而不是运行期解析**：宿主注册技能要的是 `{name, description, invocation, content}`，
 * 而 `SKILL.md` 的 frontmatter 是 YAML。运行期读 YAML 需要引一个 YAML 库（本包刻意零运行时依赖），
 * 手写一个 YAML 子集解析器又等于把一个会漂移的实现塞进热路径。生成器把「解析」这件事放到构建期，
 * 运行期只做 `readFileSync` + 一次 `---` 切分。
 *
 * **为什么 `--check` 必须是打包门禁**：技能目录是 vendor 进来的第三方内容，可能被换版本或被手改。
 * 生成物与磁盘不一致时，运行期注册出去的技能集与 `skills/` 里躺着的文件对不上；而这种不一致的
 * 表现是「少一个技能」或「描述是上一版的」，没有任何报错。宁可在打包这一步失败。
 *
 * 用法：
 *   node scripts/gen-pstack-skills.mjs           # 写入生成物
 *   node scripts/gen-pstack-skills.mjs --check   # 只校验，不一致则 exit 1
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = join(repoRoot, "packages", "pstack", "skills");
const outFile = join(repoRoot, "packages", "pstack", "src", "skills", "index.generated.ts");
const checkOnly = process.argv.includes("--check");

/** 技能名必须是 kebab-case——与宿主 `dsh-skill-filesystem` 的校验口径一致。 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 解析 frontmatter 里的 key。只认平铺的 `key: value`，以及值留空时紧随其后的缩进续行
 * （YAML 的折叠/字面标量）。pstack 现行内容都是单行标量，续行分支是给换版留的退路。
 */
function readFrontmatterKeys(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const end = lines.indexOf("---", 1);
  if (end === -1) return undefined;
  const keys = new Map();
  for (let i = 1; i < end; i += 1) {
    const line = lines[i];
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rest] = match;
    let value = rest.trim();
    if (value === "" || value === ">" || value === ">-" || value === "|" || value === "|-") {
      const continuation = [];
      while (i + 1 < end && /^\s+\S/.test(lines[i + 1])) {
        i += 1;
        continuation.push(lines[i].trim());
      }
      value = continuation.join(" ");
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    keys.set(key, value);
  }
  return keys;
}

/**
 * 宿主 `dsh-skill-filesystem` 接受的布尔写法。非布尔值在宿主侧会让整个技能被丢弃，
 * 这里直接硬失败——生成物里不该出现一个宿主会扔掉的技能。
 */
function parseBoolean(raw, source) {
  if (raw === undefined) return undefined;
  const value = String(raw).trim().toLowerCase();
  if (["true", "yes", "on", "1"].includes(value)) return true;
  if (["false", "no", "off", "0"].includes(value)) return false;
  throw new Error(`${source}: 调用开关不是布尔值: ${JSON.stringify(raw)}`);
}

function collectSkills() {
  if (!existsSync(skillsRoot)) {
    throw new Error(`找不到 vendored 技能目录: ${skillsRoot}`);
  }
  const entries = [];
  const problems = [];
  for (const dirent of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const file = join(skillsRoot, dirent.name, "SKILL.md");
    if (!existsSync(file) || !statSync(file).isFile()) {
      problems.push(`${dirent.name}: 缺 SKILL.md`);
      continue;
    }
    const source = `skills/${dirent.name}/SKILL.md`;
    const front = readFrontmatterKeys(readFileSync(file, "utf8"));
    if (!front) {
      problems.push(`${source}: 缺 frontmatter`);
      continue;
    }
    const name = (front.get("name") ?? "").trim();
    const description = (front.get("description") ?? "").trim();
    if (!name || !description) {
      problems.push(`${source}: frontmatter 缺 name 或 description`);
      continue;
    }
    if (!SKILL_NAME.test(name)) {
      problems.push(`${source}: 技能名不是 kebab-case: ${name}`);
      continue;
    }
    if (name !== dirent.name) {
      problems.push(`${source}: 技能名与目录名不一致 (${name} != ${dirent.name})`);
      continue;
    }
    if (front.has("disableModelInvocation") || front.has("modelInvocable")) {
      problems.push(`${source}: 用了驼峰调用开关，宿主只认 disable-model-invocation / user-invocable`);
      continue;
    }
    const modelInvocable = parseBoolean(front.get("disable-model-invocation"), source) !== true;
    const userInvocable = parseBoolean(front.get("user-invocable"), source) !== false;
    entries.push({ name, description, modelInvocable, userInvocable });
  }
  if (problems.length > 0) {
    throw new Error(`技能清单生成失败：\n  ${problems.join("\n  ")}`);
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.name)) throw new Error(`技能名重复: ${entry.name}`);
    seen.add(entry.name);
  }
  return entries;
}

function render(entries) {
  const rows = entries.map((entry) => {
    const description = JSON.stringify(entry.description);
    return `  { name: ${JSON.stringify(entry.name)}, description: ${description}, modelInvocable: ${entry.modelInvocable}, userInvocable: ${entry.userInvocable} },`;
  });
  return `// 本文件由 scripts/gen-pstack-skills.mjs 从 packages/pstack/skills/*/SKILL.md 生成。
// 不要手改：改技能请改 skills/ 下的原文，然后重跑 \`pnpm --filter @void/pstack run gen\`。
// \`scripts/pack-all.ps1\` 会用 --check 校验它与磁盘一致。

/** vendored 技能在目录里的元数据；正文由运行期从 SKILL.md 现读。 */
export interface PstackSkillEntry {
  /** kebab-case 技能名，与 skills/ 下的目录名一致。 */
  readonly name: string
  /** 面向发现消费者的路由描述；宿主按 500 字符上限渲染它。 */
  readonly description: string
  /** 是否出现在面向模型的目录与 loader 里。 */
  readonly modelInvocable: boolean
  /** 是否出现在面向用户的 \`/\` 菜单里。 */
  readonly userInvocable: boolean
}

/** 全部 vendored 技能，按名称排序。 */
export const PSTACK_SKILLS: readonly PstackSkillEntry[] = [
${rows.join("\n")}
]

/** 技能数量。测试用它盯住「vendor 目录被换版本」这类静默变化。 */
export const PSTACK_SKILL_COUNT = ${entries.length}
`;
}

const entries = collectSkills();
const next = render(entries);
const current = existsSync(outFile) ? readFileSync(outFile, "utf8") : undefined;

if (checkOnly) {
  if (current !== next) {
    console.error("[x] packages/pstack/src/skills/index.generated.ts 与 skills/ 不一致。");
    console.error("    重跑：node scripts/gen-pstack-skills.mjs");
    process.exit(1);
  }
  console.log(`[ok] pstack 技能清单一致（${entries.length} 个）`);
} else {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, next, "utf8");
  console.log(`[ok] 写出 ${entries.length} 个技能 -> ${outFile}`);
}
