#!/usr/bin/env node
/**
 * 生成 `packages/void-entry/src/client/primitives.d.ts`。
 *
 * ## 为什么需要它
 *
 * `@deepseek-ai/dsh-client-ui-primitives` **不能装进 node_modules**：它的
 * peerDependencies 是 `@deepseek-ai/cordis@^4.0.2`，而本 workspace 固定在 4.0.1，
 * 装进来会把既有包的 peer 提升到 4.0.2，使 void-tools / void-legion / void-memory 报
 * `does not provide an export named 'CallId' / 'isJsonValue'`（方案文档 §20.1）。
 * 它在运行时由宿主的冻结模块表提供，所以只能在编译期手写一份 ambient 声明。
 *
 * 手写的问题是**会漂移**：宿主的原语签名一改，本地声明不会自己跟上，而且不报错——
 * 要等真机上渲染崩了才发现。dsh 官方对同类问题用 `ts type-equiv` 门禁（文档里的类型
 * 声明必须与源码逐字相等），本脚本是它在「宿主外部包」场景下的等价物。
 *
 * ## 设计
 *
 * **输入是用法，不是白名单**：脚本扫描 `src/client/**` 里从该模块 import 的名字，
 * 只生成这些。新用一个原语而忘了重新生成，`--check` 会立刻失败；不会出现「声明里有，
 * 但代码里已经不用了」或反过来的情况。
 *
 * 名字从 `lib/types/index.d.ts` 的 re-export 表解析到具体文件，再按名抽取声明（连同
 * 它上面的 JSDoc）。声明里引用到的包内类型会被递归带上（例如图标的 `IconProps`）。
 *
 * ## 用法
 *
 * ```sh
 * # 从 npm 上同版的包取类型（需联网）
 * node scripts/gen-primitives-types.mjs
 *
 * # 从已解开的目录取（离线；目录里应有 lib/types）
 * node scripts/gen-primitives-types.mjs --from .tmp/primitives-types/package
 *
 * # 只检查是否最新（不写入，落后则退出码 1）
 * node scripts/gen-primitives-types.mjs --check
 * ```
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT_DIR = join(ROOT, "packages/void-entry/src/client");
const OUTPUT = join(CLIENT_DIR, "primitives.d.ts");
const MODULE_NAME = "@deepseek-ai/dsh-client-ui-primitives";

/**
 * 宿主 dsh 的版本。必须与正在使用的宿主一致——声明就是从同版包的 `lib/types` 抄的。
 * 宿主升级时改这里，然后重跑本脚本。
 */
const HOST_VERSION = "0.1.5-rc.2";

const args = process.argv.slice(2);
const check = args.includes("--check");
const fromIndex = args.indexOf("--from");
const fromDir = fromIndex >= 0 ? args[fromIndex + 1] : undefined;

/**
 * 把 re-export 里的模块说明符解析成实际的声明文件。
 *
 * `index.d.ts` 写的是**源码**路径（`./icons/index.tsx`），而随包发布的是对应的
 * `index.d.ts`——扩展名要换掉。
 *
 * @param fromFile - 发出该说明符的文件。
 * @param spec - `./x.tsx` 这类相对说明符。
 * @returns 声明文件的绝对路径。
 */
function resolveDecl(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base.replace(/\.tsx?$/, ".d.ts"),
    base.replace(/\.tsx?$/, ".d.ts").replace(/\/index\.d\.ts$/, "/index.d.ts"),
    `${base}.d.ts`,
    base,
  ];
  for (const candidate of candidates) {
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
  }
  throw new Error(`解析不到声明文件：${spec}（来自 ${fromFile}）`);
}
/** 递归列出目录下的文件。 */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * 取出客户端代码实际从这个模块 import 的名字。
 *
 * 用正则而不是 TS 解析器：这里只需要 import 列表，正则足够且不引入依赖。副作用是
 * 动态 import 与 `import * as` 看不到——真出现了 `--check` 会因声明缺失而失败，比
 * 静默漏掉好。
 */
function usedNames() {
  const names = new Set();
  for (const file of walk(CLIENT_DIR)) {
    if (!/\.tsx?$/.test(file) || file.endsWith("primitives.d.ts")) continue;
    const source = readFileSync(file, "utf8");
    const re = new RegExp(`import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s+from\\s+["']${MODULE_NAME}["']`, "g");
    for (const match of source.matchAll(re)) {
      for (const raw of match[1].split(",")) {
        // `import { type Foo }` 的内联 type 修饰符不属于名字本身。
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
        if (name !== "") names.add(name);
      }
    }
  }
  return [...names].sort();
}

/** 定位 primitives 包的类型根目录。 */
function resolveTypesRoot() {
  if (fromDir !== undefined) {
    const root = join(resolve(fromDir), "lib/types");
    if (!statSync(root, { throwIfNoEntry: false })) throw new Error(`--from 下没有 lib/types：${root}`);
    return { root, cleanup: () => {} };
  }
  const temp = mkdtempSync(join(tmpdir(), "primitives-types-"));
  process.stderr.write(`从 npm 取 ${MODULE_NAME}@${HOST_VERSION} 的类型...\n`);
  execFileSync("npm", ["pack", `${MODULE_NAME}@${HOST_VERSION}`, "--pack-destination", temp], {
    stdio: ["ignore", "ignore", "inherit"],
    shell: process.platform === "win32",
  });
  const tarball = readdirSync(temp).find((f) => f.endsWith(".tgz"));
  if (tarball === undefined) throw new Error("npm pack 没有产出 tarball");
  execFileSync("tar", ["-xzf", join(temp, tarball), "-C", temp], { stdio: "inherit" });
  return { root: join(temp, "package/lib/types"), cleanup: () => rmSync(temp, { recursive: true, force: true }) };
}

/**
 * 解析一个 `.d.ts` 的导出表：名字 → 源文件（相对该文件的路径）。
 *
 * 处理三种形态：`export { A, B } from './x'`、`export type { A } from './x'`、
 * 以及 `export * from './x'`（递归展开）。
 */
function exportTable(root, file) {
  const table = new Map();
  const source = readFileSync(file, "utf8");
  for (const line of source.split("\n")) {
    const named = line.match(/^export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/);
    if (named) {
      for (const raw of named[1].split(",")) {
        const name = raw.trim().split(/\s+as\s+/).pop().trim();
        if (name !== "") table.set(name, resolveDecl(file, named[2]));
      }
      continue;
    }
    const star = line.match(/^export\s+\*\s+from\s+['"]([^'"]+)['"]/);
    if (star) {
      for (const [name, target] of exportTable(root, resolveDecl(file, star[1]))) {
        if (!table.has(name)) table.set(name, target);
      }
      continue;
    }
    // 直接在本文件里声明的导出。`export *` 展开进来的文件（如 icons/index.d.ts）
    // 就是这样——它的 200 个图标是声明，不是再导出。
    const declared = line.match(/^export\s+(?:declare\s+)?(?:function|const|interface|type|class)\s+(\w+)/);
    if (declared) table.set(declared[1], file);
  }
  return table;
}

/**
 * 按名抽取一条声明，连同它上面的 JSDoc。
 *
 * 结束位置靠括号平衡加 `;` 判断，覆盖这些 `.d.ts` 里出现的全部形态：
 * `export declare function X(...): T;`、`export interface X { ... }`、
 * `export type X = ...;`、`export declare const X: (...)=>T;`。
 */
function extract(file, name) {
  const lines = readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((line) =>
    new RegExp(`^export\\s+(declare\\s+)?(function|const|interface|type|class)\\s+${name}\\b`).test(line),
  );
  if (start < 0) throw new Error(`在 ${file} 里找不到声明：${name}`);

  // 往上吃掉紧邻的 JSDoc 块（`/** ... */`）。
  let from = start;
  if (from > 0 && lines[from - 1].trimEnd().endsWith("*/")) {
    let open = from - 1;
    while (open > 0 && !lines[open].trimStart().startsWith("/**")) open -= 1;
    if (lines[open].trimStart().startsWith("/**")) from = open;
  }

  let depth = 0;
  let end = start;
  const isTypeAlias = /^export\s+type\s/.test(lines[start]);
  for (let i = start; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === "{" || ch === "(" || ch === "[") depth += 1;
      else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
    }
    end = i;
    if (depth === 0 && (isTypeAlias || /[;}]\s*$/.test(lines[i]))) break;
  }
  return { text: lines.slice(from, end + 1).join("\n"), start };
}

/**
 * 列出一个文件里声明的全部名字（含未导出的）。
 *
 * 用于补全闭包：`Button` 的签名引用了同文件的 `ButtonVariant`，而后者没被任何人
 * import——只跟 import 走会漏掉它。**漏掉也不会报错**，因为 tsconfig 里
 * `skipLibCheck: true` 会让 `.d.ts` 内部的错误被静默跳过，所以必须在这里自己算全。
 *
 * @param file - 声明文件。
 * @returns 该文件声明的名字。
 */
function fileDeclarations(file) {
  const names = new Set();
  const source = readFileSync(file, "utf8");
  const re = /^(?:export\s+)?(?:declare\s+)?(?:function|const|interface|type|class|enum)\s+(\w+)/gm;
  for (const match of source.matchAll(re)) names.add(match[1]);
  return names;
}
/** 声明文本里用到的、来自包内相对导入的名字。 */
function localImports(file, text) {
  const source = readFileSync(file, "utf8");
  const needed = new Map();
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"](\.[^'"]+)['"]/g;
  for (const match of source.matchAll(re)) {
    for (const raw of match[1].split(",")) {
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop().trim();
      if (name !== "" && new RegExp(`\\b${name}\\b`).test(text)) {
        needed.set(name, resolveDecl(file, match[2]));
      }
    }
  }
  return needed;
}

/** react 导入的名字，最后合并成一条。 */
function reactImports(file) {
  const source = readFileSync(file, "utf8");
  const names = new Set();
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]react['"]/g;
  for (const match of source.matchAll(re)) {
    for (const raw of match[1].split(",")) {
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (name !== "") names.add(name);
    }
  }
  return names;
}

const PREAMBLE = `/**
 * Ambient types for \`${MODULE_NAME}\`.
 *
 * **这个文件是生成的，不要手改。** 改用法后重跑：
 *
 * \`\`\`sh
 * node scripts/gen-primitives-types.mjs
 * \`\`\`
 *
 * 校验是否最新：\`node scripts/gen-primitives-types.mjs --check\`（落后则退出码 1）。
 *
 * 生成它的原因：该包在运行时由**宿主的冻结模块表**提供（前端 bundle 里以
 * \`"${MODULE_NAME}"\` 注册），**不能装进 node_modules**——它的 peerDependencies 是
 * \`@deepseek-ai/cordis@^4.0.2\`，而本 workspace 固定在 4.0.1，装进来会把既有包的 peer
 * 提升到 4.0.2，使 void-tools / void-legion / void-memory 报
 * \`does not provide an export named 'CallId' / 'isJsonValue'\`（方案文档 §20.1）。
 *
 * 声明逐字抄自 npm 上**与宿主同版**的 \`${MODULE_NAME}@${HOST_VERSION}\`
 * 的 \`lib/types/**\`。宿主升级时改脚本里的 \`HOST_VERSION\` 再重跑。
 */`;

/**
 * 断言生成的文本里没有「引用了但没带上」的包内类型。
 *
 * 这道检查是必需的，不是保险：tsconfig 里 `skipLibCheck: true`，所以 `.d.ts` 内部
 * 悬空引用**不会**产生任何编译错误——它只会让类型悄悄退化成 `any`。生成器漏掉
 * `ButtonVariant` 时正是这个情况，`tsc` 全绿。
 *
 * 只拿「这个包自己声明过的名字」当判据，所以不会有全局类型的误报。
 *
 * @param text - 生成的声明体。
 * @param declaredEverywhere - 该包所有文件声明过的名字。
 * @param emitted - 本次实际带上的名字。
 * @param react - 合并后的 react 导入名。
 * @throws Error 当有包内类型被引用却没带上。
 */
function assertClosure(text, declaredEverywhere, emitted, react) {
  const missing = new Set();
  for (const candidate of declaredEverywhere) {
    if (emitted.has(candidate) || react.has(candidate)) continue;
    if (new RegExp(`\\b${candidate}\\b`).test(text)) missing.add(candidate);
  }
  if (missing.size > 0) {
    throw new Error(
      `生成的声明引用了没带上的包内类型：${[...missing].sort().join(", ")}\n` +
        `这是生成器的闭包漏项；skipLibCheck 不会替你发现它。`,
    );
  }
}
function generate(typesRoot) {
  const index = join(typesRoot, "index.d.ts");
  const table = exportTable(typesRoot, index);
  const wanted = usedNames();

  // 包里声明过的全部名字，供闭包自检当判据。
  const declaredEverywhere = new Set();
  for (const file of walk(typesRoot)) {
    if (!file.endsWith(".d.ts")) continue;
    for (const n of fileDeclarations(file)) declaredEverywhere.add(n);
  }

  const missing = wanted.filter((name) => !table.has(name));
  if (missing.length > 0) {
    throw new Error(
      `这些名字在 ${MODULE_NAME} 的导出表里找不到：${missing.join(", ")}\n` +
        `确认宿主版本（当前按 ${HOST_VERSION} 生成）与拼写。`,
    );
  }

  const react = new Set();
  const chunks = [];
  const seen = new Set();
  const queue = wanted.map((name) => ({ name, file: table.get(name) }));

  while (queue.length > 0) {
    const { name, file } = queue.shift();
    const key = `${file}#${name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const { text } = extract(file, name);
    for (const n of reactImports(file)) react.add(n);
    for (const [dep, depFile] of localImports(file, text)) {
      queue.push({ name: dep, file: depFile });
    }
    // 同文件里被引用到的其它声明（`Button` → `ButtonVariant`）。只跟 import 走会漏掉，
    // 而且因为 skipLibCheck 不会报错。
    for (const local of fileDeclarations(file)) {
      if (local !== name && new RegExp(`\\b${local}\\b`).test(text)) {
        queue.push({ name: local, file });
      }
    }
    chunks.push({ name, text });
  }

  chunks.sort((a, b) => a.name.localeCompare(b.name));
  assertClosure(
    chunks.map((c) => c.text).join("\n"),
    declaredEverywhere,
    new Set(chunks.map((c) => c.name)),
    react,
  );
  const reactImport =
    react.size === 0
      ? ""
      : `  import type {\n${[...react].sort().map((n) => `    ${n},`).join("\n")}\n  } from "react";\n\n`;

  return (
    `${PREAMBLE}\n\ndeclare module "${MODULE_NAME}" {\n` +
    reactImport +
    chunks
      .map((c) =>
        c.text
          // `declare module` 里已经是 ambient 上下文，`export declare function` 会报
          // TS1038；去掉 `declare` 才对。这个错误在 `skipLibCheck: true` 下不可见。
          .replace(/^export declare /gm, "export ")
          .replace(/^/gm, "  "),
      )
      .join("\n\n") +
    `\n}\n`
  );
}

const { root, cleanup } = resolveTypesRoot();
let next;
try {
  next = generate(root);
} finally {
  cleanup();
}

const current = statSync(OUTPUT, { throwIfNoEntry: false }) ? readFileSync(OUTPUT, "utf8") : "";
if (current === next) {
  process.stdout.write(`${relative(ROOT, OUTPUT)} 已是最新。\n`);
  process.exit(0);
}
if (check) {
  process.stderr.write(
    `${relative(ROOT, OUTPUT)} 与宿主 ${HOST_VERSION} 的类型不一致。\n` +
      `重跑：node scripts/gen-primitives-types.mjs\n`,
  );
  process.exit(1);
}
writeFileSync(OUTPUT, next);
process.stdout.write(`${relative(ROOT, OUTPUT)} 已更新（按宿主 ${HOST_VERSION} 生成）。\n`);
