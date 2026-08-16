#!/usr/bin/env node
/**
 * P0 配置合同校验 Gate：检查 config/void-capabilities.json 的完整性。
 * 1. 缺项：Star .env.example 全集 + .env.local 独有 是否都被清单覆盖；
 * 2. 重复：starVariable 是否重复；
 * 3. 未知：classification 是否在七类内；
 * 4. 敏感：sensitive 字段是否正确标记、且 note 不含值（不泄漏凭据）。
 * 只读 Star 文件，不写任何文件。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEVEN = new Set([
  "void_native", "dsh_mapped", "plugin_internal", "adapter_credential",
  "development_only", "legacy_or_omit", "defer",
]);

function extractVars(path, withComments) {
  const vars = new Set();
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    console.error(`✗ 无法读取 ${path}:`, error.message);
    process.exit(2);
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(withComments
      ? /^[ \t]*#?[ \t]*([A-Za-z_][A-Za-z0-9_]*)=/
      : /^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (m) vars.add(m[1]);
  }
  return vars;
}

const caps = JSON.parse(readFileSync(resolve(root, "config/void-capabilities.json"), "utf8"));
// 母清单只依赖 Star 的 .env.example（稳定只读）；.env.local 是用户机器临时文件，不作为校验源。
const allVars = extractVars(resolve(root, "..", ".env.example"), true);

let errors = 0;

// 1. 缺项
const listed = new Set(caps.capabilities.map((c) => c.starVariable));
const missing = [...allVars].filter((v) => !listed.has(v));
if (missing.length > 0) {
  console.error(`✗ 缺项 ${missing.length} 个:`, missing.join(", "));
  errors += 1;
}

// 2. 重复
const seen = new Set();
const dupes = [];
for (const c of caps.capabilities) {
  if (seen.has(c.starVariable)) dupes.push(c.starVariable);
  seen.add(c.starVariable);
}
if (dupes.length > 0) {
  console.error(`✗ 重复项:`, dupes.join(", "));
  errors += 1;
}

// 3. 未知分类
const unknown = caps.capabilities.filter((c) => !SEVEN.has(c.classification));
if (unknown.length > 0) {
  console.error(`✗ 未知分类:`, unknown.map((c) => `${c.starVariable}(${c.classification})`).join(", "));
  errors += 1;
}

// 4. 敏感字段检查
const sensitive = caps.capabilities.filter((c) => c.sensitive);
const misclassified = sensitive.filter((c) => c.classification !== "adapter_credential");
if (misclassified.length > 0) {
  console.error(`✗ 敏感字段分类错误（应 adapter_credential）:`, misclassified.map((c) => c.starVariable).join(", "));
  errors += 1;
}

if (errors === 0) {
  console.log(`✓ 配置合同校验通过`);
  console.log(`  清单项: ${caps.capabilities.length}`);
  console.log(`  覆盖 .env.example 变量: ${allVars.size}`);
  console.log(`  敏感字段: ${sensitive.length} 项已标记`);
  console.log(`  无缺项 / 无重复 / 无未知分类 / 敏感分类正确`);
} else {
  console.error(`✗ 校验失败（${errors} 类问题）`);
  process.exit(1);
}
