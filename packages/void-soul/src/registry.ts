import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./atomic-file.js";
import { assertAuthorityReferences } from "./authority.js";
import { SoulProfileError, isFacetDirectoryName, parseSoulDocument, type SoulFrontMatter } from "./profile.js";
import { readUtf8TextFile } from "./text-file.js";

export interface SoulRecord {
  id: string;
  directoryName: string;
  soulPath: string;
  frontMatter: SoulFrontMatter;
  body: string;
}

export interface SessionBinding {
  sessionId: string;
  agentId: string;
}

/** 扫描 agents 下每个目录的 SOUL.md。跳过共用模组库与普通文件；链接、重复 id、越界都拒绝。 */
export async function loadSoulRegistry(dataDir: string): Promise<Map<string, SoulRecord>> {
  const agentsRoot = path.resolve(dataDir, "agents");
  // 数据根或 agents 目录还不存在时按「一份档案都没有」处理：首次运行时列档案、开面板不该报错，
  // 也不该顺手把目录建出来（建目录是写档案那一步的事）。
  const realRoot = await realpath(agentsRoot).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (realRoot === undefined) return new Map();
  const entries = await readdir(agentsRoot, { withFileTypes: true });
  const records = new Map<string, SoulRecord>();
  for (const entry of entries) {
    if (isFacetDirectoryName(entry.name)) continue;
    // 链接（Windows 上的 junction 也算）不能像普通文件那样跳过：`readdir` 把它们报成「不是目录」，
    // 照旧 `continue` 的后果是一份档案凭空消失，人只看到「没有这份档案」，查不出为什么。
    if (entry.isSymbolicLink()) {
      const target = await realpath(path.resolve(agentsRoot, entry.name)).catch(() => undefined);
      const where = target === undefined
        ? "（链接目标读不到）"
        : isInside(realRoot, target) ? `（指向库内 ${target}）` : `（指向数据根外 ${target}）`;
      throw new SoulProfileError(`档案目录是链接，拒绝读入: ${entry.name}${where}`);
    }
    if (!entry.isDirectory()) continue;
    const soulPath = path.resolve(agentsRoot, entry.name, "SOUL.md");
    const realSoul = await realpath(soulPath).catch(() => undefined);
    if (realSoul === undefined) continue;
    if (!isInside(realRoot, realSoul)) {
      throw new SoulProfileError(`档案路径越界或指向链接外部: ${entry.name}`);
    }
    const parsed = parseSoulDocument(await readUtf8TextFile(realSoul, `档案 ${entry.name} 的 SOUL.md`));
    if (records.has(parsed.frontMatter.id)) {
      throw new SoulProfileError(`档案 id 重复: ${parsed.frontMatter.id}`);
    }
    records.set(parsed.frontMatter.id, {
      id: parsed.frontMatter.id,
      directoryName: entry.name,
      soulPath: realSoul,
      frontMatter: parsed.frontMatter,
      body: parsed.body,
    });
  }
  assertAuthorityReferences(records);
  return records;
}

/** 空会话绑定。已有绑定不能改成另一个档案；未知档案直接拒绝。 */
export function bindSession(input: {
  bindings: ReadonlyMap<string, string>;
  registry: ReadonlyMap<string, SoulRecord>;
  sessionId: string;
  agentId: string;
}): Map<string, string> {
  if (!input.registry.has(input.agentId)) {
    throw new SoulProfileError(`没有这份档案，拒绝进入模型: ${input.agentId}`);
  }
  const existing = input.bindings.get(input.sessionId);
  if (existing !== undefined && existing !== input.agentId) {
    throw new SoulProfileError(`会话已绑定 ${existing}，不能改成 ${input.agentId}`);
  }
  const next = new Map(input.bindings);
  next.set(input.sessionId, input.agentId);
  return next;
}

export async function saveSessionBindings(dataDir: string, bindings: ReadonlyMap<string, string>): Promise<void> {
  const body = JSON.stringify([...bindings].map(([sessionId, agentId]) => ({ sessionId, agentId })));
  await writeFileAtomic(path.join(dataDir, "runtime", "session-bindings.json"), body);
}

export async function loadSessionBindings(dataDir: string): Promise<Map<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(dataDir, "runtime", "session-bindings.json"), "utf8"));
    if (!Array.isArray(parsed)) throw new SoulProfileError("会话绑定文件损坏");
    const bindings = new Map<string, string>();
    for (const item of parsed) {
      if (!isBinding(item)) throw new SoulProfileError("会话绑定文件损坏");
      bindings.set(item.sessionId, item.agentId);
    }
    return bindings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    if (error instanceof SoulProfileError) throw error;
    throw new SoulProfileError("会话绑定文件损坏");
  }
}

function isBinding(value: unknown): value is SessionBinding {
  return typeof value === "object" && value !== null && "sessionId" in value && "agentId" in value
    && typeof value.sessionId === "string" && typeof value.agentId === "string";
}

export function resolveBinding(bindings: ReadonlyMap<string, string>, sessionId: string): string {
  const agentId = bindings.get(sessionId);
  if (agentId === undefined) throw new SoulProfileError(`会话没有档案绑定: ${sessionId}`);
  return agentId;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}
