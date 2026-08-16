#!/usr/bin/env node
/**
 * Verify that the Void belldandy-memory snapshot is a faithful copy of the
 * Star source tree plus the explicitly allow-listed Void patches.
 *
 * Current layout (after plan-B migration):
 *   starSrc  = <repo>/../packages/belldandy-memory/src
 *   target   = <repo>/packages/void-memory/src/star
 *
 * The pre-migration legacy target below is retained for rollback comparison:
 *   target   = <repo>/vendor/star/belldandy-memory/src
 *
 * The script is migration-safe: it compares normalized file content only, so
 * it can be run before and after the directory move without code changes.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");

const DEFAULT_STAR_SRC = path.resolve(repoRoot, "..", "packages", "belldandy-memory", "src");
const LEGACY_TARGET = path.join(repoRoot, "vendor", "star", "belldandy-memory", "src");
const MERGED_TARGET = path.join(repoRoot, "packages", "void-memory", "src", "star");

/**
 * Files whose only allowed difference vs Star is replacing
 * `@belldandy/protocol` with the local protocol shim.
 * Values are relative POSIX paths inside the snapshot tree.
 */
const PROTOCOL_REWRITE_FILES = new Map([
  ["dream-model-request.ts", "./protocol/index.js"],
  ["embeddings/openai-embedding-transport.ts", "../protocol/index.js"],
  ["manager.ts", "./protocol/index.js"],
  ["memory-chunk-summary-model-request.ts", "./protocol/index.js"],
  ["memory-evolution-model-request.ts", "./protocol/index.js"],
  ["task-summarizer.ts", "./protocol/index.js"],
  ["task-summary-model-request.ts", "./protocol/index.js"],
]);

/** Target-side files that have no Star counterpart and are owned by Void. */
const ALLOWED_EXTRA_FILES = new Set([
  "protocol/index.ts",
  "protocol/outbound-request-policy.ts",
  "protocol/state-dir.ts",
]);

function normalizeEol(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function readNormalized(file) {
  return normalizeEol(fs.readFileSync(file, "utf8"));
}

function walkTsFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function toRel(file, base) {
  return path.relative(base, file).split(path.sep).join("/");
}

function applyProtocolRewrite(source, relativePath) {
  const rewriteTo = PROTOCOL_REWRITE_FILES.get(relativePath);
  if (!rewriteTo) return source;
  const needle = "@belldandy/protocol";
  const occurrences = source.split(needle).length - 1;
  if (occurrences === 0) {
    throw new Error(`patch table lists ${relativePath} but source contains no ${needle}`);
  }
  return source.split(needle).join(rewriteTo);
}

function firstDiffLine(left, right) {
  const a = left.split("\n");
  const b = right.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) {
      return {
        line: i + 1,
        star: a[i] ?? "<missing>",
        void: b[i] ?? "<missing>",
      };
    }
  }
  return null;
}

function resolveTarget(cliTarget) {
  if (cliTarget) return path.resolve(cliTarget);
  if (fs.existsSync(MERGED_TARGET) && !fs.existsSync(LEGACY_TARGET)) return MERGED_TARGET;
  if (fs.existsSync(LEGACY_TARGET)) return LEGACY_TARGET;
  throw new Error(
    `snapshot target not found. Expected one of:\n  ${LEGACY_TARGET}\n  ${MERGED_TARGET}\nUse --target <dir>.`,
  );
}

function parseArgs(argv) {
  const args = { starSrc: "", target: "", json: false, verbose: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--star-src") {
      args.starSrc = argv[++i];
    } else if (arg === "--target") {
      args.target = argv[++i];
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--verbose") {
      args.verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function helpText() {
  return `verify-star-memory-snapshot.mjs [options]

Options:
  --star-src <dir>   Star belldandy-memory source directory.
                     Default: ${DEFAULT_STAR_SRC}
  --target <dir>     Void snapshot source directory.
                     Default: auto-detect current or post-migration layout.
  --json             Emit machine-readable JSON instead of a table.
  --verbose          Print every compared file.
  -h, --help         Show this help.
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(helpText());
    return;
  }

  const starSrc = path.resolve(args.starSrc || DEFAULT_STAR_SRC);
  const target = resolveTarget(args.target);

  if (!fs.existsSync(starSrc)) {
    console.error(`Star source directory does not exist: ${starSrc}`);
    process.exit(2);
  }
  if (!fs.existsSync(target)) {
    console.error(`Snapshot target directory does not exist: ${target}`);
    process.exit(2);
  }

  const starFiles = walkTsFiles(starSrc).filter((file) => !file.endsWith(".test.ts"));
  const targetFiles = walkTsFiles(target);

  const starRel = new Map(starFiles.map((file) => [toRel(file, starSrc), file]));
  const targetRel = new Map(targetFiles.map((file) => [toRel(file, target), file]));

  const report = {
    starSrc,
    target,
    starNonTestFiles: starRel.size,
    targetFiles: targetRel.size,
    identical: [],
    patched: [],
    allowedExtras: [],
    drift: [],
    missing: [],
    unexpectedExtras: [],
    targetTestFiles: [],
  };

  for (const [rel, starFile] of starRel) {
    const targetFile = targetRel.get(rel);
    if (!targetFile) {
      report.missing.push(rel);
      continue;
    }
    const starContent = readNormalized(starFile);
    const targetContent = readNormalized(targetFile);

    if (starContent === targetContent) {
      report.identical.push(rel);
      continue;
    }

    let expected;
    try {
      expected = applyProtocolRewrite(starContent, rel);
    } catch (error) {
      report.drift.push({ rel, reason: String(error.message ?? error) });
      continue;
    }

    if (targetContent === expected) {
      report.patched.push(rel);
    } else {
      report.drift.push({
        rel,
        reason: "content differs from Star and does not match the allow-listed patch",
        firstDiff: firstDiffLine(expected, targetContent),
      });
    }
  }

  for (const [rel] of targetRel) {
    if (starRel.has(rel)) continue;
    if (ALLOWED_EXTRA_FILES.has(rel)) {
      report.allowedExtras.push(rel);
    } else if (rel.endsWith(".test.ts")) {
      report.targetTestFiles.push(rel);
    } else {
      report.unexpectedExtras.push(rel);
    }
  }

  const ok =
    report.drift.length === 0 &&
    report.missing.length === 0 &&
    report.unexpectedExtras.length === 0 &&
    report.targetTestFiles.length === 0;

  if (args.json) {
    console.log(JSON.stringify({ ok, ...report }, null, 2));
  } else {
    console.log(`Star source : ${report.starSrc}`);
    console.log(`Void target : ${report.target}`);
    console.log(`Star non-test files: ${report.starNonTestFiles}`);
    console.log(`Target files      : ${report.targetFiles}`);
    console.log(`identical         : ${report.identical.length}`);
    console.log(`patched (allowed) : ${report.patched.length}`);
    console.log(`allowed extras    : ${report.allowedExtras.length}`);
    console.log(`drift             : ${report.drift.length}`);
    console.log(`missing           : ${report.missing.length}`);
    console.log(`unexpected extras : ${report.unexpectedExtras.length}`);
    console.log(`target test files : ${report.targetTestFiles.length}`);
    if (args.verbose) {
      for (const rel of [...report.identical, ...report.patched].sort()) {
        const kind = report.patched.includes(rel) ? "patched" : "same";
        console.log(`  [${kind}] ${rel}`);
      }
    }
    for (const rel of report.missing) console.log(`  [MISSING] ${rel}`);
    for (const rel of report.unexpectedExtras) console.log(`  [EXTRA]   ${rel}`);
    for (const rel of report.targetTestFiles) console.log(`  [TEST]    ${rel}`);
    for (const item of report.drift) {
      console.log(`  [DRIFT]   ${item.rel}: ${item.reason}`);
      if (item.firstDiff) {
        const d = item.firstDiff;
        console.log(`            line ${d.line} expected: ${d.star}`);
        console.log(`            line ${d.line} actual  : ${d.void}`);
      }
    }
  }

  if (!ok) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exit(2);
}
