#!/usr/bin/env node
/**
 * 军团健康探针（B4，§22.6）。
 *
 * **它是进程外的**：由操作系统的计划任务、另一个 dsh profile 或人手运行；军团自己
 * 的进程挂了，它自己救不了自己。判据不是日志里写了什么，而是**退出码**：
 *
 * | 退出码 | 含义 | 人该做什么 |
 * |---|---|---|
 * | 0 | 正常（或操作者手动停用） | 不用管 |
 * | 1 | 重启可以修 | 重启 `dsh web`；军团会把未完成 run 结算成 interrupted |
 * | 2 | 重启也修不了 | 人工查损坏文件/权限；重启不会修 |
 * | 3 | 等 setup | 先装/启用军团、配置数据根 |
 *
 * **超时/不可达不等于数据坏了**：宿主不可达且还有 `running` 记录，判 1（重启会结算）；
 * JSON 损坏、目录存在但读不了，判 2（重启不会把坏文件修好）。
 *
 * 用法（Windows 计划任务里也照这个命令）：
 * ```sh
 * node scripts/legion-health.mjs --profile web            # 默认 http://127.0.0.1:3080
 * node scripts/legion-health.mjs --data-dir <绝对路径> --json
 * node scripts/legion-health.mjs --profile web --respect-stop
 * ```
 *
 * 手动停机前创建 `runtime/legion-health.stop`，再带 `--respect-stop` 运行，探针会
 * 判 0 而不是误报。停机结束后删掉该文件。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

export const HEALTH_CODES = Object.freeze({
  ok: 0,
  restartCanFix: 1,
  restartCannotFix: 2,
  waitingSetup: 3,
});

export const HEALTH_STATES = Object.freeze({
  0: "ok",
  1: "restart-can-fix",
  2: "restart-cannot-fix",
  3: "waiting-setup",
});

export const LEGION_PLUGIN_ID = "@void/void-legion";

function codeResult(code, reasons, actions, extra = {}) {
  return {
    code,
    state: HEALTH_STATES[code],
    reasons,
    actions,
    ...extra,
  };
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(file) {
  const text = await readFile(file, "utf8");
  return JSON.parse(text);
}

async function listJson(dir) {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * 解析数据根：显式 `dataDir` > `DSH_HOME`/`dshHome` + `DSH_PROFILE`/`profile`。
 * 与 `void-soul` 的默认目录规则一致：`<DSH_HOME>/void-data/<profile>`。
 */
export function resolveDataDir(input = {}) {
  if (typeof input.dataDir === "string" && input.dataDir.trim() !== "") return path.resolve(input.dataDir);
  const home = typeof input.dshHome === "string" && input.dshHome.trim() !== ""
    ? input.dshHome
    : process.env.DSH_HOME?.trim() && process.env.DSH_HOME.trim() !== ""
      ? process.env.DSH_HOME.trim()
      : path.join(os.homedir(), ".dsh");
  const profile = typeof input.profile === "string" && input.profile.trim() !== ""
    ? input.profile.trim()
    : process.env.DSH_PROFILE?.trim();
  if (profile === undefined || profile === "") return undefined;
  return path.join(path.resolve(home), "void-data", profile);
}

async function checkCorrupt(dataDir) {
  const problems = [];
  const legion = path.join(dataDir, "legion");
  const single = ["dispatch-policy.json", "dispatch-source.json", "notifications.json"];
  for (const name of single) {
    const file = path.join(legion, name);
    if (!(await exists(file))) continue;
    try {
      await readJsonFile(file);
    } catch (error) {
      problems.push(`${path.relative(dataDir, file)} 坏了：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const [dirName, label] of [["runs", "运行记录"], ["teams", "队伍配置"]]) {
    const dir = path.join(legion, dirName);
    for (const name of await listJson(dir)) {
      try {
        await readJsonFile(path.join(dir, name));
      } catch (error) {
        problems.push(`${path.relative(dataDir, path.join(dir, name))} 坏了：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return problems;
}

async function countRunningRuns(dataDir) {
  const dir = path.join(dataDir, "legion", "runs");
  let count = 0;
  for (const name of await listJson(dir)) {
    try {
      const record = await readJsonFile(path.join(dir, name));
      if (record?.status === "running") count += 1;
    } catch {
      // 坏文件由 checkCorrupt 报；这里只数还能读的。
    }
  }
  return count;
}

async function fetchStatus(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return { ok: false, reason: `状态端点返回 HTTP ${response.status}` };
    const payload = await response.json();
    const plugins = Array.isArray(payload?.plugins) ? payload.plugins : [];
    const legion = plugins.find((plugin) => plugin?.id === LEGION_PLUGIN_ID);
    return { ok: true, plugins, legion };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 判四码。纯函数 + 注入 `fetchImpl`，测试不用真的起宿主。
 *
 * @param {{
 *   dataDir?: string, dshHome?: string, profile?: string,
 *   statusUrl?: string, fetchImpl?: typeof fetch, timeoutMs?: number,
 *   respectStop?: boolean, stopFlag?: string, now?: Date
 * }} input
 */
export async function evaluateLegionHealth(input = {}) {
  const dataDir = resolveDataDir(input);
  const checkedAt = (input.now ?? new Date()).toISOString();
  if (dataDir === undefined) {
    return codeResult(
      HEALTH_CODES.waitingSetup,
      ["没有数据根：用 --data-dir，或同时提供 DSH_HOME 与 DSH_PROFILE"],
      ["先确定 profile，再装/启用军团插件"],
      { dataDir: null, checkedAt },
    );
  }
  if (!(await exists(dataDir))) {
    return codeResult(
      HEALTH_CODES.waitingSetup,
      [`数据根不存在：${dataDir}`],
      ["先启动一次 dsh web 让数据根生成，或检查 --data-dir 是否写对"],
      { dataDir, checkedAt },
    );
  }
  const stopFlag = input.stopFlag ?? path.join(dataDir, "runtime", "legion-health.stop");
  if (input.respectStop === true && (await exists(stopFlag))) {
    return codeResult(
      HEALTH_CODES.ok,
      [`操作者手动停机标记存在：${stopFlag}`],
      ["停机结束后删掉这个标记，否则探针一直判正常"],
      { dataDir, checkedAt, stopped: true },
    );
  }
  const legionDir = path.join(dataDir, "legion");
  if (!(await exists(legionDir))) {
    return codeResult(
      HEALTH_CODES.waitingSetup,
      [`军团数据目录不存在：${legionDir}`],
      ["先装/启用军团插件并跑一次，或确认 --data-dir 是 void-data 那一层"],
      { dataDir, checkedAt },
    );
  }

  // 坏文件优先判 2：重启不会把损坏修好，先别让人白重启。
  let problems;
  try {
    problems = await checkCorrupt(dataDir);
  } catch (error) {
    return codeResult(
      HEALTH_CODES.restartCannotFix,
      [`数据根读不了：${error instanceof Error ? error.message : String(error)}`],
      ["人工检查目录权限/占用；重启不会修"],
      { dataDir, checkedAt },
    );
  }
  if (problems.length > 0) {
    return codeResult(
      HEALTH_CODES.restartCannotFix,
      problems,
      ["人工修好损坏的 JSON/权限；重启不会修"],
      { dataDir, checkedAt },
    );
  }

  const running = await countRunningRuns(dataDir);
  const statusUrl = input.statusUrl === undefined ? "http://127.0.0.1:3080/void/api/status" : input.statusUrl;
  if (statusUrl === "") {
    // 显式不做 HTTP 检查（headless profile）：文件都正常就算正常。
    return codeResult(
      HEALTH_CODES.ok,
      ["未做状态端点检查（--no-status）", `running 记录 ${running} 条`],
      [],
      { dataDir, checkedAt, running },
    );
  }
  const status = await fetchStatus(statusUrl, input.fetchImpl ?? globalThis.fetch, input.timeoutMs ?? 3000);
  if (!status.ok) {
    if (running > 0) {
      return codeResult(
        HEALTH_CODES.restartCanFix,
        [`宿主不可达（${status.reason}），且还有 ${running} 条 running 记录`],
        ["重启 dsh web；军团会把未完成 run 结算成 interrupted，不会自动重跑"],
        { dataDir, checkedAt, running },
      );
    }
    return codeResult(
      HEALTH_CODES.restartCanFix,
      [`宿主不可达：${status.reason}`],
      ["重启 dsh web；若宿主本来就该停，先创建 stop 标记并带 --respect-stop"],
      { dataDir, checkedAt, running },
    );
  }
  if (status.legion === undefined || status.legion.enabled !== true) {
    return codeResult(
      HEALTH_CODES.waitingSetup,
      [`军团插件不可用：${status.legion === undefined ? "状态端点里没有它" : "已安装但被停用"}`],
      ["在面板或 profile patch 里启用军团，再重启/刷新"],
      { dataDir, checkedAt, running },
    );
  }
  return codeResult(
    HEALTH_CODES.ok,
    [`宿主可达、军团已启用；running 记录 ${running} 条`],
    [],
    { dataDir, checkedAt, running },
  );
}

function parseArgs(argv) {
  const args = { statusUrl: undefined, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${token} 缺少值`);
      return argv[index];
    };
    switch (token) {
      case "--data-dir": args.dataDir = next(); break;
      case "--dsh-home": args.dshHome = next(); break;
      case "--profile": args.profile = next(); break;
      case "--url": args.statusUrl = next(); break;
      case "--timeout-ms": args.timeoutMs = Number(next()); break;
      case "--stop-flag": args.stopFlag = next(); break;
      case "--respect-stop": args.respectStop = true; break;
      case "--no-status": args.statusUrl = ""; break;
      case "--json": args.json = true; break;
      case "--help":
      case "-h": args.help = true; break;
      default: throw new Error(`不认识的参数: ${token}`);
    }
  }
  return args;
}

const HELP = `军团健康探针（B4）

退出码：0 正常 / 1 重启可修 / 2 重启也修不了 / 3 等 setup

选项：
  --data-dir <绝对路径>   直接指定 void-data/<profile> 那一层
  --dsh-home <路径>       DSH_HOME（默认 ~/.dsh）
  --profile <名字>        DSH_PROFILE（与 --dsh-home 一起用）
  --url <地址>            状态端点（默认 http://127.0.0.1:3080/void/api/status）
  --timeout-ms <毫秒>     状态端点超时（默认 3000）
  --no-status             不做 HTTP 检查（headless profile）
  --respect-stop          看到 runtime/legion-health.stop 就判 0
  --stop-flag <路径>      自定义手动停机标记位置
  --json                  输出 JSON
`;

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    process.exitCode = HEALTH_CODES.waitingSetup;
    return;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  const result = await evaluateLegionHealth(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`军团健康：${result.code} ${result.state}\n`);
    for (const reason of result.reasons) process.stdout.write(`- ${reason}\n`);
    for (const action of result.actions) process.stdout.write(`  → ${action}\n`);
  }
  process.exitCode = result.code;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
