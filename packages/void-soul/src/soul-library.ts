/**
 * 灵魂档案与模组库的读写（**可信人类管理入口**用，不给模型工具）。
 *
 * 这里是 §16.1「灵魂卡片/详情」「模组库详情」两个视图的数据来源。三条边界写死在这里：
 *
 * 1. **显示名、头像与底线正文可改**（13.1 推荐口径 / 19.2 与 2026-09-22 定案）。主人、上下级
 *    不在这个入口的可写面里——`saveProfileDisplayFields` 只认前两个键，别的键进不来。
 *    正文走单独一条路（`saveProfileBody`）：**每次改之前先把旧版整份留痕**，能看、能回滚。
 * 2. **改文件先算内容哈希当修订**。文件没有自增修订号，读到的哈希就是「我开始编辑时
 *    的那一版」；保存时对不上就拒绝，让人重读（与队伍配置同一套栅）。
 * 3. **写盘前先按读的规则解析一遍**。写进去一个自己读不回来的档案，比拒绝保存糟得多：
 *    下次进模型才会炸，而且看不出是谁写坏的。
 *
 * @module @void/void-soul/src/soul-library
 */
import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readdir, rename, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./atomic-file.js";
import { assertPromptRenderable, PROMPT_VARIABLES } from "./facet.js";
import { loadFacetFiles, loadSavedFacetView, saveFacetSelection, saveFirstMeetingState, saveProfileSuspension } from "./facet-store.js";
import { DEFAULT_PROMPT_MAX_CHARACTERS } from "./plugin.js";
import { SoulProfileError, parseSoulDocument, resolveAgentDirectory } from "./profile.js";
import { LEGION_TEAMS_DIRECTORY, loadProfileReferences, type ProfileReferences } from "./references.js";
import { bindSession, loadSessionBindings, loadSoulRegistry, saveSessionBindings, type SoulRecord } from "./registry.js";
import { readUtf8TextFile } from "./text-file.js";

/**
 * 人类入口允许改的档案字段。别的字段一律「不开放编辑」，而不是悄悄接受。
 * 底线正文不在这张表里：它走 `saveProfileBody` 那条**带留痕**的路，不跟显示名混在一次改动里。
 */
export const EDITABLE_PROFILE_KEYS = ["name", "avatar"] as const;

/** 人类入口允许改的模组字段：显示名、简介、正文。id 不许改（那是文件身份）。 */
export const EDITABLE_FACET_KEYS = ["name", "summary", "body"] as const;

/** 回收站：删掉的档案搬进 `<数据根>/trash/`，搬而不是抹，人还能自己捞回来。 */
export const TRASH_DIRECTORY_NAME = "trash";

/** 删除留痕：一行一次删除，记清谁在什么时候把哪份档案搬去了哪、什么留在了原地。 */
export const DELETION_LOG_FILE = "deletions.jsonl";

/** 数据根里放运行状态的那一层（会话绑定也在这里）。 */
export const RUNTIME_DIRECTORY_NAME = "runtime";

/** 停用/启用留痕：一行一次状态切换，落在 `<数据根>/runtime/suspensions.jsonl`。 */
export const SUSPENSION_LOG_FILE = "suspensions.jsonl";

export interface ProfileSummary {
  id: string;
  name: string;
  summary: string;
  avatar?: string;
  owner?: string;
  directoryName: string;
  /** 文件内容哈希（前 16 位）。文件没有自增修订号，这一版就是它。 */
  revision: string;
  authorityEnabled: boolean;
  superiors: readonly string[];
  subordinates: readonly string[];
  boundSessions: readonly string[];
  facetId: string | null;
  facetName: string | null;
  selectionRevision: number;
  /** 首次见面引导：档案 front matter 里的一行。没写就是 null——见面时不加任何东西。 */
  firstMeeting: string | null;
  /** 引导做完没有。状态在 `state.json` 里，既不改文件哈希，也不动选择修订。 */
  firstMeetingDone: boolean;
  /**
   * 这份档案是不是停用了（14.1 / 19.1 的「停用」）。停用只改 `state.json` 里的一个布尔值：
   * 绑定它的会话进模型会被拒绝、军团不会拿它派活，别处一个字节都不动，随时能启用回来。
   */
  suspended: boolean;
}

/** 删一份档案的结果：搬走了什么、搬去哪了、什么留在了原地。路径都是相对数据根的。 */
export interface ProfileDeletion {
  profileId: string;
  name: string;
  directoryName: string;
  /** 档案目录，形如 `agents/小贝`。 */
  archiveDirectory: string;
  /** 记忆所在的目录，形如 `agents/xiaobei`——按**档案 id** 走，与档案目录可能不是同一个。 */
  memoryDirectory: string;
  /** 回收站里的那一个目录，形如 `trash/2026-09-23T22-07-04-147Z-小贝`。 */
  movedTo: string;
  /** 搬走的条目（只有档案自己的文件）。 */
  moved: readonly string[];
  /** 目录里剩下的东西：有它就说明目录没被删掉（记忆通常就在这里）。 */
  leftBehind: readonly string[];
  /** 档案目录空了、顺手删掉了没有。 */
  removedDirectory: boolean;
  /** 还绑着这份档案的会话：绑定留着不动，重新建一份同 id 的档案就能接回来。 */
  boundSessions: readonly string[];
  at: string;
}

/** 停用/启用留痕的一条：什么时候把哪份档案切成了什么状态。 */
export interface SuspensionEntry {
  profileId: string;
  name: string;
  directoryName: string;
  /** `true`＝停用，`false`＝启用。 */
  suspended: boolean;
  at: string;
  note?: string;
}

/**
 * 停用/启用的结果：状态切成了什么、还有谁在引用它、真要删会涉及哪些地方。
 *
 * 「引用检查」与「回收范围预览」跟着这一次动作一起交回去，是因为**停用本来就是删除前的
 * 一步**（19.1：停用 + 引用检查 + 预览回收范围，不做一键递归）：人要在这个位置就能看清
 * 「还有谁在用它」，而不是等删完才发现军团里少了个成员。
 */
export interface ProfileSuspension {
  profileId: string;
  name: string;
  suspended: boolean;
  at: string;
  /** 状态写在哪：档案目录里的 `state.json`（相对数据根的路径）。 */
  stateFile: string;
  /** 引用检查：还绑着它的会话、用到它的队伍、组织图里提到它的档案。 */
  references: ProfileReferences;
  /** 真要删的时候会涉及哪些地方（**只是预览**，停用一个字节都不删）。 */
  reclaimScope: readonly ReclaimScopeEntry[];
  /** 留痕文件（相对数据根）。 */
  logFile: string;
}

/** 回收范围预览里的一处：哪个路径、是什么、真删的时候怎么处理。 */
export interface ReclaimScopeEntry {
  /** 相对数据根的路径；不在数据根里的（聊天记录）照实写明。 */
  path: string;
  what: string;
  /** `move`＝搬进回收站；`keep`＝一个字节都不动；`append`＝只追加一行留痕。 */
  action: "move" | "keep" | "append";
}

/** 停用或删除之前该先看清的两件事：还有谁在用它，真动手会涉及哪些地方。 */
export interface ProfileInspection {
  references: ProfileReferences;
  reclaimScope: readonly ReclaimScopeEntry[];
}

export interface FacetSummary {
  id: string;
  name: string;
  summary: string;
  revision: string;
  /** 当前把这份模组选成角色的档案 id。 */
  usedBy: readonly string[];
}

export interface FacetDetail extends FacetSummary {
  /** 正文（front matter 之后的部分）。 */
  body: string;
  /** 整个文件的原文，按安全文本预览。 */
  markdown: string;
}

export interface SessionBindingSummary {
  sessionId: string;
  profileId: string;
}

/** 底线正文留痕的目录名（档案目录里的一层）与日志文件名。日志是追加写的 JSONL，一行一条。 */
export const SOUL_HISTORY_DIRECTORY_NAME = "history";
export const SOUL_HISTORY_LOG_FILE = "soul-log.jsonl";

/**
 * **档案自己的文件**：删档案只搬这三样。
 *
 * 目录里别的东西一律不碰——尤其是记忆（`agents/<档案 id>/` 下的 `MEMORY.md`、`memory/`、
 * `memory.sqlite`、`retracted/`）。档案目录名与档案 id 可以不是同一个目录，但也可以**正好
 * 是同一个**：那种情况下整目录搬走就等于顺手删了记忆，所以这里逐样搬，最后只在目录空了
 * 才 `rmdir`（2026-09-22 定案：删档案不删记忆、不删聊天记录）。
 */
export const ARCHIVE_ENTRY_NAMES = ["SOUL.md", "state.json", SOUL_HISTORY_DIRECTORY_NAME] as const;

/**
 * 底线正文的一版留痕。`revision` 是**被替换掉**的那一版整份文件的修订（16 位内容哈希），
 * 回滚就是照这个值去 `history/SOUL-<revision>.md` 取回原文。
 */
export interface SoulBodyHistoryEntry {
  revision: string;
  /** ISO 时间字符串。 */
  at: string;
  action: "save" | "restore";
  /** 被替换掉那一版的正文字节数（UTF-8）。 */
  bytes: number;
  /** 换上去以后成了哪一版（整份文件的修订）。 */
  nextRevision: string;
  /** 回滚时：正文取自哪一版。 */
  sourceRevision?: string;
  /** 人写的一句原因（可空）。 */
  note?: string;
}

/** 底线正文视图：当前正文、修订、字节数，加上留痕（最新在前）。 */
export interface ProfileBodyView {
  profileId: string;
  revision: string;
  body: string;
  bytes: number;
  history: readonly SoulBodyHistoryEntry[];
}

/** 内容哈希当修订：同一份文件内容一定得到同一个值，改一个字符就变。 */
export function revisionOf(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 16);
}

/** 每个档案一份只读卡片：身份、主人、权限、绑定会话、当前角色与修订。 */
export async function loadProfileSummaries(dataDir: string): Promise<ProfileSummary[]> {
  const registry = await loadSoulRegistry(dataDir);
  const bindings = await loadSessionBindings(dataDir);
  const summaries: ProfileSummary[] = [];
  for (const record of registry.values()) {
    summaries.push(await summarizeProfile(dataDir, record, bindings));
  }
  return summaries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id));
}

async function summarizeProfile(dataDir: string, record: SoulRecord, bindings: ReadonlyMap<string, string>): Promise<ProfileSummary> {
  const raw = await readUtf8TextFile(record.soulPath, "档案 SOUL.md");
  const view = await loadSavedFacetView(dataDir, record);
  const { frontMatter } = record;
  return {
    id: frontMatter.id,
    name: frontMatter.name,
    summary: frontMatter.summary,
    ...(frontMatter.avatar === undefined ? {} : { avatar: frontMatter.avatar }),
    ...(frontMatter.owner === undefined ? {} : { owner: frontMatter.owner }),
    directoryName: record.directoryName,
    revision: revisionOf(raw),
    authorityEnabled: frontMatter.authority?.enabled ?? false,
    superiors: frontMatter.authority?.superiors ?? [],
    subordinates: frontMatter.authority?.subordinates ?? [],
    boundSessions: [...bindings].filter(([, agentId]) => agentId === record.id).map(([sessionId]) => sessionId).sort(),
    facetId: view.saved.facetId,
    facetName: view.saved.name,
    selectionRevision: view.saved.selectionRevision,
    firstMeeting: frontMatter.firstMeeting ?? null,
    firstMeetingDone: view.firstMeetingDone,
    suspended: view.suspended,
  };
}

/** 模组库列表：id 排序，带上「谁在用」。 */
export async function loadFacetSummaries(dataDir: string): Promise<FacetSummary[]> {
  const files = await loadFacetFiles(dataDir);
  const registry = await loadSoulRegistry(dataDir);
  const usedBy = new Map<string, string[]>();
  for (const record of registry.values()) {
    const view = await loadSavedFacetView(dataDir, record);
    if (view.saved.facetId === null) continue;
    usedBy.set(view.saved.facetId, [...(usedBy.get(view.saved.facetId) ?? []), record.id]);
  }
  return [...files.values()]
    .map((entry) => ({
      id: entry.card.id,
      name: entry.card.frontMatter.name,
      summary: entry.card.frontMatter.summary,
      revision: revisionOf(entry.raw),
      usedBy: (usedBy.get(entry.card.id) ?? []).sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function loadFacetDetail(dataDir: string, facetId: string): Promise<FacetDetail> {
  const entry = await requireFacetFile(dataDir, facetId);
  const summaries = await loadFacetSummaries(dataDir);
  const summary = summaries.find((item) => item.id === facetId);
  return {
    id: entry.card.id,
    name: entry.card.frontMatter.name,
    summary: entry.card.frontMatter.summary,
    revision: revisionOf(entry.raw),
    usedBy: summary?.usedBy ?? [],
    body: entry.card.body,
    markdown: entry.raw,
  };
}

export async function loadBindings(dataDir: string): Promise<SessionBindingSummary[]> {
  const bindings = await loadSessionBindings(dataDir);
  return [...bindings]
    .map(([sessionId, profileId]) => ({ sessionId, profileId }))
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

/**
 * 改显示名 / 头像。只认这两个键；空值表示清掉（头像可以没有，显示名不行）。
 *
 * 修订对不上就拒绝：文件是别的入口也在维护的，硬覆盖等于把别人刚写的改动吃掉。
 */
export async function saveProfileDisplayFields(dataDir: string, input: {
  profileId: string;
  changes: Readonly<Record<string, unknown>>;
  expectedRevision: string;
}): Promise<ProfileSummary> {
  const unknown = Object.keys(input.changes).filter((key) => !(EDITABLE_PROFILE_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) throw new SoulProfileError(`灵魂档案只允许改显示名与头像: ${unknown.join("、")}`);
  if (Object.keys(input.changes).length === 0) throw new SoulProfileError("没有要保存的改动");
  const registry = await loadSoulRegistry(dataDir);
  const record = registry.get(input.profileId);
  if (!record) throw new SoulProfileError(`没有这份档案: ${input.profileId}`);
  const raw = await readUtf8TextFile(record.soulPath, "档案 SOUL.md");
  assertRevision("档案", input.expectedRevision, revisionOf(raw));
  const scalars: Record<string, string | undefined> = {};
  if ("name" in input.changes) {
    const name = scalarText(input.changes.name, "显示名");
    if (name === undefined) throw new SoulProfileError("显示名不能为空");
    scalars.name = name;
  }
  if ("avatar" in input.changes) scalars.avatar = scalarText(input.changes.avatar, "头像");
  const next = rewriteSoulFile(raw, { scalars });
  parseSoulDocument(next);
  await writeAtomic(record.soulPath, next);
  // 重新读一遍再回卡片：手里这份是改之前的解析结果，拿它回话会把旧名字当成新值。
  return refreshProfile(dataDir, input.profileId);
}

/**
 * 改底线正文。**这是可信人类入口，不给模型工具**（16.1 / 19.2）。
 *
 * 三条边界：
 * 1. **只换正文**：front matter（id、显示名、主人、权限、首次见面引导）原样保留——
 *    `rewriteSoulFile` 只接 `body`，别的一行都不动。
 * 2. **改之前先留痕**：旧版整份存进 `history/SOUL-<修订>.md`，再往 `soul-log.jsonl` 追加一行。
 *    顺序是先留痕后写正文：反过来一旦写正文失败，旧内容就找不回来了。
 * 3. **空正文与超预算都在这里拦**：没有底线的档案取不出派活身份（`persona.ts`），
 *    而超预算的正文要到下次进模型才炸，那时看不出是谁写坏的。
 */
export async function saveProfileBody(dataDir: string, input: {
  profileId: string;
  body: string;
  expectedRevision: string;
  note?: unknown;
}): Promise<ProfileSummary> {
  const record = await requireProfile(dataDir, input.profileId);
  const raw = await readUtf8TextFile(record.soulPath, "档案 SOUL.md");
  assertRevision("档案", input.expectedRevision, revisionOf(raw));
  const body = requireSoulBody(input.body, "底线正文");
  assertSoulBodyWithinBudget(body);
  const next = rewriteSoulFile(raw, { body });
  parseSoulDocument(next);
  await archiveSoulVersion(record, raw, { action: "save", nextRevision: revisionOf(next), note: scalarText(input.note, "留痕备注") });
  await writeAtomic(record.soulPath, next);
  return refreshProfile(dataDir, input.profileId);
}

/** 读底线正文与它的留痕（最新在前）。留痕坏了要报出来，不能当成「没有历史」——回滚就靠它。 */
export async function loadProfileBody(dataDir: string, profileId: string): Promise<ProfileBodyView> {
  const record = await requireProfile(dataDir, profileId);
  const raw = await readUtf8TextFile(record.soulPath, "档案 SOUL.md");
  const body = parseSoulDocument(raw).body;
  return {
    profileId,
    revision: revisionOf(raw),
    body,
    bytes: Buffer.byteLength(body, "utf8"),
    history: await loadSoulHistory(record),
  };
}

/**
 * 把底线正文回滚到留痕里的某一版。**回滚本身也留痕**：被换掉的那一版照样进 `history/`，
 * 所以来回滚不会把任何一版弄丢，滚回去再滚回来都行。
 */
export async function restoreProfileBody(dataDir: string, input: {
  profileId: string;
  revision: unknown;
  expectedRevision: string;
  note?: unknown;
}): Promise<ProfileSummary> {
  const record = await requireProfile(dataDir, input.profileId);
  const raw = await readUtf8TextFile(record.soulPath, "档案 SOUL.md");
  assertRevision("档案", input.expectedRevision, revisionOf(raw));
  const target = typeof input.revision === "string" ? input.revision.trim() : "";
  if (target === "") throw new SoulProfileError("回滚要指明回滚到哪一版：给留痕里的修订");
  const archived = await readUtf8TextFile(soulHistoryPath(record, target), `底线正文留痕那一版（${target}）`).catch((error: unknown) => {
    if (isMissing(error)) throw new SoulProfileError(`留痕里没有这一版: ${target}（能回滚的版本看 ${SOUL_HISTORY_DIRECTORY_NAME}/ 目录与 ${SOUL_HISTORY_LOG_FILE}）`);
    throw error;
  });
  const body = requireSoulBody(parseSoulDocument(archived).body, `留痕那一版（${target}）的正文`);
  assertSoulBodyWithinBudget(body);
  const next = rewriteSoulFile(raw, { body });
  parseSoulDocument(next);
  await archiveSoulVersion(record, raw, {
    action: "restore",
    nextRevision: revisionOf(next),
    sourceRevision: target,
    note: scalarText(input.note, "留痕备注"),
  });
  await writeAtomic(record.soulPath, next);
  return refreshProfile(dataDir, input.profileId);
}

/**
 * 标「首次见面引导做完了」，或者让它再来一遍。
 *
 * **只写 `state.json`**，档案正文一个字节都不动：引导文字是人在 SOUL.md 的 front matter 里
 * 写的（`firstMeeting:`），这个入口根本没有改它的路径——§12「不能让引导工具随意改底线」。
 * 交回去的正文是这里刚读的那一份，等于声明「这次不改底线」；真顺着这个入口送改过的正文
 * 会被 `saveFirstMeetingState` 拦下。
 */
export async function setFirstMeetingDone(dataDir: string, input: { profileId: string; done: boolean }): Promise<ProfileSummary> {
  const registry = await loadSoulRegistry(dataDir);
  const record = registry.get(input.profileId);
  if (!record) throw new SoulProfileError(`没有这份档案: ${input.profileId}`);
  await saveFirstMeetingState({ dataDir, record, done: input.done, soulBody: record.body });
  return refreshProfile(dataDir, input.profileId);
}

/**
 * 停用或启用一份档案（19.1：停用 + 引用检查 + 预览回收范围，不做一键递归）。
 *
 * **只写 `state.json` 里的一个布尔值**，别处一个字节都不动：`SOUL.md`、记忆、聊天记录、会话
 * 绑定全留在原地。停用之后绑定它的会话进模型会被拒绝（理由写进通知栏「灵魂未生效」），军团
 * 也不会拿它派活；启用回来时同一个会话下一轮装配就自愈，不用换会话、也不用重启宿主。
 *
 * 交回去的不只是新状态，还有引用检查与回收范围预览——停用本来就是「准备删」的落脚点，
 * 人要在这个位置就看清楚「还有谁在用它」，而不是等删完才发现军团里少了个成员。
 */
export async function setProfileSuspended(dataDir: string, input: {
  profileId: string;
  suspended: boolean;
  note?: string | undefined;
}): Promise<ProfileSuspension> {
  const registry = await loadSoulRegistry(dataDir);
  const record = registry.get(input.profileId);
  if (!record) throw new SoulProfileError(`没有这份档案: ${input.profileId}`);
  const note = scalarText(input.note, "留痕备注");
  const view = await saveProfileSuspension({ dataDir, record, suspended: input.suspended });
  const references = await referencesOf(dataDir, record, registry);
  const entry: SuspensionEntry = {
    profileId: record.id,
    name: record.frontMatter.name,
    directoryName: record.directoryName,
    // 记结果，不记请求：状态文件里现在是什么，留痕里就是什么。
    suspended: view.suspended,
    at: new Date().toISOString(),
    ...(note === undefined ? {} : { note }),
  };
  await appendSuspensionLog(dataDir, entry);
  return {
    profileId: record.id,
    name: record.frontMatter.name,
    suspended: view.suspended,
    at: entry.at,
    stateFile: path.join("agents", record.directoryName, "state.json"),
    references,
    reclaimScope: reclaimScopeOf({ record, references }),
    logFile: path.join(RUNTIME_DIRECTORY_NAME, SUSPENSION_LOG_FILE),
  };
}

/**
 * 读停用/启用留痕（最新在前，只看这一份档案）。坏行要报出来，不能当成「没有记录」——
 * 「谁在什么时候把它关了」就靠这份日志回答。
 */
export async function loadSuspensionHistory(dataDir: string, profileId: string, limit = 5): Promise<SuspensionEntry[]> {
  const file = path.join(dataDir, RUNTIME_DIRECTORY_NAME, SUSPENSION_LOG_FILE);
  const raw = await readUtf8TextFile(file, "停用留痕日志").catch((error: unknown) => {
    if (isMissing(error)) return "";
    throw error;
  });
  const entries: SuspensionEntry[] = [];
  let lineNumber = 0;
  for (const line of raw.split("\n")) {
    lineNumber += 1;
    const text = line.trim();
    if (text === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SoulProfileError(`停用留痕坏了：${RUNTIME_DIRECTORY_NAME}/${SUSPENSION_LOG_FILE} 第 ${lineNumber} 行不是 JSON，没法据此回看`);
    }
    const entry = suspensionEntryOf(parsed);
    if (entry === undefined) {
      throw new SoulProfileError(`停用留痕坏了：${RUNTIME_DIRECTORY_NAME}/${SUSPENSION_LOG_FILE} 第 ${lineNumber} 行缺字段，没法据此回看`);
    }
    if (entry.profileId === profileId) entries.push(entry);
  }
  return entries.reverse().slice(0, limit);
}

/**
 * 引用检查 + 回收范围预览（19.1 的「引用检查 + 预览回收范围」）。**只读**，一个字节都不改：
 * 停用之前要看一眼，删除之前更该看一眼。坏了的地方照实报出来，不猜。
 */
export async function inspectProfile(dataDir: string, profileId: string): Promise<ProfileInspection> {
  const registry = await loadSoulRegistry(dataDir);
  const record = registry.get(profileId);
  if (!record) throw new SoulProfileError(`没有这份档案: ${profileId}`);
  const references = await referencesOf(dataDir, record, registry);
  return { references, reclaimScope: reclaimScopeOf({ record, references }) };
}

/**
 * 真要删这份档案时涉及的地方（19.1「预览回收范围」）。**只是预览**：停用一个字节都不删。
 *
 * 与 `deleteProfile` 的实际行为必须一致：搬的只有档案自己的三样，记忆、聊天记录、会话绑定与
 * 队伍引用一律留在原地，另加一行删除留痕。档案目录名与档案 id 相同时（记忆就在档案目录里），
 * 目录本身也不会被删——预览要照实说，不能让人以为「删档案＝连目录一起端走」。
 */
export function reclaimScopeOf(input: { record: SoulRecord; references: ProfileReferences }): ReclaimScopeEntry[] {
  const { record } = input;
  const archiveDirectory = path.join("agents", record.directoryName);
  const memoryDirectory = path.join("agents", record.id);
  const sameDirectory = record.directoryName === record.id;
  const archiveEntries: ReclaimScopeEntry[] = [
    { path: path.join(archiveDirectory, "SOUL.md"), what: "底线正文（档案自己的文件）", action: "move" },
    { path: path.join(archiveDirectory, "state.json"), what: "停用位、角色选择与引导状态", action: "move" },
    { path: path.join(archiveDirectory, SOUL_HISTORY_DIRECTORY_NAME), what: "底线正文留痕（整份存档与 soul-log.jsonl）", action: "move" },
  ];
  // 目录名与档案 id 相同时，档案目录本身就是记忆目录：不写两条同名路径，把「目录留着」与
  // 「记忆不动」并成一条说清，免得面板上同一行路径出现两遍。
  const memoryEntries: ReclaimScopeEntry[] = sameDirectory
    ? [{ path: archiveDirectory, what: "记忆与档案目录是同一层：MEMORY.md、memory/、memory.sqlite、retracted/ 与目录本身都不动，只搬上面三样", action: "keep" }]
    : [
        { path: archiveDirectory, what: "档案目录本身（搬空之后才删）", action: "move" },
        { path: memoryDirectory, what: "记忆：MEMORY.md、memory/、memory.sqlite、retracted/", action: "keep" },
      ];
  return [
    ...archiveEntries,
    ...memoryEntries,
    { path: "sessions/（在 DSH_HOME 下，不在数据根里）", what: "聊天记录：这个插件既不复制也不清除", action: "keep" },
    {
      path: path.join(RUNTIME_DIRECTORY_NAME, "session-bindings.json"),
      what: `会话绑定（${input.references.sessions.length} 条）：留着不动，重建同 id 的档案就接回来`,
      action: "keep",
    },
    {
      path: LEGION_TEAMS_DIRECTORY,
      what: `军团队伍里的 ${input.references.teams.length} 处引用：留着不动（但队伍会派不出活）`,
      action: "keep",
    },
    { path: path.join(TRASH_DIRECTORY_NAME, DELETION_LOG_FILE), what: "删除留痕：追加一行", action: "append" },
  ];
}

/**
 * 新建一份档案。目录名只是位置，id 才是身份；两者都要显式给，不替人猜。
 *
 * 写完立刻按读的规则解析一遍，并重新扫一遍注册表——重复 id、越界目录都会在这里被挡下。
 */
export async function createProfile(dataDir: string, input: {
  id: string;
  directoryName: string;
  name: string;
  summary: string;
  owner?: string;
  avatar?: string;
}): Promise<ProfileSummary> {
  const directory = resolveAgentDirectory(dataDir, input.directoryName);
  const registry = await loadSoulRegistry(dataDir);
  if (registry.has(input.id)) throw new SoulProfileError(`档案 id 已经被占用: ${input.id}`);
  if (await exists(directory)) throw new SoulProfileError(`Agent 目录已经被占用: ${input.directoryName}`);
  const id = scalarText(input.id, "档案 id");
  const name = scalarText(input.name, "显示名");
  const summary = scalarText(input.summary, "简介");
  if (id === undefined || name === undefined || summary === undefined) throw new SoulProfileError("档案 id、显示名与简介都是必填");
  const owner = scalarText(input.owner, "主人 UUID");
  const avatar = scalarText(input.avatar, "头像");
  const markdown = [
    "---",
    `id: ${id}`,
    `name: ${name}`,
    `summary: ${summary}`,
    ...(avatar === undefined ? [] : [`avatar: ${avatar}`]),
    ...(owner === undefined ? [] : [`owner: ${owner}`]),
    "---",
    "",
    `（${name} 的身份说明还没有写：底线、禁忌、价值观与权限规则写在这里。）`,
    "",
  ].join("\n");
  parseSoulDocument(markdown);
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory);
  await writeFile(path.join(directory, "SOUL.md"), markdown, "utf8");
  const created = (await loadSoulRegistry(dataDir)).get(id);
  if (!created) throw new SoulProfileError(`新建的档案没有进注册表: ${id}`);
  return summarizeProfile(dataDir, created, await loadSessionBindings(dataDir));
}

/**
 * 删一份档案：把**档案自己的文件**（`SOUL.md`、`state.json`、`history/`）搬进回收站，
 * 其余一律不动（2026-09-22 定案：删档案不删记忆、不删聊天记录）。
 *
 * 三条边界：
 *
 * 1. **搬，不抹**。目标目录是 `<数据根>/trash/<时间戳>-<目录名>/`，人自己就能把文件搬回去。
 *    每次删除往 `trash/deletions.jsonl` 追加一行留痕，写清搬走了什么、什么留在了原地。
 * 2. **绝不整目录搬走**。记忆住在 `agents/<档案 id>/`，档案住在 `agents/<目录名>/`；两者可以
 *    正好是同一个目录。逐样搬 + 只在目录空了才 `rmdir`，两种情况都不会碰到记忆。
 * 3. **链接不跟**。档案目录本身是链接（Windows 上的 junction 也算）就拒绝——删档案不该跟着
 *    链接把库外的东西搬走。读注册表那一步其实已经拒过链接目录，这里在真正下手的这一刻再查
 *    一次：从读到删之间目录可能被换成链接。绑定关系也留着：那些会话取不到身份会拒绝进模型，
 *    而重新建一份同 id 的档案就能接回来（记忆本来就按 id 存着）。
 */
export async function deleteProfile(dataDir: string, input: {
  profileId: string;
  expectedRevision?: string;
  note?: string | undefined;
}): Promise<ProfileDeletion> {
  const record = await requireProfile(dataDir, input.profileId);
  const raw = await readUtf8TextFile(record.soulPath, "档案 SOUL.md");
  if (input.expectedRevision !== undefined) assertRevision("档案", input.expectedRevision, revisionOf(raw));
  const archiveDirectory = path.dirname(record.soulPath);
  const agentsRoot = path.resolve(dataDir, "agents");
  if (path.dirname(archiveDirectory) !== agentsRoot) {
    throw new SoulProfileError(`档案目录不在 agents 下，拒绝删除: ${archiveDirectory}`);
  }
  // 注册表已经拒过链接目录；这里是「从读到删」之间的兜底，别把它当成主门禁。
  if ((await lstat(archiveDirectory)).isSymbolicLink()) {
    throw new SoulProfileError(`档案目录是链接，拒绝删除: ${record.directoryName}（先把链接本身挪走再删）`);
  }
  const trashDir = await reserveTrashDir(path.join(dataDir, TRASH_DIRECTORY_NAME), `${stampForTrash()}-${record.directoryName}`);
  const moved: string[] = [];
  for (const name of ARCHIVE_ENTRY_NAMES) {
    const from = path.join(archiveDirectory, name);
    if (!(await exists(from))) continue;
    await moveArchiveEntry(from, path.join(trashDir, name), record, name);
    moved.push(name);
  }
  const leftBehind = (await readdir(archiveDirectory)).sort();
  let removedDirectory = false;
  if (leftBehind.length === 0) {
    // 目录空了才删：`rmdir` 对非空目录会失败，这一句同时也是「没碰记忆」的兜底。
    await rmdir(archiveDirectory);
    removedDirectory = true;
  }
  const boundSessions = [...(await loadSessionBindings(dataDir))]
    .filter(([, agentId]) => agentId === record.id)
    .map(([sessionId]) => sessionId)
    .sort();
  const deletion: ProfileDeletion = {
    profileId: record.id,
    name: record.frontMatter.name,
    directoryName: record.directoryName,
    archiveDirectory: `agents/${record.directoryName}`,
    memoryDirectory: `agents/${record.id}`,
    movedTo: `${TRASH_DIRECTORY_NAME}/${path.basename(trashDir)}`,
    moved,
    leftBehind,
    removedDirectory,
    boundSessions,
    at: new Date().toISOString(),
  };
  await appendDeletionLog(dataDir, deletion, scalarText(input.note, "删除原因"));
  return deletion;
}

/** 改模组：显示名、简介、正文。id 不许改——改 id 等于换一份模组，应该新建文件。 */
export async function saveFacetMarkdown(dataDir: string, input: {
  facetId: string;
  changes: Readonly<Record<string, unknown>>;
  expectedRevision: string;
}): Promise<FacetDetail> {
  if (input.changes.id !== undefined && input.changes.id !== input.facetId) {
    throw new SoulProfileError(`模组 id 不能改: ${input.facetId} → ${String(input.changes.id)}（要换 id 就新建一个文件）`);
  }
  const unknown = Object.keys(input.changes).filter((key) => !(EDITABLE_FACET_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) throw new SoulProfileError(`模组详情只允许改显示名、简介与正文: ${unknown.join("、")}`);
  if (Object.keys(input.changes).length === 0) throw new SoulProfileError("没有要保存的改动");
  const entry = await requireFacetFile(dataDir, input.facetId);
  assertRevision("模组", input.expectedRevision, revisionOf(entry.raw));
  const scalars: Record<string, string | undefined> = {};
  if ("name" in input.changes) {
    const name = scalarText(input.changes.name, "显示名");
    if (name === undefined) throw new SoulProfileError("显示名不能为空");
    scalars.name = name;
  }
  if ("summary" in input.changes) {
    const summary = scalarText(input.changes.summary, "简介");
    if (summary === undefined) throw new SoulProfileError("简介不能为空");
    scalars.summary = summary;
  }
  const body = "body" in input.changes ? requireText(input.changes.body, "模组正文") : undefined;
  const next = rewriteSoulFile(entry.raw, { scalars, ...(body === undefined ? {} : { body }) });
  const parsed = parseSoulDocument(next);
  if (parsed.frontMatter.id !== input.facetId) {
    throw new SoulProfileError(`模组 id 不能改: ${input.facetId} → ${parsed.frontMatter.id}（要换 id 就新建一个文件）`);
  }
  // 未知变量到下一次请求才会炸，而且表现为「说明书发不出去」。保存时就拦住。
  assertPromptRenderable(
    { soul: "", facet: parsed.body, facetId: parsed.frontMatter.id, selectionRevision: 0 },
    { variables: PROMPT_VARIABLES, maxCharacters: Number.MAX_SAFE_INTEGER },
  );
  await writeAtomic(entry.file, next);
  return loadFacetDetail(dataDir, input.facetId);
}

/** 给一个会话绑上档案。已经绑了别的档案就拒绝（改绑要先解绑，不能悄悄换人）。 */
export async function bindSessionToProfile(dataDir: string, input: { profileId: string; sessionId: string }): Promise<SessionBindingSummary[]> {
  const sessionId = scalarText(input.sessionId, "会话 id");
  if (sessionId === undefined) throw new SoulProfileError("会话 id 是必填");
  const registry = await loadSoulRegistry(dataDir);
  const bindings = await loadSessionBindings(dataDir);
  const next = bindSession({ bindings, registry, sessionId, agentId: input.profileId });
  await saveSessionBindings(dataDir, next);
  return loadBindings(dataDir);
}

/** 解绑：解错了顶多下次进模型没有身份，比悄悄改成另一个人安全。 */
export async function unbindSession(dataDir: string, sessionId: string): Promise<SessionBindingSummary[]> {
  const bindings = await loadSessionBindings(dataDir);
  const id = scalarText(sessionId, "会话 id");
  if (id === undefined || !bindings.has(id)) throw new SoulProfileError(`这个会话没有绑定档案: ${sessionId}`);
  const next = new Map(bindings);
  next.delete(id);
  await saveSessionBindings(dataDir, next);
  return loadBindings(dataDir);
}

/** 给一个档案换/清角色。不带修订就按磁盘当前值改（面板上的一次点按，不是长期编辑）。 */
export async function selectFacetForProfile(dataDir: string, input: {
  profileId: string;
  facetId: string | null;
  expectedRevision?: number;
}): Promise<{ profileId: string; facetId: string | null; name: string | null; selectionRevision: number }> {
  const registry = await loadSoulRegistry(dataDir);
  const record = registry.get(input.profileId);
  if (!record) throw new SoulProfileError(`没有这份档案: ${input.profileId}`);
  if (input.facetId !== null) await requireFacetFile(dataDir, input.facetId);
  const view = await loadSavedFacetView(dataDir, record);
  const saved = await saveFacetSelection({
    dataDir,
    record,
    facetId: input.facetId,
    expectedRevision: input.expectedRevision ?? view.saved.selectionRevision,
    soulBody: record.body,
  });
  return { profileId: record.id, facetId: saved.saved.facetId, name: saved.saved.name, selectionRevision: saved.saved.selectionRevision };
}

async function requireFacetFile(dataDir: string, facetId: string) {
  const files = await loadFacetFiles(dataDir);
  const entry = files.get(facetId);
  if (!entry) throw new SoulProfileError(`没有这个模组: ${facetId}`);
  return entry;
}

function assertRevision(label: string, expected: string, actual: string): void {
  if (expected !== actual) {
    throw new SoulProfileError(`${label}已被其他保存更新（期望修订 ${expected}，实际 ${actual}），请重读后再改`);
  }
}

/**
 * 只换顶层单行字段与正文，其余字节原样保留。
 *
 * 逐行改写而不是「解析成对象再序列化」：档案是人手写的，注释、字段顺序、缩进块都该留着，
 * 序列化一遍等于替人重写整份文件。
 */
export function rewriteSoulFile(raw: string, input: {
  scalars?: Readonly<Record<string, string | undefined>>;
  body?: string;
}): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) throw new SoulProfileError("档案缺少开头的 front matter");
  const changes = input.scalars ?? {};
  const lines = (match[1] ?? "").split(/\r?\n/);
  const out: string[] = [];
  const handled = new Set<string>();
  let nameAt = -1;
  for (const line of lines) {
    const separator = /^\s/.test(line) ? -1 : line.indexOf(":");
    const key = separator > 0 ? line.slice(0, separator).trim() : "";
    if (key !== "" && key in changes) {
      handled.add(key);
      const value = changes[key];
      if (value === undefined) continue; // 空值 = 清掉这个字段（头像）
      out.push(`${key}: ${value}`);
      if (key === "name") nameAt = out.length - 1;
      continue;
    }
    out.push(line);
    if (key === "name") nameAt = out.length - 1;
  }
  for (const [key, value] of Object.entries(changes)) {
    if (handled.has(key) || value === undefined) continue;
    if (key === "avatar") {
      out.splice(nameAt === -1 ? out.length : nameAt + 1, 0, `avatar: ${value}`);
      continue;
    }
    out.push(`${key}: ${value}`);
  }
  const body = input.body ?? raw.slice(match[0].length);
  return `---\n${out.join("\n")}\n---\n${body}`;
}

/** 字段值只收一行文本：换行会写坏 front matter，空串按「清掉」处理。 */
function scalarText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new SoulProfileError(`${label}必须是文本`);
  const text = value.trim();
  if (text === "") return undefined;
  if (/[\r\n]/.test(text)) throw new SoulProfileError(`${label}不能带换行`);
  return text;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new SoulProfileError(`${label}必须是文本`);
  return value;
}

async function writeAtomic(file: string, content: string): Promise<void> {
  await writeFileAtomic(file, content);
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(() => true, () => false);
}

/** 回收站目录名里的时间戳：ISO 里的 `:` 与 `.` 在 Windows 上是非法文件名字符，换成 `-`。 */
function stampForTrash(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** 占一个回收站目录。同一毫秒删两份同名档案也不会撞在一起：撞了就往后编号。 */
async function reserveTrashDir(root: string, name: string): Promise<string> {
  await mkdir(root, { recursive: true });
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const candidate = path.join(root, attempt === 1 ? name : `${name}-${attempt}`);
    try {
      await mkdir(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new SoulProfileError(`回收站里同名的目录太多了，换个时间再删: ${name}`);
}

/**
 * 搬一样档案文件进回收站。`rename` 不动链接指向的东西，正好是我们要的「搬走这一样」。
 *
 * 跨卷时 `rename` 会报 `EXDEV`（比如 `agents/` 是指向另一个盘的链接）。这时**不**退化成
 * 「复制再删」：搬一半失败比直接拒绝糟得多——人只会看到一份缺文件的档案。
 */
async function moveArchiveEntry(from: string, to: string, record: SoulRecord, name: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EXDEV") {
      throw new SoulProfileError(`回收站与档案不在同一个卷上，搬不动 ${name}: ${record.directoryName}（请手工把 agents/${record.directoryName} 里的 SOUL.md、state.json 与 history/ 挪走）`);
    }
    throw error;
  }
}

/** 删除留痕：追加一行，失败就报出来——删了却没有记录，比删除本身更该拦住。 */
async function appendDeletionLog(dataDir: string, deletion: ProfileDeletion, note: string | undefined): Promise<void> {
  const line = JSON.stringify(note === undefined ? deletion : { ...deletion, note });
  await appendFile(path.join(dataDir, TRASH_DIRECTORY_NAME, DELETION_LOG_FILE), `${line}\n`, "utf8");
}

/**
 * 停用/启用留痕：追加一行。状态改了却没有记录，等于「谁在什么时候把它关了」无从查起，
 * 所以这里和删除留痕一样，写不进去就报出来。
 */
async function appendSuspensionLog(dataDir: string, entry: SuspensionEntry): Promise<void> {
  const dir = path.join(dataDir, RUNTIME_DIRECTORY_NAME);
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, SUSPENSION_LOG_FILE), `${JSON.stringify(entry)}\n`, "utf8");
}

/** 档案目录里的留痕目录，以及某一版整份存档的路径。 */
function soulHistoryDir(record: SoulRecord): string {
  return path.join(path.dirname(record.soulPath), SOUL_HISTORY_DIRECTORY_NAME);
}

function soulHistoryPath(record: SoulRecord, revision: string): string {
  return path.join(soulHistoryDir(record), `SOUL-${revision}.md`);
}

/** 取档案；没有就报「没有这份档案」，与别的入口同一句话。 */
async function requireProfile(dataDir: string, profileId: string): Promise<SoulRecord> {
  const record = (await loadSoulRegistry(dataDir)).get(profileId);
  if (!record) throw new SoulProfileError(`没有这份档案: ${profileId}`);
  return record;
}

/** 重新读一遍再回卡片：手里那份是改之前的解析结果，拿它回话会把旧值当成新值。 */
async function refreshProfile(dataDir: string, profileId: string): Promise<ProfileSummary> {
  const refreshed = (await loadSoulRegistry(dataDir)).get(profileId);
  if (!refreshed) throw new SoulProfileError(`保存后档案不见了: ${profileId}`);
  return summarizeProfile(dataDir, refreshed, await loadSessionBindings(dataDir));
}

/** 注册表由调用方给（一次动作里已经读过了），绑定表在这里现读一份。 */
async function referencesOf(dataDir: string, record: SoulRecord, registry: ReadonlyMap<string, SoulRecord>): Promise<ProfileReferences> {
  return loadProfileReferences({ dataDir, record, records: registry, bindings: await loadSessionBindings(dataDir) });
}

/** 底线正文不能是空的：空底线的档案取不出派活身份（`persona.ts` 会拒绝派活）。 */
function requireSoulBody(value: unknown, label: string): string {
  if (typeof value !== "string") throw new SoulProfileError(`${label}必须是文本`);
  if (value.trim() === "") throw new SoulProfileError(`${label}不能为空：没有底线的档案取不出派活身份，要清空就先删档案`);
  return value;
}

/**
 * 保存时按插件默认上限量一次。默认上限只是**早一步**的提醒：真正的预算是按模型上下文窗口
 * 算的（`resolvePromptBudget`），组装那一刻还会再拦一次。
 */
function assertSoulBodyWithinBudget(body: string): void {
  assertPromptRenderable(
    { soul: body, facet: "", facetId: null, selectionRevision: 0 },
    { variables: PROMPT_VARIABLES, maxCharacters: DEFAULT_PROMPT_MAX_CHARACTERS, budgetSource: "插件默认上限" },
  );
}

/** 把旧版整份存进 `history/SOUL-<修订>.md`（同一个修订只存一次），再往日志追加一行。 */
async function archiveSoulVersion(record: SoulRecord, raw: string, input: {
  action: "save" | "restore";
  nextRevision: string;
  sourceRevision?: string;
  note?: string | undefined;
}): Promise<void> {
  const dir = soulHistoryDir(record);
  await mkdir(dir, { recursive: true });
  const revision = revisionOf(raw);
  const file = soulHistoryPath(record, revision);
  if (!(await exists(file))) await writeAtomic(file, raw);
  const entry: SoulBodyHistoryEntry = {
    revision,
    at: new Date().toISOString(),
    action: input.action,
    bytes: Buffer.byteLength(parseSoulDocument(raw).body, "utf8"),
    nextRevision: input.nextRevision,
    ...(input.sourceRevision === undefined ? {} : { sourceRevision: input.sourceRevision }),
    ...(input.note === undefined ? {} : { note: input.note }),
  };
  await appendFile(path.join(dir, SOUL_HISTORY_LOG_FILE), `${JSON.stringify(entry)}\n`, "utf8");
}

/** 读留痕日志（最新在前）。坏行要报出来，不能当成「没有历史」——回滚就靠它。 */
async function loadSoulHistory(record: SoulRecord): Promise<SoulBodyHistoryEntry[]> {
  const file = path.join(soulHistoryDir(record), SOUL_HISTORY_LOG_FILE);
  const raw = await readUtf8TextFile(file, `底线正文留痕日志`).catch((error: unknown) => {
    if (isMissing(error)) return "";
    throw error;
  });
  const entries: SoulBodyHistoryEntry[] = [];
  let lineNumber = 0;
  for (const line of raw.split("\n")) {
    lineNumber += 1;
    const text = line.trim();
    if (text === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SoulProfileError(`底线正文留痕坏了：${SOUL_HISTORY_DIRECTORY_NAME}/${SOUL_HISTORY_LOG_FILE} 第 ${lineNumber} 行不是 JSON，没法据此回滚`);
    }
    const entry = historyEntryOf(parsed);
    if (entry === undefined) {
      throw new SoulProfileError(`底线正文留痕坏了：${SOUL_HISTORY_DIRECTORY_NAME}/${SOUL_HISTORY_LOG_FILE} 第 ${lineNumber} 行缺字段，没法据此回滚`);
    }
    entries.push(entry);
  }
  return entries.reverse();
}

/** 一行留痕的形状检查：宁可报「坏了」，也不要拿半条记录去回滚。 */
function historyEntryOf(value: unknown): SoulBodyHistoryEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const item = value as Record<string, unknown>;
  const action = item.action;
  if (action !== "save" && action !== "restore") return undefined;
  if (typeof item.revision !== "string" || typeof item.at !== "string" || typeof item.nextRevision !== "string") return undefined;
  if (typeof item.bytes !== "number" || !Number.isFinite(item.bytes)) return undefined;
  return {
    revision: item.revision,
    at: item.at,
    action,
    bytes: item.bytes,
    nextRevision: item.nextRevision,
    ...(typeof item.sourceRevision === "string" ? { sourceRevision: item.sourceRevision } : {}),
    ...(typeof item.note === "string" ? { note: item.note } : {}),
  };
}

/** 一行停用留痕的形状检查：宁可报「坏了」，也不要拿半条记录去解释状态是怎么变的。 */
function suspensionEntryOf(value: unknown): SuspensionEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.profileId !== "string" || item.profileId === "") return undefined;
  if (typeof item.name !== "string" || typeof item.directoryName !== "string" || typeof item.at !== "string") return undefined;
  if (typeof item.suspended !== "boolean") return undefined;
  return {
    profileId: item.profileId,
    name: item.name,
    directoryName: item.directoryName,
    suspended: item.suspended,
    at: item.at,
    ...(typeof item.note === "string" ? { note: item.note } : {}),
  };
}

/** 文件不在与读不动是两回事：只有 ENOENT 才当「没有」。 */
function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}
