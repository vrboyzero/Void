import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { authorityProfileOf } from "./authority.js";
import type { SoulRecord } from "./registry.js";

/**
 * 引用检查（19.1：停用/删除之前先看清「还有谁在用它」）。
 *
 * 三处引用都能从数据根上读出来，来源分得很清楚：
 * - **会话绑定**：`runtime/session-bindings.json`，谁绑了这份档案；
 * - **军团**：`legion/teams/*.json`，哪支队伍把它排进了 lane、或把它当管理者；
 * - **组织图**：别的档案在 front matter 里把它写成上级/下级（关系引用的是稳定 id）。
 *
 * 为什么灵魂包自己读军团那几个文件、而不调军团的读法：`@void/void-legion` 依赖
 * `@void/void-soul`（成员身份走 `voidAuthority`），反过来引用就成环了。所以这里只**只读**
 * 它需要的两个字段（`members[].agentId`、`managerAgentId`），格式不认、文件坏了都只是
 * 「这一处读不了」，报出来给人看——**绝不猜、也绝不因此让面板打不开**。
 */
export const LEGION_TEAMS_DIRECTORY = path.join("legion", "teams");

/** 军团里的一处引用。 */
export interface TeamReference {
  teamId: string;
  /** `member`＝排进了某个 lane；`manager`＝队伍的 `managerAgentId`。 */
  kind: "member" | "manager";
  /** 成员才有 lane，管理者没有。 */
  laneId: string | null;
  role: string | null;
}

/** 读不了的队伍文件。**不当成「没有引用」**：宁可说读不了，也不给人一个假的「没人用它」。 */
export interface UnreadableTeamFile {
  /** 相对数据根的路径，人能照着去查。 */
  file: string;
  reason: string;
  /** 底层报错原文，方便排查；没有就省略。 */
  detail?: string;
}

export interface ProfileReferences {
  /** 绑定了这份档案的会话（排序）。 */
  sessions: readonly string[];
  teams: readonly TeamReference[];
  unreadableTeams: readonly UnreadableTeamFile[];
  /** 把它写进 `subordinates`、或在 `superiors` 里点名它的那些档案（＝它的上级）。 */
  superiors: readonly string[];
  /** 把它写进 `superiors`、或在 `subordinates` 里点名它的那些档案（＝它的下级）。 */
  subordinates: readonly string[];
}

/** 注册表与绑定表由调用方给：一次面板详情要问好几个问题，不该各读一遍磁盘。 */
export async function loadProfileReferences(input: {
  dataDir: string;
  record: SoulRecord;
  records: ReadonlyMap<string, SoulRecord>;
  bindings: ReadonlyMap<string, string>;
}): Promise<ProfileReferences> {
  const agentId = input.record.id;
  const { superiors, subordinates } = reverseAuthorityOf(input.records, agentId);
  const { teams, unreadable } = await scanTeams(input.dataDir, agentId);
  return {
    sessions: [...input.bindings].filter(([, bound]) => bound === agentId).map(([sessionId]) => sessionId).sort(),
    teams,
    unreadableTeams: unreadable,
    superiors,
    subordinates,
  };
}

/** 别人写的关系也算引用：组织图允许任意一边声明，两处都要认。 */
function reverseAuthorityOf(records: ReadonlyMap<string, SoulRecord>, agentId: string): { superiors: string[]; subordinates: string[] } {
  const superiors = new Set<string>();
  const subordinates = new Set<string>();
  for (const other of records.values()) {
    if (other.id === agentId) continue;
    const profile = authorityProfileOf(other);
    if (profile.superiors.includes(agentId)) subordinates.add(other.id);
    if (profile.subordinates.includes(agentId)) superiors.add(other.id);
  }
  return { superiors: [...superiors].sort(), subordinates: [...subordinates].sort() };
}

/**
 * 队伍目录走一遍，引用与「读不了」分两个篮子装：坏文件要单独报出来，混进引用表里
 * 就分不清「没人用它」和「没读出来」了。
 */
async function scanTeams(dataDir: string, agentId: string): Promise<{ teams: TeamReference[]; unreadable: UnreadableTeamFile[] }> {
  const teams: TeamReference[] = [];
  const unreadable: UnreadableTeamFile[] = [];
  for (const file of await teamFiles(dataDir)) {
    const document = await readTeamDocument(dataDir, file);
    if (document.kind === "unreadable") {
      unreadable.push(document.problem);
      continue;
    }
    teams.push(...teamReferencesOf(document.value, agentId, file));
  }
  return { teams, unreadable };
}

/** 扫一遍队伍目录。整个目录不在＝这个数据根还没有军团，不是错误。 */
async function teamFiles(dataDir: string): Promise<string[]> {
  try {
    const names = await readdir(path.join(dataDir, LEGION_TEAMS_DIRECTORY));
    return names.filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

type TeamDocument = { kind: "team"; value: Record<string, unknown> } | { kind: "unreadable"; problem: UnreadableTeamFile };

/** 读一个队伍文件：读不动、不是 JSON、顶层不是对象，三种都只回「这一处读不了」。 */
async function readTeamDocument(dataDir: string, file: string): Promise<TeamDocument> {
  const relative = path.join(LEGION_TEAMS_DIRECTORY, file);
  let raw: string;
  try {
    raw = await readFile(path.join(dataDir, relative), "utf8");
  } catch (error) {
    return { kind: "unreadable", problem: { file: relative, reason: "文件读不动", detail: messageOf(error) } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { kind: "unreadable", problem: { file: relative, reason: "不是能读的 JSON", detail: messageOf(error) } };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "unreadable", problem: { file: relative, reason: "顶层不是一支队伍" } };
  }
  return { kind: "team", value: parsed as Record<string, unknown> };
}

function teamReferencesOf(document: Record<string, unknown>, agentId: string, file: string): TeamReference[] {
  const teamId = typeof document.id === "string" && document.id.trim() !== "" ? document.id : path.basename(file, ".json");
  const references: TeamReference[] = [];
  if (Array.isArray(document.members)) {
    for (const entry of document.members) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const member = entry as Record<string, unknown>;
      if (member.agentId !== agentId) continue;
      references.push({
        teamId,
        kind: "member",
        laneId: typeof member.laneId === "string" ? member.laneId : null,
        role: typeof member.role === "string" ? member.role : null,
      });
    }
  }
  if (document.managerAgentId === agentId) references.push({ teamId, kind: "manager", laneId: null, role: null });
  return references;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
